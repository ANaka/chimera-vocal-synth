/**
 * Parametric vocal-fold source: generates the glottal *area* waveform, which drives the
 * interactive glottal port of the airway network. Flow is computed by the network
 * (Bernoulli + inertance), so pulse skewing, F1 ripple and devoicing under oral closure
 * emerge from the physics.
 *
 * Voicing is gated physiologically:
 *  - transglottal pressure must exceed the phonation threshold (≈2–3 cmH₂O),
 *  - wide abduction (voiceless consonants, /h/) stops vibration.
 */
import { CM_H2O } from "../physics.ts";
import { Rng, Drift, TAU, clamp, smoothstep } from "../util/math.ts";

export interface GlottisParams {
  /** fundamental frequency (Hz) */
  f0: number;
  /** peak vibratory area (cm²) at full effort */
  amplitude: number;
  /** abduction: static opening between the vocal processes (cm²) */
  abduction: number;
  /** posterior chink leakage (cm²), always open */
  chink: number;
  /** open quotient 0..1 */
  openQuotient: number;
  /** fraction of the open phase spent opening (0.5 symmetric, larger = faster closing) */
  skew: number;
  /** 0 = smooth (raised-cosine) closure, 1 = abrupt slope at closure */
  closureSharpness: number;
  /** vocal effort 0..1 (scales amplitude; pressed voice lowers OQ) */
  effort: number;
  /** cycle-to-cycle period perturbation (fraction, e.g. 0.006) */
  jitter: number;
  /** cycle-to-cycle amplitude perturbation (fraction, e.g. 0.04) */
  shimmer: number;
  /** vibrato depth (cents) and rate (Hz) */
  vibratoDepth: number;
  vibratoRate: number;
  /** slow random pitch drift (cents) */
  drift: number;
  /** vocal fry 0..1: low-frequency double-pulsing with short open phase */
  fry: number;
  /** diplophonia / period doubling 0..1 (alternating amplitude & period) */
  diplophonia: number;
  /** extra glottal closure force 0..1 (glottal stop / ejective: holds the folds shut) */
  closure: number;
}

export const DEFAULT_GLOTTIS: GlottisParams = {
  f0: 110,
  amplitude: 0.16,
  abduction: 0.0,
  chink: 0.006,
  openQuotient: 0.62,
  skew: 0.62,
  closureSharpness: 0.6,
  effort: 0.7,
  jitter: 0.004,
  shimmer: 0.03,
  vibratoDepth: 0,
  vibratoRate: 5.5,
  drift: 6,
  fry: 0,
  diplophonia: 0,
  closure: 0,
};

export class ParametricGlottis {
  readonly fs: number;
  params: GlottisParams = { ...DEFAULT_GLOTTIS };
  private phase = 0;
  private cycleAmp = 1;
  private cyclePeriodScale = 1;
  private cycleIndex = 0;
  private vibPhase = 0;
  private readonly rng = new Rng(777);
  private readonly drift: Drift;
  private driftValue = 0;
  private driftCounter = 0;
  private pitchFactor = 1;
  /** smoothed voicing gate 0..1 (telemetry) */
  voicing = 0;
  private voicingSm = 0;
  /** smoothed transglottal pressure (dyn/cm²) */
  private dpSm = 0;
  private readonly dpCoef: number;
  private readonly voiceCoef: number;
  /** last area (telemetry) */
  area = 0;
  /** instantaneous f0 actually used (telemetry) */
  f0Now = 110;
  /** phonation threshold pressure (dyn/cm²) */
  threshold = 2.5 * CM_H2O;
  // per-sample smoothing of control-rate parameters (steps in the glottal area at high airflow
  // radiate as clicks, because the output is the derivative of flow)
  private staticSm = 0;
  private closureSm = 0;
  private ampSm = 0;
  private readonly smCoef: number;

  constructor(fs: number) {
    this.fs = fs;
    this.drift = new Drift(fs / 32, 0.3, 4242);
    this.dpCoef = 1 - Math.exp(-TAU * 30 / fs);
    this.voiceCoef = 1 - Math.exp(-TAU * 25 / fs);
    this.smCoef = 1 - Math.exp(-1 / (0.004 * fs));
  }

  /** Reset phase etc. */
  reset(): void {
    this.phase = 0;
    this.voicingSm = 0;
    this.dpSm = 0;
  }

  /**
   * Advance one sample. `dp` is the instantaneous transglottal pressure (p_sub − p_supra).
   * Returns the glottal area (cm²).
   */
  next(dp: number): number {
    const P = this.params;
    this.dpSm += this.dpCoef * (dp - this.dpSm);

    // drift and vibrato evaluated at a decimated rate (pitch modulation is slow)
    if (--this.driftCounter <= 0) {
      this.driftCounter = 32;
      this.driftValue = this.drift.step();
      this.vibPhase += ((P.vibratoRate * 32) / this.fs) * (1 + 0.04 * this.driftValue);
      if (this.vibPhase > 1) this.vibPhase -= 1;
      const cents = P.vibratoDepth * Math.sin(TAU * this.vibPhase) + P.drift * this.driftValue;
      this.pitchFactor = Math.pow(2, cents / 1200);
    }
    let f0 = P.f0 * this.pitchFactor;
    // fry pulls the rate down toward ~45 Hz
    if (P.fry > 0) f0 = f0 * (1 - P.fry) + Math.min(f0, 48) * P.fry;
    this.f0Now = f0;

    // voicing gate: pressure above threshold, adduction sufficient, not forcibly closed
    const pressureGate = smoothstep(this.threshold * 0.8, this.threshold * 1.6, this.dpSm);
    const adductGate = 1 - smoothstep(0.08, 0.22, this.staticSm - P.chink);
    const target = pressureGate * adductGate * (1 - this.closureSm);
    this.voicingSm += this.voiceCoef * (target - this.voicingSm);
    this.voicing = this.voicingSm;

    // phase advance with per-cycle perturbations
    this.phase += (f0 / this.fs) / this.cyclePeriodScale;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.cycleIndex++;
      const alt = this.cycleIndex & 1 ? 1 : -1;
      this.cyclePeriodScale = 1 + P.jitter * this.rng.gauss() + P.diplophonia * 0.08 * alt;
      this.cyclePeriodScale = clamp(this.cyclePeriodScale, 0.7, 1.4);
      this.cycleAmp = Math.max(0.2, 1 + P.shimmer * this.rng.gauss() - P.diplophonia * 0.35 * (alt > 0 ? 1 : 0));
    }

    // pulse shape within the cycle
    let oq = clamp(P.openQuotient - 0.18 * (P.effort - 0.5), 0.25, 0.98);
    if (P.fry > 0) oq = oq * (1 - P.fry) + 0.28 * P.fry;
    let pulse = this.shape(this.phase, oq, P.skew, P.closureSharpness);
    if (P.fry > 0.3) {
      // second, weaker pulse shortly after the first (double pulsing typical of fry)
      const ph2 = this.phase - 0.38;
      if (ph2 > 0) pulse += 0.55 * smoothstep(0.3, 0.8, P.fry) * this.shape(ph2, oq * 0.8, P.skew, P.closureSharpness);
    }
    const effortScale = 0.45 + 0.75 * P.effort;
    const sc = this.smCoef;
    this.ampSm += sc * (P.amplitude * effortScale - this.ampSm);
    this.closureSm += sc * (P.closure - this.closureSm);
    this.staticSm += sc * (P.abduction + P.chink - this.staticSm);
    const vib = this.ampSm * this.cycleAmp * this.voicingSm * pulse;
    const statics = this.staticSm * (1 - 0.92 * this.closureSm);
    const a = Math.max(0, vib + statics);
    this.area = a;
    return a;
  }

  /** Normalised area pulse (0..1) at cycle phase ph. */
  private shape(ph: number, oq: number, skew: number, sharp: number): number {
    if (ph >= oq) return 0;
    const t = ph / oq;
    const s = clamp(skew, 0.3, 0.9);
    if (t < s) return 0.5 - 0.5 * Math.cos((Math.PI * t) / s);
    const u = (t - s) / (1 - s);
    const soft = 0.5 + 0.5 * Math.cos(Math.PI * u);
    const hard = Math.cos(0.5 * Math.PI * u);
    return soft + (hard - soft) * sharp;
  }

  get cyclePhase(): number {
    return this.phase;
  }
}
