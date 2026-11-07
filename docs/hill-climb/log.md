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
   - Experiment 2 softened the closure: the 2–4 and 4–8 kHz costs fell to 0.13 and 0.68, so the
     high bands are about done. H1−H2 (2.21) and level 0–0.5 kHz (1.32) did not move: they are
     not the closure. They point at the open quotient and how it follows pitch: the synth's
     H1−H2 rises with pitch where hers falls.
   - Experiment 3 opened a small posterior chink: level 0–0.5 kHz 1.32 → 1.14, H1−H2 only
     2.21 → 2.14. What is left of H1−H2 is how it follows pitch and vowel, not its level. By
     vowel class and pitch, the synth's H1−H2 swings two to three times as far as hers as the
     harmonics cross F1: close vowels −9 → +23 dB from MIDI 56 to 68 (hers 1 → 11), mid vowels
     −10 → +14 from 60 to 72 (hers 5 → −3). The tract's closed-glottis F1 bandwidths are 35–70 Hz
     (female body). Two candidates: a wider F1 bandwidth (wall resistance: doubling
     `WALL_SOFT.resistance` raises B1 by about half but lowers F1 by 10–20 Hz, so the vowel tables
     need `chimera calibrate`), or F1 that follows pitch (singers open the jaw on high notes).
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
   - Experiment 4 held the folds open from the in-breath to the first voiced segment: WORSE. With
     the glottis open, the breath (which reaches full pressure 20 ms before the first segment)
     blows a loud [h] before the vowel or the onset consonant, and the detector reads it as voicing
     100–150 ms early. The cause is upstream: the breath arrives before the first articulation is
     in place. Next angle: start the breath ramp with the first segment's closure or constriction
     (`breath` gesture in `plan_utterance`), not 60 ms ahead of it, and leave the folds alone.
   - Experiment 10 timed a sung phrase's breath to reach full drive as its first segment starts
     (20 ms later than before): vowel-initial cost 1.49 → 0.97 (median −0.016 → +0.004 s, hers
     +0.005), voiceless-initial 1.08 → 0.52 (−0.020 → +0.037 s, hers +0.018). The medians are
     about right now; what is left is the mean gap, so a few phrases far off (the /s/, /f/, /h/
     onsets voiced well before the note, and the phrase-initial stops that never phonate, lead 5).
4. **Vibrato.** Costs: rate 0.67, share 0.62. The synth puts 35-cent vibrato on every long note
   at 5.5 Hz. She uses it on about two thirds of her long notes, at about 6.1 Hz
   (`vibrato_gesture` in `crates/chimera/src/phonetics/sing.rs`).
   - Experiment 5 raised the rate to 5.9–6.1 Hz: rate cost 0.66 → 0, score −0.044, but WORSE on
     the fewer-notes guard (barely voiced short notes, lead 5). Retry it once lead 5 is fixed.
   - The like-for-like judge (after experiment 6) and experiment 8 have both cleared the way: retry
     it as it was. Rate cost is 0.64 at experiment 8.
   - Experiment 9 kept 6.0 Hz: rate cost 0.64 → 0. What is left is the share (0.65): the synth puts
     vibrato on every long note, she on about two thirds. That is a planner choice
     (`vibrato_gesture`), not the source's.
5. **Voicing in held notes.** Cost 0.26. Gaps mid-note, worst in en018a, en041a and en043a
   (0.65–0.70 voiced).
   - The same fault blocks other experiments (1, 3, 5): short notes on a stop coda that the synth
     voices 0–12 % of the time, so one stray voiced frame decides whether H1−H2 and pitch are
     measured. Any change to the sound flips a few of them either way, and the fewer-notes guard
     calls a loss WORSE. Fixing these notes is the most useful next step.
   - Experiment 6 found the main cause: 315 of the 368 notes the synth voices under 30 % (she
     voices them over 70 %) are a phrase's last note. `plan_song` ends a phrase's last vowel up to
     120 ms (30 % of the note) before the note's end to leave a breath, though callers already
     split phrases at rests. Holding the note to 50 ms before its end: score 0.889 → 0.747, voiced
     share and aperiodicity costs to about 0. WORSE only on the fewer-notes guard, through two
     phrase-initial notes the synth never voices (below). Retry it once those voice.
   - The note that blocks it, en044a no. 145 "pæ" at 63.77 s (phrase-initial, 0.18 s, then
     "dwi"): the /p/ burst and aspiration are there (63.76–63.84 s), then 50 ms at −55 dB, about
     25 dB below the aspiration, where the vowel should be, and voicing starts only with the next
     note's /d/. The vowel never phonates after a phrase-initial voiceless stop. Its old "onset"
     was a stray frame 80 ms before the note. en036a no. 71 "ki" is the same shape. Look at why the
     folds don't start after the stop's abduction at a phrase start (lead 3's breath timing, or the
     abduction gesture's release).
   - Experiment 7 retried experiment 6 at r = 0.05 under the like-for-like judge: BETTER (0.889 →
     0.747), speech and speed OK, but reverted on a test. `songs_match_typescript` in
     `crates/chimera/tests/golden_planning.rs` checks `plan_song` against TypeScript-era plans in
     `tests/golden/planning.json`, which `CHIMERA_BLESS` doesn't regenerate, so it fails on any
     change to how songs are planned. The change is ready to keep once the owner decides how that
     fixture may be updated (a bless path for the song plans, or an exception in the rules like the
     airway one). Until then, no `plan_song` change can be kept.
   - Experiment 8 kept it, once the planners' snapshots were blessed: voiced share cost 0.26 →
     0.04, aperiodicity 0.90 → 0.03. This lead is about closed. What is left is the phrase-initial
     notes that never phonate after a voiceless stop (en044a no. 145, en036a no. 71), which is
     lead 3's.
6. **Speech consonants.** Not scored, only guarded. Whisper mishears /tʃ/, /dʒ/, /ʃ/ and /s/:
   "sheet" as "feet", "chicken leg" as "quickly like", "juice" as "roost". This is for a later
   loop on speech.
   - Experiment 11 found why /ʃ/ is heard as /f/: the chamber in front of the raised tongue tip
     (under the alveolar ridge, and the sublingual space) took the mid-oral area law, ~5.5 cm²,
     so the front-cavity resonance that the teeth source excites sat at 1.7 kHz (male) and
     2.1 kHz (female). A narrower law for the rays ahead of the tip: speech 40.73 → 35.76 %
     (BETTER), singer guards pass, but reverted on `geometry_continuity` (an existing jump at
     the top of the pharynx that the recalibrated child /ə/ lands on). Fix that jump, then keep
     experiment 11 as it was. The /ʃ/ is still about 21 dB below the vowel (female), as loud as
     /f/: its level is the next thing to look at.

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

### 2. The folds close over a return phase, not at a corner (kept)

- Hypothesis: at tension 0.55, which the comparison sings with, the glottal area pulse closed
  with sharpness 0.635: close to a hard corner, as if the folds met all at once. Real folds close
  along their length and depth over a return phase, so the source spectrum falls faster above
  about 1 kHz. The synth had 7.5 dB too much at 4–8 kHz and 4.4 dB too much at 2–4 kHz, on every
  vowel. A softer closure should lower both bands and leave the low bands and H1−H2 roughly
  alone.
- Change: `apply_source` in `crates/chimera/src/voice/human_voice.rs`: closure sharpness
  `0.25 + 0.7·tension` → `0.4·tension` (0.22 at tension 0.55; speech, at 0.5, gets 0.2). Tried,
  against experiment 1:
  - `0.1 + 0.55·tension` (0.40): 1.047; BETTER. 4–8 kHz cost 2.91, 2–4 kHz 0.60.
  - `0.4·tension` (0.22): 0.930; BETTER. Kept.
  - `0.2·tension` (0.11): 0.915; BETTER, but the synth's 4–8 kHz median (−25.6 dB) passes hers
    (−24.8), MCD is flat (8.628) and it leaves tension almost no say in the closure. The extra
    0.015 is not worth that.
- Singer: training score 1.245 → 0.930 (−0.314 like for like), held-out 1.402 → 1.045.
  - Level 4–8 kHz cost 5.37 → 0.68 (synth median −17.3 → −23.7 dB, hers −24.8).
  - Level 2–4 kHz 1.43 → 0.13 (−14.0 → −17.1, hers −18.4).
  - Aperiodicity 1.74 → 0.97 (held out 0.96 → 0.05): YIN reads less high-frequency energy
    between the harmonics.
  - H1−H2 2.09 → 2.21: within the 0.25 a term may rise.
  - Level 0–0.5 kHz 1.41 → 1.32. Note MCD 9.288 → 8.624 dB. Nothing else moved by more than
    0.07.
- Speech: word error rate 39.07 → 39.07 % (OK).
- Speed: `os=2` 18.5 % → 19.1 % (3 %).
- Tests: pass, including `golden_analysis`.
- Commit: 8c04752.
- Next: the high bands are close to her now. The largest costs are H1−H2 (2.21), the onsets
  (1.39 and 1.10), level 0–0.5 kHz (1.32) and aperiodicity (0.97). H1−H2 and the low band point
  at the open quotient and how it follows pitch (lead 1), not at the closure.

### 3. A posterior glottal chink that stays open through closure (kept)

- Hypothesis: H1−H2 (cost 2.21) and level 0–0.5 kHz (1.32) were too low. At the default
  breathiness the folds sealed almost completely (chink 0.007 cm² on the female body). Most voices,
  women's and trained singers' included, keep a small posterior gap through the closed phase
  (Södersten & Lindestad 1990). Its leak lifts H1 and damps the tract, so H1−H2 and the low band
  should rise and H1−H2 should swing less as the harmonics cross F1.
- Change: `apply_source` in `crates/chimera/src/voice/human_voice.rs`: chink base 0.004 → 0.008
  (`0.008 + 0.03·breathiness`, times k²). Tried, against experiment 2:
  - 0.02: 0.896; WORSE, seven notes fewer measured (H1−H2 and pitch on en008a, en009a, en018a and
    more). Every lost note is one the synth hardly voices (5–10 % voiced: short notes on a stop
    coda like "dɑk", "ɹaɪt", "ɪt"); one stray voiced frame decides whether they are measured.
  - 0.016: 0.883; WORSE, the same kind of notes.
  - 0.012: 0.878; WORSE: one note fewer for H1−H2 (en048a "lʊk", 10 % voiced) and one fewer long
    enough for vibrato (en033a no. 96, a 0.6 s /ə/ whose voiced run fell under 0.4 s).
  - 0.008: 0.889; BETTER. Kept.
  - The larger chinks scored better but lose more of these notes. That is lead 5 again: notes
    the synth barely voices.
- Singer: training score 0.930 → 0.889 (−0.041 like for like), held-out 1.045 → 1.018.
  - Level 0–0.5 kHz 1.32 → 1.14 (synth median −7.31 → −7.04 dB, hers −4.02).
  - H1−H2 2.21 → 2.14 (−1.21 → −0.96 dB, hers +3.20). The swing with pitch is unchanged: by
    pitch the synth's medians still run −5 dB at MIDI 54 to +12 at 72, hers +2 to 0.
  - Level 4–8 kHz 0.68 → 0.44, level 2–4 kHz 0.13 → 0.00, aperiodicity 0.97 → 0.90.
  - Note MCD 8.624 → 8.573 dB. Nothing else moved by more than 0.02.
- Speech: word error rate 39.07 → 39.40 % (OK).
- Speed: `os=2` 19.1 % → 18.2 %.
- Tests: pass, including `golden_analysis`.
- Commit: f5cc671.
- Next: a larger chink doesn't flatten H1−H2's swing with pitch, and it costs notes the synth
  barely voices. Try a wider F1 bandwidth or F1 that follows pitch (lead 1). Lead 5 is worth
  a run of its own: those barely voiced short notes before a stop make every guard noisy.

### 4. The folds stay apart from the in-breath until the first voiced segment (reverted)

- Hypothesis: a phrase starts with the folds adducted (abduction 0) while the breath gesture
  ramps the pressure up from 60 ms before the first segment. So the voice starts as soon as the
  pressure crosses threshold: 15–20 ms before a vowel-initial note (hers +5 ms), and as a voiced
  blip before a voiceless onset (/s/, /f/, /h/ voiced 100–130 ms early). A real breath group
  starts from the open glottis of the in-breath, and the folds close only into the first voiced
  sound. Holding them open until then should move both onset terms later and leave the rest
  alone.
- Change: `plan_utterance` in `crates/chimera/src/phonetics/planner.rs`: an "inhale" abduction
  gesture (0.3, strength 6, like the voiceless one) from 50 ms before the plan start to 30 ms
  before the first voiced segment, ramping out over 30 ms. Tried, against experiment 3:
  - on every phrase: 1.378; WORSE. Vowel-initial onset −0.015 → −0.040 s, voiceless-initial
    −0.024 → −0.095 s, voiced share 0.260 → 0.634 cost, aperiodicity 0.90 → 2.50, 28 song
    measures on fewer notes. In the render (en001a at 2.40 s) the vowel now voices on time, but
    a 54 dB [h] (the vowel is 78 dB) runs for 55 ms before it: full breath through an open
    glottis. YIN counts that as the voice starting.
  - only on phrases that open on a voiceless consonant: 1.134; WORSE. Vowel-initial unchanged,
    voiceless-initial still −0.095 s: the breath blows through the open glottis before the
    onset's oral closure is made, an [h] before /k/, /t/, /p/. The gesture also reached back into
    the previous phrase when the gap was short (en002a "dh_eo" at 9.41 s, 135 ms before
    "p_l_ei_n_z": voiced 1.0 → 0.0), which cost voiced share and aperiodicity.
- Singer: training score 0.889 → 1.378 / 1.134 (not kept); held-out 1.018 → 1.314 (first try).
- Speech: not measured (the singer verdict was WORSE).
- Verdict: WORSE on both tries: onset terms rose instead of falling, voiced share and
  aperiodicity rose, songs measured on fewer notes.
- Next: don't open the glottis at the phrase start while the breath leads the articulation.
  The breath's 60 ms lead over the first segment is the real fault. Time the breath ramp to the
  first segment's oral closure (or, for a vowel, end it at the vowel's start), so that pressure
  builds behind a closure or into adducted folds, not into the open air (lead 3).

### 5. A trained singer's vibrato rate, 6 Hz rather than 5.5 (reverted)

- Hypothesis: the synth puts every vibrato at 5.5 Hz (measured 5.49), and hers runs at 6.1
  (6.0 over all her notes). Trained singers' vibrato is 5.5–6.5 Hz, about 6 Hz on average
  (Prame 1994, Sundberg). Raising the source's default rate should close the vibrato-rate gap
  (cost 0.66) and leave everything else alone, since only the pitch modulation's speed changes.
- Change: the default `vibrato_rate` 5.5 → 6.0 Hz in `DEFAULT_SOURCE`
  (`crates/chimera/src/voice/human_voice.rs`) and in the glottis default
  (`crates/chimera/src/sources/glottis.rs`). Speech has no vibrato, so it is untouched. Tried,
  against experiment 4's best (experiment 3, 0.889):
  - 6.0 Hz: 0.845 (−0.044 like for like); WORSE, en009a and en048a lose one H1−H2 and pitch note
    each.
  - 5.9 Hz: 0.843 (−0.046); WORSE, en019a, en033a (one note fewer long enough for vibrato), en034a,
    en048a and one more each lose a note.
  - 6.1 Hz: 0.846 (−0.044); WORSE, en019a loses one H1−H2 and pitch note.
- Singer: training 0.889 → 0.845 at 6.0 Hz (not kept), held out 1.018 → 1.007–1.008 at 5.9 and
  6.1 Hz. Vibrato rate cost 0.66 → 0.00 at every rate (synth 5.49 → 5.87 / 5.98 / 6.08 Hz, hers
  6.08); vibrato share 0.59 → 0.60–0.64; nothing else moved by more than 0.03.
- Speech: not measured (the singer verdict was WORSE).
- Verdict: WORSE on the fewer-notes guard at every rate. Every note that flips is a short note
  (0.08–0.34 s, mostly a stop coda: "aʊt", "lʊk", "ɹis", "mʌst") that the synth voices 0–12 % of
  its length, so one stray voiced frame decides whether it is measured. Notes were also gained
  ("dɑk" en015a, "ɪt" en045a, "noʊt" en011a): the flips go both ways, as noise. The vibrato
  oscillator runs through these notes even where the gesture gives them no depth, so its phase
  is enough to move a frame. I stopped at three rates rather than search for a rate that happens
  to pass the guard.
- Next: fix lead 5 first. These barely voiced short notes have now blocked or limited three
  experiments (1, 3, 5). Once they voice reliably, retry 6 Hz: it is worth about −0.04.


### 6. A phrase holds its last note to the end; the breath comes from the rest (reverted)

- Hypothesis: lead 5's barely voiced notes are mostly phrase-final. Of the 368 notes the synth
  voices under 30 % of their steady part while she voices them over 70 %, 315 end a phrase.
  `plan_song` ends a phrase's last vowel and its coda `min(0.12, 0.3·note)` before the note's end
  "to leave a breath before the next phrase". But both callers (`compare csd` and `render notes`)
  split phrases at rests and call `plan_song` once per phrase, so the breath has the rest after
  the note. A 0.12 s "aʊt" gave its vowel and /t/ 0.08 s, and the steady window (30–80 % of the
  note) caught the /t/. A singer holds the note to its notated end and puts the coda on the
  release. Holding the last phrase of a `plan_song` call to the note's end should raise voiced
  share and lower aperiodicity, and leave a mid-call phrase end (no rest) as it was.
- Change: `plan_song` in `crates/chimera/src/phonetics/sing.rs`: the reserve stays
  `min(0.12, 0.3·note)` for a phrase that runs straight into another in the same call, and
  becomes `min(r, 0.3·note)` for the call's last phrase. Tried, against experiment 3:
  - r = 0: 0.939 (+0.050); WORSE. Voiced share cost 0.26 → 0.00, aperiodicity 0.90 → 0.00, but the
    voice decays for about 50 ms after the plan ends (the breath's 50 ms ramp-out; the folds part
    45 ms after a sonorant), so it runs past the note into the next phrase's onset search, which
    starts 30 ms after the previous note. Vowel-initial onset −0.015 → −0.040 s (cost 1.39 → 3.44),
    voiceless-initial cost 1.11 → 1.40, level 0–0.5 kHz 1.14 → 1.44.
  - r = 0.05 (the breath's release, so the sound stops at the note's end): 0.747 (−0.142 like for
    like); WORSE, en036a and en044a lose one voiceless-initial onset each.
  - r = 0.04: 0.733 (−0.156); WORSE, the same two onsets and one H1−H2 and pitch note in en048a.
  - r = 0.06: 0.762 (−0.127); WORSE, the en044a onset.
- Singer at r = 0.05: training 0.889 → 0.747, held-out 1.018 → 0.98 (from the held-out costs).
  Voiced share cost 0.26 → 0.04 (synth 0.876 → 0.896, hers 0.927), aperiodicity 0.90 → 0.03,
  H1−H2 2.14 → 2.29, level 0–0.5 kHz 1.14 → 1.28, onsets 1.39 → 1.47 and 1.11 → 1.14. Note MCD
  8.573 → 8.537 dB, envelope correlation 0.797 → 0.810. Nothing else moved by more than 0.05.
- Speech: not measured (the singer verdict was WORSE). Speech doesn't use `plan_song`.
- Verdict: WORSE on the fewer-notes guard at every value. The lost onsets are two phrase-initial
  notes the synth never voices, before or after (en044a no. 145 "pæ", en036a no. 71 "ki"). Their
  onset was a stray voiced frame 80–100 ms before the note, which the change removed. The
  rules' answer is revert; the gain is real but waits on those notes.
- Next: fix the vowel that never phonates after a phrase-initial voiceless stop (lead 5's second
  note: aspiration, then 50 ms at −55 dB where the vowel should be). Then retry this change at
  r = 0.05: it is worth about −0.14, the largest single gain so far. H1−H2 and the low band rose
  a little with it, as more of the short notes' vowels are now measured.

### Judge change after experiment 6: like for like, note by note

Experiments 1, 3, 5 and 6 were blocked or held back by the per-song coverage guard. It flipped
on notes the synth barely voices (0–12 %), where one stray voiced frame decides whether a note
has an onset, H1−H2 or pitch reading. Per-note voicing has no gap to put a threshold in.

The verdict now recomputes each song's value of each term for both runs, over the notes on
which both runs give it. `score.json` keeps every note for this. A note that stops or starts
being measured leaves both runs alike. Not voicing a note still costs, through the voiced share.
The coverage counts are gone, and the score itself is unchanged: 0.889 at the current best,
and a rerun is NO CLEAR CHANGE.

Checked on experiment 5's change (vibrato 5.5 → 6.0 Hz): BETTER, −0.043 like for like. It
was not kept: that is for an experiment to do. Experiments 5 and 6 are worth retrying as they
were.

### 7. Experiment 6 again under the like-for-like judge: the last note held to the end (reverted)

- Hypothesis: as in experiment 6. `plan_song` ends a phrase's last vowel and coda
  `min(0.12, 0.3·note)` before the note's end to leave a breath, but the call's last phrase is
  followed by a rest (both callers split phrases at rests), so the breath comes from the rest. The
  steady window of short phrase-final notes caught the coda instead of the vowel. Holding the
  call's last note to 50 ms before its end (the breath's release) should raise voiced share and
  lower aperiodicity. Experiment 6 measured this at −0.142 and failed only the coverage guard,
  which the judge change after it removed.
- Change: `plan_song` in `crates/chimera/src/phonetics/sing.rs`: the reserve is
  `min(0.12, 0.3·note)` for a phrase that runs straight into another in the same call, and
  `min(0.05, 0.3·note)` for the call's last phrase. One value, the one experiment 6 settled on.
- Singer: training score 0.889 → 0.747 (−0.145 like for like, BETTER), held-out 1.018 → 0.983.
  - Voiced share cost 0.26 → 0.04 (synth 0.876 → 0.896, hers 0.927).
  - Aperiodicity 0.90 → 0.03.
  - H1−H2 2.14 → 2.29 and level 0–0.5 kHz 1.14 → 1.28: more of the short notes' vowels are now
    measured, and they have the pitch-dependent H1−H2 of lead 1.
  - Vowel-initial onset 1.39 → 1.47; voiceless-initial 1.11 → 1.14.
  - Note MCD 8.573 → 8.537 dB, envelope correlation 0.797 → 0.810. Nothing else moved by more than
    0.05.
- Speech: word error rate 39.4 → 39.4 % (OK; speech doesn't use `plan_song`).
- Speed: `os=2` 18.2 % → 18.4 %.
- Tests: `bun test tests` passes (18). After blessing twice, `cargo test --workspace` fails one
  test: `songs_match_typescript` (`golden_planning.rs`), "Made of air (male)" gestures[138].t1
  11.6066 vs 11.6766. That is the last note's vowel ending 70 ms later (0.12 → 0.05 s), the change
  itself. The baseline passes it. The test compares `plan_song` against TypeScript-era plans in
  `tests/golden/planning.json`, and `CHIMERA_BLESS` doesn't regenerate them (the TypeScript engine
  is gone), so it isn't a blessed fixture. The rules' only exception is the airway checks in
  `golden_analysis`.
- Verdict: reverted on a failing test, as the rules require, though every judge passed. Editing or
  re-baselining the test to let the change through is not this experiment's to do.
- Next: the owner should decide whether the song plans in `planning.json` may be re-blessed after
  an intended planner change (as the sound fixtures are), or add a rules exception for
  `songs_match_typescript` like the airway one. Then keep this change as it is: it is worth −0.145
  and takes voiced share and aperiodicity to about 0. Until then no `plan_song` change can be kept,
  so the next run should pick a lead outside `plan_song`: the vibrato rate (lead 4, about −0.04,
  in the source), or F1 bandwidth for H1−H2 (lead 1).

### Decision after experiment 7: the planners' snapshots are blessed too

`golden_planning` compared the planners against TypeScript-era plans in `planning.json`. Blessing
didn't regenerate those, so no change to `plan_song` (or any planner) could pass the tests.
Like the audio fixtures, these are snapshots of a retired engine. `CHIMERA_BLESS=1` now
rewrites the utterance, duration, phrase, song and live-note plans in `planning.json`, keeping
its inputs. Blessing an unchanged planner rewrites the same values (worst difference 2e-16).
The beat sequencer's expectations stay fixed.

Experiment 7's change (a phrase's last note held to 0.05 s before its end, −0.145 like for
like, speech and bench OK) can now be retried as it was.

### 8. Experiment 7 again, now that the planners' snapshots bless: the last note held to the end (kept)

- Hypothesis: as in experiments 6 and 7. `plan_song` ends a phrase's last vowel and coda
  `min(0.12, 0.3·note)` before the note's end to leave a breath, but the call's last phrase is
  followed by a rest (both callers split phrases at rests), so the breath comes from the rest. On
  short phrase-final notes the steady window caught the coda, not the vowel. Holding the call's
  last note to 50 ms before its end (the breath's release) should raise voiced share and lower
  aperiodicity. Experiment 7 was BETTER on every judge and reverted only on
  `songs_match_typescript`, which the decision after it turned into a blessed snapshot.
- Change: `plan_song` in `crates/chimera/src/phonetics/sing.rs`: the reserve is
  `min(0.05, 0.3·note)` for the call's last phrase and stays `min(0.12, 0.3·note)` for a phrase
  that runs straight into another in the same call. One value, experiment 7's.
- Singer: training score 0.889 → 0.747 (−0.145 like for like, BETTER), held-out 1.018 → 0.983.
  The same numbers as experiment 7:
  - Voiced share cost 0.26 → 0.04 (synth 0.876 → 0.896, hers 0.927); aperiodicity 0.90 → 0.03.
  - H1−H2 2.14 → 2.29 and level 0–0.5 kHz 1.14 → 1.28: more short notes' vowels are measured, with
    lead 1's pitch-dependent H1−H2.
  - Vowel-initial onset 1.39 → 1.47; voiceless-initial 1.11 → 1.14.
  - Note MCD 8.573 → 8.537 dB, envelope correlation 0.797 → 0.810. Nothing else moved by more than
    0.05.
- Speech: word error rate 39.4 → 39.4 % (OK; speech doesn't use `plan_song`).
- Speed: `os=2` 18.2 % → 18.4 %.
- Tests: after blessing twice (the first run fails `engine.rs` on the beatbox fixture, as
  expected), `cargo test --workspace` passes, `golden_planning` and `golden_analysis` included, and
  `bun test tests` passes (18).
- Commit: 31643bb.
- Next: the largest costs are now H1−H2 (2.29), the onsets (1.47 and 1.14) and level 0–0.5 kHz
  (1.28). The cheapest next gain is experiment 5's vibrato rate (5.5 → 6.0 Hz, about −0.04, lead
  4), which the like-for-like judge already called BETTER. For H1−H2, try a wider F1 bandwidth or
  F1 that follows pitch (lead 1).

### 9. Experiment 5 again under the like-for-like judge: a trained singer's vibrato rate, 6 Hz (kept)

- Hypothesis: as in experiment 5. Every vibrato ran at 5.5 Hz (measured 5.50), and hers runs at
  6.1. Trained singers' vibrato is 5.5–6.5 Hz, about 6 Hz on average (Prame 1994, Sundberg).
  Raising the source's default rate should close the vibrato-rate gap (cost 0.64) and leave the
  rest alone. Experiment 5 measured −0.044 and failed only the coverage guard, which the judge
  change after experiment 6 replaced; that judge already called it BETTER.
- Change: the default `vibrato_rate` 5.5 → 6.0 Hz in `DEFAULT_SOURCE`
  (`crates/chimera/src/voice/human_voice.rs`) and in the glottis default
  (`crates/chimera/src/sources/glottis.rs`). One value, experiment 5's first.
- Singer: training score 0.747 → 0.714 (−0.034 like for like, BETTER), held-out 0.983 → 0.978.
  - Vibrato rate cost 0.64 → 0.00 (synth 5.50 → 5.98 Hz, hers 6.08); held-out 0.09 → 0.00.
  - Vibrato share 0.59 → 0.65 and depth 0.04 → 0.02: the detector reads a few notes differently
    at the new rate.
  - Aperiodicity 0.03 → 0.06, voiceless-initial onset 1.14 → 1.08, vowel-initial 1.47 → 1.49,
    H1−H2 2.29 → 2.27. Note MCD 8.537 → 8.535 dB, envelope correlation 0.810 → 0.810, pitch error
    4.81 → 4.86 cents. Nothing else moved by more than 0.01.
- Speech: word error rate 39.4 → 39.4 % (OK; speech has no vibrato).
- Speed: `os=2` 18.4 % → 19.4 %, then 18.4 % on the rerun.
- Tests: after blessing twice (the first run fails `engine.rs`, as expected), `cargo test
  --workspace` passes, `golden_analysis` and `golden_planning` included, and `bun test tests`
  passes (18). The blessed `planning.json` changed too (the live-note plans carry the rate).
- Commit: ec79db0.
- Next: the vibrato group's last cost is the share (0.65): the synth vibratos every long note,
  she about two thirds. The largest costs are still H1−H2 (2.27), the onsets (1.49 and 1.08) and
  level 0–0.5 kHz (1.28). For H1−H2, try a wider F1 bandwidth or F1 that follows pitch (lead 1);
  for the onsets, time the breath ramp to the first segment (lead 3).

### 10. A sung phrase's breath reaches full drive at its first segment (kept)

- Hypothesis: every phrase's breath gesture ramped up over the 40 ms ending 20 ms before its first
  segment, so the lung pressure crossed the phonation threshold early and a sung phrase voiced
  ahead of its note: 16 ms early before a vowel (hers 5 ms late) and 20 ms early before a voiceless
  onset (hers 18 ms late). A sung onset is planned (`plan_song` puts the first vowel on the beat),
  so a singer times the breath to it: the pressure builds into the adducted folds, or behind the
  first constriction, as the first segment starts. The two onset terms should move later and
  nothing else should move much.
- Change: `plan_utterance` in `crates/chimera/src/phonetics/planner.rs`: for a sung phrase
  (`sung`, set only by `plan_song`), the breath gesture reaches full drive at the first segment
  (`BREATH_SUNG_AT` = 0.06 s after the plan start, which is where the first segment starts)
  instead of 0.04 s. Speech and live notes keep the old lead, so speech is untouched and live
  notes get no added latency. Tried, against experiment 9:
  - 0.05: 0.661 (−0.048 like for like); BETTER. Onsets −0.005 / +0.020 s, costs 1.18 / 0.77.
  - 0.06: 0.623 (−0.085); BETTER. Kept: the breath peaks just as the first segment starts.
  - 0.07: 0.647 (−0.063); BETTER. Onsets +0.015 / +0.006 s, costs 1.10 / 0.68.
- Singer: training score 0.714 → 0.623 (−0.085 like for like, BETTER), held-out 0.978 → 0.791.
  - Onset, vowel-initial cost 1.49 → 0.97 (synth median −0.016 → +0.004 s, hers +0.005); held-out
    1.16 → 0.00.
  - Onset, voiceless-initial 1.08 → 0.52 (−0.020 → +0.037 s, hers +0.018); held-out 1.14 → 0.05.
  - Envelope correlation 0.810 → 0.814, note MCD 8.535 → 8.535 dB, pitch error 4.86 → 4.85 cents.
    No other term moved by more than 0.01.
- Speech: word error rate 39.4 → 39.4 % (OK; speech isn't `sung`).
- Speed: the bench doesn't run the planner, so its render path is unchanged. The machine was
  loaded (load average 30 on 16 cores, from other sessions): `os=2` read 34.0 % and 33.6 %, and the
  previous commit read 33.1 % against this one's 33.2 % in back-to-back runs. `out/hill/best/bench.txt`
  keeps the last quiet-machine figure (19.4 %).
- Tests: after blessing twice (the first run fails `engine.rs`, as expected), `cargo test
  --workspace` passes, `golden_planning` and `golden_analysis` included, and `bun test tests`
  passes (18).
- Commit: 3747f99.
- Next: the largest cost by far is H1−H2 (2.27, a sixth of the score on its own), then level
  0–0.5 kHz (1.28), the onsets' remaining mean gap (0.97 and 0.52) and the vibrato share (0.65).
  For H1−H2, try a wider F1 bandwidth or F1 that follows pitch (lead 1). For the onsets, look at the
  phrases still far off rather than the medians, which are now about right.

### Batch review (Codex), and what changed after it

The review found no engine defect and called all six changes plausible. Three things changed:

- **Speech and speed are judged against the batch's baseline** (`out/hill/baseline/`), not
  the best run. With a 3-point or 10 % allowance per step measured against the best run,
  small losses could add up over a batch: 38 → 41 → 44 → 47 % would pass every step.
- **Fixtures are written atomically** (a temporary file, then a rename). While one planning
  test blessed `planning.json`, another could start and read half of it.
- **The pressed end of the tension control is back.** Experiment 2's `0.4·tension` capped the
  closure at 0.4 even at full "Pressed", where it had been 0.95. That is a sound no judge
  measures, since everything is rendered at tension 0.5–0.55. Above 0.6 the closure now
  sharpens again, to 0.95 at full tension. Every judged render is byte-identical, so no score
  moves. A test (`tests/voice_source.rs`) keeps the closure rising with tension all the way.


### Listening result (2026-11-07): the pilot's answer is yes

Blind A/B, singer first, every clip at the same loudness (5 song excerpts, 4 sentences):
**now 7, before 0, can't tell 2** (en006a and harvard-male-07). Every held-out excerpt went to
"now". So the score's direction matches the user's ears.

What they heard, in their words, and what the renders show:

- **"Mostly a brightness change; the darker one sounds better as a default."** "Now" is the darker
  one. Its spectral centroid is about 150 Hz lower in every song clip (White Christmas
  1110 → 943 Hz; hers is 807), and 2–8 kHz is 3–8 dB down. The user wants a control for it.
- **The gains feel incremental.** The user is more interested in pronunciation, which the singer
  score doesn't measure.
- **"Sheet" heard as "feet".** In a fresh render of "sheet" the /ʃ/ is 23 dB below its vowel, the
  same as /f/ in "feet". Whisper hears "feet" in both voices too, and "fire" for "sharp"
  (female). Every word with ch or j fails in Whisper as well: juice → "roost", chair →
  "coloring", chain → "pin", birch → "bird", chopped → "hopped", chicken dropped.
- **J sounds very muted.** The /dʒ/ of "juice" is about 25 dB below its vowel, and mostly
  low-frequency voicing.
- **A huge pop on the p of "sharp".** The /p/ release peaks 7 dB above the loudest point of the
  vowel, and its energy is all below 4 kHz: a pressure thump, not a burst.
- **A tinny noise at syllable ends (after "truck").** It is a 750 Hz buzz, with lines at exact
  multiples of 750 Hz about 25 Hz wide. 750 Hz is the control rate: 48 kHz ÷ 64, one update
  every 64 samples. The /k/ release of "truck" is mostly this buzz, and it is in the decay after
  every word checked (sheet, feet, juice, pushes). Steady fricatives are clean noise.
- **"Pu" of "pushes" inaudible.** The stressed /ʊ/ lasts about 40 ms; the unstressed "-es"
  gets about 100 ms. The text front end marks the stress correctly (pˈʊʃəz).

Whisper agrees with the user on the word errors (sheet → feet, and the j and ch words), which
supports using it as the pronunciation judge. It disagrees on one: it heard "pushes" correctly in
the female voice after the batch (before it heard "puffs"). It can't judge the pop or the buzz,
since neither changes the words, so those need checks of their own.

## Batch 2: pronunciation (from 2026-11-07)

Batch 1 is merged (PR #16). The owner's listening (above) asked for pronunciation, so batch 2's
judge is Whisper. See the README's "current batch" section for the rules.

### Before the batch: the fixes and the Bright control (PR #19, not a hill-climb step)

- **The tinny ring: fixed.** It was a 750 Hz buzz from the lung pressure stepping once per
  control block. It now ramps across the block. Block-periodic share of a word's tail ~20 % →
  under 1 %.
- **The pop on "sharp": not fixed.** The tongue squeezes the air between the closed lips and its
  /t/ seal to 11x the lungs' pressure (88 cmH2O). The /p/ releases at +7 dB re the sentence's
  loudest vowel (male). Absorbing a sealed pocket's wall motion halved it but broke the engine's
  adiabatic-compression test and the creatures' parity; reverted. The ignored test
  `the_p_of_sharp_does_not_pop` in `tests/consonant_artifacts.rs` measures it.
- **Bright control** (`VoiceSource.brightness`, default 0.25 = the current sound).
- Against batch 1's best: singer 0.623 → 0.582 (BETTER, onsets), held-out 0.791 → 0.789; speech
  39.4 → 40.7 %; speed 18.2 % of one core.

### The judge for batch 2

- `tools/asr/sentences.tsv` gained 20 held-out sentences (set column "held"): Harvard list 2, and
  ten unpredictable sentences dense in sh, ch and j. They never decide.
- `speech_wer.py --against` now says BETTER (training word error rate down by at least 1.5
  points), WORSE (up by more than 3) or NO CLEAR CHANGE, and reports the held-out rate.
- The old batch-1 directories are kept as `out/hill/batch1-baseline` and `out/hill/batch1-best`.

### Batch 2 baseline (commit 4980e3b, `out/hill/baseline`)

- Speech, training: **40.73 %** (harvard female 37.5, male 37.5; nonsense female 42.25, male
  46.48). Held-out: **50.67 %** (harvard female 35.44, male 39.24; nonsense female 70.42, male
  60.56).
- Singer: training 0.582, held-out 0.789.
- Speed: 18.2 % of one core (`os=2`).
- The /p/ of "sharp": +7.0 dB re the loudest vowel, oral pressure 11.1x the lungs' (male).

### 11. The space in front of the raised tongue tip is narrow: /ʃ/'s front cavity (reverted)

- Hypothesis: the /ʃ/ of "sheet" peaked at 2.06 kHz (female) and 1.73 kHz (male), against
  2.5–3.5 kHz in real speech, and Whisper heard "feet". A probe of the noise sources showed the
  teeth (obstacle) source makes the /ʃ/: with it off the fricative falls 10 dB, while the
  aspiration source changes nothing. The peak is the resonance of the front cavity between the
  postalveolar constriction and the lips, which it excites. In the area function that cavity
  holds a chamber of 4.7–5.5 cm² over about 1 cm (male, ~10 cm³ in all). It is the space under the
  alveolar ridge and below the raised tip, down to the floor of the mouth (midsagittal depth
  ≈ 1.7 cm). Those rays took the oral law, 2.6·d^1.4, which describes the mid-oral cavity
  between the molars. In front of the tip the airway lies inside the anterior dental arch and the
  sublingual space, far narrower. Lips and jaw were checked first and are not the cause:
  - lip width 0.2 → 0.6: peak +100–200 Hz
  - lip protrusion 0.75 → 0.4: +240 Hz
  - jaw 0.35 → 0.1: nothing
  - tongue tip forward (ttX 5.7 → 6.05): about +100–200 Hz
- Change: `crates/chimera/src/anatomy/human.rs`: a fourth area law, `AreaLaw.ahead`, for the oral
  rays whose midpoint lies in front of the tongue tip, faded in by
  `smoothstep(0, 0.4·k, mid.x − tip.x)`. Vowel and consonant tables regenerated with `chimera
  calibrate`: the vowels' formants moved up to 4–5 % (the open vowels' F1 down, /ɝ/ F2 up).
  After recalibration the mean F1 error is 1.33 → 1.59 % (male) and 2.01 → 2.53 % (female); F2
  and F3 are about the same. Values tried (/ʃ/ of "sheet", peak female / male):
  - α = 2.0 (the dental arch's front law), no recalibration: 2.16 / 1.78 kHz. Too little.
  - α = 1.2, with an uncalibrated sensitivity check of α = 0.7 (3.0 / 2.5 kHz):
    - "Sheet": 2.81 / 2.06 kHz, 1–2 kHz band −5 → −18 dB (female).
    - Speech NO CLEAR CHANGE: 40.73 → 39.40 %. Harvard male 37.5 → 27.5, Harvard female
      37.5 → 46.25.
    - Singer WORSE: 0.582 → 0.590, note MCD 8.536 → 8.648 dB, over its 0.1 dB guard.
  - α = 1.6: "sheet" 2.34 / 1.92 kHz. The numbers below are for this value.
  - /s/ and /f/ barely move at any value: "seat" 4.0–4.1 kHz, "feet" 4.3–4.5 kHz (female).
- Speech: word error rate 40.73 → 35.76 % (training, **BETTER**), 50.67 → 45.33 % (held-out).
  - Moved right: "chicken leg" (male, 5 → 1 errors), "juice" (male), "sharp" and "the thin road"
    (female), "soft hill" (female), "some bright doors" (male).
  - "Sheet" is now heard in the male voice ("screw the sheet": the error moved to "glue"). The
    female still hears "feet": her /ʃ/ is still 21–22 dB below the vowel, as quiet as her /f/.
  - Chair, chain, birch and chopped still fail.
- Singer: training 0.582 → 0.584 (NO CLEAR CHANGE, every guard holds; note MCD 8.536 → 8.628
  dB), held-out 0.789 → 0.810. Level 0–0.5 kHz cost 1.22.
- Speed: `os=2`, back to back with the baseline commit: 18.2 / 19.1 % (baseline) against
  18.4 / 19.7 % (change), so 1–3 %. A first run read 22.2 %, while other sessions loaded the
  machine (load average 13).
- Tests (fixtures blessed twice, then `cargo test --workspace`):
  - `golden_analysis` fails at its first "human |H|" check: the README's airway exception. Its
    later checks (tube networks, FFT, LPC, YIN, Nelder–Mead) don't touch the human tract.
  - `golden_geometry` (the TypeScript-era area function) fails: it has to move with any
    deliberate geometry change. It is the same kind of check as the airway one; the batch PR
    would regenerate it.
  - `golden_planning`'s beat sequencer checks fail by 1e-3 in tongue targets, which come from the
    regenerated vowel table.
  - **`geometry_continuity::no_area_jumps_anywhere_in_the_articulators_speech_ranges` fails:**
    "child ə velum=1.117: 0.32 cm²". The new law doesn't cause it:
    - new law, old tables: passes.
    - old law (α = 2.6), new tables: fails the same way.
    - The recalibrated child /ə/ posture lands on a jump that was already in the geometry. It is
      at the top of the pharynx (the velopharyngeal rays), with the velum raised to about 1.117
      (posture jaw 0.80, tbX 2.70, tbY 7.38, root −0.50).
  - `bun test` was not run.
- Verdict: reverted. The speech is BETTER, the singer guards hold and the speed is fine, but a
  non-fixture test fails, so the rules revert it. This is the same position as experiment 7.
- Commit: none (log only). The patch: in `AreaLaw` add `pub ahead: (f64, f64)`, default
  `(1.6, 1.4)`. In the region-2 branch of the area loop, replace `a_o·d^b_o` with
  `lerp(a_o·d^b_o, a_h·d^b_h, smoothstep(0, 0.4·k, g.mid.x − tip.x))`. Then run `chimera calibrate
  vowels all` and `chimera calibrate consonants`.
- Next:
  - Fix the velopharyngeal jump that `geometry_continuity` finds for the recalibrated child /ə/
    (velum ≈ 1.117) as its own step, then retry this change as it was.
  - Retry α = 1.2 too: it moved /ʃ/ further (2.8 kHz female), and its speech result (−1.33)
    was within Whisper's run-to-run noise of α = 1.6's.
  - After that, the /ʃ/'s level: the female /ʃ/ is 21 dB below its vowel and the male 11 dB.
    The teeth source's gain, or how its weight depends on the distance behind the teeth (2.5 cm
    for /ʃ/, just short of where `w_dist` starts to fade, at 2.6), is the place to look.
