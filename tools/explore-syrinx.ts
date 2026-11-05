/**
 * Explore the Gardner–Mindlin labial normal form in normalised time τ:
 *   X' = Y,  Y' = −α − βX − X³ − X²Y + X² − XY
 * For a grid of (α, β): does a limit cycle exist? period in τ, amplitude, harmonic richness.
 * Usage: bun tools/explore-syrinx.ts
 */
function rhs(x: number, y: number, a: number, b: number): [number, number] {
  return [y, -a - b * x - x * x * x - x * x * y + x * x - x * y];
}
function simulate(a: number, b: number) {
  let x = 0.1, y = 0.0;
  const h = 0.002;
  const N = 400000;
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    const [k1x, k1y] = rhs(x, y, a, b);
    const [k2x, k2y] = rhs(x + 0.5 * h * k1x, y + 0.5 * h * k1y, a, b);
    const [k3x, k3y] = rhs(x + 0.5 * h * k2x, y + 0.5 * h * k2y, a, b);
    const [k4x, k4y] = rhs(x + h * k3x, y + h * k3y, a, b);
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
    if (!Number.isFinite(x) || Math.abs(x) > 50) return null;
    if (i > N / 2) xs.push(x);
  }
  let mn = Infinity, mx = -Infinity, mean = 0;
  for (const v of xs) { mn = Math.min(mn, v); mx = Math.max(mx, v); mean += v; }
  mean /= xs.length;
  if (mx - mn < 1e-3) return { osc: false, fix: mean };
  // period from upward mean crossings
  const cr: number[] = [];
  for (let i = 1; i < xs.length; i++) if (xs[i - 1] < mean && xs[i] >= mean) cr.push(i);
  if (cr.length < 3) return { osc: false, fix: mean };
  const period = ((cr[cr.length - 1] - cr[0]) / (cr.length - 1)) * h;
  // crude richness: ratio of time spent in the top 20% of the swing (spiky = rich)
  let top = 0; for (const v of xs) if (v > mn + 0.8 * (mx - mn)) top++;
  return { osc: true, period, amp: mx - mn, min: mn, max: mx, duty: top / xs.length };
}
const rows: string[] = [];
for (const b of [0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0, 1.3]) {
  const cells: string[] = [];
  for (const a of [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6]) {
    const r = simulate(a, b);
    cells.push(!r ? "  diverge  " : !r.osc ? "    ·      " : `T${r.period!.toFixed(1).padStart(5)} A${r.amp!.toFixed(2)}`);
  }
  rows.push(`β=${b.toFixed(2).padStart(5)} | ${cells.join(" ")}`);
}
console.log("α =       0.00        0.05        0.10        0.15        0.20        0.30        0.40        0.60");
console.log(rows.join("\n"));
