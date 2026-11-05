/** Parametrised mammalian/reptilian airway: lungs → trachea → glottis → pharynx ─┬─ oral → mouth
 *                                                                             └─ velum → nasal → nostrils */
import { AirwayNetwork, type Tube } from "../airway/network.ts";
import { WALL_SOFT, WALL_TRACHEA, WALL_NASAL, type WallParams } from "../physics.ts";
import { ParametricGlottis } from "../sources/glottis.ts";
import { tube, lungs } from "./build.ts";

export interface MammalSpec {
  trachea: [length: number, area: number];
  pharynx: [length: number, area: number];
  oral: [length: number, area: number];
  nasal?: [length: number, area: number];
  wall?: WallParams;
  /** fraction of wall motion that radiates (body/skin radiation) */
  wallRadiation?: number;
  /** coarse sections for very long tubes (×dxMin) */
  coarse?: number;
  /** the nasal tube ends in nostrils (default) or continues into something else (trunk) */
  nasalRadiates?: boolean;
}

export interface MammalAirway {
  net: AirwayNetwork;
  trachea: Tube;
  pharynx: Tube;
  oral: Tube;
  nasal: Tube | null;
  lungs: number;
  glottis: number;
  velum: number;
  glottisSrc: ParametricGlottis;
  pharArea: Float64Array;
  oralArea: Float64Array;
}

export function mammalAirway(fs: number, s: MammalSpec, extra?: (net: AirwayNetwork, a: Omit<MammalAirway, "glottisSrc" | "pharArea" | "oralArea" | "lungs" | "glottis" | "velum"> & { lungs?: number }) => void): MammalAirway {
  const net = new AirwayNetwork(fs);
  const wall = s.wall ?? WALL_SOFT;
  const coarse = s.coarse ?? 1;
  const trachea = tube(net, "trachea", fs, s.trachea[0], s.trachea[1], { wall: WALL_TRACHEA, coarse: Math.max(coarse, 1.6), max: 60 });
  const pharynx = tube(net, "pharynx", fs, s.pharynx[0], s.pharynx[1], { wall, coarse, wallRadiation: s.wallRadiation ?? 0.25, perimeterFactor: 1.3 });
  const oral = tube(net, "oral", fs, s.oral[0], s.oral[1], { wall, coarse, wallRadiation: s.wallRadiation ?? 0.25, perimeterFactor: 1.5 });
  const nasal = s.nasal ? tube(net, "nasal", fs, s.nasal[0], s.nasal[1], { wall: WALL_NASAL, coarse, perimeterFactor: 2.6, viscousFactor: 2 }) : null;
  const lungNode = lungs(net, trachea.firstNode, s.trachea[1]);
  const glottis = net.addPort(trachea.lastNode, pharynx.firstNode, { area: 0, length: 0.4, kEntrance: 0.37, kExit: 1, slitWidth: Math.sqrt(s.trachea[1]) * 0.9 });
  net.connect(pharynx.lastNode, oral.firstNode);
  const velum = nasal ? net.addPort(pharynx.lastNode, nasal.firstNode, { area: 0, length: 1, kEntrance: 0.3, kExit: 0.8 }) : -1;
  net.addRadiation(oral.lastNode);
  if (nasal && s.nasalRadiates !== false) net.addRadiation(nasal.lastNode);
  extra?.(net, { net, trachea, pharynx, oral, nasal });
  net.finalize();
  return { net, trachea, pharynx, oral, nasal, lungs: lungNode, glottis, velum, glottisSrc: new ParametricGlottis(fs), pharArea: new Float64Array(pharynx.n), oralArea: new Float64Array(oral.n) };
}

/**
 * Register turbulence sources: aspiration at the glottis (hiss, breathiness) and the narrowest
 * point of the oral tube (mouth/teeth hiss). Call at control rate.
 */
export function mammalNoise(a: MammalAirway, gains: { glottis: number; oral?: number }): void {
  const list: { src: number; fwd: number; bwd: number; gain: number; lowpassHz?: number; highpassHz?: number }[] = [
    { src: a.glottis, fwd: a.pharynx.branch(Math.min(1, a.pharynx.n - 2)), bwd: a.trachea.branch(a.trachea.n - 2), gain: gains.glottis, lowpassHz: 4000, highpassHz: 250 },
  ];
  if (gains.oral) {
    let mi = 0, mv = Infinity;
    for (let i = 0; i < a.oral.n - 1; i++) {
      const v = a.oralArea[i];
      if (v > 0 && v < mv) {
        mv = v;
        mi = i;
      }
    }
    if (mv < 2) list.push({ src: a.oral.branch(mi), fwd: a.oral.branch(Math.min(a.oral.n - 2, mi + 1)), bwd: a.oral.branch(Math.max(0, mi - 1)), gain: gains.oral, lowpassHz: 5000, highpassHz: 600 });
  }
  a.net.setNoiseSources(list);
}

/** Drive the glottal port from its source for one sample. */
export function stepGlottis(a: MammalAirway): void {
  const p = a.net.p;
  a.net.setPortArea(a.glottis, a.glottisSrc.next(p[a.trachea.lastNode] - p[a.pharynx.firstNode]));
}
