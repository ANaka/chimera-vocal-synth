/**
 * Segment sequence → gestural score. Timing and phonation are articulatory: aspiration is a
 * glottal opening gesture peaking at the release (VOT emerges), nasality is velum lowering with
 * anticipation, coarticulation comes from overlapping vowel gestures beneath consonant gestures.
 */
import type { Gesture } from "../control/score.ts";
import type { HumanArtic } from "../anatomy/human.ts";
import { phoneme, type PhonemeDef } from "./inventory.ts";
import vowelTable from "./vowelTargets.generated.json";

export interface Segment {
  ipa: string;
  /** duration override (s) */
  dur?: number;
  /** 0 unstressed, 1 primary, 2 secondary */
  stress?: number;
  /** explicit pitch (Hz) for this segment (singing) */
  f0?: number;
  /** word boundary after this segment */
  wordEnd?: boolean;
}

export interface PlanOptions {
  body: string;
  /** voice-clock start time (s) */
  t0: number;
  /** speaking-rate multiplier (>1 = faster) */
  rate?: number;
  /** baseline pitch (Hz) */
  f0?: number;
  /** "statement" (final fall) or "question" (final rise) */
  intonation?: "statement" | "question" | "flat";
  /** pitch excursion for stressed syllables (fraction) */
  accent?: number;
}

export interface PlannedSegment {
  ipa: string;
  t0: number;
  t1: number;
  kind: string;
}

export interface Plan {
  gestures: Gesture[];
  segments: PlannedSegment[];
  end: number;
}

const VOWEL_KEYS = ["tbX", "tbY", "jaw", "lipAp", "lipProt", "lipWidth", "root", "larynx", "ttCurl"] as const;
type VTable = Record<string, Record<string, { artic: Partial<HumanArtic> }>>;
const VT = vowelTable as unknown as VTable;

/** Diphthongs and r-coloured vowels expand to vowel sequences. */
const EXPAND: Record<string, string[]> = {
  aɪ: ["a", "ɪ"],
  aʊ: ["a", "ʊ"],
  ɔɪ: ["ɔ", "ɪ"],
  eɪ: ["e", "ɪ"],
  oʊ: ["o", "ʊ"],
  ɚ: ["ɝ"],
};

export function isVowel(ipa: string, body = "male"): boolean {
  return !!VT[body]?.[ipa] || ipa in EXPAND;
}

export function vowelArtic(ipa: string, body: string): Partial<HumanArtic> | null {
  const v = VT[body]?.[ipa] ?? VT.male?.[ipa];
  if (!v) return null;
  const out: Partial<HumanArtic> = {};
  for (const k of VOWEL_KEYS) if (v.artic[k] !== undefined) out[k] = v.artic[k] as number;
  return out;
}

export function planUtterance(input: Segment[], o: PlanOptions): Plan {
  const rate = o.rate ?? 1;
  const body = o.body;
  // expand diphthongs into two vowel targets sharing the duration
  const segs: (Segment & { def?: PhonemeDef; vowel?: Partial<HumanArtic>; glideFrom?: boolean })[] = [];
  for (const s of input) {
    if (EXPAND[s.ipa]) {
      const parts = EXPAND[s.ipa];
      const base = s.dur ?? (s.stress ? 0.2 : 0.14);
      parts.forEach((p, i) => segs.push({ ...s, ipa: p, dur: parts.length > 1 ? base * (i === 0 ? 0.55 : 0.45) : base, glideFrom: i > 0, wordEnd: i === parts.length - 1 ? s.wordEnd : false }));
    } else segs.push({ ...s });
  }
  for (const s of segs) {
    const v = vowelArtic(s.ipa, body);
    if (v) s.vowel = v;
    else s.def = phoneme(s.ipa, body);
  }
  const gestures: Gesture[] = [];
  const planned: PlannedSegment[] = [];
  let t = o.t0 + 0.06; // breath onset lead
  const times: { t0: number; t1: number }[] = [];
  for (const s of segs) {
    let d: number;
    if (s.dur !== undefined) d = s.dur;
    else if (s.vowel) d = s.stress === 1 ? 0.17 : s.stress === 2 ? 0.13 : 0.095;
    else d = s.def?.dur ?? 0.08;
    // final lengthening on the last syllable rhyme
    d /= rate;
    times.push({ t0: t, t1: t + d });
    t += d;
  }
  const end = t;
  // ---- vowel gestures: overlap neighbours so the tongue travels vowel-to-vowel
  const vIdx = segs.map((s, i) => (s.vowel ? i : -1)).filter((i) => i >= 0);
  vIdx.forEach((i, n) => {
    const prev = n > 0 ? times[vIdx[n - 1]].t1 : times[i].t0 - 0.08;
    const next = n < vIdx.length - 1 ? times[vIdx[n + 1]].t0 : times[i].t1 + 0.08;
    const rIn = Math.max(0.04, 0.85 * (times[i].t0 - prev)) + 0.02;
    const rOut = Math.max(0.04, 0.85 * (next - times[i].t1)) + 0.02;
    gestures.push({ t0: times[i].t0, t1: times[i].t1, rampIn: rIn, rampOut: rOut, strength: 1, targets: segs[i].vowel!, label: segs[i].ipa });
  });
  // utterance-initial/final consonants: lend them the nearest vowel's body posture
  // ---- consonant gestures
  segs.forEach((s, i) => {
    const { t0, t1 } = times[i];
    const dur = t1 - t0;
    planned.push({ ipa: s.ipa, t0, t1, kind: s.vowel ? "vowel" : s.def?.manner ?? "?" });
    const def = s.def;
    if (!def) return;
    const prevVowel = i > 0 && !!segs[i - 1].vowel;
    const nextVowel = i < segs.length - 1 && !!segs[i + 1].vowel;
    const prevSeg = i > 0 ? segs[i - 1] : null;
    const addOral = (tg: Partial<HumanArtic>, a: number, b: number, speed: number, label: string) => gestures.push(...oralGestures(def, tg, a, b, speed, label));
    switch (def.manner) {
      case "stop":
      case "nasal":
        addOral(def.targets, t0, t1, 1.55, def.ipa);
        break;
      case "tap":
        addOral(def.targets, t0, t1, 2.8, def.ipa);
        break;
      case "trill": {
        // driven trill: rapid alternation of near-closure and release at ~26 Hz
        const n = Math.max(2, Math.round(dur * 26));
        for (let k = 0; k < n; k++) {
          const a = t0 + (k / n) * dur;
          addOral(def.targets, a, a + 0.35 / 26, 3.2, def.ipa);
        }
        break;
      }
      case "affricate": {
        const split = t0 + dur * 0.55;
        addOral(def.targets, t0, split, 2.0, def.ipa);
        const rel = def.release ? phoneme(def.release, body) : undefined;
        if (rel) addOral(rel.targets, split + 0.008, t1, 1.4, def.ipa);
        break;
      }
      case "fricative":
      case "approximant":
      case "lateral":
        addOral(def.targets, t0, t1, 1.3, def.ipa);
        break;
      case "glottal":
        break;
    }
    // nasality: velum lowering with anticipation into the preceding vowel
    if (def.nasal) gestures.push({ t0: t0 - 0.03, t1: t1 + 0.01, rampIn: 0.06, rampOut: 0.05, strength: 4, targets: { velum: 0.85 }, label: "velum" });
    // phonation
    const k2 = 1; // abduction is body-scaled in the voice
    if (def.glottal === "open") gestures.push({ t0: t0 - 0.01, t1, rampIn: 0.03, rampOut: 0.035, strength: 5, targets: { abduction: 0.33 * k2 }, label: "h" });
    else if (def.glottal === "breathy") gestures.push({ t0, t1, rampIn: 0.03, rampOut: 0.03, strength: 5, targets: { abduction: 0.1 * k2 }, label: "ɦ" });
    else if (def.glottal === "stop") gestures.push({ t0, t1, rampIn: 0.012, rampOut: 0.015, strength: 8, targets: { closure: 1 }, label: "ʔ" });
    else if (def.voicing === "voiceless") {
      if (def.manner === "stop" || def.manner === "affricate") {
        // aspirated when syllable-initial before a vowel and not after /s/ (English-like)
        const aspirated = nextVowel && !(prevSeg && prevSeg.ipa === "s");
        const vot = aspirated ? 0.05 / rate : 0.012;
        gestures.push({ t0: t0 + 0.25 * dur, t1: t1 + vot * 0.4, rampIn: 0.035, rampOut: aspirated ? 0.045 : 0.02, strength: 6, targets: { abduction: aspirated ? 0.36 : 0.22 }, label: "aspiration" });
      } else {
        gestures.push({ t0: t0 - 0.015, t1: t1 + 0.005, rampIn: 0.03, rampOut: 0.03, strength: 6, targets: { abduction: 0.3 }, label: "voiceless" });
      }
    } else if (def.manner === "fricative") {
      gestures.push({ t0, t1, rampIn: 0.03, rampOut: 0.03, strength: 3, targets: { abduction: 0.035 }, label: "voiced frication" });
    }
    void prevVowel;
  });
  // ---- breath: on through the utterance
  gestures.push({ t0: o.t0 + 0.04, t1: end, rampIn: 0.04, rampOut: 0.07, strength: 1, targets: { breath: 1 }, label: "breath" });
  // ---- intonation: pitch targets on vowels
  const f0 = o.f0 ?? 110;
  const accent = o.accent ?? 0.14;
  const total = Math.max(0.2, end - o.t0);
  vIdx.forEach((i, n) => {
    const s = segs[i];
    const { t0, t1 } = times[i];
    let target: number;
    if (s.f0) target = s.f0;
    else {
      const prog = (t0 - o.t0) / total;
      const decl = 1 - 0.1 * prog;
      const acc = s.stress === 1 ? 1 + accent : s.stress === 2 ? 1 + accent * 0.5 : 1;
      target = f0 * decl * acc;
      const last = n === vIdx.length - 1;
      if (last && o.intonation === "question") target = f0 * 1.35;
      if (last && (o.intonation ?? "statement") === "statement") target = f0 * 0.82;
    }
    gestures.push({ t0, t1, rampIn: 0.06, rampOut: 0.06, strength: s.f0 ? 6 : 1, targets: { f0: target }, label: "pitch" });
  });
  return { gestures, segments: planned, end };
}

/**
 * Oral gestures for one consonant constriction held acoustically from `a` to `b` (closure to
 * release): a dominant gesture on the consonant's own articulators and a weak one on the rest.
 * Movement latencies are compensated so the acoustic closure and release land on a and b.
 */
export function oralGestures(def: PhonemeDef, tg: Partial<HumanArtic>, a: number, b: number, speed: number, label: string): Gesture[] {
  const out: Gesture[] = [];
  const dom: Partial<HumanArtic> = {};
  const sec: Partial<HumanArtic> = {};
  for (const [k, v] of Object.entries(tg) as [keyof HumanArtic, number][]) (def.dominant.includes(k) ? dom : sec)[k] = v;
  // the dorsum is heavy: its releases are slower than tip and lip releases
  const bodyOnly = def.dominant.every((k) => k === "tbX" || k === "tbY" || k === "root");
  const sp = bodyOnly ? 1 + (speed - 1) * 0.35 : speed;
  // articulators need ~10–15 ms to climb out of the overshoot (contact) target, so the
  // gesture releases early and the acoustic release lands on the planned boundary:
  // measured movement latencies (closure lag / release lag) per articulator class
  const closing = def.manner === "stop" || def.manner === "nasal" || def.manner === "affricate";
  const lipsOnly = def.dominant.every((k) => k === "lipAp" || k === "labiodental");
  const lead = closing ? (bodyOnly ? 0.034 : lipsOnly ? 0.019 : 0.02) : 0;
  // a consonant must own its constriction articulators (Task-Dynamics style): at strength 40
  // the overlapping vowel contributes ~2 %, so closures seal instead of being diluted
  const early = closing ? (bodyOnly ? 0.024 : lipsOnly ? 0.022 : 0.031) : 0.008;
  if (Object.keys(dom).length) out.push({ t0: a - early, t1: Math.max(a + 0.01, b - lead), rampIn: 0.03, rampOut: bodyOnly ? 0.03 : 0.018, strength: 40, targets: dom, speed: sp, releaseHold: 0.045, label });
  if (Object.keys(sec).length) out.push({ t0: a, t1: b, rampIn: 0.05, rampOut: 0.05, strength: 2.2, targets: sec, label });
  return out;
}

/** Plan consecutive phrases (each with its own breath group and intonation) from t0. */
export function planPhrases(
  phrases: { segments: Segment[]; intonation?: "statement" | "question" | "flat"; pause?: number }[],
  o: Omit<PlanOptions, "intonation">,
): Plan {
  const all: Plan = { gestures: [], segments: [], end: o.t0 };
  let t = o.t0;
  for (const p of phrases) {
    const plan = planUtterance(p.segments, { ...o, t0: t, intonation: p.intonation ?? "statement" });
    all.gestures.push(...plan.gestures);
    all.segments.push(...plan.segments);
    t = plan.end + (p.pause ?? 0.25);
    all.end = plan.end;
  }
  return all;
}
