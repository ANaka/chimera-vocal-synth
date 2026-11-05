/**
 * The area function must change smoothly as the articulators move: a jump in a section's area
 * is heard as a tick and a formant jump. Sweeps each articulator through its speech range from
 * several vowel postures and flags any step far above its neighbours.
 */
import { describe, expect, test } from "bun:test";
import { HumanVocalTract, NEUTRAL, BODY_MALE, BODY_FEMALE, BODY_CHILD, restTip, type HumanArtic } from "../src/engine/anatomy/human.ts";
import { vowelArtic } from "../src/engine/phonetics/planner.ts";
import { Polyline, rayCrossings } from "../src/engine/anatomy/geom.ts";
import TARGETS from "../src/engine/phonetics/vowelTargets.generated.json";


/**
 * The largest change that survives refinement of [u0, u1] to 2⁻²⁰ of its width: every half
 * still changing by more than `tol` is refined (keeping only the larger half could follow a
 * steep ramp and miss a real jump in the other). A true discontinuity keeps its size; a steep
 * but continuous ramp shrinks away.
 */
export function jumpSize(areas: (u: number) => number[], u0: number, u1: number, tol = 0.05): number {
  const memo = new Map<number, number[]>();
  const at = (u: number) => {
    let v = memo.get(u);
    if (!v) memo.set(u, (v = areas(u)));
    return v;
  };
  const diff = (a: number, b: number) => {
    const x = at(a), y = at(b);
    let m = 0;
    for (let j = 0; j < x.length; j++) m = Math.max(m, Math.abs(x[j] - y[j]));
    return m;
  };
  let worst = 0;
  const visit = (lo: number, hi: number, depth: number, d: number) => {
    if (depth === 20) {
      worst = Math.max(worst, d);
      return;
    }
    const mid = (lo + hi) / 2;
    const d1 = diff(lo, mid), d2 = diff(mid, hi);
    if (d1 > tol) visit(lo, mid, depth + 1, d1);
    if (d2 > tol) visit(mid, hi, depth + 1, d2);
  };
  const d = diff(u0, u1);
  if (d > tol) visit(u0, u1, 0, d);
  return worst;
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
    const jumps: string[] = [];
    const N = 400;
    for (const [bodyName, body] of [["male", BODY_MALE], ["female", BODY_FEMALE], ["child", BODY_CHILD]] as const) {
    const tract = new HumanVocalTract(body);
    const ph = new Float64Array(20), or = new Float64Array(24);
    const areas = (a: HumanArtic) => {
      tract.resample(a, tract.compute(a), 20, 24, ph, or);
      return [...ph, ...or];
    };
    for (const vw of ["i", "ɑ", "u", "ə"]) {
      const v = vowelArtic(vw, bodyName)!;
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
          if (j > 0.05) jumps.push(`${bodyName} ${vw} ${key}=${(lo + ((hi - lo) * (i + 1)) / N).toFixed(3)}: ${j.toFixed(2)} cm²`);
        });
      }
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

  test("refinement finds a small jump beside a steep ramp", () => {
    const f = (u: number) => [Math.min(1.6 * u, 0.8) + (u >= 0.75 ? 0.1 : 0)];
    expect(jumpSize(f, 0, 1)).toBeCloseTo(0.1, 3);
    expect(jumpSize((u) => [Math.min(1.6 * u, 0.8)], 0, 1)).toBe(0); // a ramp alone is no jump
  });

  test("a ray grazing a polyline vertex sees no tissue layer that is not there", () => {
    // a polyline touching the ray's line at a vertex (from either side): no crossing, or an
    // entry and its exit at the same point, never one unmatched crossing
    const t: number[] = new Array(8), ex = new Uint8Array(8);
    for (const side of [-1, 1]) {
      const touch = new Polyline();
      touch.push({ x: side, y: -1 }).push({ x: 0, y: 0 }).push({ x: side, y: 1 });
      const n = rayCrossings(0, -5, 0, 1, touch, 0, 10, t, ex);
      expect(n === 0 || (n === 2 && t[0] === t[1] && ex[0] !== ex[1])).toBe(true);
    }
    // a polyline passing through the line at a vertex crosses it once
    const through = new Polyline();
    through.push({ x: -1, y: -1 }).push({ x: 0, y: 0 }).push({ x: 1, y: 1 });
    expect(rayCrossings(0, -5, 0, 1, through, 0, 10, t, ex)).toBe(1);
    // the reviewer's posture: a fan ray grazing the tip of a calibrated /ɝ/ exactly at a vertex
    const tract = new HumanVocalTract(BODY_MALE);
    const base = { ...NEUTRAL, ...(TARGETS as Record<string, Record<string, { artic: Partial<HumanArtic> }>>).male["ɝ"].artic, ttX: 5.625 } as HumanArtic;
    const ph = new Float64Array(20), or = new Float64Array(24);
    const areas = (ttY: number) => {
      const a = { ...base, ttY };
      tract.resample(a, tract.compute(a), 20, 24, ph, or);
      return [...ph, ...or];
    };
    const y = 8.588839057347066;
    const [a, b, c] = [areas(y - 1e-9), areas(y), areas(y + 1e-9)];
    for (let j = 0; j < a.length; j++) {
      expect(Math.abs(b[j] - a[j])).toBeLessThan(1e-3);
      expect(Math.abs(c[j] - b[j])).toBeLessThan(1e-3);
    }
  });
});
