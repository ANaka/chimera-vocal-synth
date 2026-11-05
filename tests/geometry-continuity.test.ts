/**
 * The area function must change smoothly as the articulators move: a jump in a section's area
 * is heard as a tick and a formant jump. Sweeps each articulator through its speech range from
 * several vowel postures and flags any step far above its neighbours.
 */
import { describe, expect, test } from "bun:test";
import { HumanVocalTract, NEUTRAL, BODY_MALE, restTip, type HumanArtic } from "../src/engine/anatomy/human.ts";
import { vowelArtic } from "../src/engine/phonetics/planner.ts";

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
          if (s > 0.25 && s > 6 * Math.max(med, 0.01)) jumps.push(`${vw} ${key}=${(lo + ((hi - lo) * (i + 1)) / N).toFixed(3)}: ${s.toFixed(2)} cm²`);
        });
      }
    }
    expect(jumps).toEqual([]);
  });
});
