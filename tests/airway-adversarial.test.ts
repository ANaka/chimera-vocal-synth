import { test, expect } from "bun:test";
import { AirwayNetwork } from "../src/engine/airway/network.ts";
import { transferFunction, findPeaks, linspace } from "../src/engine/airway/frequency.ts";
import { FFT } from "../src/engine/analysis/fft.ts";
import { RHO, RHO_C2, CM_H2O, WALL_SOFT } from "../src/engine/physics.ts";

const FS = 96000;

test("nearly closed three-way junction stays stable at the working CFL", () => {
  const net = new AirwayNetwork(FS);
  const n = 20, len = 8; // Δ = 0.4 cm → CFL ≈ 0.91
  const a = net.addTube({ name: "a", n, length: len, area: 3 });
  const b = net.addTube({ name: "b", n, length: len, area: 3 });
  const c = net.addTube({ name: "c", n, length: len, area: 3 });
  // junction = last node of a, which we squeeze to a tiny area
  net.connect(a.lastNode, b.firstNode);
  net.connect(a.lastNode, c.firstNode);
  net.addRadiation(b.lastNode);
  net.addRadiation(c.lastNode);
  net.finalize();
  const areas = new Float64Array(n).fill(3);
  areas[n - 1] = 0.002;
  net.setTubeTargets(a, areas);
  net.beginBlock(64);
  let peak = 0;
  for (let i = 0; i < FS; i++) {
    if (i % 64 === 0) net.beginBlock(64);
    if (i < 400) net.extFlow[a.firstNode] = 200 * Math.sin(i * 0.3);
    const y = net.step();
    expect(Number.isFinite(y)).toBe(true);
    peak = Math.max(peak, Math.abs(net.p[a.lastNode]));
  }
  expect(peak).toBeLessThan(1e7);
  // decays once excitation stops
  let tail = 0;
  for (let i = 0; i < FS / 10; i++) tail = Math.max(tail, Math.abs(net.p[a.lastNode] + net.step() * 0));
  expect(tail).toBeLessThan(peak);
});

test("sealed cavity compression follows the (linearised) adiabatic law", () => {
  const net = new AirwayNetwork(FS);
  const t = net.addTube({ name: "cav", n: 10, length: 4, area: 2 });
  net.finalize();
  // shrink volume by 5 % over 20 ms
  const steps = FS * 0.02;
  const block = 64;
  for (let i = 0; i < steps; i++) {
    if (i % block === 0) {
      const f = Math.min(1, (i + block) / steps);
      net.setTubeTargets(t, new Float64Array(10).fill(2 * (1 - 0.05 * f)));
      net.beginBlock(block);
    }
    net.step();
  }
  for (let i = 0; i < FS * 0.02; i++) {
    if (i % block === 0) net.beginBlock(block);
    net.step();
  }
  const expected = RHO_C2 * Math.log(1 / 0.95); // ∫ρc² dV/V
  let mean = 0;
  for (let k = 0; k < 10; k++) mean += net.p[t.node(k)] / 10;
  expect(Math.abs(mean - expected) / expected).toBeLessThan(0.03);
});

test("steady flow through a short constriction obeys Bernoulli with jet loss", () => {
  for (const lengthFrac of [1, 0.25]) {
    const net = new AirwayNetwork(FS);
    const n = 30;
    const t = net.addTube({ name: "t", n, length: 12, area: 3 });
    const lung = net.addPressureNode("lung");
    net.addPort(lung, t.firstNode, { area: 3, length: 1, kEntrance: 0, kExit: 0 });
    net.addRadiation(t.lastNode);
    net.finalize();
    const Ac = 0.08;
    const areas = new Float64Array(n).fill(3);
    const mins = new Float64Array(n).fill(3);
    // constriction occupying a whole section, or only a quarter of it (sub-grid)
    const harmonic = 1 / (lengthFrac / Ac + (1 - lengthFrac) / 3);
    areas[20] = harmonic;
    mins[20] = Ac;
    net.setTubeTargets(t, areas, undefined, mins);
    const P = 6 * CM_H2O;
    for (let i = 0; i < FS * 0.25; i++) {
      if (i % 64 === 0) net.beginBlock(64);
      net.setFixedPressure(lung, P * Math.min(1, i / (FS * 0.02)));
      net.step();
    }
    const U = Math.abs(net.U[t.branch(20)]);
    const bernoulli = Ac * Math.sqrt((2 * P) / RHO);
    expect(Math.abs(U - bernoulli) / bernoulli).toBeLessThan(0.15);
  }
});

test("formant bandwidths agree between FDTD and the frequency-domain model", () => {
  const net = new AirwayNetwork(FS);
  const t = net.addTube({ name: "t", n: 40, length: 17.5, area: Array.from({ length: 40 }, (_, i) => 1.5 + 2.5 * Math.sin((i / 39) * 2.5) ** 2), wall: WALL_SOFT });
  net.addRadiation(t.lastNode);
  net.finalize();
  const fr = linspace(80, 4500, 6000);
  const ref = findPeaks(fr, transferFunction(net.linearElements(), t.firstNode, fr).mag).filter((p) => p.freq < 4000);
  const n = FS;
  const nfft = 1 << 17;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  net.beginBlock(1);
  for (let i = 0; i < n; i++) {
    if (i === 0) net.extFlow[t.firstNode] = FS;
    re[i] = net.step();
  }
  new FFT(nfft).transform(re, im);
  const freqs = new Float64Array(nfft / 2), mag = new Float64Array(nfft / 2);
  for (let k = 0; k < nfft / 2; k++) {
    freqs[k] = (k * FS) / nfft;
    mag[k] = Math.hypot(re[k], im[k]) / (2 * Math.PI * Math.max(freqs[k], 1));
  }
  const got = findPeaks(freqs, mag, 80).filter((p) => p.freq < 4200);
  for (const r of ref) {
    const g = got.reduce((b, c) => (Math.abs(c.freq - r.freq) < Math.abs(b.freq - r.freq) ? c : b));
    expect(Math.abs(g.freq - r.freq) / r.freq).toBeLessThan(0.012);
    if (Number.isFinite(r.bw) && Number.isFinite(g.bw)) expect(Math.abs(g.bw - r.bw) / r.bw).toBeLessThan(0.2);
  }
});

test("a realistic sliding closure with trapped pressure releases without spikes", () => {
  // closure forms over 25 ms (as articulator dynamics produce), slides 6 sections back toward the
  // lungs while held (trapped pressure behind it), then releases over 12 ms
  const net = new AirwayNetwork(FS);
  const n = 40;
  const t = net.addTube({ name: "t", n, length: 17, area: 3, wall: WALL_SOFT });
  const lung = net.addPressureNode("lung");
  net.addPort(lung, t.firstNode, { area: 3, length: 1 });
  net.addRadiation(t.lastNode);
  net.finalize();
  const block = 64;
  let peakP = 0, peakOut = 0, peakOpenOut = 0;
  const total = FS * 0.6;
  const P = 8 * CM_H2O;
  for (let i = 0; i < total; i++) {
    const time = i / FS;
    if (i % block === 0) {
      const tt = (i + block) / FS;
      const depth = tt < 0.05 ? 0 : tt < 0.075 ? 1.3 * (tt - 0.05) / 0.025 : tt < 0.4 ? 1.3 : Math.max(0, 1.3 - (1.3 * (tt - 0.4)) / 0.012);
      const pos = 30 - 6 * Math.min(1, Math.max(0, (tt - 0.1) / 0.25));
      const areas = new Float64Array(n);
      for (let k = 0; k < n; k++) areas[k] = Math.max(0, 3 * (1 - depth * Math.exp(-(((k - pos) / 1.6) ** 2))));
      net.setTubeTargets(t, areas);
      net.beginBlock(block);
    }
    net.setFixedPressure(lung, P * Math.min(1, time / 0.03));
    const y = net.step();
    if (time > 0.03) peakOut = Math.max(peakOut, Math.abs(y));
    if (time > 0.03 && time < 0.05) peakOpenOut = Math.max(peakOpenOut, Math.abs(y));
    for (let k = 0; k < n; k++) peakP = Math.max(peakP, Math.abs(net.p[t.node(k)]));
  }
  // pressure stays within a small multiple of the driving pressure
  expect(peakP).toBeLessThan(2.5 * P);
  expect(Number.isFinite(peakOut)).toBe(true);
});

test("fast (but articulator-limited) closure gives bounded piston pressure", () => {
  // closing 3 cm² → 0 over 8 ms is near the fastest lip/tongue motion; pressure must stay sane
  const net = new AirwayNetwork(FS);
  const n = 40;
  const t = net.addTube({ name: "t", n, length: 17, area: 3, wall: WALL_SOFT });
  net.addRadiation(t.lastNode);
  net.finalize();
  let peakP = 0;
  for (let i = 0; i < FS * 0.1; i++) {
    if (i % 64 === 0) {
      const tt = (i + 64) / FS;
      const depth = Math.min(1.2, (1.2 * tt) / 0.008);
      const areas = new Float64Array(n);
      for (let k = 0; k < n; k++) areas[k] = Math.max(0, 3 * (1 - depth * Math.exp(-(((k - 30) / 1.6) ** 2))));
      net.setTubeTargets(t, areas);
      net.beginBlock(64);
    }
    net.step();
    for (let k = 0; k < n; k++) peakP = Math.max(peakP, Math.abs(net.p[t.node(k)]));
  }
  expect(peakP).toBeLessThan(20 * CM_H2O);
});
