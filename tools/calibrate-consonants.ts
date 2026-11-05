/**
 * Calibrate the main coordinate of fricatives so the constriction area matches its target
 * (adult-male target × body scale²), in an /a/-like context. Bisection on the monotonic
 * contact model. Writes src/engine/phonetics/consonantTargets.generated.json
 */
import { writeFileSync } from "node:fs";
import { HumanAirway } from "../src/engine/voice/humanAirway.ts";
import { NEUTRAL, BODY_MALE, BODY_FEMALE, BODY_CHILD, type HumanArtic } from "../src/engine/anatomy/human.ts";
import { CONSONANTS } from "../src/engine/phonetics/inventory.ts";
import vowels from "../src/engine/phonetics/vowelTargets.generated.json";

const out: Record<string, Record<string, Partial<HumanArtic>>> = {};
for (const [name, body] of [["male", BODY_MALE], ["female", BODY_FEMALE], ["child", BODY_CHILD]] as const) {
  const air = new HumanAirway({ fs: 96000, body });
  const ctx = { ...NEUTRAL, ...(vowels as any)[name]["ɑ"].artic, jaw: 0.55 } as HumanArtic;
  out[name] = {};
  for (const p of CONSONANTS) {
    if (!p.area || !p.calKey) continue;
    const target = p.area * body.scale * body.scale;
    const key = p.calKey;
    const minArea = (v: number) => {
      const a = { ...ctx, ...p.targets, [key]: v } as HumanArtic;
      air.apply(a);
      let m = Infinity;
      for (const x of air.phMin) if (x < m) m = x;
      for (const x of air.orMin) if (x < m) m = x;
      return m;
    };
    // search direction: area decreases as the coordinate moves toward closure
    const base = p.targets[key] as number;
    let lo = base - 1.2, hi = base + 1.2;
    const decreasing = minArea(hi) < minArea(lo); // area falls as value rises?
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const A = minArea(mid);
      if ((A > target) === decreasing) lo = mid;
      else hi = mid;
    }
    const v = (lo + hi) / 2;
    const got = minArea(v);
    out[name][p.ipa] = { [key]: Math.round(v * 1000) / 1000 };
    console.log(`${name.padEnd(6)} ${p.ipa.padEnd(3)} ${key}=${v.toFixed(3)} area ${got.toFixed(3)} (target ${target.toFixed(3)})`);
  }
}
writeFileSync("src/engine/phonetics/consonantTargets.generated.json", JSON.stringify(out, null, 1));
