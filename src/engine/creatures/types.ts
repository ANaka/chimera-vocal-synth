/** Creature definitions: physics (airway + sources), playable parameters, calls, and drawing. */
import type { AirwayNetwork, Tube } from "../airway/network.ts";

export type CreatureGroup = "human" | "bird" | "mammal" | "marine" | "reptile" | "amphibian" | "insect" | "crustacean" | "fantasy";

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  log?: boolean;
  /** smoothing time constant (s) */
  smooth?: number;
  /** "pitch" params follow the keyboard */
  role?: "pitch";
  /** decimals for display */
  digits?: number;
}

export interface CallKey {
  t: number;
  v: Record<string, number>;
  /** interpolation from the previous key: linear (default), exponential (for frequencies), or step */
  curve?: "lin" | "exp" | "step";
}

export interface CallDef {
  id: string;
  name: string;
  hint: string;
  keys: CallKey[];
  /** pitch params in the call are scaled by playedPitch / pitchRef when triggered from the keys */
  pitchRef?: number;
}

export interface CreatureVisual {
  /** body outline in drawing units (≈ cm; y up) */
  silhouette: [number, number][];
  /** extra shapes drawn in tissue tones (shade 0 black … 1 white) */
  parts?: { shade: number; pts: [number, number][]; stroke?: boolean }[];
  /** airway centrelines per tube name (tube nodes are distributed along the path); inView: false
   *  keeps the label out of the cross-section (it still names the tube's lane) */
  tubes: { tube: string; path: [number, number][]; label?: string; inView?: boolean }[];
  /** how much wider than life to draw the airway (narrow tubes stay legible) */
  tubeScale?: number;
  /** drawing extents */
  view: { x0: number; x1: number; y0: number; y1: number };
  /** sound sources to draw, keyed into CreatureSim.sourceState() */
  sources?: { key: string; at: [number, number]; label: string }[];
}

export interface CreatureSim {
  readonly net: AirwayNetwork | null;
  /** tubes exposed to telemetry/visuals, by name */
  readonly tubes: Record<string, Tube>;
  /** control-rate update with smoothed parameters; gate 0..1 is the breath */
  control(p: Record<string, number>, gate: number, dt: number): void;
  /** one internal sample → radiated output (arbitrary units) */
  sample(): number;
  /** fixed output normalisation */
  readonly gain: number;
  /** a few named source values for the source glyph (0..1) */
  sourceState?(): Record<string, number>;
  /** discrete events from calls (e.g. clicks, snaps) */
  trigger?(name: string, amount: number): void;
}

export interface CreatureDef {
  id: string;
  name: string;
  latin: string;
  group: CreatureGroup;
  /** how it makes sound, one sentence */
  blurb: string;
  /** musical role in a track */
  role: string;
  /** internal oversampling factor relative to the output rate */
  oversample: number;
  /** breath gate attack/release time constants (s) */
  gateTimes?: { attack: number; release: number };
  params: ParamDef[];
  calls: CallDef[];
  visual: CreatureVisual;
  create(fs: number): CreatureSim;
}
