# The engine in Rust

*Design, 2026-11-05. Written before the port; the "Status" section at the end records what shipped.*

## Why

1. **JDAW.** JDAW (`~/jdaw/VISION.md`) is a native Rust engine with a web UI. CHIMERA joins it as a
   source module "once its DSP is ported to Rust" (principles 5, 9, 14). JDAW needs a headless,
   deterministic, real-time-safe library with no browser in it. Offline renders must equal
   real-time output (6), the engine must be able to use every core (7), and macOS and Linux must
   both work, with WASM for the web (8).
2. **Audio-thread headroom.** The TS engine uses 30–45% of one fast core in the AudioWorklet
   (male voice at 2× oversampling, the creatures at a similar cost). A slower laptop has little
   headroom left.

The UI lag is a separate problem. Measured in Chromium, it comes from the anatomy view's canvas
`blur()` filter (applied to every fill, every frame), not from the engine. It gets its own small
fix.

## Scope

Everything under `src/engine/` moves to Rust, and the TS engine is deleted, so there is one
source of truth and no drift. That covers the airway FDTD, the frequency-domain oracle, the human
anatomy and articulators, the gestural score, the glottis/valves/syrinx sources, the creatures,
the phonetics (IPA, CMUdict G2P, syllables, durations, planner, singing, beatbox, demo songs) and
the analysis code (FFT, LPC, YIN). The worklet's state machine (`src/worklet/processor.ts`: body
switches, creature switches, beat player, ordered replay) moves too, because JDAW needs that
behaviour as well.

These stay in TS:

- **UI-only code**: React, the canvas renderers, the creature drawing data (silhouettes and tube
  paths), the zustand stores, Web MIDI, and the live Sing controller (`ui/singing.ts`). The
  controller calls the Rust planners.
- **The browser audio graph**: the analysers and the close-mic chain, which use WebAudio nodes.

## Layout

```
Cargo.toml                 workspace
crates/chimera/            the engine (lib). deps: libm, serde(+derive), serde_json. No I/O, no globals but OnceLock tables.
crates/chimera-wasm/       cdylib for wasm32-unknown-unknown: a C ABI over chimera, no wasm-bindgen
crates/chimera-cli/        `chimera render …`: headless renders to WAV (replaces tools/render-*.ts) + calibration bins
src/engine/                (TS) thin typed facade over the wasm module: same names/types the UI imports today
```

Module tree of `chimera` mirrors `src/engine` 1:1 (`airway::network`, `anatomy::human`, …), so the
port can be reviewed file against file. `chimera::engine::Engine` is the old processor.

## Real-time contract (what JDAW needs)

- `Engine`, `HumanVoice`, `CreatureVoice`: `Send`, no shared mutable state, so each can render
  on its own thread.
- `render(&mut [f32])` allocates nothing once warm. Any per-block or per-control-step temporary
  is a buffer that lives in the struct and keeps its capacity. The geometry `Frame`, the
  noise-source list, the beatbox gesture builder and the score storage all follow this rule; the
  gesture score has a fixed capacity, as the TS version effectively does with `MAX_GESTURES`.
- The planners (text → gestures) allocate and are meant for a non-real-time thread: the main
  thread in the browser, an edit thread in JDAW. Live sung notes call `plan_note_on`, which is
  small; making the planner allocation-free is left for the JDAW integration.
- Output does not depend on block size: the same commands give the same samples whether you
  render in blocks of 1, 128 or 48 000. Commands apply at the start of the next `render` call;
  a host that needs sample accuracy splits its block at the event.

## Determinism

- All transcendental math (`sin cos tan exp ln pow tanh atan2 acos cbrt hypot log10 log2`) goes
  through `chimera::math`, which wraps the pure-Rust `libm` crate. `sqrt`, `abs`, `floor` and the
  basic arithmetic are IEEE-exact everywhere. Rust never contracts to FMA on its own. The result
  is that native x86-64, native aarch64 (macOS) and wasm32 produce **bit-identical** output. That
  settles JDAW's open question on cross-machine determinism, at least for CHIMERA. There is a
  test that renders a fixed scenario and checks a hash committed alongside it.
- `Math.min`/`Math.max` propagate NaN; `f64::min`/`f64::max` don't. The port uses explicit
  comparisons wherever the TS relies on that, or where an argument could be NaN.
- Hosts must not enable FTZ/DAZ: flushed denormals change the samples. The engine already
  flushes silent state itself, as the TS version does.

## Port fidelity

The port is literal. It keeps the same equations, the same operation order, the same constants
and the same PRNGs (mulberry32 with the same seeds). It does not retune anything. The checks:

1. **Golden comparison against the TS engine, before the TS engine is deleted.** A TS script
   (`tools/golden.ts`) renders scenarios and dumps fixtures: per-module numeric outputs
   (geometry frames, area functions, transfer functions, plans as JSON, G2P on a word list,
   syllabification) and audio (speech, a sung phrase, a beatbox bar, each creature's calls, live
   articulator sweeps, a body switch). Rust tests compare against them.
   - Plans, geometry and G2P must match exactly, or to within 1e-9 relative where floats are
     involved.
   - Audio is compared sample by sample. The expectation is ≲1e-6 relative to peak for the first
     ~0.25 s; libm and V8 differ in the last ulp of `pow`/`exp`, and the voice's nonlinear
     feedback can grow that. Over the whole render the check is a looser envelope/spectral one
     (RMS envelope within 0.1 dB, log-spectrum distance) so that real porting errors still fail.
   - Fixtures are short and committed (<2 MB total), so the Rust tests keep guarding behaviour
     after the TS engine is gone.
2. **The existing bun tests**, which check resonances against analytic values, FDTD against the
   chain matrix, stability, formants, closures and singing behaviour, are ported to `cargo test`
   with the same thresholds.
3. **The app's e2e smoke test** (`tools/e2e.ts`) runs against the wasm build and must stay
   green.
4. **Benchmarks** (`cargo bench`-style, plain `std::time`, so no criterion dependency): native
   and wasm real-time factors next to the TS numbers measured before the port.

## The browser boundary

- **One wasm module.** The main thread compiles it once (`WebAssembly.compileStreaming`) and
  passes the `WebAssembly.Module` to the worklet in `processorOptions`. Each side instantiates it
  synchronously and gets its own instance and memory. The import object is empty: no WASI and
  no JS glue.
- **Audio thread (worklet).** The exports are C ABI with numbers and pointers only, for example
  `engine_new(fs)`, `engine_render(n) -> *f32`, `engine_set_artic(ptr, mask)` and
  `engine_schedule(ptr, count, lead, replace)`.
  - Gestures cross as fixed-size `#[repr(C)]` records: a header of t0, t1, ramps, strength,
    speed, releaseHold and tag; 22 target slots with NaN for absent; and a 24-byte UTF-8 label.
    A ~60-line TS codec (`src/engine/wire.ts`) writes them into wasm memory.
  - Telemetry is a set of pointer/length getters read into the same `TelemetryMessage` shape
    the UI uses today, so the UI barely changes.
  - The worklet scope has no `TextEncoder`/`TextDecoder`, so labels use a tiny UTF-8 helper.
  - Typed-array views are re-created after every call that might grow memory. Memory starts
    pre-sized so that the audio path never grows it.
- **Main thread.** Rich, non-real-time calls take JSON in and give JSON out through
  `serde_json`: `plan_phrases`, `plan_song`, `plan_note_on`, `g2p_*`, `lyrics_to_syllables`,
  `model_frame` (the geometry for drawing), `model_transfer` (H(f) and formants), and the
  creature, beatbox and vowel catalogues. The TS facade parses that JSON into the types the UI
  already imports (`Gesture`, `Plan`, `HumanFrame`, `CreatureDef` minus the drawing data, which
  stays in TS). CMUdict is still fetched and gunzipped in the browser; its text goes into the
  wasm instance once.
- **Panics.** The crate is built with `panic = "abort"`, so a panic in the worklet traps. The
  processor catches the trap, posts an error, outputs silence and rebuilds the instance with the
  performer's state.

## Build

- `bun run wasm` runs `cargo build -p chimera-wasm --release --target wasm32-unknown-unknown`
  and copies the result to `src/wasm/chimera.wasm`, which Vite imports with `?url`. `dev`,
  `build` and `test` run it first.
- `bun test` keeps the TS-side tests (the codec, the facade, and the e2e run against the built
  app). `cargo test` holds the engine tests.

## What JDAW gets

`chimera` as a path or git dependency:

- `Engine::new(sample_rate)` plus `handle(Command)`, `render(&mut [f32])` and
  `telemetry(&mut Telemetry)`.
- The voices directly: `HumanVoice`, `CreatureVoice`.
- The planners: `plan_phrases`, `plan_song`, `plan_note_on/off`, `lyrics_to_syllables`, and
  `EnglishG2P` with a dictionary given as `&str`.

JDAW's eventual module trait (note-on/off with lyrics and expression read from the notes) is an
adapter over these, written when JDAW's module interface exists. Designing it now would be
speculative (JDAW principle: generality must earn its place).

## Tools

- `render-speech`, `render-text`, `render-song`, `render-beatbox`, `render-creature` and
  `render-vowels` become `chimera render <kind> …`, which writes a WAV. The spectrogram PNG stays
  a TS tool (`tools/spectrogram.ts in.wav out.png`, reusing `tools/lib`).
- `calibrate-vowels`, `calibrate-consonants` and `gen-syrinx-table` become `chimera-cli` bins,
  because they regenerate committed data.
- The one-off exploration and diagnostic scripts are deleted: `proto-vowel`, `explore-syrinx`,
  `measure-closures`, `measure-consonants`, `speech-diagnostics` and `draw-anatomy`. Their
  findings are already in the code and the commit history.
