# Hill-climb log

The rules are in [README.md](README.md). Entries are in order, newest last.

## Baseline (2026-11-07)

- **Singer:** training score 1.433, held-out 1.590. 0 means every term is within her own
  variation; lower is better.
- **Speech:** word error rate 38.7 %. Harvard sentences 32.5 % (male) and 37.5 % (female);
  nonsense sentences 47.9 % and 38.0 %.
- **Speed:** the voice takes 18.3 % of one core in real time (`os=2`).

## Leads

The largest costs at the baseline, and what they point at. When an experiment closes a lead or
opens a new one, update this list and give the experiment's number.

1. **Spectral tilt and the fundamental.** Costs: level 4–8 kHz 5.4, H1−H2 2.1, level 2–4 kHz
   1.4, level 0–0.5 kHz 1.4.
   - Too much energy above 2 kHz and too little below 500 Hz, on every vowel.
   - H1−H2 is too low on low notes (−5.8 dB, she has +4.0) and too high on high ones (+8.2 dB,
     she has +0.1).
   - Together they sound like a source that is too pressed. Look at the open quotient, skew and
     closure sharpness, and at how they vary with pitch and effort
     (`crates/chimera/src/sources/glottis.rs`, and how `voice/human_voice.rs` drives it).
2. **Aperiodicity.** Cost 2.9: the synth's is about twice hers. Look at jitter, shimmer, drift
   and aspiration noise in the source. She is a clean, trained voice.
   - Experiment 1 lowered the jitter: cost 1.74. Most of what is left comes from a few songs with
     voicing trouble (en043a 0.05, en018a 0.03), not from the source's median: with jitter and
     shimmer at zero the cost stays at 1.30. Lowering shimmer raises note MCD past its guard.
3. **Phrase onsets.** Costs: vowel-initial 1.4, voiceless-initial 1.1.
   - Voicing starts about 20 ms early before a vowel.
   - Before /s/, /f/ and /h/ the synth voices 100–130 ms before the note, so the voicing runs
     into the fricative or comes before it.
   - Look at how a phrase starts: the 60 ms lead in `plan_song`, and the glottal abduction of a
     voiceless onset.
4. **Vibrato.** Costs: rate 0.67, share 0.62. The synth puts 35-cent vibrato on every long note
   at 5.5 Hz. She uses it on about two thirds of her long notes, at about 6.1 Hz
   (`vibrato_gesture` in `crates/chimera/src/phonetics/sing.rs`).
5. **Voicing in held notes.** Cost 0.26. Gaps mid-note, worst in en018a, en041a and en043a
   (0.65–0.70 voiced).
6. **Speech consonants.** Not scored, only guarded. Whisper mishears /tʃ/, /dʒ/, /ʃ/ and /s/:
   "sheet" as "feet", "chicken leg" as "quickly like", "juice" as "roost". This is for a later
   loop on speech.

## Experiments

### 1. A trained singer's jitter, not a clinical one (kept)

- Hypothesis: at the default roughness (0.1), which the comparison sings with, the source
  jittered 0.65 % and shimmered 4.2 % per cycle. Those values are near the clinical thresholds
  (MDVP: 1.04 % and 3.81 %), and the synth's YIN aperiodicity was twice hers (0.010 against
  0.005). A healthy trained voice has about 0.3–0.5 % jitter. Less jitter should lower
  aperiodicity and leave the spectrum alone.
- Change: `apply_source` in `crates/chimera/src/voice/human_voice.rs`: jitter
  `0.003 + 0.035·roughness` → `0.0021 + 0.0245·roughness` (0.45 % at 0.1, 2.7 % at 1).
  Shimmer unchanged. Tried, against the baseline:
  - jitter and shimmer both 0 (diagnostic only): 1.173, aperiodicity cost 1.30; WORSE, note MCD
    +0.86 dB. The averaged log-mel spectra need some perturbation between the harmonics.
  - jitter 0.35 %, shimmer 2.3 %: 1.157; WORSE, note MCD +0.24 dB, and one note fewer for en016a's
    voiceless onsets.
  - jitter 0.35 %, shimmer unchanged: 1.201, MCD +0.06; WORSE on the en016a note alone.
  - jitter 0.45 %, shimmer unchanged: 1.245; BETTER. Kept.
  - The en016a note (no. 100, "tak" at 58.59 s) is a note the synth never voices (0 % voiced in
    the baseline too). Its onset was one stray voiced frame 70 ms before the note, and any change
    to the random sequence can drop it. The guard decided; the gap is a voicing fault (lead 5).
- Singer: training score 1.433 → 1.245 (−0.188 like for like), held-out 1.590 → 1.402.
  Aperiodicity cost 2.88 → 1.74 (synth median 0.010 → 0.008; held-out cost 2.09 → 0.96). Note MCD
  9.243 → 9.288 dB. No other term moved by more than 0.02.
- Speech: word error rate 38.74 → 39.07 % (OK).
- Speed: `os=2` 18.4 % → 18.5 %.
- Tests: pass. Two things for the batch PR:
  - `CHIMERA_BLESS=1 cargo test --workspace` stops at the first failing test binary. `engine.rs`
    reads `beatbox-bar.f32` and fails before `golden_planning` can bless it, so bless with
    `--no-fail-fast`.
  - `golden_analysis` checks the power spectrum of `voice-sustain-male.f32` against TypeScript-era
    numbers in `analysis.json`. Once the voice fixtures are re-blessed it fails on any change to
    the sound. The PR has to update that expectation or analyse a fixed signal instead.
- Commit: 2c41618.
- Next: don't lower shimmer again: the note MCD guard is close. The rest of the aperiodicity cost
  is in songs with voicing gaps (en043a, en018a), which is lead 5, and the largest single cost is
  still level 4–8 kHz (lead 1).
