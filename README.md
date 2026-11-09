# CHIMERA

A physical-modeling voice synthesizer in the browser. Every sound comes from a simulated
airway (lungs, vocal folds or syrinx, a branched vocal tract, lips, nose), not from samples.
The engine is Rust, compiled to WebAssembly for an AudioWorklet; the same code runs natively
for tests and the `chimera` CLI.

## What it does

- **Play**: drag the tongue, lips and jaw in a live cutaway of the head; vowel pad, encoders,
  computer keyboard and Web MIDI.
- **Speak**: English text (CMUdict with a letter-to-sound fallback) or IPA, turned into
  gestures and prosody, with the gestural score and a consonant chart on screen.
- **Sing**: piano roll with lyrics per note; consonants land before the beat.
- **Beatbox**: pads and a step sequencer, every drum an articulatory gesture.
- **Bestiary**: songbird (two-voice syrinx), seal, alligator and elephant.
- **Duet** (`?show=<id>`): two 3D heads replay a pre-rendered song.

Male, female and child bodies blend continuously. Everything on screen animates from live
engine state: pressure in the airway, airflow, the vocal folds, spectra and formants.

## Run it

Needs Rust with the `wasm32-unknown-unknown` target, and Bun.

```sh
bun install
bun run dev        # builds the wasm, then Vite on 127.0.0.1:5317
bun run test       # wasm build, cargo test --workspace, bun test tests
```

Open `http://127.0.0.1:5317/?mode=speak` for the English-input version. Type a sentence and press
**Speak** (or **⌘/Ctrl + Enter**) to hear the physical voice.

The AudioWorklet needs a secure context, so open it on localhost or over HTTPS (for example
`tailscale serve`). Vercel builds it with `vercel.json`.

For MP4 export with the full vocal-tract display and timed English captions, see the [performance renderer](tools/performance/README.md).

Offline renders and measurement:

```sh
cargo run --release -p chimera-cli -- render speech|text|song|notes|beatbox|creature|vowels …
cargo run --release -p chimera-cli -- diagnose       # nasal leakage, formants, bandwidths, pitch
cargo run --release -p chimera-cli -- compare csd    # against a real singer (docs/csd-comparison.md)
bun tools/spectrogram.ts in.wav out.png
```

A song of your own for the duet page (`?show=<id>`, a folder under the gitignored `public/shows/`):

```sh
bun tools/midi-to-melody.ts song.mid --track 1 --phrases                       # the phrases a lyric sheet is written against
bun tools/midi-to-melody.ts song.mid --track 1 --sheet sheet.txt --out melody.json
cargo run --release -p chimera-cli -- render notes melody.json voice male --tele voice.tele
bun tools/show-video.ts <id> out.mp4                                            # frame-exact MP4 of the show
```

The melody file can carry the song's own voice (`"vibrato"`, and a `"source"` object such as
`{"brightness": 0.7, "roughness": 0.3}`), and a show voice can carry a `"performance"`: a head pose
and expression tracked from a video, which turns the 3D head (`src/show/performance.ts`). On a host
whose Playwright browser is stale, set `CHIMERA_CHROME` to a Chrome executable for the browser tools.

## Docs

- [docs/architecture.md](docs/architecture.md): the acoustic model (FDTD airway, sources,
  anatomy, gestures).
- [docs/rust-engine.md](docs/rust-engine.md): the engine's real-time and determinism contract,
  and the browser boundary.
- [docs/ui-redesign.md](docs/ui-redesign.md) and [docs/mockups/](docs/mockups/): the vector
  display look.
- [docs/csd-comparison.md](docs/csd-comparison.md): scoring the voice against the Children's
  Song Dataset.
- [docs/hill-climb/](docs/hill-climb/): the rules and log for tuning the voice one measured
  step at a time.

Agents: see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Bundled third-party files keep their own licenses: the CMU Pronouncing
Dictionary ([public/data/CMUDICT-LICENSE.txt](public/data/CMUDICT-LICENSE.txt)) and the fonts
([public/fonts/](public/fonts/)).
