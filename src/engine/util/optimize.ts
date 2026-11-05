/** Nelder–Mead simplex minimiser with box bounds (clamped). */
export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: { step?: number[]; lo?: number[]; hi?: number[]; maxIter?: number; tol?: number } = {},
): { x: number[]; fx: number; iters: number } {
  const n = x0.length;
  const lo = opts.lo ?? x0.map(() => -Infinity);
  const hi = opts.hi ?? x0.map(() => Infinity);
  const clampX = (x: number[]) => x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
  const step = opts.step ?? x0.map((v) => (Math.abs(v) > 1e-3 ? 0.1 * Math.abs(v) : 0.05));
  const maxIter = opts.maxIter ?? 400 * n;
  const tol = opts.tol ?? 1e-7;
  let simplex: number[][] = [clampX(x0)];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += step[i];
    simplex.push(clampX(p));
  }
  let values = simplex.map(f);
  let it = 0;
  for (; it < maxIter; it++) {
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = idx.map((i) => simplex[i]);
    values = idx.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) < tol * (Math.abs(values[0]) + 1e-12)) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const xr = clampX(centroid.map((c, j) => c + (c - worst[j])));
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = clampX(centroid.map((c, j) => c + 2 * (c - worst[j])));
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        values[n] = fe;
      } else {
        simplex[n] = xr;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr;
      values[n] = fr;
    } else {
      const xc = clampX(centroid.map((c, j) => c + 0.5 * (worst[j] - c)));
      const fc = f(xc);
      if (fc < values[n]) {
        simplex[n] = xc;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = clampX(simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], fx: values[best], iters: it };
}
