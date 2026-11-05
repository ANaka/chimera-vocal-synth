/**
 * Running-speech diagnostics (the "marbles in the mouth" battery): renders sentences through the
 * full pipeline and measures, against published norms,
 *  - nasal leakage: velopharyngeal port during vowels with no nasal neighbour
 *    (heard as nasal from ~0.01 cm² for high vowels, ~0.15 cm² for low; Bunton & Story 2011)
 *  - vowel undershoot: LPC F1/F2 at vowel midpoints vs the calibrated (Hillenbrand) targets
 *  - formant bandwidths at vowel midpoints (Klatt defaults B1 60, B2 90, B3 150 Hz)
 *  - spectral balance: octave-band long-term spectrum relative to 500 Hz
 *  - duration contrasts: stressed vs unstressed, phrase-final vs not
 *  - pitch: share of voiced time stuck at the baseline (snapping back between vowels)
 * Usage: bun tools/speech-diagnostics.ts [outdir]
 */
import { readFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { EnglishG2P } from "../src/engine/phonetics/english.ts";
import { planPhrases, diphthongParts } from "../src/engine/phonetics/planner.ts";
import { VOWELS } from "../src/engine/phonetics/vowelData.ts";
import { estimateFormants } from "../src/engine/analysis/lpc.ts";
import { FFT, hann } from "../src/engine/analysis/fft.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const FS = 48000;
const SENTENCES = [
  "The north wind and the sun were disputing which was the stronger.",
  "We were away a year ago.",
  "Should we chase those cowboys?",
  "Can you hear me now?",
  "She sells sea shells by the sea shore.",
];
const NASALS = new Set(["m", "n", "ŋ"]);
const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync("public/data/cmudict.txt.gz")).toString("utf8"));
const REF = new Map(VOWELS.map((v) => [v.ipa, v.male]));

interface VowelStat { ipa: string; stressed: boolean; final: boolean; dur: number; f1: number; f2: number; t1: number; t2: number; bw: number[] }
const vowels: VowelStat[] = [];
let oralFrames = 0, leak1 = 0, leak5 = 0, leak15 = 0, maxOralPort = 0;
let voicedFrames = 0, atBase = 0;
const f0s: number[] = [];
const bands = [250, 500, 1000, 2000, 4000, 8000];
const bandE = new Float64Array(bands.length);
const fft = new FFT(2048), win = hann(2048);

for (const [si, text] of SENTENCES.entries()) {
  const v = new HumanVoice({ fsOut: FS });
  const phrases = g2p.toPhrases(text);
  const plan = planPhrases(phrases, { body: "male", t0: 0.1, f0: 110 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + 0.3));
  const out = new Float32Array(N);
  const port: number[] = [], f0t: number[] = [], voic: number[] = [];
  for (let i = 0; i < N; i += 128) {
    v.render(out, i, Math.min(128, N - i));
    port.push(v.airway.frame?.velumPort ?? 0);
    f0t.push(v.glottis.f0Now);
    voic.push(v.glottis.voicing);
  }
  const frameAt = (t: number) => Math.min(port.length - 1, Math.max(0, Math.round((t * FS) / 128)));
  const segs = plan.segments;
  segs.forEach((s, k) => {
    if (s.kind !== "vowel") return;
    const nasalNb = (segs[k - 1] && NASALS.has(segs[k - 1].ipa)) || (segs[k + 1] && NASALS.has(segs[k + 1].ipa));
    if (!nasalNb)
      for (let f = frameAt(s.t0); f <= frameAt(s.t1); f++) {
        oralFrames++;
        if (port[f] > 0.01) leak1++;
        if (port[f] > 0.05) leak5++;
        if (port[f] > 0.15) leak15++;
        maxOralPort = Math.max(maxOralPort, port[f]);
      }
    // formants at the midpoint (first target of a diphthong at 30 %)
    const parts = diphthongParts(s.ipa);
    const tgt = parts ? parts[0] : s.ipa;
    const ref = REF.get(tgt);
    const tm = parts ? s.t0 + 0.3 * (s.t1 - s.t0) : (s.t0 + s.t1) / 2;
    const dec = 4, len = Math.round(0.025 * FS);
    const c = Math.round(tm * FS);
    const fr: number[] = [];
    for (let i = c - len / 2; i < c + len / 2; i += dec) {
      let acc = 0;
      for (let j = 0; j < dec; j++) acc += out[i + j] ?? 0;
      fr.push(acc / dec);
    }
    const fm = estimateFormants(fr, FS / dec, { order: 14, maxBw: 700 });
    if (ref && fm.length >= 2) {
      const next = segs.slice(k + 1).find((x) => x.kind === "vowel");
      vowels.push({ ipa: s.ipa, stressed: s.stress === 1, final: !next || next.t0 - s.t1 > 0.2, dur: s.t1 - s.t0, f1: fm[0].freq, f2: fm[1].freq, t1: ref[0], t2: ref[1], bw: fm.slice(0, 3).map((x) => x.bw) });
    }
  });
  // pitch: voiced frames within 3 % of the 110 Hz baseline
  for (let f = 0; f < f0t.length; f++)
    if (voic[f] > 0.5) {
      voicedFrames++;
      f0s.push(f0t[f]);
      if (Math.abs(f0t[f] / 110 - 1) < 0.03) atBase++;
    }
  // long-term spectrum over frames with signal
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i + 2048 < N; i += 1024) {
    let e = 0;
    for (let j = 0; j < 2048; j++) e += out[i + j] * out[i + j];
    if (Math.sqrt(e / 2048) < peak * 0.01) continue;
    const re = new Float64Array(2048), im = new Float64Array(2048);
    for (let j = 0; j < 2048; j++) re[j] = out[i + j] * win[j];
    fft.transform(re, im);
    for (let k = 1; k < 1024; k++) {
      const f = (k * FS) / 2048;
      const p = re[k] * re[k] + im[k] * im[k];
      bands.forEach((b, bi) => {
        if (f >= b / Math.SQRT2 && f < b * Math.SQRT2) bandE[bi] += p;
      });
    }
  }
  if (outDir) {
    writeWav(`${outDir}/s${si + 1}.wav`, [out], FS);
    renderSpectrogram(`${outDir}/s${si + 1}.png`, out, FS, { title: text.replace(/[^\x20-\x7e]/g, "?"), maxFreq: 8000, windowMs: 5, marks: segs.map((s) => ({ t: s.t0, label: "" })) });
  }
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)} %`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };
console.log("== nasal leakage during vowels with no nasal neighbour");
console.log(`   frames with port > 0.01 cm²: ${pct(leak1, oralFrames)}   > 0.05: ${pct(leak5, oralFrames)}   > 0.15: ${pct(leak15, oralFrames)}   max ${maxOralPort.toFixed(3)} cm²   (norm: ~0 %)`);
console.log("== vowel midpoints vs calibrated targets");
// LPC fails on short vowels that came out voiceless (aspiration): drop frames with no F1 below 1.2 kHz
const ok = (vs: VowelStat[]) => vs.filter((x) => x.f1 < 1200 && x.f2 < 3200);
const err = (vs0: VowelStat[]) => {
  const vs = ok(vs0);
  return `F1 ${(100 * median(vs.map((x) => Math.abs(x.f1 / x.t1 - 1)))).toFixed(0)} %  F2 ${(100 * median(vs.map((x) => Math.abs(x.f2 / x.t2 - 1)))).toFixed(0)} % median error (n=${vs.length}/${vs0.length} measurable)`;
};
// distance from schwa in (F1, log F2) relative to the target's
const sch = [500, 1500];
const reach = (vs: VowelStat[]) => median(ok(vs).filter((x) => Math.hypot(x.t1 - sch[0], 1000 * Math.log(x.t2 / sch[1])) > 80).map((x) => Math.hypot(x.f1 - sch[0], 1000 * Math.log(x.f2 / sch[1])) / Math.hypot(x.t1 - sch[0], 1000 * Math.log(x.t2 / sch[1]))));
const S = vowels.filter((x) => x.stressed), U = vowels.filter((x) => !x.stressed);
console.log(`   stressed:   ${err(S)}; distance from schwa reached ${(100 * reach(S)).toFixed(0)} % (norm ≥ 90 %)`);
console.log(`   unstressed: ${err(U)}; distance from schwa reached ${(100 * reach(U)).toFixed(0)} % (norm ≥ 75 %)`);
if (process.env.DIAG_VERBOSE) for (const x of vowels) console.log(`     ${x.stressed ? "S" : "u"} ${x.ipa.padEnd(3)} ${(1000 * x.dur).toFixed(0).padStart(4)} ms  F1 ${x.f1.toFixed(0).padStart(4)}/${x.t1}  F2 ${x.f2.toFixed(0).padStart(5)}/${x.t2}  B1 ${x.bw[0].toFixed(0)}`);
console.log("== formant bandwidths at vowel midpoints (median)");
console.log(`   B1 ${median(vowels.map((x) => x.bw[0])).toFixed(0)} Hz  B2 ${median(vowels.map((x) => x.bw[1])).toFixed(0)} Hz  B3 ${median(vowels.map((x) => x.bw[2] ?? NaN).filter(Number.isFinite)).toFixed(0)} Hz   (Klatt defaults 60 / 90 / 150)`);
console.log("== long-term spectrum, octave bands re 500 Hz");
const ref500 = bandE[1];
const ltass = [-2, 0, -6, -11, -16, -20]; // approximate natural male speech (Byrne et al. 1994 LTASS, octave-averaged)
console.log("   " + bands.map((b, i) => `${b >= 1000 ? b / 1000 + "k" : b}: ${(10 * Math.log10(bandE[i] / ref500)).toFixed(1)} (≈${ltass[i]})`).join("   "));
console.log("== durations");
const fin = vowels.filter((x) => x.final), non = vowels.filter((x) => !x.final);
console.log(`   stressed ${(1000 * mean(S.map((x) => x.dur))).toFixed(0)} ms vs unstressed ${(1000 * mean(U.map((x) => x.dur))).toFixed(0)} ms (norm ≥ 2 ×); phrase-final ${(1000 * mean(fin.map((x) => x.dur))).toFixed(0)} ms vs non-final ${(1000 * mean(non.map((x) => x.dur))).toFixed(0)} ms (norm: final ≈ 1.3–1.4 ×)`);
console.log("== pitch");
const st = (a: number, b: number) => 12 * Math.log2(a / b);
const sorted = [...f0s].sort((a, b) => a - b);
console.log(`   voiced time at the 110 Hz baseline (±3 %): ${pct(atBase, voicedFrames)}   range (5–95 %) ${st(sorted[Math.floor(sorted.length * 0.95)], sorted[Math.floor(sorted.length * 0.05)]).toFixed(1)} semitones`);
