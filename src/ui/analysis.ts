/**
 * Main-thread acoustic model mirroring the worklet's airway (same topology & node counts, in the
 * engine): geometry frames for drawing, the transfer function and formants for display, and
 * vowel-space interpolation for the vowel map. Never runs inside the audio thread.
 */
import { airwayModel, airwayFrame, airwayAreas, airwayTransfer, TractMap, BODY_MALE, BODY_FEMALE, BODY_CHILD, NEUTRAL, ARTIC_KEYS, VOWELS, VOWEL_TARGETS, type AirwayModel, type HumanArtic, type HumanBody, type HumanFrame } from "../wasm/engine.ts";
import type { BodyName } from "../worklet/protocol.ts";

export const BODIES: Record<BodyName, HumanBody> = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD };

export interface VowelPoint {
  ipa: string;
  example: string;
  F1: number;
  F2: number;
  artic: Partial<HumanArtic>;
}

export class VoiceModel {
  readonly body: BodyName;
  /** the body's dimensions */
  readonly bodyParams: HumanBody;
  /** template ↔ body coordinates */
  readonly tract: TractMap;
  readonly vowels: VowelPoint[];
  readonly nPh: number;
  readonly nOr: number;
  private readonly model: AirwayModel;
  private cacheKey = "";
  private cacheFrame: HumanFrame | null = null;
  private tfKey = "";
  private tf: { freqs: number[]; db: number[]; formants: number[] } | null = null;

  constructor(body: BodyName, sampleRate: number) {
    this.body = body;
    this.bodyParams = BODIES[body];
    this.tract = new TractMap(this.bodyParams);
    this.model = airwayModel(body, sampleRate);
    this.nPh = this.model.nPh;
    this.nOr = this.model.nOr;
    const table = VOWEL_TARGETS[body] ?? {};
    this.vowels = VOWELS.filter((v) => table[v.ipa]).map((v) => ({
      ipa: v.ipa,
      example: v.example,
      F1: table[v.ipa].formants[0],
      F2: table[v.ipa].formants[1],
      artic: table[v.ipa].artic,
    }));
  }

  static articFromArray(arr: ArrayLike<number>): HumanArtic {
    const a = { ...NEUTRAL };
    ARTIC_KEYS.forEach((k, i) => (a[k] = arr[i]));
    return a;
  }

  frame(a: HumanArtic): HumanFrame {
    const key = ARTIC_KEYS.map((k) => a[k].toFixed(3)).join(",");
    if (key !== this.cacheKey || !this.cacheFrame) {
      this.cacheFrame = airwayFrame(this.model, a);
      this.cacheKey = key;
    }
    return this.cacheFrame;
  }

  /** The area function the worklet's airway would get for this articulation. */
  areas(a: HumanArtic): { phAreas: number[]; orAreas: number[]; phLen: number; orLen: number } {
    return airwayAreas(this.model, a);
  }

  /** Transfer function (dB) + formants for an articulation (cached on a coarse key). */
  transfer(a: HumanArtic): { freqs: number[]; db: number[]; formants: number[] } {
    const key = ARTIC_KEYS.map((k) => a[k].toFixed(2)).join(",");
    if (key === this.tfKey && this.tf) return this.tf;
    this.tf = airwayTransfer(this.model, a);
    this.tfKey = key;
    return this.tf;
  }

  /** Blend calibrated vowel articulations for a point in (F1, F2) space (inverse-distance, log Hz). */
  articForFormants(F1: number, F2: number): Partial<HumanArtic> {
    const w: { v: VowelPoint; w: number }[] = this.vowels.map((v) => {
      const d1 = Math.log(F1 / v.F1) * 2.2; // F1 differences are perceptually larger
      const d2 = Math.log(F2 / v.F2);
      const d = Math.hypot(d1, d2);
      return { v, w: 1 / Math.pow(d + 0.02, 3) };
    });
    w.sort((p, q) => q.w - p.w);
    const top = w.slice(0, 4);
    const sum = top.reduce((s, x) => s + x.w, 0);
    const keys = ["tbX", "tbY", "jaw", "lipAp", "lipProt", "lipWidth", "root", "larynx", "ttCurl"] as const;
    const out: Partial<HumanArtic> = {};
    for (const k of keys) {
      let acc = 0;
      for (const { v, w: wi } of top) acc += ((v.artic[k] as number | undefined) ?? NEUTRAL[k]) * wi;
      out[k] = acc / sum;
    }
    return out;
  }

  /** s-position (cm from glottis) of each tract node in the telemetry arrays */
  nodeS(phLen: number, orLen: number): Float64Array {
    const nPh = this.nPh, nOr = this.nOr;
    const s = new Float64Array(nPh + nOr);
    for (let i = 0; i < nPh; i++) s[i] = ((i + 0.5) / nPh) * phLen;
    for (let i = 0; i < nOr; i++) s[nPh + i] = phLen + ((i + 0.5) / nOr) * orLen;
    return s;
  }

  /** s-position of a noise-source branch index (pharynx/oral internal branches) */
  branchS(branch: number, phLen: number, orLen: number): number {
    const ph = this.model.pharynxBranches, or = this.model.oralBranches;
    if (branch >= ph.base && branch < ph.base + ph.n - 1) return ((branch - ph.base + 1) / ph.n) * phLen;
    if (branch >= or.base && branch < or.base + or.n - 1) return phLen + ((branch - or.base + 1) / or.n) * orLen;
    if (branch === this.model.glottisPort) return 0.2;
    return -1;
  }
}
