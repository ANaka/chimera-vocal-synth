/**
 * Render the beatbox kit through the real-time voice.
 *  - each sound alone: acoustic onset relative to the planned hit (calibrates `latency`), peak,
 *    and a spectrogram strip
 *  - a preset pattern (two bars) as WAV + spectrogram with step marks
 * Usage: bun tools/render-beatbox.ts outdir [preset name] [male|female|child]
 */
import { mkdirSync } from "node:fs";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD } from "../src/engine/anatomy/human.ts";
import { BEAT_SOUNDS, BEAT_PRESETS, beatReady, parseBeat } from "../src/engine/phonetics/beatbox.ts";
import { BeatPlayer } from "../src/engine/control/beatPlayer.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const outDir = process.argv[2] ?? "out/beatbox";
const presetName = process.argv[3] ?? "Boots and cats";
const bodyName = (process.argv[4] ?? "male") as "male" | "female" | "child";
const body = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD }[bodyName];
mkdirSync(outDir, { recursive: true });
const FS = 48000;

function voice(): HumanVoice {
  const v = new HumanVoice({ fsOut: FS, body });
  v.setArticulation(beatReady(bodyName));
  v.setSource({ f0: 100, voiced: true, pressure: 8 });
  v.setGate(0);
  return v;
}

// ---- each sound alone
const player = new BeatPlayer();
player.body = bodyName;
const rows: string[] = [];
const strip = new Float32Array(Math.round(FS * 0.5 * BEAT_SOUNDS.length));
BEAT_SOUNDS.forEach((s, idx) => {
  const v = voice();
  const hit = 0.25;
  v.schedule(player.gestures({ id: s.id }, hit, 0.15));
  const N = Math.round(FS * 0.5);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i += 128) v.render(out, i, Math.min(128, N - i));
  // the event: its peak within [hit − 30 ms, hit + 80 ms]; onset = first sample from hit − 40 ms
  // that reaches a quarter of that peak
  let pk = 0;
  for (let i = Math.round((hit - 0.03) * FS); i < Math.round((hit + 0.08) * FS); i++) pk = Math.max(pk, Math.abs(out[i]));
  let on = Math.round(hit * FS);
  for (let i = Math.round((hit - 0.04) * FS); i < Math.round((hit + 0.08) * FS); i++) if (Math.abs(out[i]) > 0.25 * pk) { on = i; break; }
  // energy before the hit (set-up noise) relative to the hit
  let pre = 0;
  for (let i = Math.round((hit - 0.15) * FS); i < Math.round((hit - 0.04) * FS); i++) pre = Math.max(pre, Math.abs(out[i]));
  // what follows: level 60–150 ms after the hit (unwanted voicing shows up here)
  let tail = 0;
  for (let i = Math.round((hit + 0.06) * FS); i < Math.round((hit + 0.15) * FS); i++) tail = Math.max(tail, Math.abs(out[i]));
  rows.push(`${s.id.padEnd(4)} ${s.name.padEnd(13)} onset ${((on / FS - hit) * 1000).toFixed(1).padStart(6)} ms  peak ${pk.toFixed(3)}  set-up ${(20 * Math.log10(Math.max(1e-6, pre) / pk)).toFixed(1)} dB  tail ${(20 * Math.log10(Math.max(1e-6, tail) / pk)).toFixed(1)} dB  lead-in ${(BeatPlayer.leadIn(s.id, bodyName) * 1000).toFixed(0)} ms`);
  strip.set(out, idx * N);
  writeWav(`${outDir}/${s.id.replace(/[^A-Za-z]/g, "_")}.wav`, [out], FS);
});
console.log(rows.join("\n"));
renderSpectrogram(`${outDir}/kit.png`, strip, FS, { title: `kit (${bodyName}): ${BEAT_SOUNDS.map((s) => s.id).join(" ")}`.replace(/[^\x20-\x7e]/g, "?"), maxFreq: 12000, windowMs: 4, marks: BEAT_SOUNDS.map((_, i) => ({ t: i * 0.5 + 0.25, label: "" })) });
writeWav(`${outDir}/kit.wav`, [strip], FS);

// ---- a pattern, two bars, through the sequencer exactly as the worklet runs it
const preset = BEAT_PRESETS.find((p) => p.name.toLowerCase() === presetName.toLowerCase()) ?? BEAT_PRESETS[0];
const v = voice();
const seq = new BeatPlayer();
seq.body = bodyName;
seq.steps = parseBeat(preset.text);
seq.setTempo(preset.bpm, preset.swing);
seq.start(v.clock);
const bars = 2;
const total = Math.round(FS * (seq.horizon + bars * seq.steps.length * seq.stepDur + 0.3));
const out = new Float32Array(total);
for (let i = 0; i < total; i += 128) {
  seq.tick(v.clock, (gs) => v.schedule(gs));
  v.render(out, i, Math.min(128, total - i));
}
let pk = 0;
for (const x of out) pk = Math.max(pk, Math.abs(x));
const slug = preset.name.toLowerCase().replace(/[^a-z]+/g, "-");
writeWav(`${outDir}/${slug}.wav`, [out], FS);
const marks = Array.from({ length: bars * seq.steps.length }, (_, n) => ({ t: seq.horizon + n * seq.stepDur + (n % 2 ? seq.swing * 0.5 * seq.stepDur : 0), label: "" }));
renderSpectrogram(`${outDir}/${slug}.png`, out, FS, { title: `${preset.name} ${preset.bpm} bpm`, maxFreq: 12000, windowMs: 4, marks });
console.log(`pattern "${preset.name}": ${(total / FS).toFixed(2)} s, peak ${pk.toFixed(3)} -> ${outDir}/${slug}.wav`);
