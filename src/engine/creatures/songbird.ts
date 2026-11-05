/**
 * Two-voice songbird (thrush-sized). Each side of the syrinx has its own labial oscillator and
 * pitch; both bronchi merge into the trachea → larynx → oropharyngeal–oesophageal cavity (OEC,
 * a Helmholtz resonator whose volume can track f0 for pure tones) → beak (gape controls radiation).
 */
import { AirwayNetwork } from "../airway/network.ts";
import { WALL_TRACHEA } from "../physics.ts";
import { SyrinxLabia } from "../sources/syrinx.ts";
import type { CreatureDef, CreatureSim, CallKey } from "./types.ts";
import { tube, fillAreas } from "./build.ts";

const OEC_NECK = 0.03; // cm² (larynx)
const OEC_LEN = 0.35; // cm, with end corrections

function create(fs: number): CreatureSim {
  const net = new AirwayNetwork(fs);
  const bronL = tube(net, "bronchusL", fs, 0.8, 0.02);
  const bronR = tube(net, "bronchusR", fs, 0.8, 0.02);
  const trachea = tube(net, "trachea", fs, 3.6, 0.045, { wall: WALL_TRACHEA });
  const sac = net.addPressureNode("air sac");
  net.addPort(sac, bronL.firstNode, { area: 0.05, length: 0.4 });
  net.addPort(sac, bronR.firstNode, { area: 0.05, length: 0.4 });
  const vL = net.addPort(bronL.lastNode, trachea.firstNode, { area: 0, length: 0.08, kEntrance: 0.5, kExit: 1 });
  const vR = net.addPort(bronR.lastNode, trachea.firstNode, { area: 0, length: 0.08, kEntrance: 0.5, kExit: 1 });
  const oec = net.addCavity("oec", 0.4);
  net.addPort(trachea.lastNode, oec, { area: OEC_NECK, length: 0.25, kEntrance: 0.3, kExit: 0.8 });
  const beak = tube(net, "beak", fs, 1.3, 0.08);
  net.connect(oec, beak.firstNode);
  net.addRadiation(beak.lastNode);
  net.finalize();
  const oecLen = Math.cbrt(0.4);
  const labL = new SyrinxLabia(fs, 0);
  const labR = new SyrinxLabia(fs, 1);
  const beakAreas = new Float64Array(beak.n);
  const AMAX = 0.03;
  return {
    net,
    tubes: { trachea, beak, bronchusL: bronL, bronchusR: bronR },
    gain: 4.8e-7,
    control(p, gate) {
      net.setFixedPressure(sac, p.pressure * 1000 * gate * 10); // kPa → dyn/cm² (×10 000)
      labL.f0 = p.pitch;
      labR.f0 = p.pitch * Math.pow(2, p.interval / 12);
      labL.drive = labR.drive = p.drive;
      labL.tension = labR.tension = p.tension;
      // voices: 0 = left only, 0.5 = both, 1 = right only
      labL.gate = p.voices <= 0.5 ? 1 : Math.max(0, 2 - 2 * p.voices);
      labR.gate = p.voices >= 0.5 ? 1 : Math.max(0, 2 * p.voices);
      // OEC tracks the (lower) fundamental for pure tones, or stays at its own size
      const fT = Math.min(labL.f0, labR.f0);
      const vTrack = OEC_NECK / (OEC_LEN * Math.pow(fT / 5570, 2));
      const vol = Math.min(2.5, Math.max(0.04, p.purity * vTrack + (1 - p.purity) * p.oec));
      net.setNodeAreaTarget(oec, vol / oecLen);
      const gape = p.gape;
      net.setTubeTargets(beak, fillAreas(beak, (u) => 0.012 + gape * (0.05 + 0.22 * u), beakAreas));
    },
    sample() {
      net.setPortArea(vL, AMAX * labL.next());
      net.setPortArea(vR, AMAX * labR.next());
      return net.step();
    },
    sourceState: () => ({ left: labL.opening, right: labR.opening }),
  };
}

// --- calls --------------------------------------------------------------------------------------
function trill(f0: number, rate: number, n: number, sweep: number): CallKey[] {
  const keys: CallKey[] = [];
  const per = 1 / rate;
  for (let i = 0; i < n; i++) {
    const t = i * per;
    keys.push({ t, v: { gate: 0, pitch: f0 * (1 - sweep / 2) } , curve: "step" });
    keys.push({ t: t + per * 0.08, v: { gate: 1 } });
    keys.push({ t: t + per * 0.62, v: { gate: 1, pitch: f0 * (1 + sweep / 2) }, curve: "exp" });
    keys.push({ t: t + per * 0.75, v: { gate: 0 } });
  }
  return keys;
}

export const SONGBIRD: CreatureDef = {
  id: "songbird",
  name: "Songbird",
  latin: "Hylocichla mustelina & kin",
  group: "bird",
  blurb: "Two independent labial pairs in the syrinx, one per bronchus, each with its own pitch; a throat cavity tracks the note.",
  role: "Shimmering two-note leads, arpeggio trills, glitchy chirps",
  oversample: 4,
  gateTimes: { attack: 0.004, release: 0.012 },
  params: [
    { key: "pitch", label: "Pitch, left voice", min: 400, max: 9000, default: 2600, unit: "Hz", log: true, smooth: 0.008, role: "pitch" },
    { key: "interval", label: "Right voice interval", min: -12, max: 12, default: 7, unit: "st", smooth: 0.02, digits: 1 },
    { key: "voices", label: "Left ↔ both ↔ right", min: 0, max: 1, default: 0.5, smooth: 0.02 },
    { key: "drive", label: "Drive (pure → raspy)", min: 0, max: 1, default: 0.35, smooth: 0.02 },
    { key: "tension", label: "Labial tension", min: 0, max: 1, default: 0.4, smooth: 0.02 },
    { key: "pressure", label: "Air-sac pressure", min: 0.1, max: 2, default: 0.9, unit: "kPa", smooth: 0.01, digits: 2 },
    { key: "purity", label: "Throat tracks note", min: 0, max: 1, default: 0.8, smooth: 0.02 },
    { key: "oec", label: "Throat cavity size", min: 0.05, max: 2, default: 0.4, unit: "cm³", log: true, smooth: 0.03, digits: 2 },
    { key: "gape", label: "Beak gape", min: 0, max: 1, default: 0.55, smooth: 0.02 },
  ],
  calls: [
    {
      id: "flute",
      name: "Flute phrase",
      hint: "Wood-thrush style: three notes, then a two-voice shimmer",
      pitchRef: 2600,
      keys: [
        { t: 0, v: { gate: 0, pitch: 2000, voices: 0.15, drive: 0.25, interval: 7 } },
        { t: 0.02, v: { gate: 1 } },
        { t: 0.2, v: { gate: 1, pitch: 2100 }, curve: "exp" },
        { t: 0.23, v: { gate: 0 } },
        { t: 0.3, v: { gate: 1, pitch: 2600 }, curve: "step" },
        { t: 0.5, v: { pitch: 2500 }, curve: "exp" },
        { t: 0.53, v: { gate: 0 } },
        { t: 0.6, v: { gate: 1, pitch: 3300, voices: 0.5, interval: 4 }, curve: "step" },
        { t: 1.1, v: { pitch: 3500, interval: 5 }, curve: "exp" },
        { t: 1.2, v: { gate: 0 } },
      ],
    },
    { id: "trill", name: "Canary trill", hint: "16 notes a second, each a quick upsweep", pitchRef: 3000, keys: [{ t: 0, v: { voices: 0.15, drive: 0.3 } }, ...trill(3000, 16, 18, 0.35)] },
    {
      id: "chirps",
      name: "Chirp cascade",
      hint: "Falling chirps, faster and faster",
      pitchRef: 4500,
      keys: [{ t: 0, v: { voices: 0.15, drive: 0.4 } }, ...Array.from({ length: 9 }, (_, i): CallKey[] => {
        const t = i * (0.14 - i * 0.008);
        return [
          { t, v: { gate: 0, pitch: 7000 - i * 300 }, curve: "step" },
          { t: t + 0.01, v: { gate: 1 } },
          { t: t + 0.06, v: { gate: 1, pitch: 2400 - i * 80 }, curve: "exp" },
          { t: t + 0.07, v: { gate: 0 } },
        ];
      }).flat()],
    },
    {
      id: "buzz",
      name: "Finch buzz",
      hint: "Zebra-finch style: raspy, pulsed by mini-breaths",
      pitchRef: 1200,
      keys: [
        { t: 0, v: { voices: 0.5, drive: 0.95, tension: 0.15, interval: 0.5, pitch: 1200, purity: 0.1, gate: 0 } },
        ...Array.from({ length: 8 }, (_, i): CallKey[] => [
          { t: 0.02 + i * 0.07, v: { gate: 1 } },
          { t: 0.06 + i * 0.07, v: { gate: 0.35 } },
        ]).flat(),
        { t: 0.6, v: { gate: 0 } },
      ],
    },
  ],
  visual: {
    view: { x0: -4, x1: 14, y0: -6, y1: 8 },
    silhouette: [[-3.2, -1.2], [-1.6, -3.4], [1.6, -4.6], [5.2, -4.4], [7.8, -2.6], [9.0, -0.4], [9.6, 1.8], [10.4, 2.4], [12.8, 2.6], [10.6, 3.0], [9.8, 3.6], [9.2, 4.6], [7.6, 5.2], [6.0, 4.6], [4.2, 2.8], [2.0, 2.0], [-0.2, 1.6], [-3.6, 1.4], [-3.4, 0.2]],
    parts: [{ shade: 0.2, pts: [[8.6, 4.0], [8.95, 4.3], [9.2, 4.0], [8.95, 3.7]] }],
    tubes: [
      { tube: "bronchusL", path: [[3.4, -1.9], [4.4, -1.4]], label: "Left bronchus", inView: false },
      { tube: "bronchusR", path: [[3.4, -0.9], [4.4, -1.2]], label: "Right bronchus", inView: false },
      { tube: "trachea", path: [[4.4, -1.3], [5.6, -0.4], [6.8, 0.8], [7.8, 1.9], [8.6, 2.5]], label: "Trachea" },
      { tube: "beak", path: [[9.4, 2.75], [10.6, 2.75], [12.4, 2.7]], label: "Beak" },
    ],
    tubeScale: 1.6,
    sources: [{ key: "left", at: [4.2, -1.6], label: "Left voice" }, { key: "right", at: [4.2, -1.0], label: "Right voice" }],
  },
  create,
};
