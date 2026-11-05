/**
 * Prototype: hand-made vowel area functions through the full airway (lungs → trachea →
 * glottis → pharynx → oral + nasal) with the parametric glottis. Writes WAV + spectrogram.
 * Usage: bun tools/proto-vowel.ts [outdir]
 */
import { AirwayNetwork } from "../src/engine/airway/network.ts";
import { Decimator } from "../src/engine/airway/decimator.ts";
import { ParametricGlottis } from "../src/engine/sources/glottis.ts";
import { WALL_SOFT, WALL_TRACHEA, WALL_NASAL, CM_H2O } from "../src/engine/physics.ts";
import { estimateFormants } from "../src/engine/analysis/lpc.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram, renderPlot } from "./lib/spectrogram.ts";

const outDir = process.argv[2] ?? "out/proto";
const FS_OUT = 48000;
const M = 2;
const FS = FS_OUT * M;

// Area functions sampled glottis→lips (17 cm), loosely after Fant/Story shapes.
function shapeA(x: number): number {
  // x in [0,1]: narrow pharynx, wide front cavity
  return 0.6 + (x < 0.45 ? 0.6 + 0.4 * Math.sin(x * 7) ** 2 : 3 + 3.5 * Math.sin(((x - 0.45) / 0.55) * Math.PI * 0.85));
}
function shapeI(x: number): number {
  if (x < 0.1) return 1.5;
  if (x < 0.55) return 5 + 2 * Math.sin(((x - 0.1) / 0.45) * Math.PI);
  if (x < 0.85) return Math.max(0.3, 5 - (x - 0.55) * 30);
  return 1.5;
}
function shapeU(x: number): number {
  if (x < 0.1) return 1.5;
  if (x < 0.5) return 3 + 2 * Math.sin(((x - 0.1) / 0.4) * Math.PI);
  if (x < 0.7) return Math.max(0.4, 3 - (x - 0.5) * 15);
  if (x < 0.92) return 3.5;
  return 0.35;
}

const vowels: [string, (x: number) => number][] = [["a", shapeA], ["i", shapeI], ["u", shapeU]];

const net = new AirwayNetwork(FS);
const trachea = net.addTube({ name: "trachea", n: 16, length: 14, area: 2.5, wall: WALL_TRACHEA });
const ph = net.addTube({ name: "pharynx", n: 22, length: 8.8, area: 3, wall: WALL_SOFT, wallRadiation: 0.3 });
const or = net.addTube({ name: "oral", n: 21, length: 8.4, area: 3, wall: WALL_SOFT, wallRadiation: 0.3, perimeterFactor: 1.3 });
const na = net.addTube({ name: "nasal", n: 26, length: 11.4, area: Array.from({ length: 26 }, (_, i) => (i < 4 ? 2.5 : i > 22 ? 0.9 : 1.6)), wall: WALL_NASAL, perimeterFactor: 2.2, viscousFactor: 2 });
const lung = net.addPressureNode("lungs");
net.connect(lung, trachea.firstNode);
const glot = net.addPort(trachea.lastNode, ph.firstNode, { area: 0, length: 0.3, kEntrance: 0.37, kExit: 1.0, slitWidth: 1.4 });
net.connect(ph.lastNode, or.firstNode);
const velum = net.addPort(ph.lastNode, na.firstNode, { area: 0, length: 1.0, kEntrance: 0.4, kExit: 1.0 });
net.addRadiation(or.lastNode);
net.addRadiation(na.lastNode);
net.finalize();
net.setNoiseSources([{ src: glot, fwd: ph.branch(1), bwd: trachea.branch(14), gain: 4e-6 }]);

const glottis = new ParametricGlottis(FS);
glottis.params.f0 = 110;
const dec = new Decimator(M);
const segDur = 0.8;
const total = Math.round(FS_OUT * segDur * vowels.length);
const out = new Float32Array(total);
const flowTrace = new Float64Array(Math.round(FS * 0.04));
const areaTrace = new Float64Array(flowTrace.length);
let o = 0;
let step = 0;
const block = 64 * M;
for (let v = 0; v < vowels.length; v++) {
  const [, fn] = vowels[v];
  const areasPh = Array.from({ length: ph.n }, (_, i) => fn(((i + 0.5) / ph.n) * 0.52));
  const areasOr = Array.from({ length: or.n }, (_, i) => fn(0.52 + ((i + 0.5) / or.n) * 0.48));
  const nSeg = Math.round(FS * segDur);
  for (let i = 0; i < nSeg; i++, step++) {
    if (step % block === 0) {
      net.setTubeTargets(ph, areasPh);
      net.setTubeTargets(or, areasOr);
      net.beginBlock(block);
    }
    const t = step / FS;
    // breath envelope per vowel
    const local = i / FS;
    const env = Math.min(1, local / 0.05) * Math.min(1, (segDur - local) / 0.08);
    net.setFixedPressure(lung, 8 * CM_H2O * Math.max(0, env));
    const dp = net.p[trachea.lastNode] - net.p[ph.firstNode];
    net.setPortArea(glot, glottis.next(dp));
    const y = net.step();
    if (v === 0 && i >= FS * 0.4 && i < FS * 0.4 + flowTrace.length) {
      flowTrace[i - FS * 0.4] = net.U[glot];
      areaTrace[i - FS * 0.4] = net.portArea[glot];
    }
    if (dec.push(y) && o < total) out[o++] = dec.value;
    void t;
  }
}
// normalise
let pk = 0;
for (let i = 0; i < out.length; i++) pk = Math.max(pk, Math.abs(out[i]));
for (let i = 0; i < out.length; i++) out[i] = (out[i] / pk) * 0.9;
writeWav(`${outDir}/vowels.wav`, [out], FS_OUT);
renderSpectrogram(`${outDir}/vowels.png`, out, FS_OUT, { title: "PROTO VOWELS A I U  F0 110", maxFreq: 5000, windowMs: 5 });
renderPlot(`${outDir}/glottal.png`, [
  { y: flowTrace, color: [120, 220, 255], label: "FLOW U" },
  { y: Array.from(areaTrace, (a) => a * 1500), color: [255, 160, 90], label: "AREA X1500" },
], { title: "GLOTTAL FLOW (A)" });
for (let v = 0; v < vowels.length; v++) {
  const c = Math.round(FS_OUT * (v * segDur + 0.4));
  const frame = out.subarray(c, c + 1024);
  // analyse at 10 kHz-ish resolution: downsample by 4 via averaging for LPC robustness
  const ds = new Float64Array(256);
  for (let i = 0; i < 256; i++) ds[i] = (frame[4 * i] + frame[4 * i + 1] + frame[4 * i + 2] + frame[4 * i + 3]) / 4;
  const fm = estimateFormants(ds, FS_OUT / 4, { order: 12 });
  console.log(vowels[v][0], fm.slice(0, 4).map((f) => `${f.freq.toFixed(0)}(${f.bw.toFixed(0)})`).join(" "));
}
console.log("peak", pk.toExponential(3));
