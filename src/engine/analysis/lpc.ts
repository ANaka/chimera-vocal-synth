/**
 * Linear prediction and formant estimation (autocorrelation method + Levinson–Durbin,
 * roots via Durand–Kerner). Pure TS; used by tests, offline tools and the UI.
 */

export function autocorr(x: ArrayLike<number>, order: number): Float64Array {
  const r = new Float64Array(order + 1);
  const n = x.length;
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = k; i < n; i++) s += x[i] * x[i - k];
    r[k] = s;
  }
  return r;
}

/** Returns LPC polynomial a[0..p] with a[0] = 1 (A(z) = 1 + a1 z^-1 + ...), and prediction error. */
export function levinson(r: Float64Array, p: number): { a: Float64Array; err: number } {
  const a = new Float64Array(p + 1);
  a[0] = 1;
  let err = r[0] * (1 + 1e-9) + 1e-30;
  const tmp = new Float64Array(p + 1);
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) break;
  }
  return { a, err };
}

/** Complex roots of polynomial with real coefficients c[0] z^n + c[1] z^(n-1) + ... + c[n]. */
export function polyRoots(c: ArrayLike<number>, iters = 400): { re: Float64Array; im: Float64Array } {
  const n = c.length - 1;
  const lead = c[0];
  const coef = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) coef[i] = c[i] / lead;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n + 0.4;
    re[i] = 0.9 * Math.cos(ang);
    im[i] = 0.9 * Math.sin(ang);
  }
  for (let it = 0; it < iters; it++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      // evaluate p(z_i) by Horner
      let pr = 1, pi = 0;
      for (let k = 1; k <= n; k++) {
        const nr = pr * re[i] - pi * im[i] + coef[k];
        const ni = pr * im[i] + pi * re[i];
        pr = nr;
        pi = ni;
      }
      // denominator prod (z_i - z_j)
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const xr = re[i] - re[j];
        const xi = im[i] - im[j];
        const nr = dr * xr - di * xi;
        const ni = dr * xi + di * xr;
        dr = nr;
        di = ni;
      }
      const den = dr * dr + di * di + 1e-300;
      const qr = (pr * dr + pi * di) / den;
      const qi = (pi * dr - pr * di) / den;
      re[i] -= qr;
      im[i] -= qi;
      maxDelta = Math.max(maxDelta, Math.abs(qr) + Math.abs(qi));
    }
    if (maxDelta < 1e-12) break;
  }
  return { re, im };
}

export interface Formant {
  freq: number;
  bw: number;
}

/**
 * Estimate formants of a voiced frame. Pre-emphasis, Hamming window, LPC order p.
 * Returns formants sorted by frequency with bandwidth filter.
 */
export function estimateFormants(
  frame: ArrayLike<number>,
  sampleRate: number,
  opts: { order?: number; preEmph?: number; maxBw?: number; minFreq?: number } = {},
): Formant[] {
  const order = opts.order ?? Math.round(2 + sampleRate / 1000);
  const pre = opts.preEmph ?? 0.97;
  const n = frame.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = frame[i] - (i > 0 ? pre * frame[i - 1] : 0);
    x[i] = v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const r = autocorr(x, order);
  // lag window (mild) for numerical robustness
  for (let k = 1; k <= order; k++) r[k] *= Math.exp(-0.5 * Math.pow((2 * Math.PI * 40 * k) / sampleRate, 2));
  const { a } = levinson(r, order);
  const { re, im } = polyRoots(a);
  const out: Formant[] = [];
  for (let i = 0; i < re.length; i++) {
    if (im[i] <= 0) continue;
    const mag = Math.hypot(re[i], im[i]);
    const freq = (Math.atan2(im[i], re[i]) * sampleRate) / (2 * Math.PI);
    const bw = (-Math.log(mag) * sampleRate) / Math.PI;
    if (freq < (opts.minFreq ?? 90) || bw > (opts.maxBw ?? 600)) continue;
    out.push({ freq, bw });
  }
  out.sort((p, q) => p.freq - q.freq);
  return out;
}

/** LPC spectral envelope in dB at given frequencies. */
export function lpcEnvelopeDb(a: Float64Array, err: number, sampleRate: number, freqs: ArrayLike<number>): Float64Array {
  const out = new Float64Array(freqs.length);
  for (let f = 0; f < freqs.length; f++) {
    const w = (2 * Math.PI * freqs[f]) / sampleRate;
    let re = 0, im = 0;
    for (let k = 0; k < a.length; k++) {
      re += a[k] * Math.cos(w * k);
      im -= a[k] * Math.sin(w * k);
    }
    out[f] = 10 * Math.log10(err / (re * re + im * im + 1e-30));
  }
  return out;
}
