/**
 * Frequency-domain analysis of the (linearised) airway network: the same lumped elements
 * as the FDTD, solved per frequency by tree elimination (O(N) per frequency).
 * Used as a test oracle, for vowel calibration, and for the live transfer-function display.
 */
import { RHO, C_SOUND } from "../physics.ts";
import type { LinearElements } from "./network.ts";

export interface TransferResult {
  freqs: Float64Array;
  /** |U_rad / U_in| */
  mag: Float64Array;
  /** radiated pressure ∝ |jω·U_rad/U_in| (dB, arbitrary reference) */
  pressureDb: Float64Array;
}

/**
 * Transfer function from a volume-velocity source injected at `inject` to total radiated
 * volume velocity. Branches in `cut` are removed (e.g. the glottis: an ideal flow source has
 * infinite internal impedance, which decouples the subglottal system).
 */
export function transferFunction(el: LinearElements, inject: number, freqs: ArrayLike<number>, cut: number[] = []): TransferResult {
  const N = el.nNodes;
  // adjacency of open branches
  const adjStart = new Int32Array(N + 1);
  const cutSet = new Set(cut);
  for (let j = 0; j < el.nBranches; j++) {
    if (!el.open[j] || cutSet.has(j)) continue;
    adjStart[el.a[j] + 1]++;
    adjStart[el.b[j] + 1]++;
  }
  for (let k = 0; k < N; k++) adjStart[k + 1] += adjStart[k];
  const adj = new Int32Array(adjStart[N]);
  const fill = adjStart.slice(0, N);
  for (let j = 0; j < el.nBranches; j++) {
    if (!el.open[j] || cutSet.has(j)) continue;
    adj[fill[el.a[j]]++] = j;
    adj[fill[el.b[j]]++] = j;
  }
  // BFS tree from the injection node
  const order: number[] = [];
  const parent = new Int32Array(N).fill(-2);
  const parentBranch = new Int32Array(N).fill(-1);
  parent[inject] = -1;
  order.push(inject);
  for (let q = 0; q < order.length; q++) {
    const m = order[q];
    for (let e = adjStart[m]; e < adjStart[m + 1]; e++) {
      const j = adj[e];
      const k = el.a[j] === m ? el.b[j] : el.a[j];
      if (parent[k] !== -2) continue; // visited (a loop would be ignored here)
      parent[k] = m;
      parentBranch[k] = j;
      order.push(k);
    }
  }
  const radOf = new Int32Array(N).fill(-1);
  for (let r = 0; r < el.radNodes.length; r++) radOf[el.radNodes[r]] = r;

  const nf = freqs.length;
  const mag = new Float64Array(nf);
  const pdb = new Float64Array(nf);
  const yr = new Float64Array(N); // total admittance of subtree (incl. node shunt)
  const yi = new Float64Array(N);
  const er = new Float64Array(N); // equivalent admittance seen from parent (incl. series branch)
  const ei = new Float64Array(N);
  const pr = new Float64Array(N);
  const pi = new Float64Array(N);
  const radYr = new Float64Array(N);
  const radYi = new Float64Array(N);
  const wYr = new Float64Array(N);
  const wYi = new Float64Array(N);

  for (let f = 0; f < nf; f++) {
    const w = 2 * Math.PI * Math.max(freqs[f], 1e-3);
    // shunt admittances
    for (const k of order) {
      let gr = 0;
      let gi = w * el.C[k];
      wYr[k] = wYi[k] = 0;
      if (el.wallArea[k] > 0) {
        // Y = S / (r + j(ωm − k/ω))
        const zr = el.wallR[k];
        const zi = w * el.wallM[k] - el.wallK[k] / w;
        const d = zr * zr + zi * zi;
        wYr[k] = (el.wallArea[k] * zr) / d;
        wYi[k] = (-el.wallArea[k] * zi) / d;
        gr += wYr[k];
        gi += wYi[k];
      }
      radYr[k] = radYi[k] = 0;
      const r = radOf[k];
      if (r >= 0) {
        const a = el.radArea[r];
        const Lr = (8 * RHO) / (3 * Math.PI * Math.sqrt(Math.PI * a));
        const Rr = (128 * RHO * C_SOUND) / (9 * Math.PI * Math.PI * a);
        radYr[k] = 1 / Rr;
        radYi[k] = -1 / (w * Lr);
        gr += radYr[k];
        gi += radYi[k];
      }
      if (el.fixed[k]) gr += 1e30;
      yr[k] = gr;
      yi[k] = gi;
    }
    // eliminate leaves → root
    for (let q = order.length - 1; q >= 1; q--) {
      const k = order[q];
      const j = parentBranch[k];
      // Y_eq = Y / (1 + Z·Y), Z = R + jωL
      const zr = el.R[j];
      const zi = w * el.L[j];
      const dr = 1 + zr * yr[k] - zi * yi[k];
      const di = zr * yi[k] + zi * yr[k];
      const dd = dr * dr + di * di;
      er[k] = (yr[k] * dr + yi[k] * di) / dd;
      ei[k] = (yi[k] * dr - yr[k] * di) / dd;
      const m = parent[k];
      yr[m] += er[k];
      yi[m] += ei[k];
    }
    // root pressure for unit injected flow
    {
      const dd = yr[inject] * yr[inject] + yi[inject] * yi[inject];
      pr[inject] = yr[inject] / dd;
      pi[inject] = -yi[inject] / dd;
    }
    // back-substitute root → leaves: I = p_m·Y_eq(k); p_k = p_m − Z·I
    let ur = 0;
    let ui = 0;
    for (let q = 0; q < order.length; q++) {
      const k = order[q];
      if (q > 0) {
        const m = parent[k];
        const j = parentBranch[k];
        const Ir = pr[m] * er[k] - pi[m] * ei[k];
        const Ii = pr[m] * ei[k] + pi[m] * er[k];
        const zr = el.R[j];
        const zi = w * el.L[j];
        pr[k] = pr[m] - (zr * Ir - zi * Ii);
        pi[k] = pi[m] - (zr * Ii + zi * Ir);
      }
      if (radOf[k] >= 0) {
        ur += pr[k] * radYr[k] - pi[k] * radYi[k];
        ui += pr[k] * radYi[k] + pi[k] * radYr[k];
      }
      if (el.wallRad[k] > 0 && el.wallArea[k] > 0) {
        ur += el.wallRad[k] * (pr[k] * wYr[k] - pi[k] * wYi[k]);
        ui += el.wallRad[k] * (pr[k] * wYi[k] + pi[k] * wYr[k]);
      }
    }
    mag[f] = Math.hypot(ur, ui);
    pdb[f] = 20 * Math.log10(mag[f] * w + 1e-30);
  }
  return { freqs: Float64Array.from(freqs), mag, pressureDb: pdb };
}

export interface Peak {
  freq: number;
  /** -3 dB bandwidth (Hz), NaN if not measurable */
  bw: number;
  db: number;
}

/** Local maxima of |H| (dB) with parabolic refinement and −3 dB bandwidths. */
export function findPeaks(freqs: ArrayLike<number>, mag: ArrayLike<number>, minFreq = 80): Peak[] {
  const n = mag.length;
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) db[i] = 20 * Math.log10(mag[i] + 1e-30);
  const out: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (freqs[i] < minFreq) continue;
    if (db[i] > db[i - 1] && db[i] >= db[i + 1]) {
      const a = db[i - 1], b = db[i], c = db[i + 1];
      const den = a - 2 * b + c;
      const off = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
      const df = freqs[i + 1] - freqs[i];
      const f = freqs[i] + off * df;
      const peakDb = b - 0.25 * (a - c) * off;
      // -3 dB points
      let lo = i, hi = i;
      while (lo > 0 && db[lo] > peakDb - 3) lo--;
      while (hi < n - 1 && db[hi] > peakDb - 3) hi++;
      let bw = NaN;
      if (db[lo] <= peakDb - 3 && db[hi] <= peakDb - 3) {
        const fl = freqs[lo] + ((peakDb - 3 - db[lo]) / (db[lo + 1] - db[lo])) * (freqs[lo + 1] - freqs[lo]);
        const fh = freqs[hi - 1] + ((db[hi - 1] - (peakDb - 3)) / (db[hi - 1] - db[hi])) * (freqs[hi] - freqs[hi - 1]);
        bw = fh - fl;
      }
      out.push({ freq: f, bw, db: peakDb });
    }
  }
  return out;
}

export function linspace(a: number, b: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a + ((b - a) * i) / (n - 1);
  return out;
}
