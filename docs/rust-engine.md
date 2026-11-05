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

- `Engine`, `HumanVoice` and `CreatureVoice` are `Send` and share no mutable state, so each can
  render on its own thread.
- **Steady-state rendering allocates nothing.** That covers `render(&mut [f32])`, control steps,
  geometry frames, noise-source lists, beat-sequencer gesture builds and telemetry snapshots,
  which all reuse buffers held in their structs.
- **Bounded state with defined overflow.** The gesture score holds at most
  `GestureScore::CAPACITY` (16 384) gestures. A gesture added past that is dropped and counted
  (the TS score had no bound). Each `schedule` command takes at most 4 000 gestures, as the TS
  worklet did. Pruning compacts in place and keeps insertion order, which matters because
  blends sum in that order.
- **Commands that allocate.** These are meant for when nothing is sounding, or for a host that
  builds things off the audio thread:
  - a body switch (it builds a new airway network);
  - a creature switch;
  - the first `Engine::new` (it also loads the phonetics tables, so nothing initialises lazily
    on the audio thread later).

  Scheduling, releases, artic/source/gate changes and beat edits don't allocate.
- **Planners allocate** (text → gestures) and belong on a non-real-time thread: the main thread
  in the browser, an edit thread in JDAW. `plan_note_on` for live sung notes is small but
  allocates too; making it allocation-free is left for the JDAW integration.
- **Block-size independence.** `Engine::render` advances in fixed 128-sample sub-blocks, and the
  per-block work (beat-sequencer ticks) happens at those sub-block boundaries, which sit at
  absolute sample positions. The same commands at the same absolute sample positions therefore
  give the same samples whatever the host's block size. The TS worklet ticked once per host
  block, so a 48 000-sample offline block would have lost beats. Commands apply at the start of
  the next `render` call; a host that needs sample accuracy splits its block at the event.
- **Events out.** Responses go into a queue that the host drains after `handle`/`render`:
  `Ready { body, creature, n_ph, n_or }` after a voice switch, and `Planned { id, t0, end }` for a
  schedule that carries an id (the UI's timelines use `t0`).
- **Telemetry.** A snapshot is fixed-size and written into caller-owned buffers. Interval
  measures (RMS levels, the glottal scope's cycle capture) reset on each read; the struct docs
  mark which fields are which. Load measurement and message cadence stay in JS.
- **The human clock stops while a creature plays**, as before.

## Determinism

- **Repeatability (promised).** A given build renders the same samples every time, for any
  block size.
- **Cross-target identity (tested where possible).** All transcendental math goes through
  `chimera::math`, which wraps the pure-Rust `libm` crate at a pinned version. `sqrt` and the
  basic operations are IEEE-exact, and Rust never contracts to FMA on its own. A test renders
  fixed scenarios natively and through the wasm build and requires identical samples on
  x86-64 Linux. aarch64/macOS is untested here, so identity there is a goal, not a claim.
- **JS semantics.** `Math.min`/`Math.max` become `js_min`/`js_max`, which propagate NaN from
  either argument and order −0 below +0. Ternaries are ported as written. `Math.round` becomes
  `js_round`, which rounds halves up. The PRNG uses explicit wrapping `u32` arithmetic.
- **Precision.** State and gesture values are `f64` throughout; only output and telemetry are
  `f32`, as the TS `Float32Array`s were.
- **No FTZ/DAZ.** Hosts must not enable flush-to-zero or denormals-are-zero, because those
  change the samples. The engine already flushes silent state itself.

## Port fidelity

The port is literal. It keeps the same equations, the same operation order, the same constants,
the same PRNG seeds, and the same container order where order decides random-number
consumption or sums (noise sources, gestures). It retunes nothing. The checks:

1. **Golden comparison against the TS engine, before the TS engine is deleted.** Each
   `tools/golden/<area>.ts` runs the TS engine on fixed scenarios and writes fixtures, and the
   Rust tests compare against them.
   - Numeric outputs (geometry, area functions, plans, G2P, syllables) must agree to 1e-9
     relative, with an absolute floor near zero. Plans and G2P must agree exactly in structure.
   - Audio is compared on scenarios with events throughout (artic changes, releases, cancels,
     calls, body switches), not just at the start. Renders must agree sample for sample (≲1e-6
     of peak) until a discrete decision flips on a last-ulp difference between V8's libm and
     Rust's. After that, every 10 ms window's RMS must agree to 0.05 dB, and onset/release
     timing, silence, pitch and closures are covered by the ported behavioural tests. Any
     divergence before an event is investigated, not tolerated.
   - With the TS engine gone, `CHIMERA_BLESS=1 cargo test` rewrites the fixtures from the Rust
     engine after an intended change to the sound.
2. **The existing bun tests** (resonances against analytic values, FDTD against the chain
   matrix, stability, formants, closures, singing behaviour) are ported to `cargo test` with
   the same thresholds.
3. **The app's e2e smoke test** (`tools/e2e.ts`) runs against the wasm build and stays green.
4. **Benchmarks** measure native and wasm real-time factors against the TS numbers taken
   before the port.

## The browser boundary

- **One wasm module.** The main thread compiles it once and passes the `WebAssembly.Module` to
  the worklet in `processorOptions` (structured clone). Each side instantiates it
  synchronously. The import object is empty: no WASI and no JS glue. A build check asserts the
  artifact has no imports.
- **Startup ordering.** The wasm module must be ready before any UI module that calls into it
  runs, because `ui/singing.ts` builds syllables when it loads. `main.tsx` awaits the module,
  then imports the app. A failure shows a retryable error screen.
- **Audio thread (worklet).** The exports are C ABI with numbers and pointers only, over one
  engine handle.
  - Engine-owned buffers have a stable address for the engine's lifetime: an output buffer of
    up to 4 096 frames, a command scratch area, and the telemetry block. JS re-creates its
    typed-array views whenever `memory.buffer` has changed, and copies telemetry before the
    next call.
  - Gestures cross as fixed 256-byte little-endian records, layout version 1, specified in
    `crates/chimera-wasm/src/lib.rs` and mirrored by `src/engine/wire.ts`:
    - eight `f64`s: t0, t1, rampIn, rampOut, strength, speed, releaseHold, tag;
    - 22 `f64` targets in `ControlKey` order;
    - a u8 label length and 24 bytes of UTF-8;
    - padding.

    NaN marks an absent optional or target. Labels are cut at a character boundary.
  - The worklet scope has no `TextEncoder`/`TextDecoder`, so a tiny UTF-8 helper handles
    labels and ids.
- **Main thread.** Rich, non-real-time calls are JSON in and out through `serde_json`:
  - planning, G2P and syllables;
  - the anatomy model: frame, transfer function and formants, the `P`/`unP` template maps,
    scale, tube node positions, and branch → drawing position;
  - the creature, beatbox and vowel catalogues.

  The TS facade gives the UI the types it uses today. Creature drawing data stays in TS.
- **Faults.** The crate is built with `panic = "abort"`, so a panic in the worklet traps. The
  processor then outputs silence for good and posts one error. The main thread may build a new
  node, which restarts playback state: score, clocks and beat. There's no attempt at seamless
  recovery.

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
- `speech-diagnostics` (nasal leakage, formant undershoot, bandwidths, pitch) becomes
  `chimera diagnose`, because it's a measurement tool for future tuning.
- The one-off explorations are deleted: `proto-vowel`, `explore-syrinx`, `measure-closures`,
  `measure-consonants` and `draw-anatomy`. Their findings are already in the code and the
  commit history.

## Review

A design review (Codex, 2026-11-05) changed several points: block-size independence of the
beat sequencer, the bounded score and the list of allocating commands, latching faults instead
of rebuilding on the audio thread, determinism claimed only as tested, the event and telemetry
contract, the ABI layout, facade gaps and startup ordering.

It also suggested keeping G2P, planning and songs in TS for now. That suggestion was declined:
- the beat sequencer runs in the engine and needs most of the planner core (inventory, oral
  gestures, vowel targets);
- JDAW's headless core (principle 4) has to sing lyrics on notes (principle 15);
- phonetics split across two languages would drift.

The worklet's per-block replay budget stays out of Rust, because commands apply at the next
render call and so it isn't needed.
