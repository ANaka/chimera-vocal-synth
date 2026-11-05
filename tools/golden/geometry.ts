/** Anatomy fixtures: grids, area functions, contacts and outlines for many postures. */
import { HumanVocalTract, NEUTRAL, type HumanArtic } from "../../src/engine/anatomy/human.ts";
import { ARTIC_KEYS, ARTIC_SPECS } from "../../src/engine/control/articulators.ts";
import { Rng } from "../../src/engine/util/math.ts";
import TARGETS from "../../src/engine/phonetics/vowelTargets.generated.json";
import { BODIES, write, num } from "./lib.ts";

function articCases(): { body: string; artic: HumanArtic }[] {
  const cases: { body: string; artic: HumanArtic }[] = [];
  const T = TARGETS as unknown as Record<string, Record<string, { artic: Partial<HumanArtic> }>>;
  for (const body of Object.keys(BODIES)) {
    cases.push({ body, artic: { ...NEUTRAL } });
    for (const v of Object.values(T[body])) cases.push({ body, artic: { ...NEUTRAL, ...v.artic } });
  }
  const rng = new Rng(2026);
  for (let i = 0; i < 45; i++) {
    const a = { ...NEUTRAL };
    for (const k of ARTIC_KEYS) {
      const s = ARTIC_SPECS[k];
      // half the cases keep the rest of the posture neutral, so contacts and closures occur
      if (i % 2 === 0 || rng.next() < 0.5) a[k] = s.min + (s.max - s.min) * rng.next();
    }
    cases.push({ body: ["male", "female", "child"][i % 3], artic: a });
  }
  return cases;
}

{
  const tracts: Record<string, HumanVocalTract> = {};
  const out = articCases().map(({ body, artic }, i) => {
    // full drawing outlines for a few cases; area functions and contacts for all
    const pts = (ps: { x: number; y: number }[]) => (i % 12 === 0 ? ps.flatMap((p) => [p.x, p.y]) : undefined);
    const t = (tracts[body] ??= new HumanVocalTract(BODIES[body]));
    const f = t.compute(artic);
    const nPh = 18, nOr = 18;
    const ph = new Float64Array(nPh), or = new Float64Array(nOr), phMin = new Float64Array(nPh), orMin = new Float64Array(nOr);
    const { phLen, orLen } = t.resample(artic, f, nPh, nOr, ph, or, phMin, orMin);
    return {
      body,
      artic,
      grid: f.grid.map((g) => [g.region, g.d, g.area, g.s]),
      outer: pts(f.outer),
      inner: pts(f.inner),
      tongue: pts(f.tongue),
      velum: pts(f.velum),
      upperLip: pts(f.upperLip),
      lowerLip: pts(f.lowerLip),
      scalars: [f.length, f.pharynxLength, f.teethS, f.lipS, f.velumPort, f.lipArea, f.tongueRadius, f.tip.x, f.tip.y, f.splitIndex, t.contactTip, t.contactBody, t.contactTipN.x, t.contactTipN.y, t.contactBodyN.x, t.contactBodyN.y].map(num),
      resample: { phLen, orLen, ph: [...ph], or: [...or], phMin: [...phMin], orMin: [...orMin] },
    };
  });
  write("geometry", out);
}

