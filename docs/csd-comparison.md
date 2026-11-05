# Comparing the synth to a singer: the Children's Song Dataset

`chimera compare csd` sings the English songs of the Children's Song Dataset (CSD) and
measures each render against the recording, note by note.

## The dataset

CSD (Choi, Kim, Park, Yong & Nam, ISMIR 2020; [Zenodo 10.5281/zenodo.4916302](https://zenodo.org/record/4916302), v1.1):

- one professional female singer
- 50 English and 50 Korean children's songs, each recorded in two keys (`a`, `b`)
- 44.1 kHz WAVs, with note onsets, offsets, MIDI pitch and a phonemic syllable for every note

It is licensed CC BY-NC-SA 4.0. Use it for research and tuning only. Don't ship its audio, or
anything derived from it, in the product.

```sh
tools/fetch-csd.sh            # 1.85 GB to ~/datasets/csd; unpacks CSD/english
```

## Running it

```sh
cargo run --release -p chimera-cli -- compare csd                      # the 50 `a` songs, female body, all cores (~2 min)
cargo run --release -p chimera-cli -- compare csd ~/datasets/csd/CSD out/csd --songs en001a,en002a
#   --songs a | b | all | <ids>   --body female|male|child   --jobs n   --float
```

It writes the following to the output directory (`out/csd` by default):

- `<id>-synth.wav`: the synth's render, on the same timeline as `english/wav/<id>.wav`. You can
  load both into a DAW, or make spectrograms of the pair with `bun tools/spectrogram.ts`.
- `report.md`: medians over songs, spectral balance per vowel, and one line per song.
- `report.json`: every note's measures for the singer and the synth.

## Method

**What the synth sings.** CSD's syllables (`k_y_uu`, `eo_n_d`) are mapped to the engine's IPA
by the table in `crates/chimera-cli/src/compare.rs`. An unmapped symbol is an error. So the synth
sings exactly the phonemes the singer sang, at her note times and her score pitches; G2P is not
under test.

- **Phrases.** A gap of more than 80 ms between notes ends a phrase. Each phrase is one
  `plan_song` call at 60 bpm, so a beat is one second.
- **Melisma.** A vowel-only syllable on the same vowel, starting within 20 ms of the previous
  note, continues that note as a melisma.
- **Settings.** The body, the source settings and the 35-cent vibrato match `render song`.

**What is measured.** Each note is measured over its steady part: from 30 % into the note to
20 % before its end, or from 10 % to 10 % for melisma notes.

| measure | what it tells you |
|---|---|
| pitch vs score, synth vs singer (cents) | intonation; YIN searched ±7 semitones around the score note, so it cannot jump octaves |
| vibrato depth (peak cents) and rate (Hz) | from the detrended contour of notes with at least 0.35 s of steady part |
| aperiodicity | YIN's aperiodicity: noise and roughness in the voice |
| H1−H2 (dB) | first minus second harmonic, the standard voice-quality measure: high is breathy or lax, low is pressed |
| voiced share | share of steady frames the synth actually voices; a frame is voiced when YIN finds a period and it is within 35 dB of the signal's loud level |
| voice onset (s) | first voiced frame of a phrase-initial note, relative to the note start; vowel-initial and consonant-initial phrases are reported separately |
| band levels, synth − singer (dB) | 0–0.5, 0.5–1, 1–2, 2–4 and 4–8 kHz, each relative to the 0–8 kHz total: spectral tilt and vowel colour, per vowel |
| note MCD (dB) | mel-cepstral distance between the note's averaged log-mel spectra (40 bands, 13 coefficients); on the usual MCD scale, but note-level, not frame-aligned |
| envelope lag and correlation | the shift (within ±0.3 s) that best lines up the two level envelopes: overall timing, and how much the loudness shape matches |

**Caveats.**

- **Notes are the alignment.** There is no phoneme-level timing in CSD. Consonant timing is
  only seen through voice onsets and the envelope.
- **No formants.** At this singer's pitch (C4–C6) the harmonics are 260 Hz or more apart, so LPC
  formants snap to harmonics. That is why the comparison uses band levels and cepstra.
- **Microphone and room.** Level and spectrum compare a recording made with a real microphone
  in a real room against the dry synth. Some of the high-band difference may be the recording
  chain.
- **One singer.** Treat the numbers as directions to tune in, not as targets for every voice.

## Baseline (2026-11-05, the 50 `a` songs, female body)

| measure | singer | synth |
|---|---|---|
| pitch error vs score (median \|cents\|) | 15.4 | 5.0 |
| vibrato depth (peak cents) / rate (Hz) | 37 / 6.7 | 35 / 5.8 |
| H1−H2 (dB) | +3.2 | −1.7 |
| H1−H2 on notes ≤ C4 / notes ≥ G4 (dB) | +3.9 / +0.2 | −6.0 / +7.5 |
| voiced share of steady frames | 0.93 | 0.87 (0.66 in en018a) |
| voice onset, consonant-initial phrases (s) | +0.01 | −0.06 |

- **Spectral balance.** Over all vowels, synth minus singer is −3.1, 0.0, +1.4, +4.5 and +7.9 dB
  in the five bands.
- **Distance and timing.** Note MCD is 9.2 dB. The envelope lag is −0.02 s (between −0.06 and
  +0.04 s) with correlation 0.79.

What this points at:

1. **Too much energy above 2 kHz**, about +8 dB at 4–8 kHz, for every vowel.
2. **The fundamental is weak on low notes and too strong on high ones.** H1−H2 should vary much
   less with pitch than it does.
3. **Consonants come too early.** For consonant-initial phrases the singer's voicing starts at
   the note's annotated start, but the synth sings its onset consonants about 60 ms before it.
   Either CSD annotates the syllable start rather than the vowel, or this singer puts consonants
   on the beat. Either way it is a timing difference to check by ear.
4. **Vibrato is too uniform.** The synth puts the same 35-cent vibrato on every long note. The
   singer's ranges from almost none to wide, and is faster.
5. **Voicing gaps in the steady part of notes.** These are worst in en018a, en041a and en043a,
   which are worth listening to first.
