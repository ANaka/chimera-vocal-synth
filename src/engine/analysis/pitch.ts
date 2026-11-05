/**
 * YIN fundamental-frequency estimator (de Cheveigné & Kawahara 2002) for one frame.
 * Returns 0 if unvoiced (aperiodicity above threshold).
 */
export function yinPitch(
  frame: ArrayLike<number>,
  sampleRate: number,
  opts: { minF0?: number; maxF0?: number; threshold?: number } = {},
): { f0: number; aperiodicity: number } {
  const minF0 = opts.minF0 ?? 50;
  const maxF0 = opts.maxF0 ?? 2000;
  const thr = opts.threshold ?? 0.15;
  const maxLag = Math.min(Math.floor(sampleRate / minF0), Math.floor(frame.length / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / maxF0));
  const w = frame.length - maxLag;
  if (w <= 0) return { f0: 0, aperiodicity: 1 };
  const d = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const diff = frame[i] - frame[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  const cmnd = new Float64Array(maxLag + 1);
  cmnd[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    run += d[tau];
    cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let best = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < thr) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    // global minimum as fallback, reported with its aperiodicity
    let mi = minLag;
    for (let tau = minLag; tau <= maxLag; tau++) if (cmnd[tau] < cmnd[mi]) mi = tau;
    return { f0: 0, aperiodicity: cmnd[mi] };
  }
  // parabolic interpolation
  let tauF = best;
  if (best > 1 && best < maxLag) {
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) tauF = best + (0.5 * (a - c)) / den;
  }
  return { f0: sampleRate / tauF, aperiodicity: cmnd[best] };
}
