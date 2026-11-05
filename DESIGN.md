# CHIMERA — a physical-modeling voice synthesizer for many creatures

## Brief (from the user)

"Create the ultimate vocal synthesizer. Web app for now. Be extremely ambitious.
Sophisticated throat, lips, tongue modeling. Different animals: human, bird,
reptile, etc. Tonal and percussive (beatboxing). Beautiful visuals/diagrams,
dynamic animations based on params." Long build is expected.

## Product shape

A browser instrument where every sound comes from a simulated airway, not samples.

* **Creatures**: human (bass/tenor/alto/soprano/child), songbird (two-voice syrinx),
  parrot (talking bird), owl, crow, cat (meow, purr), dog/wolf (bark, howl), lion (roar),
  elephant (trunk trumpet, rumble), cow, frog (vocal sac), crocodile (bellow, hiss),
  snake (hiss), gecko (chirp), dragon (fantasy). Morph between anatomies.
* **Modes**:
  * *Play* — drag the tongue/lips/jaw in a live anatomy view; XY vowel pad; on-screen and
    computer keyboard; Web MIDI; phoneme pads (tap /t/ over a held vowel).
  * *Speak* — English text (CMUdict + letter-to-sound fallback) or raw IPA → phonemes →
    prosody → gestural score → speech. Timeline shows the gestural score.
  * *Sing* — piano roll with lyrics per note; onset consonants placed before the beat.
  * *Beatbox* — pads + 16-step sequencer; every drum is an articulatory gesture
    (bilabial ejective kick, "pf" snare, alveolar hat, inward K-snare, lip roll, click roll,
    throat bass). "One mouth" (physically honest, one tract) or "crew" (one tract per track).
  * *IPA chart* — click any symbol on the full IPA chart (incl. ejectives, implosives,
    clicks, trills) to hear/see it.
  * *Creature lab* — anatomy parameters, morphing, call presets.
* **Visuals (first-class)**: everything animates from live engine state at 60 fps.
  * Midsagittal cutaway of the current creature: tongue, jaw, lips, velum, larynx,
    epiglottis; acoustic pressure rendered as a colour field inside the airway;
    airflow particles whose speed follows simulated volume velocity; turbulence
    shown at constrictions where the Reynolds number exceeds threshold.
  * Laryngoscope "stroboscope" (top view of vocal folds / syrinx labia) replayed
    slowed down from the real simulated glottal area waveform.
  * Area-function tube diagram (cylinders with pressure), glottal flow scope,
    transfer function with formant markers, F1–F2 vowel chart with the live point,
    scrolling spectrogram, gestural-score timeline with playhead.

## Architecture

```
main thread (React UI, canvas renderers)
   │ commands (note/score/param/drag), timestamped in audio time
   ▼
AudioWorklet  ──  Engine (Rust crate `chimera`, compiled to wasm; the same code runs natively
                  for tests, the `chimera` CLI and, later, JDAW — see docs/rust-engine.md)
                   ├─ Voice[] (pool)
                   │   ├─ Controller: gesture scheduler → articulator dynamics (control rate)
                   │   ├─ Anatomy: articulator state → geometry → area functions (control rate)
                   │   ├─ Sources: glottis (parametric area / two-mass), syrinx, valves (trills)
                   │   └─ Airway: branched FDTD tube network (internal rate = 2–4× output)
                   └─ FX: mic/proximity, EQ, compressor, saturation, reverb, limiter
   │ telemetry ~60 Hz (articulators, areas, pressures, flows, glottal trace, formants)
   ▼
main thread renderers
```

Control rate: every 64–128 output samples, with per-sample linear interpolation of areas.

### 1. Airway acoustics — branched staggered-grid FDTD transmission line

Chosen over Kelly-Lochbaum because it handles, in one framework: variable section
lengths (larynx height, lip protrusion, creature size), DC aerodynamics (pressure
build-up behind closures, bursts), nonlinear kinetic losses at constrictions, yielding
walls, moving-wall volume sources (needed for clicks, ejectives, implosives), arbitrary
branching (nasal tract, sinuses, piriform fossae, two bronchi, vocal sacs, OEC).

* Units CGS. ρ = 1.14e-3 g/cm³, c = 35 000 cm/s, μ = 1.86e-4 P.
* Generic graph: pressure nodes (volume V = AΔ) and flow branches between nodes.
  Branch inertance L = ρ(Δa/2Aa + Δb/2Ab) (series half-sections, so a tiny node is
  bracketed by large inertances → stable at CFL ≤ 1 regardless of area ratio).
* Leapfrog: branches update U(n+½) from p(n); nodes update p(n+1) from U(n+½).
  Branch update is implicit in U for losses: viscous R, plus Borda–Carnot expansion
  loss a·|U|U with a = ρk/2·(1/As − 1/Al)² chosen by flow direction; solved as an
  exact quadratic per sample (avoids the period-2 instability of lagged |U|).
* Continuity: (V/ρc²) dp/dt = ΣU_in − ΣU_out − U_wall − dV/dt (moving walls).
* Walls: per-node mass–spring–damper (m≈1.5 g/cm², r≈1600, k≈3e5 CGS, ×perimeter·Δ).
  Wall flow also radiates weakly (voice bar during voiced closures).
* Radiation: Flanagan parallel R–L load at lips/nostrils/beak; output = d/dt of radiated
  volume velocity (sum of mouth, nostrils, skin).
* Turbulence: per branch Reynolds number Re = |U|·d_h/(A·ν); dipole pressure source
  g·(Re² − Re_c²)·noise injected ~1 cm downstream of the constriction exit (flow-direction
  aware), plus an obstacle source at the lower incisors when a jet reaches them (sibilants).
  Aspiration is the same mechanism at the glottis.
* Closure: branch area < ε ⇒ U = 0 (no leakage); node volumes floored for compliance.
* Internal rate 96 kHz (adult human), 192 kHz (small birds/cats), 48 kHz allowed for
  huge tracts; N chosen per anatomy so Δ ≥ c·T/0.95. Polyphase half-band decimation to
  the output rate.
* Cross-check: a frequency-domain chain-matrix model with the same loss terms computes
  H(f) for analysis, UI formant display, and as a test oracle for the FDTD.

### 2. Sources

* **Parametric glottis (default, exact pitch)**: glottal *area* pulse (opening/closing
  phases, open quotient, skew, max area, rest/abduction area, posterior chink) drives the
  interactive glottal branch, so flow shape, skewing, F1 ripple and devoicing under
  oral closure all emerge from the tract. Perturbations: jitter, shimmer, vibrato with
  drift, 1/f flutter, diplophonia/period doubling, vocal fry (low f0, short OQ, double
  pulses), falsetto (sinusoidal, incomplete closure).
* **Two-mass vocal folds (advanced)**: Ishizaka–Flanagan with collision; self-oscillating;
  pitch tracked by a feedback controller on the tension factor Q.
* **Ventricular folds**: second valve above the glottis, entrains at f0/2 for growl /
  kargyraa; static narrowing for harshness. **Epilarynx** narrowing for twang/ring.
* **Syrinx (birds)**: two independent labial oscillators (Gardner–Mindlin normal form
  ẋ=y, ẏ=−αγ²−βγ²x−γ²x³−γx²y+γ²x²−γxy). γ is a pure time scale, so pitch is exact:
  γ = 2π f0 / F(α,β) with F tabulated offline; α (air-sac pressure) and β (tension)
  shape the waveform (pure tone → pulses → period doubling/chaos). Each labium gates its
  own bronchus; bronchi merge into the trachea → OEC (Helmholtz, volume tracks f0 for
  pure tones) → beak (gape-dependent radiation).
* **Flow-induced valves**: one mass–spring valve model driven by constriction pressure
  (Bernoulli suction / upstream push) for lip trill, tongue-tip trill, uvular trill,
  lip buzz (beatbox bass, elephant trumpet as a lip-reed at the trunk base). Optional
  phase-locked drive if self-oscillation is not robust.
* **Airstream mechanisms**: lung pressure may be negative (ingressive); glottal closure +
  larynx raising/lowering (ejectives/implosives via dV/dt); velaric closure + tongue
  dorsum lowering (clicks). All physical through the FDTD — no special-cased samples.

### 3. Anatomy & articulation (human first, others as parametric variants)

* 2D midsagittal geometry (cm, head frame): fixed outer wall (posterior pharynx, velum,
  hard palate, alveolar ridge, upper incisors, upper lip) and moving inner wall
  (epiglottis/larynx, tongue root, tongue body circle, blade, tip, lower incisors,
  lower lip, jaw).
* Articulators (state, all absolute head-frame so consonant constrictions are exact):
  jaw, tongue body centre (x,y), tongue tip (x,y), tip curl (retroflex), central groove,
  lateral channel, tongue root, lip aperture (negative = compression), lip protrusion,
  lip width/rounding, labiodental, velum port area, larynx height, epilarynx, glottal
  abduction / closure, lung pressure, f0, effort, ventricular, trill drives, dorsum
  lowering (clicks).
* Area function: semipolar grid (horizontal lines in pharynx, radial in oral cavity,
  vertical at lips) intersected with inner/outer contours → midsagittal distance d →
  A = α·d^β per region; tongue grooving/laterals modify A; lengths from midpoint chain.
  Resampled to N uniform sections of current length L(t).
* Calibration: optimise vowel targets against reference formants (Hillenbrand 1995 male
  means, plus cardinal vowels for non-English) with the chain-matrix model. Female/child
  via anatomical scaling (shorter pharynx proportion), not formant warping.
* Other mammals/reptiles: same topology, species parameters (snout length, palate
  shape, larynx position/descent, nasal length, lip shape, trunk = long nasal tube,
  vocal sac = Helmholtz side branch). Birds: separate topology (syrinx/trachea/OEC/beak,
  tongue for parrots).

### 4. Control: gestures (Articulatory Phonology–style)

* Phoneme = set of gestures, each controlling a subset of articulators with targets,
  stiffness, blending strength and timing relative to the segment.
* Gestural score: vowel gestures span vowel to vowel (tongue body keeps moving through
  consonants — Öhman coarticulation); consonant gestures overlay their articulators
  with higher strength; uncontrolled articulators relax to neutral.
* Articulator dynamics: critically damped 2nd-order per articulator, physiological
  speeds (lips/tip fast, tongue body/jaw slower, velum/larynx slow).
* Consonant closures use overshoot targets clamped by the geometry (contact), so
  closures are robust; fricatives specify exact gap.
* Text: CMUdict (lazy-loaded, compact) + rule fallback → ARPAbet → IPA; stress;
  syllabification; Klatt-style durations; intonation (declination, H* on stressed
  syllables, final fall / question rise). Singing: notes+lyrics → syllable alignment.

### 5. FX / output

DC blocker → mic model (distance/proximity) → EQ → compressor → saturation → reverb →
limiter. WAV export via the same engine in a Worker (unlimited voices, faster than RT).

## Tech

Engine: Rust (`crates/chimera`), deterministic (libm for all transcendental math), no
allocation while rendering, block-size-independent output; `crates/chimera-wasm` exposes it to
the browser as a C-ABI wasm module with no imports (the worklet and the main thread each
instantiate it; see docs/rust-engine.md for the boundary). UI: TypeScript, Vite, React 19
(controls) + hand-written canvas/SVG renderers (visuals), Zustand state; `src/wasm/` is the
UI's typed facade over the engine. Bun for the UI's tooling and tests.

## Validation

* `cargo test --workspace` (engine): uniform-tube resonances vs analytic; FDTD impulse response vs chain-matrix
  H(f); long random-gesture stability (no NaN/blow-up); f0 accuracy; vowel formants vs
  targets; fricative spectral centroids (s > ʃ > f); stop bursts present; ingressive /
  ejective / click pressure signatures; bird pitch accuracy.
  Golden fixtures from the retired TypeScript engine (crates/chimera/tests/golden) check the
  port; native and wasm builds render bit-identical samples (tests/wasm-engine.test.ts).
* `bun test tests`: the UI's live paths (Sing keys, worklet ordering, MIDI) on the wasm engine.
* Offline renders (`cargo run --release -p chimera-cli -- render speech|text|song|beatbox|creature|vowels …`)
  → WAV; `tools/spectrogram.ts` draws the PNG to inspect. `chimera diagnose` measures speech
  (nasal leakage, formant undershoot, bandwidths, pitch); `chimera calibrate` regenerates the
  vowel/consonant tables.
* Headless Chromium (Playwright) smoke tests: app loads, worklet runs, no console errors,
  screenshots of each mode.
* Hosted over HTTPS via `tailscale serve` (AudioWorklet needs a secure context).

## Phases

0. Scaffold, analysis tools (WAV, FFT, LPC, spectrogram PNG), test harness.
1. Airway FDTD + parametric glottis + chain-matrix oracle.
2. Human articulatory geometry, area function, calibration; nasal; fricatives/stops.
3. Gestures, phoneme inventory (IPA), G2P, prosody → speech.
4. Worklet + core UI (anatomy view with drag, controls, keyboard, vowel pad, speak).
5. Extra sources (syrinx, valves/trills, ventricular, two-mass, purr) + creatures + visuals.
6. Beatbox (airstream mechanisms, sounds, sequencer, mic FX).
7. Singing (piano roll, lyrics, multi-voice, export).
8. Polish: visuals, presets, performance, mobile, onboarding.

## Known risks

* Fricative/burst realism depends on noise-source calibration (gain, placement, spectrum).
* Geometry→area calibration quality decides vowel quality.
* Self-oscillating valves (two-mass, trills) can be finicky → parametric fallbacks.
* CPU in the AudioWorklet (JS) with several voices; quality settings + offline render.
* Scope: large; each phase must leave a working, polished app.
