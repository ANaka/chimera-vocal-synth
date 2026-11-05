export const TAU = Math.PI * 2;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-12, g));
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f: number): number => 69 + 12 * Math.log2(Math.max(1e-6, f) / 440);
export const centsToRatio = (c: number): number => Math.pow(2, c / 1200);

/** Fast deterministic PRNG (mulberry32 core with 32-bit state), uniform in [0,1). */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1;
  }
  /** Approximately standard normal (sum of 4 uniforms, scaled). Cheap and bounded. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
}

/** One-pole smoother, time constant in samples. */
export class Smoother {
  value: number;
  private a: number;
  constructor(initial: number, tauSamples: number) {
    this.value = initial;
    this.a = tauSamples > 0 ? Math.exp(-1 / tauSamples) : 0;
  }
  setTau(tauSamples: number): void {
    this.a = tauSamples > 0 ? Math.exp(-1 / tauSamples) : 0;
  }
  step(target: number): number {
    this.value = target + (this.value - target) * this.a;
    return this.value;
  }
}

/**
 * 1/f-ish slow random drift (sum of three filtered noises at octave-spaced rates).
 * step() is called at control rate; returns roughly unit-variance output.
 */
export class Drift {
  private y = [0, 0, 0];
  private readonly a: number[];
  private readonly rng: Rng;
  constructor(controlRate: number, baseHz: number, seed: number) {
    this.rng = new Rng(seed);
    this.a = [baseHz, baseHz * 3, baseHz * 9].map((f) => Math.exp((-TAU * f) / controlRate));
  }
  step(): number {
    let s = 0;
    for (let i = 0; i < 3; i++) {
      const a = this.a[i];
      // normalise so each band has ~unit variance
      this.y[i] = a * this.y[i] + Math.sqrt(1 - a * a) * this.rng.gauss();
      s += this.y[i] / (i + 1);
    }
    return s / 1.4;
  }
}
