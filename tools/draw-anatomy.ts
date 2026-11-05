/**
 * Debug render of the human articulatory model: contours, measurement grid, area function.
 * Usage: bun tools/draw-anatomy.ts [out.png]
 */
import { HumanVocalTract, NEUTRAL, type HumanArtic } from "../src/engine/anatomy/human.ts";
import type { Vec } from "../src/engine/anatomy/geom.ts";
import { Image } from "./lib/image.ts";

const out = process.argv[2] ?? "out/anatomy.png";
const tract = new HumanVocalTract();

const poses: [string, Partial<HumanArtic>][] = [
  ["NEUTRAL", {}],
  ["I (HEED)", { tbX: 3.75, tbY: 8.25, jaw: 0.35, lipAp: 0.55, lipWidth: 0.95, lipProt: 0 }],
  ["A (FATHER)", { tbX: 2.05, tbY: 5.85, jaw: 1.6, lipAp: 1.6, lipWidth: 0.6 }],
  ["U (WHO)", { tbX: 2.25, tbY: 8.0, jaw: 0.4, lipAp: 0.35, lipWidth: 0.1, lipProt: 1.0 }],
  ["T CLOSURE", { ttX: 6.3, ttY: 9.8 }],
  ["K CLOSURE", { tbX: 2.3, tbY: 8.4 }],
];

const cellW = 420, cellH = 520;
const img = new Image(cellW * 3, cellH * 2, [14, 14, 20]);
poses.forEach(([name, pose], idx) => {
  const a = { ...NEUTRAL, ...pose };
  const f = tract.compute(a);
  const ox = (idx % 3) * cellW, oy = Math.floor(idx / 3) * cellH;
  const S = 32; // px per cm
  const X = (p: Vec) => ox + 90 + p.x * S;
  const Y = (p: Vec) => oy + 30 + (12 - p.y) * S;
  const poly = (pts: Vec[], c: [number, number, number]) => {
    for (let i = 0; i < pts.length - 1; i++) img.line(X(pts[i]), Y(pts[i]), X(pts[i + 1]), Y(pts[i + 1]), c);
  };
  img.text(ox + 8, oy + 8, name, [230, 230, 230]);
  for (const g of f.grid) {
    const col: [number, number, number] = g.region === 1 ? [70, 120, 200] : g.region === 2 ? [70, 170, 120] : [200, 150, 70];
    img.line(X(g.inner), Y(g.inner), X(g.outer), Y(g.outer), col, 0.6);
  }
  poly(f.outer, [235, 235, 235]);
  poly(f.inner, [255, 120, 140]);
  poly(f.velum, [200, 140, 200]);
  poly(f.jawBone, [160, 160, 160]);
  poly(f.upperTeeth, [250, 250, 210]);
  poly(f.lowerTeeth, [250, 250, 210]);
  img.rect(X(f.glottis) - 2, Y(f.glottis) - 2, 5, 5, [255, 220, 0]);
  // area function
  const ax = ox + 20, ay = oy + cellH - 110, aw = cellW - 40, ah = 90;
  img.rect(ax, ay, aw, ah, [24, 24, 32]);
  const maxS = 19, maxA = 8;
  const ph = new Float64Array(20), or = new Float64Array(20);
  const { phLen, orLen } = tract.resample(a, f, 20, 20, ph, or);
  const bars = [...Array.from(ph, (A, i) => [((i + 0.5) / 20) * phLen, A, phLen / 20]), ...Array.from(or, (A, i) => [phLen + ((i + 0.5) / 20) * orLen, A, orLen / 20])];
  for (const [s, A, w] of bars) {
    const x0 = ax + ((s - w / 2) / maxS) * aw, x1 = ax + ((s + w / 2) / maxS) * aw;
    const h = Math.min(1, A / maxA) * ah;
    img.rect(x0, ay + ah - h, Math.max(1, x1 - x0 - 1), h, s < phLen ? [70, 120, 200] : [200, 120, 90]);
  }
  img.text(ax + 4, ay + 4, `L ${f.length.toFixed(1)} PH ${phLen.toFixed(1)} LIP ${f.lipArea.toFixed(2)}`, [220, 220, 220]);
});
img.savePng(out);
console.log("wrote", out);
