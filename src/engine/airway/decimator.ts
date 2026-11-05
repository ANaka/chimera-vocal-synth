/**
 * FIR decimator: Kaiser-windowed sinc low-pass, integer factor M.
 * push() one input sample at a time; when ready, `value` holds the next output sample.
 */
function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

export function designLowpass(taps: number, cutoff: number, beta = 8): Float64Array {
  // cutoff as a fraction of the input sample rate (0..0.5)
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  const i0b = besselI0(beta);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const r = (2 * i) / (taps - 1) - 1;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

export class Decimator {
  readonly factor: number;
  private readonly h: Float64Array;
  private readonly buf: Float64Array;
  private pos = 0;
  private count = 0;
  value = 0;

  constructor(factor: number, tapsPerPhase = 24) {
    this.factor = factor;
    const taps = factor === 1 ? 1 : factor * tapsPerPhase + 1;
    this.h = factor === 1 ? Float64Array.of(1) : designLowpass(taps, 0.46 / factor, 8.5);
    this.buf = new Float64Array(taps * 2);
  }

  /** Push one input sample; returns true when an output sample is ready in `value`. */
  push(x: number): boolean {
    const n = this.h.length;
    this.buf[this.pos] = x;
    this.buf[this.pos + n] = x;
    this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
    if (++this.count < this.factor) return false;
    this.count = 0;
    let acc = 0;
    const h = this.h;
    const b = this.buf;
    const start = this.pos; // oldest sample
    for (let i = 0; i < n; i++) acc += h[n - 1 - i] * b[start + i];
    this.value = acc;
    return true;
  }
}
