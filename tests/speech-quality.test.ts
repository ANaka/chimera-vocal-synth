import { describe, expect, test } from "bun:test";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";
import { HumanVocalTract, NEUTRAL, BODY_MALE } from "../src/engine/anatomy/human.ts";

const FS = 48000;

function render(ipa: string, tail = 0.15) {
  const v = new HumanVoice({ fsOut: FS });
  const plan = planUtterance(tokenizeIpa(ipa), { body: "male", t0: 0.05, f0: 110 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + tail));
  const out = new Float32Array(N);
  const port: number[] = [], voicing: number[] = [];
  for (let i = 0; i < N; i += 128) {
    v.render(out, i, Math.min(128, N - i));
    port.push(v.airway.frame?.velumPort ?? 0);
    voicing.push(v.glottis.voicing);
  }
  const frame = (t: number) => Math.min(port.length - 1, Math.round((t * FS) / 128));
  return { plan, out, port, voicing, frame, at: (t: number) => port[frame(t)] };
}

/** RMS level (dB re the utterance's peak) over [t0, t1). */
function levelDb(out: Float32Array, t0: number, t1: number): number {
  let peak = 0, e = 0, n = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  for (let i = Math.round(t0 * FS); i < Math.min(out.length, Math.round(t1 * FS)); i++, n++) e += out[i] * out[i];
  return 20 * Math.log10(Math.sqrt(e / Math.max(1, n)) / peak + 1e-12);
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
  test("a phrase ends in silence: no vowel added after a final consonant, no lingering breath", () => {
    for (const ipa of ["ˈbæd", "ˈkæt", "ˈsi", "ˈðɛm"]) {
      const { plan, out, voicing, frame } = render(ipa, 0.45);
      const final = plan.segments[plan.segments.length - 1];
      const sonorant = final.kind === "vowel" || final.kind === "nasal";
      // the folds stop at a final obstruent's release; a final vowel or nasal fades out
      const voicedFor = sonorant ? 0.05 : 0.015;
      for (let f = frame(plan.end + voicedFor); f < voicing.length; f++) expect(voicing[f]).toBeLessThan(0.3);
      expect(levelDb(out, plan.end + 0.15, plan.end + 0.45)).toBeLessThan(-50);
    }
  });
});

describe("tract geometry continuity", () => {
  test("the tongue-palate contact model engages smoothly (no area jump as the gap closes past 6 mm)", () => {
    // the tongue on its way from a final /d/ back to rest: the body's gap to the roof crosses
    // the contact regime's edge (0.6 cm) at tbY ≈ 6.90
    const A = { ...NEUTRAL, jaw: 0.604, tbX: 2.935, ttX: 6.272, ttY: 6.89, lipAp: 0.703, lipProt: 0.2, lipWidth: 0.5 };
    const tract = new HumanVocalTract(BODY_MALE);
    const ph = new Float64Array(20), or = new Float64Array(24);
    let prev: number[] | null = null;
    let worst = 0;
    for (let y = 6.85; y <= 6.95; y += 0.001) {
      const a = { ...A, tbY: y };
      tract.resample(a, tract.compute(a), 20, 24, ph, or);
      const cur = [...ph, ...or];
      if (prev) for (let j = 0; j < cur.length; j++) worst = Math.max(worst, Math.abs(cur[j] - prev[j]));
      prev = cur;
    }
    expect(worst).toBeLessThan(0.05); // cm² per 0.01 mm of tongue travel (was 0.87 at the edge)
  });
});
