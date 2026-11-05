/**
 * Main-thread acoustic model mirroring the worklet's airway (same topology & node counts):
 * geometry frames for drawing, frequency-domain transfer function and formants for display,
 * and vowel-space interpolation for the vowel map. Never runs inside the audio thread.
 */
import { HumanAirway } from "../engine/voice/humanAirway.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD, NEUTRAL, type HumanArtic, type HumanBody, type HumanFrame } from "../engine/anatomy/human.ts";
import { transferFunction, findPeaks } from "../engine/airway/frequency.ts";
import { ARTIC_KEYS } from "../engine/control/articulators.ts";
import { VOWELS } from "../engine/phonetics/vowelData.ts";
import targets from "../engine/phonetics/vowelTargets.generated.json";
import type { BodyName } from "../worklet/protocol.ts";

export const BODIES: Record<BodyName, HumanBody> = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD };

type TargetTable = Record<string, Record<string, { artic: Partial<HumanArtic>; formants: number[] }>>;
const TARGETS = targets as unknown as TargetTable;

export interface VowelPoint {
  ipa: string;
  example: string;
  F1: number;
  F2: number;
  artic: Partial<HumanArtic>;
}

const FREQS = (() => {
  const n = 360;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 60 * Math.pow(8000 / 60, i / (n - 1));
  return out;
})();

export class VoiceModel {
  readonly body: BodyName;
  readonly airway: HumanAirway;
  readonly vowels: VowelPoint[];
  private cacheKey = "";
  private cacheFrame: HumanFrame | null = null;
  private tfKey = "";
  private tf: { freqs: Float64Array; db: Float64Array; formants: number[] } | null = null;

  constructor(body: BodyName, sampleRate: number) {
    this.body = body;
    const M = sampleRate > 60000 ? 1 : 2;
    this.airway = new HumanAirway({ fs: sampleRate * M, body: BODIES[body] });
    const table = TARGETS[body] ?? {};
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
      this.cacheFrame = this.airway.tract.compute(a);
      this.cacheKey = key;
    }
    return this.cacheFrame;
  }

  /** Transfer function (dB) + formants for an articulation (cached on a coarse key). */
  transfer(a: HumanArtic): { freqs: Float64Array; db: Float64Array; formants: number[] } {
    const key = ARTIC_KEYS.map((k) => a[k].toFixed(2)).join(",");
    if (key === this.tfKey && this.tf) return this.tf;
    this.airway.apply(a);
    const el = this.airway.net.linearElements();
    const H = transferFunction(el, this.airway.pharynx.firstNode, FREQS, [this.airway.glottisPort]);
    const db = new Float64Array(FREQS.length);
    for (let i = 0; i < FREQS.length; i++) db[i] = 20 * Math.log10(H.mag[i] + 1e-12);
    const formants = findPeaks(FREQS, H.mag, 150).map((p) => p.freq).slice(0, 5);
    this.tf = { freqs: FREQS, db, formants };
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
    const nPh = this.airway.nPh, nOr = this.airway.nOr;
    const s = new Float64Array(nPh + nOr);
    for (let i = 0; i < nPh; i++) s[i] = ((i + 0.5) / nPh) * phLen;
    for (let i = 0; i < nOr; i++) s[nPh + i] = phLen + ((i + 0.5) / nOr) * orLen;
    return s;
  }

  /** s-position of a noise-source branch index (pharynx/oral internal branches) */
  branchS(branch: number, phLen: number, orLen: number): number {
    const ph = this.airway.pharynx, or = this.airway.oral;
    if (branch >= ph.branchBase && branch < ph.branchBase + ph.n - 1) return ((branch - ph.branchBase + 1) / ph.n) * phLen;
    if (branch >= or.branchBase && branch < or.branchBase + or.n - 1) return phLen + ((branch - or.branchBase + 1) / or.n) * orLen;
    if (branch === this.airway.glottisPort) return 0.2;
    return -1;
  }
}
