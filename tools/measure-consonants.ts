/**
 * Objective consonant metrics from rendered VCV syllables (adult male):
 *  - frication level relative to the vowel (RMS, dB) and spectral centroid / peak
 *  - release transient peak relative to the vowel peak
 * Usage: bun tools/measure-consonants.ts
 */
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";
import { FFT, hann } from "../src/engine/analysis/fft.ts";

const FS = 48000;
const items = (process.argv[2] ?? "s,ʃ,f,θ,x,h,p,t,k,b,d,g,m,n").split(",");
const fft = new FFT(1024);
const win = hann(1024);
for (const c of items) {
  const v = new HumanVoice({ fsOut: FS });
  const plan = planUtterance(tokenizeIpa(`ˈɑ${c}ɑ`), { body: "male", t0: 0.05, f0: 110 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + 0.2));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i += 128) v.render(out, i, Math.min(128, N - i));
  const seg = plan.segments[1];
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = Math.round(a * FS); i < Math.round(b * FS); i++) s += out[i] * out[i];
    return Math.sqrt(s / Math.max(1, Math.round((b - a) * FS)));
  };
  const vowel = rms(0.14, 0.26);
  const mid = (seg.t0 + seg.t1) / 2;
  const fric = rms(seg.t0 + 0.02, seg.t1 - 0.01);
  let vpk = 0;
  for (let i = Math.round(0.14 * FS); i < Math.round(0.26 * FS); i++) vpk = Math.max(vpk, Math.abs(out[i]));
  let rpk = 0;
  for (let i = Math.round(seg.t1 * FS); i < Math.round((seg.t1 + 0.04) * FS); i++) rpk = Math.max(rpk, Math.abs(out[i]));
  // spectrum of the consonant middle
  const re = new Float64Array(1024), im = new Float64Array(1024);
  const s0 = Math.round(mid * FS) - 512;
  for (let i = 0; i < 1024; i++) re[i] = (out[s0 + i] ?? 0) * win[i];
  fft.transform(re, im);
  let num = 0, den = 0, pkBin = 1, pkVal = 0;
  for (let k = 4; k < 512; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = (k * FS) / 1024;
    num += f * p;
    den += p;
    if (f > 1000 && p > pkVal) { pkVal = p; pkBin = k; }
  }
  const db = (x: number) => (20 * Math.log10(Math.max(1e-9, x))).toFixed(1);
  const burst = rms(seg.t1, seg.t1 + 0.012);
  const asp = rms(seg.t1 + 0.012, seg.t1 + 0.04);
  console.log(`${c.padEnd(2)} level ${db(fric / vowel).padStart(6)} dB  centroid ${(num / den / 1000).toFixed(2)} kHz  peak ${((pkBin * FS) / 1024 / 1000).toFixed(2)} kHz  release/vowel peak ${(rpk / vpk).toFixed(2)}  burst ${db(burst / vowel).padStart(6)} dB  post ${db(asp / vowel).padStart(6)} dB`);
}
