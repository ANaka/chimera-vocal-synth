import { test, expect } from "bun:test";
import { AirwayNetwork } from "../src/engine/airway/network.ts";
import { transferFunction, findPeaks, linspace } from "../src/engine/airway/frequency.ts";
import { FFT } from "../src/engine/analysis/fft.ts";
import { C_SOUND } from "../src/engine/physics.ts";

function uniformTube(fs: number, opts: { walls?: boolean; length?: number; area?: number; n?: number } = {}) {
  const net = new AirwayNetwork(fs);
  const L = opts.length ?? 17.5;
  const tube = net.addTube({ name: "tract", n: opts.n ?? 40, length: L, area: opts.area ?? 3, wall: opts.walls ? { mass: 1.5, resistance: 1600, stiffness: 3e5 } : null });
  net.addRadiation(tube.lastNode);
  net.finalize();
  return { net, tube };
}

/** FDTD impulse response → |spectrum| peaks. */
function fdtdPeaks(net: AirwayNetwork, inject: number, seconds = 0.5) {
  const n = Math.round(net.fs * seconds);
  const nfft = 1 << Math.ceil(Math.log2(n));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  net.beginBlock(1);
  for (let i = 0; i < n; i++) {
    if (i === 0) net.extFlow[inject] = 1 * net.fs; // unit volume impulse
    re[i] = net.step();
    if (!Number.isFinite(re[i])) throw new Error(`non-finite at ${i}`);
  }
  new FFT(nfft).transform(re, im);
  const freqs = new Float64Array(nfft / 2);
  const mag = new Float64Array(nfft / 2);
  for (let k = 0; k < nfft / 2; k++) {
    freqs[k] = (k * net.fs) / nfft;
    // divide by ω to compare with |U_rad| (output is dU/dt)
    mag[k] = Math.hypot(re[k], im[k]) / (2 * Math.PI * Math.max(freqs[k], 1));
  }
  return findPeaks(freqs, mag, 100).filter((p) => p.freq < 5000);
}

test("uniform tube resonances match quarter-wave theory (with end correction)", () => {
  const { net, tube } = uniformTube(96000);
  const el = net.linearElements();
  const fr = linspace(50, 5000, 4000);
  const H = transferFunction(el, tube.firstNode, fr);
  const peaks = findPeaks(fr, H.mag);
  const a = Math.sqrt(3 / Math.PI);
  // node-centred discretisation: radiation load sits at the last node centre (Δ/2 inside)
  const Leff = 17.5 - 17.5 / 40 / 2 + (8 * a) / (3 * Math.PI) + 17.5 / 40 / 2;
  for (let n = 1; n <= 4; n++) {
    const fTheory = ((2 * n - 1) * C_SOUND) / (4 * Leff);
    const p = peaks.reduce((b, c) => (Math.abs(c.freq - fTheory) < Math.abs(b.freq - fTheory) ? c : b));
    expect(Math.abs(p.freq - fTheory) / fTheory).toBeLessThan(0.03);
  }
});

test("FDTD impulse response agrees with frequency-domain model", () => {
  for (const walls of [false, true]) {
    const { net, tube } = uniformTube(96000, { walls });
    const el = net.linearElements();
    const fr = linspace(50, 5000, 6000);
    const ref = findPeaks(fr, transferFunction(el, tube.firstNode, fr).mag).filter((p) => p.freq < 4800);
    const got = fdtdPeaks(net, tube.firstNode);
    expect(got.length).toBeGreaterThanOrEqual(ref.length);
    for (const r of ref) {
      const g = got.reduce((b, c) => (Math.abs(c.freq - r.freq) < Math.abs(b.freq - r.freq) ? c : b));
      expect(Math.abs(g.freq - r.freq) / r.freq).toBeLessThan(0.012);
    }
  }
});

test("FDTD stays stable with a non-uniform tube and tiny constriction", () => {
  const net = new AirwayNetwork(96000);
  const areas = Array.from({ length: 40 }, (_, i) => (i === 25 ? 0.0005 : 0.5 + 4 * Math.sin((i / 39) * Math.PI) ** 2));
  const t = net.addTube({ name: "t", n: 40, length: 17, area: areas, wall: { mass: 1.5, resistance: 1600, stiffness: 3e5 } });
  net.addRadiation(t.lastNode);
  net.finalize();
  net.beginBlock(1);
  let peak = 0;
  for (let i = 0; i < 96000; i++) {
    if (i < 2000) net.extFlow[t.firstNode] = 300 * Math.sin(i * 0.05);
    const y = net.step();
    peak = Math.max(peak, Math.abs(y));
    expect(Number.isFinite(y)).toBe(true);
  }
  // energy must decay after excitation stops
  let tail = 0;
  for (let i = 0; i < 9600; i++) tail = Math.max(tail, Math.abs(net.step()));
  expect(tail).toBeLessThan(peak * 0.01);
});
