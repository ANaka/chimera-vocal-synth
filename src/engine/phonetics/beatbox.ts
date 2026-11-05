/**
 * A physically modelled beatboxer. Each drum sound is a short gestural score on the human vocal
 * tract, made with the airstream mechanisms beatboxers actually use:
 *  - pulmonic: breath from the lungs (snares, hats, crash)
 *  - glottalic (ejective): the glottis sealed, the larynx rises like a piston and compresses the
 *    air behind an oral closure (kick, rimshot): punchy, dry, no breath noise
 *  - velaric (click): the tongue seals a pocket against the palate and hollows it; the release
 *    pops inward (tongue click, lip pop)
 *  - ingressive: breath drawn in through a constriction (inward K snare)
 *  - voiced: a hummed bass through the nose
 * One throat makes one sound at a time, so patterns are monophonic like a real beatboxer's.
 * Symbols follow Standard Beatbox Notation where it has one.
 */
import type { Gesture } from "../control/score.ts";
import type { HumanArtic } from "../anatomy/human.ts";
import { phoneme } from "./inventory.ts";
import { oralGestures, vowelArtic } from "./planner.ts";

/** A beatboxer's ready posture: jaw nearly closed, lips just apart, tongue relaxed. */
export function beatReady(body: string): Partial<HumanArtic> {
  return { ...(vowelArtic("ə", body) ?? {}), jaw: 0.4, lipAp: 0.25, lipProt: 0.1 };
}

export type BeatRole = "kick" | "snare" | "hat" | "perc" | "bass";
export type Airstream = "pulmonic" | "ejective" | "click" | "ingressive" | "voiced";

export interface BeatBuild {
  /** hum pitch (Hz) */
  f0: number;
  /** how long the sound may last (s): its step length, for sustained sounds */
  len: number;
  /** loudness 0.5..1.5 */
  accent: number;
}

export interface BeatSound {
  /** pattern symbol */
  id: string;
  name: string;
  role: BeatRole;
  airstream: Airstream;
  hint: string;
  /**
   * Gestures with the acoustic hit at t = 0. `latency` (s) is the measured delay from the
   * planned hit to the acoustic onset; the sequencer schedules that much earlier.
   */
  build(body: string, o: BeatBuild): Gesture[];
  latency: number;
}

const oral = (body: string, ipa: string, a: number, b: number, speed: number, label: string, extra: Record<string, number> = {}): Gesture[] => {
  const d = phoneme(ipa, body);
  if (!d) return [];
  return oralGestures(d, { ...d.targets, ...extra }, a, b, speed, label);
};

const g = (t0: number, t1: number, rampIn: number, rampOut: number, strength: number, targets: Gesture["targets"], label: string, speed?: number): Gesture => ({ t0, t1, rampIn, rampOut, strength, targets, label, speed });

/** Beatboxers snap their releases: faster than speech, and the heavy dorsum is no exception. */
const snap = (gs: Gesture[], speed = 3.5, rampOut = 0.01): Gesture[] => {
  for (const x of gs) if (x.strength >= 40) {
    x.speed = speed;
    x.rampOut = rampOut;
  }
  return gs;
};

/**
 * A release fricative that starts only after the burst: with the planner's 30 ms ramp it would
 * grip the articulators while the closure is still held and pry it open early.
 */
const after = (gs: Gesture[], rampIn = 0.008): Gesture[] => {
  for (const x of gs) x.rampIn = Math.min(x.rampIn, rampIn);
  return gs;
};

/** Glottalic piston: glottis sealed through the closure, larynx raised just before release. */
const ejective = (a: number, accent: number, label: string): Gesture[] => [
  g(a - 0.012, 0.03, 0.012, 0.03, 8, { closure: 1 }, label),
  g(-0.05, 0.004, 0.03, 0.08, 40, { larynx: Math.min(1.6, 1.25 + 0.3 * accent) }, label, 3),
];

/**
 * Lung pressure (× the performer's breath pressure) over [a, b], with the glottis held open
 * until the breath has gone (otherwise the folds start to vibrate on the leftover pressure).
 */
const blow = (a: number, b: number, level: number, abduction: number, label: string, tail = 0.03): Gesture[] => [
  g(a, b + tail + 0.02, 0.02, 0.03, 6, { abduction }, label),
  g(a - 0.01, b, 0.02, tail, 1, { breath: level }, label),
];

export const BEAT_SOUNDS: BeatSound[] = [
  {
    id: "B",
    name: "Kick",
    role: "kick",
    airstream: "ejective",
    hint: "Lips burst on air the rising larynx compresses",
    latency: 0.01,
    build: (body, o) => [...snap(oral(body, "p", -0.075, 0, 2, "B", { jaw: 0.3 })), ...ejective(-0.075, o.accent, "B")],
  },
  {
    id: "t",
    name: "Hi-hat",
    role: "hat",
    airstream: "pulmonic",
    hint: "Tongue-tip release into a short hiss",
    latency: -0.005,
    build: (body, o) => [...snap(oral(body, "t", -0.05, 0, 2, "t", { jaw: 0.3 })), ...after(oral(body, "s", 0.012, 0.03, 1.6, "t")), ...blow(-0.03, 0.026, 1.25 * o.accent, 0.36, "t", 0.02)],
  },
  {
    id: "tss",
    name: "Open hat",
    role: "hat",
    airstream: "pulmonic",
    hint: "The hi-hat left ringing as a long hiss",
    latency: -0.005,
    build: (body, o) => {
      const end = Math.max(0.09, Math.min(0.26, o.len * 1.6));
      return [...snap(oral(body, "t", -0.05, 0, 2, "tss", { jaw: 0.3 })), ...after(oral(body, "s", 0.012, end, 1.4, "tss")), ...blow(-0.03, end, 1.2 * o.accent, 0.4, "tss", 0.09)];
    },
  },
  {
    id: "Pf",
    name: "Snare",
    role: "snare",
    airstream: "pulmonic",
    hint: "Lips burst, then the lower lip hisses against the teeth",
    latency: 0.018,
    build: (body, o) => [...snap(oral(body, "p", -0.06, 0, 2, "Pf")), ...after(oral(body, "f", 0.018, 0.08, 1.6, "Pf")), ...blow(-0.045, 0.075, 1.7 * o.accent, 0.45, "Pf", 0.04)],
  },
  {
    id: "K",
    name: "Rimshot",
    role: "snare",
    airstream: "ejective",
    hint: "Back of the tongue bursts on larynx-compressed air",
    latency: 0.009,
    build: (body, o) => [...snap(oral(body, "k", -0.08, 0, 2, "K", { jaw: 0.35 }), 4, 0.008), ...ejective(-0.08, o.accent, "K")],
  },
  {
    id: "^K",
    name: "Inward snare",
    role: "snare",
    airstream: "ingressive",
    hint: "A sharp breath in past the back of the tongue",
    latency: -0.002,
    build: (body, o) => [
      ...snap(oral(body, "k", -0.06, 0, 2, "^K", { jaw: 0.35 }), 4, 0.008),
      ...after(oral(body, "x", 0.012, 0.085, 1.4, "^K", { tbY: 7.35 })),
      g(-0.05, 0.085, 0.02, 0.04, 6, { abduction: 0.5 }, "^K"),
      // draw the breath in behind the closure so the release rushes inward
      g(-0.035, 0.085, 0.015, 0.05, 2, { breath: -1.7 * o.accent }, "^K"),
    ],
  },
  {
    id: "!",
    name: "Tongue click",
    role: "perc",
    airstream: "click",
    hint: "Tongue seals a pocket, hollows it and pops",
    latency: -0.007,
    build: (body) => [
      ...snap(oral(body, "t", -0.12, 0, 2, "!")),
      ...oral(body, "k", -0.12, 0.035, 2, "!"),
      g(-0.03, 0.006, 0.04, 0.03, 40, { dorsum: 1 }, "!", 2),
    ],
  },
  {
    id: "P!",
    name: "Lip pop",
    role: "perc",
    airstream: "click",
    hint: "Sealed lips, the jaw drops, the lips pop open",
    latency: 0.013,
    build: (body) => [
      // a light seal (pressing the lips squeezes the pocket before the suction starts)
      ...snap(oral(body, "p", -0.12, 0, 2, "P!", { lipAp: -0.08 }), 5, 0.006),
      ...oral(body, "k", -0.12, 0.03, 2, "P!"),
      // lips stay sealed while the jaw and tongue hollow the mouth: about −30 cmH₂O of suction
      g(-0.07, 0.004, 0.04, 0.05, 40, { jaw: 1.6, dorsum: 1 }, "P!", 2),
    ],
  },
  {
    id: "kch",
    name: "Crash",
    role: "hat",
    airstream: "pulmonic",
    hint: "Back-of-tongue release into a long rounded hiss",
    latency: -0.001,
    build: (body, o) => {
      const end = Math.max(0.14, Math.min(0.34, o.len * 2));
      return [...snap(oral(body, "k", -0.06, 0, 2, "kch"), 4, 0.008), ...after(oral(body, "ʃ", 0.014, end, 1.4, "kch")), ...blow(-0.035, end, 1.45 * o.accent, 0.45, "kch", 0.14)];
    },
  },
  {
    id: "m",
    name: "Hum",
    role: "bass",
    airstream: "voiced",
    hint: "Hummed bass note through the nose",
    latency: 0.012,
    build: (body, o) => {
      const end = Math.max(0.06, o.len * 0.92);
      return [
        // lips shut before the voice starts, so the note begins as a hum rather than a vowel
        ...oral(body, "m", -0.03, end, 1.6, "m"),
        g(-0.02, end, 0.03, 0.03, 4, { velum: 0.9 }, "m"),
        g(-0.01, end, 0.02, 0.04, 1, { breath: 0.95 * o.accent }, "m"),
        g(-0.02, end, 0.015, 0.02, 8, { f0: o.f0 }, "m"),
      ];
    },
  },
];

const BY_ID = new Map(BEAT_SOUNDS.map((s) => [s.id, s]));
export const beatSound = (id: string): BeatSound | undefined => BY_ID.get(id);

/** One step of a pattern: a sound (null = rest), optional MIDI note for pitched sounds. */
export interface BeatStep {
  id: string;
  note?: number;
  accent?: number;
}

/** Default hum note (MIDI E2) */
export const BASS_NOTE = 40;

/**
 * Parse a beat written as text: tokens separated by spaces or "|" (bar lines, ignored);
 * "." or "-" is a rest; a hum may carry a MIDI note ("m:43"); a trailing ">" accents.
 */
export function parseBeat(text: string): (BeatStep | null)[] {
  const out: (BeatStep | null)[] = [];
  for (const raw of text.split(/[\s|]+/)) {
    if (!raw) continue;
    if (raw === "." || raw === "-") {
      out.push(null);
      continue;
    }
    let tok = raw;
    let accent: number | undefined;
    if (tok.endsWith(">")) {
      accent = 1.3;
      tok = tok.slice(0, -1);
    }
    let note: number | undefined;
    const m = /^(.+?):(\d+)$/.exec(tok);
    if (m) {
      tok = m[1];
      note = Number(m[2]);
    }
    const s = BY_ID.get(tok) ?? BEAT_SOUNDS.find((x) => x.id.toLowerCase() === tok.toLowerCase());
    if (s) out.push({ id: s.id, ...(note !== undefined ? { note } : {}), ...(accent ? { accent } : {}) });
    else out.push(null);
  }
  return out;
}

/** Inverse of parseBeat: four steps per group, groups separated by spaces. */
export function formatBeat(steps: (BeatStep | null)[]): string {
  const toks = steps.map((s) => (s ? `${s.id}${s.note !== undefined ? `:${s.note}` : ""}${s.accent && s.accent > 1 ? ">" : ""}` : "."));
  const groups: string[] = [];
  for (let i = 0; i < toks.length; i += 4) groups.push(toks.slice(i, i + 4).join(" "));
  return groups.join(" | ");
}

export interface BeatPreset {
  name: string;
  bpm: number;
  swing: number;
  text: string;
}

export const BEAT_PRESETS: BeatPreset[] = [
  { name: "Boots and cats", bpm: 96, swing: 0, text: "B . t . | Pf . t . | B . t . | Pf . t ." },
  { name: "Four on the floor", bpm: 122, swing: 0, text: "B . t . | B . tss . | B . t . | B . tss ." },
  { name: "Breakbeat", bpm: 94, swing: 0.18, text: "B . t . | Pf . t B | . B t . | Pf . t t" },
  { name: "Rimshot shuffle", bpm: 88, swing: 0.4, text: "B . t K | . t B . | t . K t | . B K t" },
  { name: "Inward snare", bpm: 100, swing: 0, text: "B . t . | ^K . t . | B B t . | ^K . t ." },
  { name: "Clicks and pops", bpm: 90, swing: 0.25, text: "B . ! . | P! . ! . | B ! . ! | P! . ! !" },
  { name: "Hum bass", bpm: 92, swing: 0.1, text: "B m . m:43 | Pf . m:45 . | B m:40 . m | Pf . t kch" },
];
