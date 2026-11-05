/**
 * Weddell seal: male trills sweep down over seconds from several kHz to below 100 Hz while their
 * pulse rate also slows — researchers compared them to ARP synthesizers. Modelled as a laryngeal
 * source with an extreme pitch range, a pulse (amplitude) oscillator, and a short tract.
 */
import type { CreatureDef, CreatureSim } from "./types.ts";
import { mammalAirway, stepGlottis, mammalNoise } from "./mammal.ts";
import { fillAreas, CMH2O } from "./build.ts";

function create(fs: number): CreatureSim {
  const a = mammalAirway(fs, { trachea: [24, 4], pharynx: [11, 3.2], oral: [12, 3.6], nasal: [12, 1.5], wallRadiation: 0.6 });
  const g = a.glottisSrc;
  g.params.jitter = 0.002;
  g.params.shimmer = 0.01;
  g.params.drift = 2;
  let pulsePhase = 0;
  let pulseGate = 1;
  return {
    net: a.net,
    tubes: { trachea: a.trachea, pharynx: a.pharynx, oral: a.oral },
    gain: 6.4e-8,
    control(p, gate, dt) {
      pulsePhase += p.pulseRate * dt;
      pulsePhase -= Math.floor(pulsePhase);
      const ph = pulsePhase < p.duty ? Math.sin((Math.PI * pulsePhase) / p.duty) : 0;
      pulseGate = 1 - p.pulse + p.pulse * ph;
      a.net.setFixedPressure(a.lungs, p.pressure * CMH2O * gate * pulseGate);
      g.params.f0 = p.pitch;
      g.params.amplitude = 0.22;
      g.params.openQuotient = 0.55 - 0.25 * p.bright;
      g.params.closureSharpness = 0.4 + 0.6 * p.bright;
      g.params.effort = 0.5 + 0.5 * p.bright;
      g.params.chink = 0.01;
      g.params.chaos = p.rough;
      const mouth = p.mouth;
      a.net.setTubeTargets(a.pharynx, fillAreas(a.pharynx, () => 3.0, a.pharArea));
      a.net.setTubeTargets(a.oral, fillAreas(a.oral, (u) => (u > 0.8 ? 0.3 + 4 * mouth : 3.6), a.oralArea));
      mammalNoise(a, { glottis: 2e-6 });
    },
    sample() {
      stepGlottis(a);
      return a.net.step();
    },
    sourceState: () => ({ glottis: Math.min(1, g.area / 0.3) }),
  };
}

export const SEAL: CreatureDef = {
  id: "seal",
  name: "Weddell seal",
  latin: "Leptonychotes weddellii",
  group: "marine",
  blurb: "Laryngeal calls with an extreme range: trills glide down for seconds while their pulses slow.",
  role: "Downlifters, laser zaps, acid-style sweeping leads",
  oversample: 2,
  gateTimes: { attack: 0.006, release: 0.03 },
  params: [
    { key: "pitch", label: "Pitch", min: 40, max: 6000, default: 900, unit: "Hz", log: true, smooth: 0.01, role: "pitch" },
    { key: "pulseRate", label: "Pulse rate", min: 2, max: 60, default: 18, unit: "Hz", log: true, smooth: 0.02 },
    { key: "pulse", label: "Pulsing depth", min: 0, max: 1, default: 0.6, smooth: 0.02 },
    { key: "duty", label: "Pulse duty", min: 0.15, max: 1, default: 0.55, smooth: 0.02 },
    { key: "bright", label: "Brightness", min: 0, max: 1, default: 0.6, smooth: 0.02 },
    { key: "rough", label: "Roughness", min: 0, max: 0.8, default: 0.05, smooth: 0.05 },
    { key: "pressure", label: "Breath pressure", min: 2, max: 25, default: 10, unit: "cmH₂O", smooth: 0.01 },
    { key: "mouth", label: "Mouth opening", min: 0, max: 1, default: 0.35, smooth: 0.03 },
  ],
  calls: [
    { id: "trill", name: "Descending trill", hint: "Several seconds falling from bright to subsonic, pulses slowing", pitchRef: 3600, keys: [{ t: 0, v: { gate: 1, pitch: 3600, pulseRate: 42, pulse: 0.9, duty: 0.5 } }, { t: 3.6, v: { gate: 1, pitch: 95, pulseRate: 6 }, curve: "exp" }, { t: 3.9, v: { gate: 0 } }] },
    { id: "zap", name: "Laser chirp", hint: "A 150 ms downward zap", pitchRef: 6000, keys: [{ t: 0, v: { gate: 1, pitch: 6000, pulse: 0 } }, { t: 0.15, v: { pitch: 1100 }, curve: "exp" }, { t: 0.17, v: { gate: 0 } }] },
    { id: "whistle", name: "U whistle", hint: "Dips and returns", pitchRef: 1700, keys: [{ t: 0, v: { gate: 1, pitch: 1700, pulse: 0.1 } }, { t: 0.45, v: { pitch: 620 }, curve: "exp" }, { t: 0.95, v: { pitch: 1500 }, curve: "exp" }, { t: 1.0, v: { gate: 0 } }] },
    { id: "chug", name: "Chug", hint: "Low, pulsed grunt", pitchRef: 90, keys: [{ t: 0, v: { gate: 1, pitch: 90, pulseRate: 11, pulse: 1, duty: 0.35, rough: 0.3 } }, { t: 0.9, v: { gate: 1 } }, { t: 0.95, v: { gate: 0, rough: 0.05 } }] },
  ],
  visual: {
    view: { x0: -60, x1: 60, y0: -30, y1: 30 },
    silhouette: [[-58, -2], [-50, -8], [-30, -14], [-5, -16], [20, -14], [38, -10], [48, -6], [55, -3], [58, 1], [56, 5], [50, 8], [42, 10], [30, 11], [10, 13], [-15, 13], [-35, 10], [-50, 6], [-56, 3], [-62, 8], [-64, 4], [-60, 0], [-64, -4], [-62, -8]],
    parts: [{ shade: 0.15, pts: [[47, 4], [48.5, 5], [50, 4], [48.5, 3]] }],
    tubes: [
      { tube: "trachea", path: [[8, -4], [20, -3], [30, -2]], label: "Trachea" },
      { tube: "pharynx", path: [[30, -2], [38, 0], [44, 1.5]], label: "Pharynx" },
      { tube: "oral", path: [[44, 1.5], [50, 0.5], [57, -0.5]], label: "Mouth" },
    ],
    tubeScale: 1.3,
    sources: [{ key: "glottis", at: [30, -2], label: "Larynx" }],
  },
  create,
};
