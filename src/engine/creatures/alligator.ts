/**
 * American alligator: bellows are noisy and chaotic with most power far below 100 Hz; the body
 * vibrates the water into a "dance" before the audible roar. Chaotic laryngeal source, long tract,
 * closed mouth (sound leaves through nostrils and skin).
 */
import type { CreatureDef, CreatureSim } from "./types.ts";
import { mammalAirway, stepGlottis, mammalNoise } from "./mammal.ts";
import { fillAreas, CMH2O } from "./build.ts";

function create(fs: number): CreatureSim {
  const a = mammalAirway(fs, { trachea: [30, 6], pharynx: [18, 7], oral: [24, 6], nasal: [26, 1.8], wallRadiation: 1.0, coarse: 1.3 });
  const g = a.glottisSrc;
  g.threshold = 1.5 * CMH2O;
  return {
    net: a.net,
    tubes: { trachea: a.trachea, pharynx: a.pharynx, oral: a.oral, nasal: a.nasal! },
    gain: 2.8e-7,
    control(p, gate) {
      a.net.setFixedPressure(a.lungs, p.pressure * CMH2O * gate);
      g.params.f0 = p.pitch;
      g.params.amplitude = 0.9 * (1 - p.hiss);
      g.params.abduction = 0.02 + 0.8 * p.hiss;
      g.params.openQuotient = 0.5;
      g.params.closureSharpness = 0.8;
      g.params.effort = 1;
      g.params.chaos = p.chaos;
      g.params.jitter = 0.01 + 0.05 * p.chaos;
      g.params.shimmer = 0.05 + 0.25 * p.chaos;
      g.params.drift = 8;
      a.net.setTubeTargets(a.pharynx, fillAreas(a.pharynx, () => 7, a.pharArea));
      const m = p.mouth;
      a.net.setTubeTargets(a.oral, fillAreas(a.oral, (u) => (u > 0.85 ? 0.05 + 12 * m : 6), a.oralArea));
      a.net.setPortTarget(a.velum, 0.4 + 1.6 * p.nostrils);
      mammalNoise(a, { glottis: 6e-6, oral: 4e-6 });
    },
    sample() {
      stepGlottis(a);
      return a.net.step();
    },
    sourceState: () => ({ glottis: Math.min(1, g.area / 1) }),
  };
}

export const ALLIGATOR: CreatureDef = {
  id: "alligator",
  name: "American alligator",
  latin: "Alligator mississippiensis",
  group: "reptile",
  blurb: "A chaotic, very low laryngeal roar through a long, closed-mouthed tract; the whole body radiates.",
  role: "Distorted sub drones, noise bass, impacts",
  oversample: 2,
  params: [
    { key: "pitch", label: "Pitch", min: 12, max: 120, default: 28, unit: "Hz", log: true, smooth: 0.05, role: "pitch" },
    { key: "chaos", label: "Bifurcation (period doubling → chaos)", min: 0, max: 1, default: 0.75, smooth: 0.05 },
    { key: "pressure", label: "Breath pressure", min: 3, max: 40, default: 18, unit: "cmH₂O", smooth: 0.03 },
    { key: "mouth", label: "Mouth opening", min: 0, max: 1, default: 0.02, smooth: 0.05 },
    { key: "nostrils", label: "Nasal passage", min: 0, max: 1, default: 0.8, smooth: 0.05 },
    { key: "hiss", label: "Hiss (open glottis)", min: 0, max: 1, default: 0, smooth: 0.04 },
  ],
  calls: [
    { id: "bellow", name: "Bellow", hint: "Two seconds of chaotic roar, rising into full chaos", pitchRef: 28, keys: [{ t: 0, v: { gate: 0, chaos: 0.55, pitch: 30, hiss: 0, mouth: 0.02 } }, { t: 0.15, v: { gate: 1 } }, { t: 1.6, v: { gate: 1, chaos: 0.95, pitch: 24 } }, { t: 2.0, v: { gate: 0 } }] },
    { id: "growl", name: "Growl", hint: "Short, rough warning", pitchRef: 45, keys: [{ t: 0, v: { gate: 1, chaos: 0.7, pitch: 45, mouth: 0.15 } }, { t: 0.5, v: { pitch: 38 } }, { t: 0.6, v: { gate: 0 } }] },
    { id: "hiss", name: "Hiss", hint: "Open mouth, open glottis: pure turbulence", keys: [{ t: 0, v: { gate: 0, hiss: 1, mouth: 0.9 } }, { t: 0.1, v: { gate: 1 } }, { t: 1.2, v: { gate: 1 } }, { t: 1.3, v: { gate: 0, hiss: 0, mouth: 0.02 } }] },
    { id: "dance", name: "Water dance", hint: "Steady subsonic throb that shakes the water", pitchRef: 18, keys: [{ t: 0, v: { gate: 1, chaos: 0, pitch: 18, mouth: 0 } }, { t: 1.6, v: { gate: 1 } }, { t: 1.7, v: { gate: 0, chaos: 0.75 } }] },
  ],
  visual: {
    view: { x0: -120, x1: 120, y0: -40, y1: 40 },
    silhouette: [[-118, 2], [-90, -4], [-60, -8], [-30, -14], [0, -16], [30, -14], [50, -10], [70, -8], [95, -5], [114, -3], [118, 0], [115, 3], [98, 5], [75, 7], [52, 9], [40, 12], [20, 14], [-10, 14], [-40, 11], [-70, 7], [-100, 4]],
    parts: [{ shade: 0.15, pts: [[54, 9], [56, 11], [58, 9], [56, 8]] }],
    tubes: [
      { tube: "trachea", path: [[0, -6], [18, -5], [36, -4]], label: "Trachea" },
      { tube: "pharynx", path: [[36, -4], [46, -2], [54, 0]], label: "Pharynx" },
      { tube: "oral", path: [[54, 0], [80, -1], [112, -1]], label: "Mouth" },
      { tube: "nasal", path: [[54, 2], [80, 4], [113, 2]], label: "Nostrils" },
    ],
    tubeScale: 1.05,
    sources: [{ key: "glottis", at: [36, -4], label: "Larynx" }],
  },
  create,
};
