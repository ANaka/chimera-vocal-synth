/**
 * English text → speech through the full pipeline. Usage: bun tools/render-text.ts out/name "Text." [male|female|child]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD } from "../src/engine/anatomy/human.ts";
import { planPhrases } from "../src/engine/phonetics/planner.ts";
import { EnglishG2P } from "../src/engine/phonetics/english.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const name = process.argv[2] ?? "out/text";
const text = process.argv[3] ?? "Hello world.";
const bodyName = (process.argv[4] ?? "male") as "male" | "female" | "child";
const body = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD }[bodyName];
const f0 = { male: 112, female: 205, child: 250 }[bodyName];
const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync("public/data/cmudict.txt.gz")).toString("utf8"));
const phrases = g2p.toPhrases(text);
console.log(phrases.map((p) => p.segments.map((s) => (s.stress === 1 ? "ˈ" : "") + s.ipa).join("") + (p.intonation === "question" ? "?" : "")).join(" | "));
const FS = 48000;
const voice = new HumanVoice({ fsOut: FS, body });
voice.setSource({ f0 });
const plan = planPhrases(phrases, { body: bodyName, t0: 0.05, f0 });
voice.schedule(plan.gestures);
const total = Math.round(FS * (plan.end + 0.3));
const out = new Float32Array(total);
const t0 = performance.now();
for (let i = 0; i < total; i += 128) voice.render(out, i, Math.min(128, total - i));
const ms = performance.now() - t0;
writeWav(`${name}.wav`, [out], FS);
renderSpectrogram(`${name}.png`, out, FS, { title: text.toUpperCase().replace(/[^\x20-\x7e]/g, "?").slice(0, 120), maxFreq: 8000, windowMs: 5, marks: plan.segments.map((s) => ({ t: s.t0, label: "" })) });
console.log(`wrote ${name}.wav  ${(total / FS).toFixed(2)} s, rendered in ${ms.toFixed(0)} ms`);
