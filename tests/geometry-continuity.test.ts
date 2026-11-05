/**
 * The area function must change smoothly as the articulators move: a jump in a section's area
 * is heard as a tick and a formant jump. Sweeps each articulator through its speech range from
 * several vowel postures and flags any step far above its neighbours.
 */
import { describe, expect, test } from "bun:test";
import { HumanVocalTract, NEUTRAL, BODY_MALE, BODY_FEMALE, BODY_CHILD, restTip, type HumanArtic } from "../src/engine/anatomy/human.ts";
import { vowelArtic } from "../src/engine/phonetics/planner.ts";
import TARGETS from "../src/engine/phonetics/vowelTargets.generated.json";


/**
 * Max area change across [u − h, u] for a path through postures; a true discontinuity keeps its
 * size as h shrinks, a steep but continuous ramp does not.
 */
function jumpSize(areas: (u: number) => number[], u0: number, u1: number): number {
  // bisect towards the largest change inside the coarse step, down to a millionth of it
  let lo = u0, hi = u1;
  const diff = (a: number, b: number) => {
    const x = areas(a), y = areas(b);
    let m = 0;
    for (let j = 0; j < x.length; j++) m = Math.max(m, Math.abs(x[j] - y[j]));
    return m;
  };
  for (let it = 0; it < 20; it++) {
    const mid = (lo + hi) / 2;
    if (diff(lo, mid) >= diff(mid, hi)) hi = mid;
    else lo = mid;
  }
  return diff(lo, hi);
}

const SWEEPS: [keyof HumanArtic, number, number][] = [
  ["tbY", 5.5, 8.5],
  ["tbX", 1.5, 4.2],
  ["jaw", 0, 2],
  ["ttY", 6, 9.5],
  ["ttX", 5, 7],
  ["root", -0.9, 0.9],
  ["lipAp", -0.2, 2],
  ["velum", -0.25, 1.2],
];

describe("tract geometry continuity", () => {
  test("no area jumps anywhere in the articulators' speech ranges", () => {
    const tract = new HumanVocalTract(BODY_MALE);
    const ph = new Float64Array(20), or = new Float64Array(24);
    const areas = (a: HumanArtic) => {
      tract.resample(a, tract.compute(a), 20, 24, ph, or);
      return [...ph, ...or];
    };
    const jumps: string[] = [];
    const N = 400;
    for (const vw of ["i", "ɑ", "u", "ə"]) {
      const v = vowelArtic(vw, "male")!;
      const tip = restTip(v.jaw ?? NEUTRAL.jaw, v.tbX!, v.tbY!);
      const base: HumanArtic = { ...NEUTRAL, ...v, ttX: tip.x, ttY: tip.y };
      for (const [key, lo, hi] of SWEEPS) {
        const steps: number[] = [];
        let prev = areas({ ...base, [key]: lo });
        for (let i = 1; i <= N; i++) {
          const cur = areas({ ...base, [key]: lo + ((hi - lo) * i) / N });
          let m = 0;
          for (let j = 0; j < cur.length; j++) m = Math.max(m, Math.abs(cur[j] - prev[j]));
          steps.push(m);
          prev = cur;
        }
        steps.forEach((s, i) => {
          const nb = steps.slice(Math.max(0, i - 8), i + 9).filter((_, k) => k !== Math.min(8, i)).sort((a, b) => a - b);
          const med = nb[Math.floor(nb.length / 2)] ?? 0;
          if (!(s > 0.25 && s > 6 * Math.max(med, 0.01))) return;
          const f = (u: number) => areas({ ...base, [key]: lo + (hi - lo) * u });
          const j = jumpSize(f, i / N, (i + 1) / N);
          if (j > 0.05) jumps.push(`${vw} ${key}=${(lo + ((hi - lo) * (i + 1)) / N).toFixed(3)}: ${j.toFixed(2)} cm²`);
        });
      }
    }
    expect(jumps).toEqual([]);
  });

  test("no area jumps on the way between calibrated vowels (all articulators at once, every body)", () => {
    const PAIRS = [["o", "ɝ"], ["i", "ɝ"], ["ɑ", "ɝ"], ["ə", "ɝ"], ["ɑ", "i"], ["u", "i"], ["æ", "u"], ["ʊ", "e"]];
    const jumps: string[] = [];
    const N = 300;
    for (const [bodyName, body] of [["male", BODY_MALE], ["female", BODY_FEMALE], ["child", BODY_CHILD]] as const) {
      const tract = new HumanVocalTract(body);
      const ph = new Float64Array(20), or = new Float64Array(24);
      const areas = (a: HumanArtic) => {
        tract.resample(a, tract.compute(a), 20, 24, ph, or);
        return [...ph, ...or];
      };
      // the full calibrated posture, tongue tip included (the rhotic's raised, curled tip)
      const posture = (vw: string): HumanArtic => ({ ...NEUTRAL, ...(TARGETS as Record<string, Record<string, { artic: Partial<HumanArtic> }>>)[bodyName][vw].artic }) as HumanArtic;
      for (const [x, y] of PAIRS) {
        const a = posture(x), b = posture(y);
        const at = (u: number) => Object.fromEntries(Object.keys(a).map((k) => [k, (a as unknown as Record<string, number>)[k] + ((b as unknown as Record<string, number>)[k] - (a as unknown as Record<string, number>)[k]) * u])) as unknown as HumanArtic;
        const steps: number[] = [];
        let prev = areas(at(0));
        for (let i = 1; i <= N; i++) {
          const cur = areas(at(i / N));
          let m = 0;
          for (let j = 0; j < cur.length; j++) m = Math.max(m, Math.abs(cur[j] - prev[j]));
          steps.push(m);
          prev = cur;
        }
        steps.forEach((s, i) => {
          const nb = steps.slice(Math.max(0, i - 8), i + 9).filter((_, k) => k !== Math.min(8, i)).sort((p, q) => p - q);
          const med = nb[Math.floor(nb.length / 2)] ?? 0;
          if (!(s > 0.2 && s > 6 * Math.max(med, 0.01))) return;
          const j = jumpSize((u) => areas(at(u)), i / N, (i + 1) / N);
          if (j > 0.05) jumps.push(`${bodyName} ${x}→${y} at ${((i + 1) / N).toFixed(3)}: ${j.toFixed(2)} cm²`);
        });
      }
    }
    expect(jumps).toEqual([]);
  });
});
