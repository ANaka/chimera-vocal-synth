/**
 * Calibrate articulatory vowel targets against reference formants with the frequency-domain
 * airway model. Writes src/engine/phonetics/vowelTargets.generated.json
 * Usage: bun tools/calibrate-vowels.ts [male|female|child|all]
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { HumanAirway } from "../src/engine/voice/humanAirway.ts";
import { NEUTRAL, restTip, BODY_MALE, BODY_FEMALE, BODY_CHILD, type HumanArtic, type HumanBody } from "../src/engine/anatomy/human.ts";
import { transferFunction, findPeaks } from "../src/engine/airway/frequency.ts";
import { nelderMead } from "../src/engine/util/optimize.ts";
import { VOWELS } from "../src/engine/phonetics/vowelData.ts";

const which = process.argv[2] ?? "all";
const OUT = "src/engine/phonetics/vowelTargets.generated.json";
const bodies: [string, HumanBody][] = [["male", BODY_MALE], ["female", BODY_FEMALE], ["child", BODY_CHILD]];

const freqs = (() => {
  const n = 700;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 120 * Math.pow(4600 / 120, i / (n - 1));
  return out;
})();

type Params = number[]; // tbX tbY jaw lipAp lipProt lipWidth root larynx curl
const LO: Params = [1.2, 5.0, 0.05, 0.12, 0.0, 0.0, -0.9, -1.3, 0];
const HI: Params = [4.6, 8.8, 2.3, 2.0, 1.4, 1.0, 0.9, 1.3, 1];

function toArtic(p: number[]): HumanArtic {
  const [tbX, tbY, jaw, lipAp, lipProt, lipWidth, root, larynx, curl] = p;
  const tip = restTip(jaw, tbX, tbY);
  // rhotic curl raises the tip toward the post-alveolar region
  const ttX = tip.x - 0.4 * curl;
  const ttY = tip.y + 2.0 * curl;
  return { ...NEUTRAL, tbX, tbY, jaw, lipAp, lipProt, lipWidth, root, larynx, ttX, ttY, ttCurl: curl };
}

function formants(air: HumanAirway, a: HumanArtic): { F: number[]; minArea: number } {
  air.apply(a);
  const el = air.net.linearElements();
  const H = transferFunction(el, air.pharynx.firstNode, freqs, [air.glottisPort]);
  const pk = findPeaks(freqs, H.mag, 150).map((p) => p.freq);
  let minArea = Infinity;
  for (const A of air.phAreas) minArea = Math.min(minArea, A);
  for (const A of air.orAreas) minArea = Math.min(minArea, A);
  return { F: pk, minArea };
}

const results: Record<string, Record<string, { artic: Partial<HumanArtic>; formants: number[]; target: number[]; err: number[] }>> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

for (const [bname, body] of bodies) {
  if (which !== "all" && which !== bname) continue;
  const air = new HumanAirway({ body, fs: 96000 });
  const k = body.scale;
  results[bname] = {};
  for (const vw of VOWELS) {
    const T = bname === "male" ? vw.male : bname === "female" ? vw.female : vw.child;
    // initial guess from vowel-space position
    const x0: Params = [
      3.5 - 1.3 * vw.back + 0.2 * vw.height * (1 - vw.back),
      8.0 - 2.0 * vw.height - 0.25 * vw.back,
      0.25 + 1.4 * vw.height,
      vw.round ? 0.35 + 0.6 * vw.height : 0.6 + 1.0 * vw.height,
      vw.round ? 0.9 : 0.1,
      vw.round ? 0.12 : 0.85,
      0.4 * (1 - vw.back) - 0.5 * vw.height * vw.back,
      0.4 * (1 - vw.height) * (1 - vw.back) - (vw.round ? 0.4 : 0),
      vw.ipa === "ɝ" ? 0.6 : 0,
    ];
    if (vw.ipa === "ɯ") x0.splice(0, x0.length, 2.6, 7.35, 0.25, 0.5, 0.1, 0.65, 0.4, 0.2, 0);
    const jawPrior = 0.2 + 1.5 * vw.height;
    const cost = (p: number[]): number => {
      const a = toArtic(p);
      const { F, minArea } = formants(air, a);
      if (F.length < 3) return 50;
      let c = 0;
      const w = [1.0, 1.0, vw.ipa === "ɝ" ? 1.2 : 0.45];
      for (let i = 0; i < 3; i++) c += w[i] * Math.pow(Math.log(F[i] / T[i]), 2);
      // physiology priors (soft)
      const minOk = 0.22 * k * k;
      if (minArea < minOk) c += 0.4 * Math.pow((minOk - minArea) / minOk, 2);
      c += 0.004 * Math.pow(p[2] - jawPrior, 2);
      const open = vw.height > 0.6;
      if (vw.round) {
        const wMax = open ? 0.45 : 0.3, pMin = open ? 0.35 : 0.6, apMax = 0.3 + 0.7 * vw.height;
        c += 0.05 * Math.pow(Math.max(0, p[5] - wMax), 2) + 0.05 * Math.pow(Math.max(0, pMin - p[4]), 2) + 0.05 * Math.pow(Math.max(0, p[3] - apMax), 2);
      } else {
        const apPrior = 0.35 + 0.75 * p[2];
        c += 0.05 * Math.pow(Math.max(0, 0.55 - p[5]), 2) + 0.05 * Math.pow(Math.max(0, p[4] - 0.35), 2) + 0.03 * Math.pow(Math.max(0, Math.abs(p[3] - apPrior) - 0.35), 2);
      }
      c += 0.002 * p[6] * p[6] + 0.006 * p[7] * p[7];
      // the tongue body near where the vowel's height and backness put it: many postures give
      // the same formants, and without this the fit wandered (a schwa with the tongue as low as
      // /ɑ/), making every transition through it needlessly long
      c += 0.006 * (Math.pow(p[0] - x0[0], 2) + Math.pow(p[1] - x0[1], 2));
      if (vw.ipa !== "ɝ") c += 0.5 * p[8] * p[8];
      return c;
    };
    let best = nelderMead(cost, x0, { lo: LO, hi: HI, step: [0.4, 0.4, 0.3, 0.25, 0.3, 0.25, 0.3, 0.3, 0.2], maxIter: 1800 });
    // restart from the best point to escape shallow minima
    for (let r = 0; r < 2; r++) {
      const nb = nelderMead(cost, best.x, { lo: LO, hi: HI, step: [0.2, 0.2, 0.15, 0.12, 0.15, 0.12, 0.15, 0.15, 0.1], maxIter: 1000 });
      if (nb.fx < best.fx) best = nb;
    }
    const a = toArtic(best.x);
    const { F } = formants(air, a);
    const err = [0, 1, 2].map((i) => (F[i] ? (100 * (F[i] - T[i])) / T[i] : NaN));
    const round3 = (x: number) => Math.round(x * 1000) / 1000;
    results[bname][vw.ipa] = {
      artic: { tbX: round3(a.tbX), tbY: round3(a.tbY), jaw: round3(a.jaw), lipAp: round3(a.lipAp), lipProt: round3(a.lipProt), lipWidth: round3(a.lipWidth), root: round3(a.root), larynx: round3(a.larynx), ttX: round3(a.ttX), ttY: round3(a.ttY), ttCurl: round3(a.ttCurl) },
      formants: F.slice(0, 4).map(Math.round),
      target: T.map(Math.round),
      err: err.map((e) => Math.round(e * 10) / 10),
    };
    console.log(`${bname.padEnd(6)} ${vw.ipa.padEnd(2)} F=${F.slice(0, 3).map((f) => f.toFixed(0).padStart(5)).join("")}  T=${T.map((f) => f.toFixed(0).padStart(5)).join("")}  err%=${err.map((e) => e.toFixed(1).padStart(6)).join("")}  tb=(${a.tbX.toFixed(2)},${a.tbY.toFixed(2)}) jaw=${a.jaw.toFixed(2)} lip=${a.lipAp.toFixed(2)}/${a.lipProt.toFixed(2)}/${a.lipWidth.toFixed(2)} root=${a.root.toFixed(2)} lx=${a.larynx.toFixed(2)} curl=${a.ttCurl.toFixed(2)}`);
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log("wrote", OUT);
