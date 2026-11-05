/**
 * Songbird syrinx: one labial pair modelled by the Gardner–Mindlin normal form
 *   X' = Y,  Y' = −α − βX − X³ − X²Y + X² − XY     (τ = γ·t)
 * γ is a pure time scale for fixed (α, β), so pitch is exact: γ = f0·T(α, β), with the limit-cycle
 * period T tabulated offline (tools/gen-syrinx-table.ts). α (drive ≈ air-sac pressure) moves the
 * waveform from a near-sine (Hopf onset) to rich relaxation pulses; β (labial tension) shapes it.
 * The labial displacement maps to the valve opening of its bronchus.
 */
import table from "./syrinxTable.generated.json";

interface Table {
  alphas: number[];
  betas: number[];
  T: (number | null)[][];
  lo: number[][];
  hi: number[][];
}
const TB = table as unknown as Table;

// fill cells without a limit cycle from their neighbours
for (let bi = 0; bi < TB.betas.length; bi++)
  for (let ai = TB.alphas.length - 1; ai >= 0; ai--) {
    const v = TB.T[bi][ai];
    if (v === null || !Number.isFinite(v)) {
      TB.T[bi][ai] = TB.T[bi][ai + 1] ?? TB.T[bi + 1]?.[ai] ?? 10;
      TB.lo[bi][ai] = TB.lo[bi][ai + 1] ?? -1;
      TB.hi[bi][ai] = TB.hi[bi][ai + 1] ?? 1;
    }
  }

function bilinear(grid: (number | null)[][], a: number, b: number): number {
  const as = TB.alphas, bs = TB.betas;
  const fa = Math.max(0, Math.min(as.length - 1.0001, ((a - as[0]) / (as[as.length - 1] - as[0])) * (as.length - 1)));
  const fb = Math.max(0, Math.min(bs.length - 1.0001, ((b - bs[0]) / (bs[bs.length - 1] - bs[0])) * (bs.length - 1)));
  const ia = Math.floor(fa), ib = Math.floor(fb);
  const u = fa - ia, w = fb - ib;
  const g = (i: number, j: number) => grid[j][i] as number;
  return (1 - w) * ((1 - u) * g(ia, ib) + u * g(ia + 1, ib)) + w * ((1 - u) * g(ia, ib + 1) + u * g(ia + 1, ib + 1));
}

export const ALPHA_RANGE: [number, number] = [0.09, 0.6];
export const BETA_RANGE: [number, number] = [0.2, 1.3];

export class SyrinxLabia {
  private x = 0.2;
  private y = 0;
  /** drive 0..1 → α; tension 0..1 → β */
  drive = 0.5;
  tension = 0.4;
  f0 = 3000;
  /** 0..1 gate (syringeal muscle opening this side) */
  gate = 1;
  private readonly fs: number;
  /** last opening 0..1 (telemetry) */
  opening = 0;
  private gateSm = 0;

  constructor(fs: number, seed = 0) {
    this.fs = fs;
    this.x = 0.2 + 0.05 * seed;
  }

  private static rhs(x: number, y: number, a: number, b: number, out: Float64Array): void {
    out[0] = y;
    out[1] = -a - b * x - x * x * x - x * x * y + x * x - x * y;
  }

  private k = new Float64Array(8);

  /** Advance one sample; returns the valve opening 0..1. */
  next(): number {
    const a = ALPHA_RANGE[0] + (ALPHA_RANGE[1] - ALPHA_RANGE[0]) * Math.max(0, Math.min(1, this.drive));
    const b = BETA_RANGE[0] + (BETA_RANGE[1] - BETA_RANGE[0]) * Math.max(0, Math.min(1, this.tension));
    const T = bilinear(TB.T, a, b);
    const dtau = (T * this.f0) / this.fs;
    const n = Math.max(1, Math.ceil(dtau / 0.06));
    const h = dtau / n;
    const k = this.k;
    let x = this.x, y = this.y;
    for (let i = 0; i < n; i++) {
      // RK4 (allocation-free)
      SyrinxLabia.rhs(x, y, a, b, k);
      const k1x = k[0], k1y = k[1];
      SyrinxLabia.rhs(x + 0.5 * h * k1x, y + 0.5 * h * k1y, a, b, k);
      const k2x = k[0], k2y = k[1];
      SyrinxLabia.rhs(x + 0.5 * h * k2x, y + 0.5 * h * k2y, a, b, k);
      const k3x = k[0], k3y = k[1];
      SyrinxLabia.rhs(x + h * k3x, y + h * k3y, a, b, k);
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k[0]);
      y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k[1]);
    }
    if (!Number.isFinite(x) || Math.abs(x) > 10) {
      x = 0.2;
      y = 0;
    }
    this.x = x;
    this.y = y;
    const lo = bilinear(TB.lo, a, b), hi = bilinear(TB.hi, a, b);
    const u = Math.max(0, Math.min(1, (x - lo) / Math.max(1e-3, hi - lo)));
    this.gateSm += (this.gate - this.gateSm) * 0.002;
    const open = u * u * this.gateSm;
    this.opening = open;
    return open;
  }
}
