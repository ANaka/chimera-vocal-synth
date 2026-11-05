/** Shared helpers for building creature airways. */
import { AirwayNetwork, type Tube } from "../airway/network.ts";
import { C_SOUND, RHO, type WallParams } from "../physics.ts";

/** Smallest stable section length at this internal rate (CFL 0.93). */
export const dxMin = (fs: number) => C_SOUND / fs / 0.93;

/** Number of sections for a tube: as fine as stability allows, but at least `min`, at most `max`. */
export function sections(fs: number, length: number, min = 3, max = 120, coarse = 1): number {
  return Math.max(min, Math.min(max, Math.floor(length / (dxMin(fs) * coarse))));
}

export function tube(net: AirwayNetwork, name: string, fs: number, length: number, area: number | ((u: number) => number), opts: { wall?: WallParams | null; coarse?: number; min?: number; max?: number; perimeterFactor?: number; viscousFactor?: number; wallRadiation?: number } = {}): Tube {
  const n = sections(fs, length, opts.min ?? 3, opts.max ?? 120, opts.coarse ?? 1);
  const areas = typeof area === "number" ? area : Array.from({ length: n }, (_, i) => area((i + 0.5) / n));
  return net.addTube({ name, n, length, area: areas, wall: opts.wall ?? null, perimeterFactor: opts.perimeterFactor, viscousFactor: opts.viscousFactor, wallRadiation: opts.wallRadiation });
}

/** Lungs/air-sac pressure node feeding a tube through a mildly resistive connection. */
export function lungs(net: AirwayNetwork, into: number, area: number): number {
  const node = net.addPressureNode("lungs");
  net.addPort(node, into, { area, length: 1, kEntrance: 0, kExit: 0, extraResistance: (0.5 * RHO * C_SOUND) / area });
  return node;
}

/** Fill a tube's areas from a function of position u ∈ (0,1). */
export function fillAreas(t: Tube, f: (u: number) => number, out: Float64Array): Float64Array {
  for (let i = 0; i < t.n; i++) out[i] = Math.max(0, f((i + 0.5) / t.n));
  return out;
}

export const CMH2O = 980.665;
