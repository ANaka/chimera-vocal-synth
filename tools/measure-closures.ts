/**
 * Closure-onset transients in VCV syllables: the largest output step (sample-to-sample
 * difference, a click detector) around the closure onset, relative to the vowel's own.
 * A physical closure is quieter than the vowel it ends; a teleporting one clicks.
 * Usage: bun tools/measure-closures.ts [p,t,k,b,d,g]
 */
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";

const FS = 48000;
const items = (process.argv[2] ?? "p,t,k,b,d,g,s,n").split(",");
const rows: string[] = [];
for (const c of items) {
  const v = new HumanVoice({ fsOut: FS });
  const plan = planUtterance(tokenizeIpa(`ˈɑ${c}ɑ`), { body: "male", t0: 0.05, f0: 110 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + 0.2));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i += 128) v.render(out, i, Math.min(128, N - i));
  const seg = plan.segments[1];
  const step = (a: number, b: number) => {
    let m = 0;
    for (let i = Math.max(1, Math.round(a * FS)); i < Math.round(b * FS); i++) m = Math.max(m, Math.abs(out[i] - out[i - 1]));
    return m;
  };
  const vowelStep = step(0.14, 0.26);
  const closeStep = step(seg.t0 - 0.015, seg.t0 + 0.04);
  rows.push(`${c}  closure-onset max step / vowel max step ${(closeStep / vowelStep).toFixed(2)}`);
}
console.log(rows.join("\n"));
