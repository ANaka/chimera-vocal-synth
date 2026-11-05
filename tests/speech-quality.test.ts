import { describe, expect, test } from "bun:test";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";

const FS = 48000;

function render(ipa: string) {
  const v = new HumanVoice({ fsOut: FS });
  const plan = planUtterance(tokenizeIpa(ipa), { body: "male", t0: 0.05, f0: 110 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + 0.15));
  const out = new Float32Array(N);
  const port: number[] = [];
  for (let i = 0; i < N; i += 128) {
    v.render(out, i, Math.min(128, N - i));
    port.push(v.airway.frame?.velumPort ?? 0);
  }
  return { plan, port, at: (t: number) => port[Math.min(port.length - 1, Math.round((t * FS) / 128))] };
}

describe("running-speech quality guards", () => {
  test("nasality does not spread into oral vowels (Bunton & Story: audible from ~0.01 cm²)", () => {
    // [ɑ n ə b ɑ b ɑ]: the last two vowels have no nasal neighbour
    const { plan, at } = render("ˈɑnəbɑbɑ");
    const vowels = plan.segments.filter((s) => s.kind === "vowel");
    expect(vowels.length).toBe(4);
    for (const v of vowels.slice(2)) for (let t = v.t0; t <= v.t1; t += 0.005) expect(at(t)).toBeLessThan(0.01);
    // and the nasal itself is nasal
    const n = plan.segments.find((s) => s.ipa === "n")!;
    expect(at((n.t0 + n.t1) / 2)).toBeGreaterThan(0.2);
  });
  test("phrase-final lengthening and stressed vs unstressed contrast (Klatt rules)", () => {
    const { plan } = render("ˈbɑbəˈbɑb");
    const v = plan.segments.filter((s) => s.kind === "vowel");
    const [first, mid, last] = [v[0], v[1], v[2]];
    const d = (s: { t0: number; t1: number }) => s.t1 - s.t0;
    expect(d(last) / d(first)).toBeGreaterThan(1.25);
    expect(d(first) / d(mid)).toBeGreaterThan(1.4);
  });
});
