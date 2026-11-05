/**
 * Render calibrated vowels through the real-time HumanVoice path, measure formants (LPC) and
 * f0 (YIN) from the audio, benchmark speed. Usage: bun tools/render-vowels.ts [male|female|child]
 */
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD } from "../src/engine/anatomy/human.ts";
import { estimateFormants } from "../src/engine/analysis/lpc.ts";
import { yinPitch } from "../src/engine/analysis/pitch.ts";
import targets from "../src/engine/phonetics/vowelTargets.generated.json";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const bodyName = (process.argv[2] ?? "male") as "male" | "female" | "child";
const body = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD }[bodyName];
const f0 = { male: 110, female: 205, child: 260 }[bodyName];
const FS = 48000;
const voice = new HumanVoice({ fsOut: FS, body });
voice.setSource({ f0 });
const list = ["i", "e", "ɛ", "æ", "ɑ", "ɔ", "o", "u", "ʌ", "ɝ"];
const seg = 0.6;
const out = new Float32Array(Math.round(FS * seg * list.length));
const T = (targets as Record<string, Record<string, { artic: Record<string, number>; formants: number[] }>>)[bodyName];
const t0 = performance.now();
const block = 128;
let pos = 0;
for (let v = 0; v < list.length; v++) {
  voice.setArticulation(T[list[v]].artic, true);
  const n = Math.round(FS * seg);
  for (let i = 0; i < n; i += block) {
    const local = i / FS;
    voice.setGate(local < seg - 0.12 ? 1 : 0);
    voice.render(out, pos, Math.min(block, out.length - pos));
    pos += block;
    if (pos >= out.length) break;
  }
}
const ms = performance.now() - t0;
let peak = 0;
for (const x of out) peak = Math.max(peak, Math.abs(x));
console.log(`${bodyName}: rendered ${(out.length / FS).toFixed(1)} s in ${ms.toFixed(0)} ms → ${((ms / 1000 / (out.length / FS)) * 100).toFixed(1)}% of real time; peak ${peak.toFixed(3)}`);
for (let v = 0; v < list.length; v++) {
  const c = Math.round(FS * (v * seg + 0.3));
  const frame = out.subarray(c, c + 1536);
  const ds = new Float64Array(384);
  for (let i = 0; i < 384; i++) ds[i] = (frame[4 * i] + frame[4 * i + 1] + frame[4 * i + 2] + frame[4 * i + 3]) / 4;
  const fm = estimateFormants(ds, FS / 4, { order: 12 });
  const { f0: est } = yinPitch(out.subarray(c, c + 2400), FS, { minF0: 60 });
  const ref = T[list[v]].formants;
  console.log(`  ${list[v].padEnd(2)} f0=${est.toFixed(1)}  LPC ${fm.slice(0, 3).map((f) => f.freq.toFixed(0).padStart(5)).join("")}   model ${ref.slice(0, 3).map((f) => String(f).padStart(5)).join("")}`);
}
writeWav(`out/vowels-${bodyName}.wav`, [out], FS);
renderSpectrogram(`out/vowels-${bodyName}.png`, out, FS, { title: `CALIBRATED VOWELS ${bodyName.toUpperCase()}: ${list.join(" ")}`, maxFreq: 5000, windowMs: 5 });
