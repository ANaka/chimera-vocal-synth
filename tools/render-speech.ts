/**
 * Render IPA utterances through the real-time voice with the gestural planner.
 * Usage: bun tools/render-speech.ts out/name "ˈɑpɑ ˈɑbɑ" [male|female|child]
 * Writes <name>.wav and <name>.png (spectrogram with segment marks).
 */
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD } from "../src/engine/anatomy/human.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const name = process.argv[2] ?? "out/speech";
const text = process.argv[3] ?? "ˈɑpɑ";
const bodyName = (process.argv[4] ?? "male") as "male" | "female" | "child";
const body = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD }[bodyName];
const f0 = { male: 110, female: 200, child: 250 }[bodyName];
const FS = 48000;
const voice = new HumanVoice({ fsOut: FS, body });
voice.setSource({ f0 });
const utterances = text.split("/").map((u) => u.trim()).filter(Boolean);
const marks: { t: number; label: string }[] = [];
let t0 = 0.05;
for (const u of utterances) {
  const segs = tokenizeIpa(u);
  const plan = planUtterance(segs, { body: bodyName, t0, f0 });
  voice.schedule(plan.gestures);
  for (const s of plan.segments) marks.push({ t: s.t0, label: s.ipa });
  t0 = plan.end + 0.35;
}
const total = Math.round(FS * (t0 + 0.2));
const out = new Float32Array(total);
for (let i = 0; i < total; i += 128) voice.render(out, i, Math.min(128, total - i));
let pk = 0;
for (const x of out) pk = Math.max(pk, Math.abs(x));
writeWav(`${name}.wav`, [out], FS);
renderSpectrogram(`${name}.png`, out, FS, { title: `${text}  (${bodyName})`.replace(/[^\x20-\x7e]/g, "?"), maxFreq: 9000, windowMs: 5, marks: marks.map((m) => ({ t: m.t, label: "" })) });
console.log(`wrote ${name}.wav/.png  ${(total / FS).toFixed(2)} s  peak ${pk.toFixed(3)}`);
console.log(marks.map((m) => `${m.label}@${m.t.toFixed(3)}`).join(" "));
