/**
 * Render a creature's calls (and a sustained note) offline; report level, stability and pitch.
 * Usage: bun tools/render-creature.ts <creatureId> [outdir]
 */
import { CreatureVoice } from "../src/engine/creatures/voice.ts";
import { CREATURES } from "../src/engine/creatures/index.ts";
import { yinPitch } from "../src/engine/analysis/pitch.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const id = process.argv[2] ?? "songbird";
const outDir = process.argv[3] ?? "out/creatures";
const def = CREATURES.find((c) => c.id === id);
if (!def) throw new Error(`unknown creature ${id}; have ${CREATURES.map((c) => c.id).join(", ")}`);
const FS = 48000;
const v = new CreatureVoice(def, FS);
const segs: { t: number; label: string }[] = [];
const chunks: Float32Array[] = [];
let tCursor = 0;
const t0 = performance.now();
const renderFor = (sec: number) => {
  const n = Math.round(sec * FS);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 128) v.render(buf, i, Math.min(128, n - i));
  chunks.push(buf);
  tCursor += sec;
  return buf;
};
// sustained note at the default pitch
const pitchParam = def.params.find((p) => p.role === "pitch");
segs.push({ t: tCursor, label: "sustain" });
if (def.params.some((p) => p.key === "voices")) v.setParams({ voices: 0 }); // single voice for the pitch check
v.setGate(1);
const sus = renderFor(1.2);
v.setGate(0);
renderFor(0.4);
if (def.params.some((p) => p.key === "voices")) v.setParams({ voices: 0.5 });
let pitchReport = "";
if (pitchParam) {
  const est = yinPitch(sus.subarray(Math.round(0.6 * FS), Math.round(0.6 * FS) + 4096), FS, { minF0: Math.max(20, pitchParam.min * 0.5), maxF0: Math.min(12000, pitchParam.max * 2) });
  pitchReport = `target ${pitchParam.default} Hz, measured ${est.f0.toFixed(1)} Hz (aperiodicity ${est.aperiodicity.toFixed(2)})`;
}
for (const call of def.calls) {
  segs.push({ t: tCursor, label: call.id });
  v.playCall(call.id);
  const dur = call.keys[call.keys.length - 1].t + 0.5;
  renderFor(dur);
}
const ms = performance.now() - t0;
const total = chunks.reduce((a, c) => a + c.length, 0);
const out = new Float32Array(total);
let o = 0;
for (const c of chunks) {
  out.set(c, o);
  o += c.length;
}
let pk = 0, bad = 0;
for (const x of out) {
  if (!Number.isFinite(x)) bad++;
  pk = Math.max(pk, Math.abs(x));
}
writeWav(`${outDir}/${id}.wav`, [out], FS);
renderSpectrogram(`${outDir}/${id}.png`, out, FS, { title: `${def.name} (${def.latin})`.toUpperCase().replace(/[^\x20-\x7e]/g, "?"), maxFreq: id === "songbird" ? 12000 : 6000, windowMs: id === "songbird" ? 4 : 12, marks: segs });
console.log(`${def.name}: ${(total / FS).toFixed(1)} s in ${ms.toFixed(0)} ms (${((ms / 1000 / (total / FS)) * 100).toFixed(1)}% RT, internal ${v.fs} Hz)  peak ${pk.toFixed(3)}  non-finite ${bad}`);
console.log(`  ${pitchReport}`);
