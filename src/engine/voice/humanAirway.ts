/**
 * Human airway: lungs → trachea → glottis → pharynx ─┬─ oral → lips
 *                                                    └─ velum port → nasal (+maxillary sinus) → nostrils
 * plus piriform fossae (closed side branch above the epilarynx).
 * Applies HumanArtic configurations (geometry → area function → tube targets) and manages
 * the turbulence noise sources at constrictions and the teeth.
 */
import { AirwayNetwork, type Tube } from "../airway/network.ts";
import { HumanVocalTract, type HumanArtic, type HumanBody, type HumanFrame, BODY_MALE } from "../anatomy/human.ts";
import { WALL_SOFT, WALL_TRACHEA, WALL_NASAL, RHO, C_SOUND } from "../physics.ts";
import { smoothstep as smooth } from "../util/math.ts";

export interface HumanAirwayOptions {
  body?: HumanBody;
  /** internal sample rate (Hz) */
  fs: number;
}

export class HumanAirway {
  readonly net: AirwayNetwork;
  readonly tract: HumanVocalTract;
  readonly body: HumanBody;
  readonly trachea: Tube;
  readonly pharynx: Tube;
  readonly oral: Tube;
  readonly nasal: Tube;
  readonly fossa: Tube;
  readonly lungs: number;
  readonly glottisPort: number;
  readonly velumPort: number;
  readonly radLips: number;
  readonly radNose: number;
  readonly nPh: number;
  readonly nOr: number;
  readonly phAreas: Float64Array;
  readonly orAreas: Float64Array;
  readonly phMin: Float64Array;
  readonly orMin: Float64Array;
  frame: HumanFrame | null = null;
  phLen = 8.8;
  orLen = 8.3;
  /** noise gains (tunable) */
  noiseGain = { glottis: 2.4e-6, constriction: 3.0e-6, teeth: 9e-6 };

  constructor(opts: HumanAirwayOptions) {
    const body = (this.body = opts.body ?? BODY_MALE);
    const k = body.scale;
    const fs = opts.fs;
    this.tract = new HumanVocalTract(body);
    const net = (this.net = new AirwayNetwork(fs));
    const dxMin = (C_SOUND / fs) / 0.93;
    // node counts from the shortest expected lengths (larynx raised, lips retracted)
    const phMin = 8.7 * k * (0.55 + 0.45 * body.pharynx) - 1.6 * k;
    const orMin = 8.3 * k - 1.0 * k;
    this.nPh = Math.max(8, Math.floor(phMin / dxMin));
    this.nOr = Math.max(8, Math.floor(orMin / dxMin));
    this.phAreas = new Float64Array(this.nPh);
    this.orAreas = new Float64Array(this.nOr);
    this.phMin = new Float64Array(this.nPh);
    this.orMin = new Float64Array(this.nOr);

    const trLen = 12 * k;
    this.trachea = net.addTube({ name: "trachea", n: Math.max(6, Math.floor(trLen / Math.max(dxMin, 0.9 * k))), length: trLen, area: 2.5 * k * k, wall: WALL_TRACHEA });
    this.pharynx = net.addTube({ name: "pharynx", n: this.nPh, length: 8.8 * k, area: 3 * k * k, wall: WALL_SOFT, wallRadiation: 0.25, perimeterFactor: 1.25 });
    this.oral = net.addTube({ name: "oral", n: this.nOr, length: 8.3 * k, area: 3 * k * k, wall: WALL_SOFT, wallRadiation: 0.25, perimeterFactor: 1.5 });
    const naLen = 11.4 * k;
    const nNa = Math.max(8, Math.floor(naLen / Math.max(dxMin, 0.5 * k)));
    const naAreas = Array.from({ length: nNa }, (_, i) => {
      const u = (i + 0.5) / nNa;
      const a = u < 0.18 ? 2.6 : u < 0.75 ? 2.0 - 0.6 * (u - 0.18) : u < 0.9 ? 1.4 : 1.0;
      return a * k * k;
    });
    this.nasal = net.addTube({ name: "nasal", n: nNa, length: naLen, area: naAreas, wall: WALL_NASAL, perimeterFactor: 3.2, viscousFactor: 2.5 });
    this.fossa = net.addTube({ name: "piriform", n: 3, length: 2.0 * k, area: 0.9 * k * k, wall: WALL_SOFT, perimeterFactor: 1.3 });

    this.lungs = net.addPressureNode("lungs");
    const trA = 2.5 * k * k;
    net.addPort(this.lungs, this.trachea.firstNode, { area: trA, length: 1, kEntrance: 0, kExit: 0, extraResistance: (0.5 * RHO * C_SOUND) / trA });
    this.glottisPort = net.addPort(this.trachea.lastNode, this.pharynx.firstNode, { area: 0, length: 0.3 * k, kEntrance: 0.37, kExit: 1.0, slitWidth: 1.4 * k });
    net.connect(this.pharynx.lastNode, this.oral.firstNode);
    this.velumPort = net.addPort(this.pharynx.lastNode, this.nasal.firstNode, { area: 0, length: 1.0 * k, kEntrance: 0.3, kExit: 0.8 });
    // piriform fossae branch off ≈2.6 cm above the glottis
    const fossaNode = this.pharynx.node(Math.min(this.nPh - 1, Math.round((2.6 / 8.8) * this.nPh)));
    net.connect(fossaNode, this.fossa.firstNode);
    // maxillary sinus (Helmholtz) on the nasal cavity
    const sinus = net.addCavity("sinus", 14 * k * k * k, null);
    net.addPort(this.nasal.node(Math.round(nNa * 0.45)), sinus, { area: 0.12 * k * k, length: 0.5 * k, kEntrance: 0, kExit: 0, includeHalfSections: false });
    this.radLips = net.addRadiation(this.oral.lastNode);
    this.radNose = net.addRadiation(this.nasal.lastNode);
    net.finalize();
  }

  /** Internal branch index helpers */
  branchOf(t: Tube, i: number): number {
    return t.branch(Math.max(0, Math.min(t.n - 2, i)));
  }

  /** max area change rate (cm²/s, body-scaled): a physiological guard against geometric jumps */
  maxAreaRate = 160;

  /** Geometry → targets for the next block. Returns the computed frame. `dt` enables slew limiting. */
  apply(a: HumanArtic, dt = 0): HumanFrame {
    const f = (this.frame = this.tract.compute(a));
    const oldPh = dt > 0 ? Float64Array.from(this.phAreas) : null;
    const oldOr = dt > 0 ? Float64Array.from(this.orAreas) : null;
    const { phLen, orLen } = this.tract.resample(a, f, this.nPh, this.nOr, this.phAreas, this.orAreas, this.phMin, this.orMin);
    if (oldPh && oldOr) {
      const lim = this.maxAreaRate * this.body.scale * this.body.scale * dt;
      const clampArr = (cur: Float64Array, old: Float64Array, mins: Float64Array) => {
        for (let i = 0; i < cur.length; i++) {
          const d = cur[i] - old[i];
          if (d > lim) cur[i] = old[i] + lim;
          else if (d < -lim) cur[i] = old[i] - lim;
          if (mins[i] > cur[i]) mins[i] = cur[i];
        }
      };
      clampArr(this.phAreas, oldPh, this.phMin);
      clampArr(this.orAreas, oldOr, this.orMin);
    }
    this.phLen = phLen;
    this.orLen = orLen;
    this.net.setTubeTargets(this.pharynx, this.phAreas, phLen, this.phMin);
    this.net.setTubeTargets(this.oral, this.orAreas, orLen, this.orMin);
    this.net.setPortTarget(this.velumPort, f.velumPort);
    this.updateNoise(f);
    return f;
  }

  /** Register turbulence sources: glottis, narrowest supraglottal constriction, teeth obstacle. */
  private updateNoise(f: HumanFrame): void {
    const g = this.noiseGain;
    const list: { src: number; fwd: number; bwd: number; gain: number; lowpassHz?: number; highpassHz?: number }[] = [];
    // aspiration: jet from the glottis hits the epilarynx/ventricular region
    list.push({ src: this.glottisPort, fwd: this.branchOf(this.pharynx, 1), bwd: this.branchOf(this.trachea, this.trachea.n - 2), gain: g.glottis, lowpassHz: 6000, highpassHz: 500 });
    // narrowest open point in pharynx+oral (global position index p over concatenated tubes)
    const nPh = this.nPh, nOr = this.nOr;
    let minA = Infinity, minI = -1;
    for (let i = 0; i < nPh + nOr; i++) {
      const A = i < nPh ? this.phMin[i] : this.orMin[i - nPh];
      if (A > 0 && A < minA) {
        minA = A;
        minI = i;
      }
    }
    // narrowest open point: its jet makes frication noise. Every weight below is a smooth function
    // of geometry so sources fade in/out instead of toggling (toggling = audible noise bursts).
    const k2 = this.body.scale * this.body.scale;
    const wArea = minI >= 0 ? 1 - smooth(0.35 * k2, 0.9 * k2, minA) : 0;
    if (wArea > 0) {
      const dxPh = this.phLen / nPh, dxOr = this.orLen / nOr;
      const toBranch = (gi: number): number => (gi < nPh ? this.branchOf(this.pharynx, gi) : gi === nPh ? -1 : this.branchOf(this.oral, gi - nPh));
      const dx = minI < nPh ? dxPh : dxOr;
      const off = Math.max(1, Math.round((0.9 * this.body.scale) / dx));
      const src = toBranch(Math.min(minI, nPh + nOr - 2));
      const fwd = toBranch(Math.min(nPh + nOr - 2, minI + off));
      const bwd = toBranch(Math.max(0, minI - off));
      if (src >= 0 && fwd >= 0 && bwd >= 0) {
        list.push({ src, fwd, bwd, gain: g.constriction * wArea, lowpassHz: 9000, highpassHz: 700 });
        // obstacle source: a narrow anterior jet impinging on the incisors (sibilants)
        const sMin = minI < nPh ? (minI + 0.5) * dxPh : this.phLen + (minI - nPh + 0.5) * dxOr;
        const behind = (f.teethS - sMin) / this.body.scale;
        const wDist = smooth(0.15, 0.5, behind) * (1 - smooth(1.8, 3.0, behind));
        const wJet = 1 - smooth(0.12 * k2, 0.35 * k2, minA);
        const wt = wDist * wJet;
        if (wt > 1e-3) {
          const teethI = nPh + Math.min(nOr - 2, Math.max(0, Math.round((f.teethS - this.phLen) / dxOr)));
          const tb = toBranch(teethI);
          if (tb >= 0) list.push({ src, fwd: tb, bwd, gain: g.teeth * wt, lowpassHz: 11000, highpassHz: 1800 });
        }
      }
    }
    this.net.setNoiseSources(list);
  }
}
