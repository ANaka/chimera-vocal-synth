import { test, expect } from "bun:test";
import { estimateFormants } from "../src/engine/analysis/lpc.ts";
import { yinPitch } from "../src/engine/analysis/pitch.ts";

/** Impulse train at f0 through cascaded 2-pole resonators at known formants. */
function synthVowel(sr: number, f0: number, formants: [number, number][], dur: number): Float64Array {
  const n = Math.round(sr * dur);
  let x = new Float64Array(n);
  const period = sr / f0;
  for (let k = 0; k * period < n; k++) x[Math.round(k * period)] = 1;
  for (const [f, bw] of formants) {
    const r = Math.exp((-Math.PI * bw) / sr);
    const a1 = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    const a2 = -r * r;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] + a1 * (i > 0 ? y[i - 1] : 0) + a2 * (i > 1 ? y[i - 2] : 0);
    x = y;
  }
  return x;
}

test("LPC recovers known formants", () => {
  const sr = 16000;
  const target: [number, number][] = [[730, 60], [1090, 80], [2440, 120], [3400, 150]];
  const x = synthVowel(sr, 110, target, 0.3);
  const frame = x.subarray(1600, 1600 + 512);
  const fm = estimateFormants(frame, sr, { order: 14, preEmph: 0 }); // flat-spectrum source: no pre-emphasis
  for (const [f] of target) {
    const nearest = fm.reduce((b, c) => (Math.abs(c.freq - f) < Math.abs(b.freq - f) ? c : b));
    expect(Math.abs(nearest.freq - f) / f).toBeLessThan(0.05);
  }
});

test("YIN recovers f0", () => {
  const sr = 48000;
  for (const f0 of [82, 110, 220, 440, 880]) {
    const x = synthVowel(sr, f0, [[500, 80], [1500, 100]], 0.2);
    const { f0: est } = yinPitch(x.subarray(2000, 2000 + 2400), sr, { minF0: 60 });
    expect(Math.abs(est - f0) / f0).toBeLessThan(0.01);
  }
});
