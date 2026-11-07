# CHIMERA

A physical-modeling voice synthesizer: a Rust engine (wasm in an AudioWorklet, native for tests
and the CLI) under a React UI. The README covers the rest.

## Working here

- Do what was asked, the simplest way that meets it. Experiments, new tooling and paid runs nobody asked for are
  proposals: say what they cost and what decision their result would change, and wait. If the work grows well past
  what you first expected, stop and tell the user: what you expected, where it is now, and a smaller way to finish.
- When you're repeating something the project has done before, reversing an earlier decision, or changing code
  whose purpose isn't clear, look at its history (`git log -- <path>`, `git log -S<symbol>`, `git blame`) and
  open the commits that explain it.
- The checks below are the minimum for what you touched. Run them again after any merge, rebase or conflict
  resolution.
- Commit small: one change per commit, each passing its checks. The subject says what changed, and the trap if
  there was one, in words a search would find. Unless the diff says it, the body gives the why, what you ruled
  out, what you ran (with numbers) and what you didn't test.
- Leave each fixed bug's reproduction behind as a test or a script.
- A step that's hard to reverse (schema, auth, money, external API) or several sessions long: design it in
  `docs/<topic>/` first. Judge each step on its own, not by the riskiest part of the project. Measure with the
  checks below or existing tools before writing new ones. Have a fresh session review the work (the design first,
  when that could save rework), from a different model family when one at least as capable is available, and ask
  it what to cut or do more simply, not only what's missing.
- Code and the running system outrank this file and every doc. When they disagree, fix the file in the same
  commit. When the project's code breaks unnoticed, add a rule here, with a check if one can be written; tooling
  built for one task doesn't get rules. Delete rules whose code is gone.

## Map

- `crates/chimera/src/`: the engine. No I/O. `engine.rs` is the host-facing `Engine`.
  - `airway/`: FDTD tube network, frequency-domain oracle, decimator.
  - `sources/`: glottis, syrinx, flow valves (trills). `anatomy/`: head geometry → area functions.
  - `control/`: articulators, gesture score, beat player. `voice/`: the human voice and its airway.
  - `creatures/`: songbird, seal, alligator, elephant.
  - `phonetics/`: IPA, G2P, planner, singing, beatbox, and the calibrated `*.generated.json` tables.
  - `math.rs`: deterministic math (libm, `js_*` helpers). `analysis/`: FFT, LPC, pitch.
- `crates/chimera/tests/`: engine tests; `golden/` holds fixtures from the retired TS engine.
- `crates/chimera/examples/bench.rs`: real-time load per voice.
- `crates/chimera-wasm/`: the browser's C ABI (`lib.rs`: gesture records; `api.rs`: JSON calls).
- `crates/chimera-cli/`: `chimera render | compare csd | diagnose | calibrate`.
- `src/main.tsx`: loads the wasm, then imports the app.
- `src/wasm/`: the UI's typed facade over the engine; `wire.ts` mirrors the gesture records.
- `src/worklet/`: the AudioWorklet processor and its message protocol.
- `src/audio/AudioEngine.ts`: the WebAudio graph (analysers, close-mic chain).
- `src/ui/`: React app. `components/` per screen and mode; `render/` canvas renderers and the
  vector kit (`vector.ts`); `usePhosphor.ts`; `store.ts`; `singing.ts` is the live Sing controller.
- `src/show/`, `src/ui/components/DuetPage.tsx`: `?show=<id>` duet replay from `--tele` files.
- `public/data/cmudict.txt.gz` (from `tools/build-dict.ts`), `public/fonts/` (Hershey, Archivo).
- `tests/`: bun tests against the wasm build.
- `tools/`: `e2e.ts`, `layout-lint.ts`, `spectrogram.ts`, `bench-wasm.ts`, `asr/` (Whisper speech
  judge), `fetch-csd.sh`, and the table generators.
- `docs/architecture.md`: the acoustic model. `docs/rust-engine.md`: real-time and determinism
  contract, browser boundary. `docs/ui-redesign.md` + `docs/mockups/`: the look.
  `docs/csd-comparison.md`: the singer judge. `docs/hill-climb/`: voice-tuning rules and log.
- `out/`: renders, screenshots, scores (gitignored).

## Rules

### Engine

- **Transcendental math goes through `chimera::math`, never `f64::sin` and friends.** Native and
  wasm must render bit-identical samples; std math differs by target. Check:
  `bun test tests/wasm-engine.test.ts` (after `bun run wasm`).
- **Rendering allocates nothing once warm** (render, control steps, telemetry, beat edits). Body
  and creature switches and the planners allocate, so they stay off the audio thread. Check:
  `cargo test -p chimera --test beat_alloc --test creature_realtime`.
- **Output doesn't depend on the host's block size.** Per-block work happens at the fixed
  128-sample sub-block boundaries, not per host call. Check: `cargo test -p chimera --test engine`.
- **The `*.generated.json` tables are regenerated, never hand-edited** (`chimera calibrate
  vowels|consonants`, `tools/gen-syrinx-table.ts`, `tools/gen-ipa-nfc.ts`). Vowel calibration
  isn't bit-reproducible (it moves 7 postures by ±0.002), so only rerun it when the formants are
  meant to move. Check: manual: the diff of the table matches the intent.

### Golden fixtures

- **Any change to the sound or the plans fails the golden tests, by design.** Re-bless with
  `CHIMERA_BLESS=1 cargo test --workspace --no-fail-fast`, run twice (`engine.rs` reads a
  fixture that `golden_planning` blesses). Only human-voice audio and the planners' plans
  re-bless; the other fixtures record the retired TS engine, so update the expectation or swap
  in a behavioural test (`crates/chimera/tests/golden/README.md`). Changing the airway's linear
  acoustics on purpose breaks `golden_analysis`'s "human |H|" checks. Check:
  `cargo test --workspace`.

### Browser boundary

- **`src/wasm/chimera.wasm` is a gitignored build product.** After a Rust change, `bun test tests`
  alone tests the old engine: run `bun run wasm` first, or `bun run test`. Don't share a cargo
  `target/` between checkouts; the copied artifact silently goes stale. Check: `bun run test`.
- **Gesture records are defined twice**: `crates/chimera-wasm/src/lib.rs` and `src/wasm/wire.ts`
  (size and `LAYOUT_VERSION`). Change both together and bump the version. Check:
  `bun test tests/wasm-engine.test.ts`.
- **The wasm module has no imports** (no wasm-bindgen, no WASI). Check: `bun test tests/wasm-engine.test.ts`.
- **Creature telemetry layout** crosses the worklet. Check: `bun test tests/creature-abi.test.ts`.
- **The wasm loads before any UI module runs.** `main.tsx` awaits `initChimera()` and then imports
  the app, because Sing builds syllables at import. A module that calls the engine at import
  must not be reachable from `main.tsx`'s static imports. Check: `bun run build && bun run preview`, then `bun tools/e2e.ts`.
- **A panic traps the worklet** (`panic = "abort"`), which latches to silence. The JSON calls in
  `api.rs` return `{"error": …}` for bad input rather than panicking. Check: none.

### UI

- **DOM content flows in `.screen-body` and is never absolutely positioned.** Control rows are
  `auto`; canvas rows are `minmax(min-content, Nfr)` (an fr share on control rows inflates every
  row in a short window). Add new screens and alternate states to the lint. Check:
  `bun run lint:layout` (about 6 min; blind to canvas text over line art).
- **The vector look:** blue is the body, amber is sound, green/red/pink/white are a screen's four
  control slots; Hershey capitals; build with `vector.ts`, `usePhosphor`, `Screen`/`Chip`/`Encoder`.
  DOM text keeps its natural case (capitals come from CSS) so accessible names and e2e selectors
  stay put. Check: manual: compare with `docs/mockups/`.
- **Frame rate on a real GPU can't be measured here** (headless Chromium uses SwiftShader). Check:
  manual: ask the owner.

### Content and data

- **Nothing copyrighted goes in git.** `public/shows/` (duet covers) is gitignored; song sources
  live outside the repo. CSD (CC BY-NC-SA) is for tuning only: never ship its audio or anything
  derived from it. Check: manual: `git status` before committing.
- **Voice tuning follows `docs/hill-climb/README.md`**, and never edits the judges
  (`crates/chimera-cli/src/compare.rs`, `compare/score.rs`, `tools/asr/`, the held-out songs and
  sentences) or shapes the output with EQ. Check: manual: the diff touches none of them.
- **`plan_song` puts the vowel on the beat and its consonants before it.** Check:
  `cargo test -p chimera --test golden_planning`.

### Environment

- **Renders, screenshots and scratch output go under `out/`.** `/tmp` here is a small tmpfs;
  large envs and models go in `~/.cache/<name>`. The AudioWorklet needs HTTPS off localhost:
  share previews with `tailscale serve`. Check: none.

## Checks

| When you touch | Run |
|---|---|
| anything | `bun run test` (wasm build, `cargo test --workspace`, `bun test tests`) and `bun run typecheck` |
| `crates/chimera/` (sound) | the above, re-blessing goldens per the rule; `cargo run --release -q -p chimera --example bench` against the previous commit |
| `crates/chimera-wasm/`, `src/wasm/`, `src/worklet/`, `src/main.tsx` | `bun run test`; `bun run build && bun run preview`, then `bun tools/e2e.ts` |
| `src/ui/`, `src/show/`, CSS | `bun run typecheck`, `bun run lint:layout` |
| `docs/mockups/gen/` | none (broken since cd247a6 retired the TS engine they import; the HTML pages still work) |
