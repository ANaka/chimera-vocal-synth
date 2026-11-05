/**
 * African elephant: infrasonic rumbles from self-oscillating vocal folds, routed through the trunk
 * or the mouth; trumpets from a valve at the trunk entrance that locks onto the trunk's resonances
 * like a brass player's lips on a bugle; squeaks from tensed lips.
 */
import type { CreatureDef, CreatureSim } from "./types.ts";
import { mammalAirway, stepGlottis, mammalNoise } from "./mammal.ts";
import { fillAreas, tube, CMH2O } from "./build.ts";
import { LipReed } from "../sources/valves.ts";
import { WALL_NASAL } from "../physics.ts";
import type { Tube } from "../airway/network.ts";

function create(fs: number): CreatureSim {
  let trunk: Tube | null = null;
  let valve = -1;
  const a = mammalAirway(fs, { trachea: [45, 14], pharynx: [32, 14], oral: [28, 10], nasal: [14, 6], wallRadiation: 0.6, coarse: 1.2, nasalRadiates: false }, (net, parts) => {
    // the "nasal" tube is the trunk base; a lip-like valve leads into the long trunk
    trunk = tube(net, "trunk", fs, 185, (u) => 4.2 - 3.0 * u, { wall: WALL_NASAL, coarse: 2.3, max: 110, perimeterFactor: 1.4 });
    valve = net.addPort(parts.nasal!.lastNode, (trunk as Tube).firstNode, { area: 0, length: 0.6, kEntrance: 0.3, kExit: 1 });
    net.addRadiation((trunk as Tube).lastNode);
  });
  const trunkTube = trunk as unknown as Tube;
  const lips = new LipReed(fs);
  const g = a.glottisSrc;
  g.threshold = 1.5 * CMH2O;
  let mode = 0;
  return {
    net: a.net,
    tubes: { trachea: a.trachea, pharynx: a.pharynx, oral: a.oral, trunk: trunkTube },
    gain: 1.8e-6,
    control(p, gate) {
      mode = p.mode;
      a.net.setFixedPressure(a.lungs, p.pressure * CMH2O * gate);
      // rumble: folds vibrate; trumpet: folds open, valve buzzes
      g.params.f0 = p.pitch;
      g.params.amplitude = 1.6 * (1 - mode);
      g.params.abduction = 0.05 + 3.0 * mode; // trumpet: larynx wide open, silent
      g.params.openQuotient = 0.6;
      g.params.closureSharpness = 0.6;
      g.params.effort = 0.9;
      g.params.chaos = p.chaos * 0.6;
      lips.f = p.lipPitch;
      lips.zeta = 0.08;
      lips.h0 = 0.003; // a slight rest gap: buzzing lips start from just apart
      lips.width = 2.4;
      lips.surfacePerMass = 40;
      const toTrunk = p.trunk;
      a.net.setPortTarget(a.velum, 0.1 + 6 * toTrunk);
      a.net.setTubeTargets(a.pharynx, fillAreas(a.pharynx, () => 14, a.pharArea));
      a.net.setTubeTargets(a.oral, fillAreas(a.oral, (u) => (u > 0.85 ? 0.05 + 10 * (1 - toTrunk) : 10), a.oralArea));
      mammalNoise(a, { glottis: 4e-7 * (1 - mode) });
    },
    sample() {
      stepGlottis(a);
      if (mode > 0.02) {
        const p = a.net.p;
        const dp = p[a.nasal!.lastNode] - p[trunkTube.firstNode];
        const open = lips.next(dp * mode);
        a.net.setPortArea(valve, Math.max(open, 4.5 * (1 - mode)));
      } else a.net.setPortArea(valve, 4.5);
      return a.net.step();
    },
    sourceState: () => ({ glottis: Math.min(1, g.area / 1.6), lips: Math.min(1, lips.opening / 1.2) }),
  };
}

export const ELEPHANT: CreatureDef = {
  id: "elephant",
  name: "African elephant",
  latin: "Loxodonta africana",
  group: "mammal",
  blurb: "Infrasonic rumbles from huge vocal folds, routed through a two-metre trunk or the mouth; trumpets from a buzzing valve at the trunk entrance.",
  role: "Sub-bass rumbles, distorted brass leads",
  oversample: 1,
  params: [
    { key: "mode", label: "Rumble ↔ trumpet", min: 0, max: 1, default: 0, smooth: 0.03 },
    { key: "pitch", label: "Rumble pitch", min: 8, max: 45, default: 14, unit: "Hz", log: true, smooth: 0.05, role: "pitch" },
    { key: "lipPitch", label: "Trumpet valve pitch", min: 150, max: 900, default: 470, unit: "Hz", log: true, smooth: 0.02 },
    { key: "pressure", label: "Breath pressure", min: 3, max: 45, default: 16, unit: "cmH₂O", smooth: 0.02 },
    { key: "trunk", label: "Mouth ↔ trunk", min: 0, max: 1, default: 1, smooth: 0.04 },
    { key: "chaos", label: "Chaos", min: 0, max: 1, default: 0.2, smooth: 0.05 },
  ],
  calls: [
    { id: "rumble", name: "Rumble", hint: "Three seconds of infrasonic rumble through the trunk", pitchRef: 14, keys: [{ t: 0, v: { mode: 0, gate: 0, pitch: 15, trunk: 1 } }, { t: 0.3, v: { gate: 1 } }, { t: 2.7, v: { gate: 1, pitch: 12 } }, { t: 3.1, v: { gate: 0 } }] },
    { id: "trumpet", name: "Trumpet", hint: "A brassy blast that bends up and breaks into chaos", pitchRef: 470, keys: [{ t: 0, v: { mode: 1, gate: 0, lipPitch: 380, pressure: 26, chaos: 0.1 } }, { t: 0.05, v: { gate: 1 } }, { t: 0.5, v: { lipPitch: 520 }, curve: "exp" }, { t: 1.1, v: { lipPitch: 470, chaos: 0.6, pressure: 34 }, curve: "exp" }, { t: 1.25, v: { gate: 0, mode: 0, pressure: 16 } }] },
    { id: "squeak", name: "Squeak", hint: "Tensed, high valve buzz", pitchRef: 850, keys: [{ t: 0, v: { mode: 1, gate: 0, lipPitch: 820, pressure: 20 } }, { t: 0.04, v: { gate: 1 } }, { t: 0.45, v: { lipPitch: 880 } }, { t: 0.5, v: { gate: 0, mode: 0, pressure: 16 } }] },
  ],
  visual: {
    view: { x0: -170, x1: 170, y0: -170, y1: 130 },
    silhouette: [[-160, 20], [-150, 70], [-110, 105], [-40, 118], [30, 115], [70, 100], [95, 112], [120, 108], [140, 85], [148, 55], [146, 25], [140, 5], [132, -20], [128, -60], [122, -110], [118, -150], [108, -152], [112, -100], [110, -50], [104, -20], [96, -5], [80, 0], [70, -10], [66, -90], [40, -95], [44, -30], [-90, -30], [-95, -95], [-125, -95], [-122, -10], [-150, -5]],
    parts: [{ shade: 0.15, pts: [[118, 62], [122, 66], [126, 62], [122, 58]] }, { shade: 0.62, pts: [[70, 100], [40, 60], [55, 25], [85, 40], [95, 80]] }],
    tubes: [
      { tube: "trachea", path: [[40, 20], [70, 30], [95, 38]], label: "Trachea" },
      { tube: "pharynx", path: [[95, 38], [112, 50], [124, 58]], label: "Pharynx" },
      { tube: "oral", path: [[124, 58], [130, 42], [134, 30]], label: "Mouth" },
      { tube: "trunk", path: [[136, 70], [142, 40], [136, 0], [128, -50], [120, -100], [113, -148]], label: "Trunk" },
    ],
    tubeScale: 3,
    sources: [{ key: "glottis", at: [95, 38], label: "Vocal folds" }, { key: "lips", at: [136, 70], label: "Trunk valve" }],
  },
  create,
};
