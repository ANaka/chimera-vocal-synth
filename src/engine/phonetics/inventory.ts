/**
 * Phoneme inventory (IPA) as articulatory specifications for the human model.
 * Coordinates are template-space (cm) and apply to every body (the anatomy scales them).
 * Fricative/approximant constriction heights are refined by tools/calibrate-consonants.ts
 * to hit target constriction areas; calibrated values override the defaults here.
 */
import type { HumanArtic } from "../anatomy/human.ts";
import type { ArticKey } from "../control/articulators.ts";
import consonantCal from "./consonantTargets.generated.json";

export type Manner = "vowel" | "stop" | "nasal" | "fricative" | "affricate" | "approximant" | "lateral" | "tap" | "trill" | "glottal";
export type Voicing = "voiced" | "voiceless";

export interface PhonemeDef {
  ipa: string;
  name: string;
  manner: Manner;
  voicing: Voicing;
  place: string;
  targets: Partial<HumanArtic>;
  /** articulators this segment controls strongly (others coarticulate with vowels) */
  dominant: ArticKey[];
  nasal?: boolean;
  /** default duration (s) */
  dur: number;
  /** target constriction area (cm², adult male) for calibration of the main coordinate */
  area?: number;
  /** which coordinate the calibration adjusts */
  calKey?: ArticKey;
  /** affricate: the fricative release */
  release?: string;
  /** glottal-only segments */
  glottal?: "open" | "stop" | "breathy";
}

const TIP: ArticKey[] = ["ttX", "ttY"];
const BODY: ArticKey[] = ["tbX", "tbY"];
const LIPS: ArticKey[] = ["lipAp"];

function c(ipa: string, name: string, manner: Manner, voicing: Voicing, place: string, targets: Partial<HumanArtic>, dominant: ArticKey[], dur: number, extra: Partial<PhonemeDef> = {}): PhonemeDef {
  return { ipa, name, manner, voicing, place, targets, dominant, dur, ...extra };
}

// place templates
const BILABIAL = { lipAp: -0.25 };
const ALV_STOP = { ttX: 6.25, ttY: 9.68 };
const DENT_STOP = { ttX: 6.85, ttY: 9.0 };
const POSTALV_STOP = { ttX: 5.75, ttY: 10.0 };
const RETRO_STOP = { ttX: 5.45, ttY: 10.05, ttCurl: 0.95 };
const PAL_STOP = { tbX: 3.75, tbY: 8.45 };
const VEL_STOP = { tbX: 2.3, tbY: 7.85 };
const UVU_STOP = { tbX: 1.55, tbY: 7.6 };

const BASE: PhonemeDef[] = [
  // stops
  c("p", "voiceless bilabial stop", "stop", "voiceless", "bilabial", BILABIAL, LIPS, 0.085),
  c("b", "voiced bilabial stop", "stop", "voiced", "bilabial", BILABIAL, LIPS, 0.07),
  c("t", "voiceless alveolar stop", "stop", "voiceless", "alveolar", ALV_STOP, TIP, 0.075),
  c("d", "voiced alveolar stop", "stop", "voiced", "alveolar", ALV_STOP, TIP, 0.06),
  c("ʈ", "voiceless retroflex stop", "stop", "voiceless", "retroflex", RETRO_STOP, [...TIP, "ttCurl"], 0.075),
  c("ɖ", "voiced retroflex stop", "stop", "voiced", "retroflex", RETRO_STOP, [...TIP, "ttCurl"], 0.065),
  c("c", "voiceless palatal stop", "stop", "voiceless", "palatal", PAL_STOP, BODY, 0.08),
  c("ɟ", "voiced palatal stop", "stop", "voiced", "palatal", PAL_STOP, BODY, 0.07),
  c("k", "voiceless velar stop", "stop", "voiceless", "velar", VEL_STOP, ["tbY"], 0.08),
  c("g", "voiced velar stop", "stop", "voiced", "velar", VEL_STOP, ["tbY"], 0.07),
  c("q", "voiceless uvular stop", "stop", "voiceless", "uvular", UVU_STOP, BODY, 0.085),
  c("ɢ", "voiced uvular stop", "stop", "voiced", "uvular", UVU_STOP, BODY, 0.075),
  c("ʔ", "glottal stop", "glottal", "voiceless", "glottal", {}, [], 0.06, { glottal: "stop" }),
  // nasals
  c("m", "bilabial nasal", "nasal", "voiced", "bilabial", BILABIAL, LIPS, 0.075, { nasal: true }),
  c("ɱ", "labiodental nasal", "nasal", "voiced", "labiodental", { labiodental: 1, lipAp: -0.1 }, ["labiodental", "lipAp"], 0.075, { nasal: true }),
  c("n", "alveolar nasal", "nasal", "voiced", "alveolar", ALV_STOP, TIP, 0.07, { nasal: true }),
  c("ɳ", "retroflex nasal", "nasal", "voiced", "retroflex", RETRO_STOP, [...TIP, "ttCurl"], 0.07, { nasal: true }),
  c("ɲ", "palatal nasal", "nasal", "voiced", "palatal", PAL_STOP, BODY, 0.075, { nasal: true }),
  c("ŋ", "velar nasal", "nasal", "voiced", "velar", VEL_STOP, ["tbY"], 0.08, { nasal: true }),
  c("ɴ", "uvular nasal", "nasal", "voiced", "uvular", UVU_STOP, BODY, 0.08, { nasal: true }),
  // fricatives
  c("ɸ", "voiceless bilabial fricative", "fricative", "voiceless", "bilabial", { lipAp: 0.08 }, LIPS, 0.11, { area: 0.12, calKey: "lipAp" }),
  c("β", "voiced bilabial fricative", "fricative", "voiced", "bilabial", { lipAp: 0.1 }, LIPS, 0.09, { area: 0.15, calKey: "lipAp" }),
  c("f", "voiceless labiodental fricative", "fricative", "voiceless", "labiodental", { labiodental: 1, lipAp: 0.05 }, ["labiodental", "lipAp"], 0.11, { area: 0.11, calKey: "lipAp" }),
  c("v", "voiced labiodental fricative", "fricative", "voiced", "labiodental", { labiodental: 1, lipAp: 0.06 }, ["labiodental", "lipAp"], 0.08, { area: 0.13, calKey: "lipAp" }),
  c("θ", "voiceless dental fricative", "fricative", "voiceless", "dental", { ttX: 6.85, ttY: 8.5 }, TIP, 0.11, { area: 0.15, calKey: "ttY" }),
  c("ð", "voiced dental fricative", "fricative", "voiced", "dental", { ttX: 6.85, ttY: 8.5 }, TIP, 0.07, { area: 0.17, calKey: "ttY" }),
  c("s", "voiceless alveolar fricative", "fricative", "voiceless", "alveolar", { ttX: 6.3, ttY: 9.15, jaw: 0.3 }, [...TIP, "jaw"], 0.12, { area: 0.085, calKey: "ttY" }),
  c("z", "voiced alveolar fricative", "fricative", "voiced", "alveolar", { ttX: 6.3, ttY: 9.15, jaw: 0.3 }, [...TIP, "jaw"], 0.09, { area: 0.1, calKey: "ttY" }),
  c("ʃ", "voiceless postalveolar fricative", "fricative", "voiceless", "postalveolar", { ttX: 5.7, ttY: 9.5, jaw: 0.35, lipProt: 0.75, lipWidth: 0.2 }, [...TIP, "jaw", "lipProt", "lipWidth"], 0.12, { area: 0.2, calKey: "ttY" }),
  c("ʒ", "voiced postalveolar fricative", "fricative", "voiced", "postalveolar", { ttX: 5.7, ttY: 9.5, jaw: 0.35, lipProt: 0.75, lipWidth: 0.2 }, [...TIP, "jaw", "lipProt", "lipWidth"], 0.09, { area: 0.22, calKey: "ttY" }),
  c("ʂ", "voiceless retroflex fricative", "fricative", "voiceless", "retroflex", { ttX: 5.45, ttY: 9.7, ttCurl: 0.9 }, [...TIP, "ttCurl"], 0.12, { area: 0.15, calKey: "ttY" }),
  c("ʐ", "voiced retroflex fricative", "fricative", "voiced", "retroflex", { ttX: 5.45, ttY: 9.7, ttCurl: 0.9 }, [...TIP, "ttCurl"], 0.09, { area: 0.17, calKey: "ttY" }),
  c("ç", "voiceless palatal fricative", "fricative", "voiceless", "palatal", { tbX: 3.75, tbY: 8.25 }, BODY, 0.12, { area: 0.14, calKey: "tbY" }),
  c("ʝ", "voiced palatal fricative", "fricative", "voiced", "palatal", { tbX: 3.75, tbY: 8.25 }, BODY, 0.09, { area: 0.16, calKey: "tbY" }),
  c("x", "voiceless velar fricative", "fricative", "voiceless", "velar", { tbX: 2.3, tbY: 7.7 }, ["tbY"], 0.12, { area: 0.18, calKey: "tbY" }),
  c("ɣ", "voiced velar fricative", "fricative", "voiced", "velar", { tbX: 2.3, tbY: 7.7 }, ["tbY"], 0.09, { area: 0.2, calKey: "tbY" }),
  c("χ", "voiceless uvular fricative", "fricative", "voiceless", "uvular", { tbX: 1.55, tbY: 7.6 }, BODY, 0.12, { area: 0.2, calKey: "tbY" }),
  c("ʁ", "voiced uvular fricative", "fricative", "voiced", "uvular", { tbX: 1.55, tbY: 7.6 }, BODY, 0.09, { area: 0.22, calKey: "tbY" }),
  c("ħ", "voiceless pharyngeal fricative", "fricative", "voiceless", "pharyngeal", { root: -0.95, tbX: 1.3, tbY: 6.2 }, ["root", "tbX", "tbY"], 0.12, { area: 0.25, calKey: "tbX" }),
  c("ʕ", "voiced pharyngeal fricative", "fricative", "voiced", "pharyngeal", { root: -0.95, tbX: 1.3, tbY: 6.2 }, ["root", "tbX", "tbY"], 0.09, { area: 0.3, calKey: "tbX" }),
  c("h", "voiceless glottal fricative", "glottal", "voiceless", "glottal", {}, [], 0.09, { glottal: "open" }),
  c("ɦ", "voiced glottal fricative", "glottal", "voiced", "glottal", {}, [], 0.08, { glottal: "breathy" }),
  c("ɬ", "voiceless lateral fricative", "fricative", "voiceless", "alveolar", { ...ALV_STOP, lateral: 0.35 }, [...TIP, "lateral"], 0.12),
  c("ɮ", "voiced lateral fricative", "fricative", "voiced", "alveolar", { ...ALV_STOP, lateral: 0.45 }, [...TIP, "lateral"], 0.09),
  // affricates
  c("ts", "voiceless alveolar affricate", "affricate", "voiceless", "alveolar", ALV_STOP, TIP, 0.14, { release: "s" }),
  c("dz", "voiced alveolar affricate", "affricate", "voiced", "alveolar", ALV_STOP, TIP, 0.12, { release: "z" }),
  c("tʃ", "voiceless postalveolar affricate", "affricate", "voiceless", "postalveolar", { ...POSTALV_STOP, lipProt: 0.75, lipWidth: 0.2 }, [...TIP, "lipProt", "lipWidth"], 0.15, { release: "ʃ" }),
  c("dʒ", "voiced postalveolar affricate", "affricate", "voiced", "postalveolar", { ...POSTALV_STOP, lipProt: 0.75, lipWidth: 0.2 }, [...TIP, "lipProt", "lipWidth"], 0.13, { release: "ʒ" }),
  c("pf", "voiceless labiodental affricate", "affricate", "voiceless", "labiodental", BILABIAL, LIPS, 0.14, { release: "f" }),
  // approximants, laterals, taps, trills
  c("w", "labial-velar approximant", "approximant", "voiced", "labial-velar", { lipAp: 0.28, lipProt: 1.0, lipWidth: 0.05, tbX: 2.45, tbY: 7.45 }, ["lipAp", "lipProt", "lipWidth", "tbX", "tbY"], 0.06),
  c("ʋ", "labiodental approximant", "approximant", "voiced", "labiodental", { labiodental: 0.9, lipAp: 0.25 }, ["labiodental", "lipAp"], 0.06),
  c("ɹ", "alveolar approximant", "approximant", "voiced", "postalveolar", { ttX: 5.35, ttY: 9.35, ttCurl: 0.85, lipProt: 0.5, lipWidth: 0.3, root: -0.6, tbX: 2.3, tbY: 7.1 }, ["ttX", "ttY", "ttCurl", "lipProt", "lipWidth", "root"], 0.065),
  c("ɻ", "retroflex approximant", "approximant", "voiced", "retroflex", { ttX: 5.4, ttY: 9.55, ttCurl: 1 }, [...TIP, "ttCurl"], 0.065),
  c("j", "palatal approximant", "approximant", "voiced", "palatal", { tbX: 3.8, tbY: 7.95, jaw: 0.25 }, BODY, 0.055),
  c("ɰ", "velar approximant", "approximant", "voiced", "velar", { tbX: 2.35, tbY: 7.45 }, BODY, 0.06),
  c("l", "alveolar lateral approximant", "lateral", "voiced", "alveolar", { ...ALV_STOP, lateral: 1 }, [...TIP, "lateral"], 0.065),
  c("ɫ", "velarised lateral", "lateral", "voiced", "alveolar", { ...ALV_STOP, lateral: 1, tbX: 1.9, tbY: 6.8 }, [...TIP, "lateral", "tbX", "tbY"], 0.075),
  c("ɭ", "retroflex lateral", "lateral", "voiced", "retroflex", { ...RETRO_STOP, lateral: 1 }, [...TIP, "ttCurl", "lateral"], 0.065),
  c("ʎ", "palatal lateral", "lateral", "voiced", "palatal", { ...PAL_STOP, lateral: 1 }, [...BODY, "lateral"], 0.07),
  c("ɾ", "alveolar tap", "tap", "voiced", "alveolar", ALV_STOP, TIP, 0.025),
  c("ɽ", "retroflex flap", "tap", "voiced", "retroflex", RETRO_STOP, [...TIP, "ttCurl"], 0.03),
  c("r", "alveolar trill", "trill", "voiced", "alveolar", { ttX: 6.25, ttY: 9.45 }, TIP, 0.11),
  c("ʀ", "uvular trill", "trill", "voiced", "uvular", { tbX: 1.55, tbY: 7.85 }, BODY, 0.11),
  c("ʙ", "bilabial trill", "trill", "voiced", "bilabial", { lipAp: 0.02 }, LIPS, 0.12),
];
void DENT_STOP;

type CalTable = Record<string, Record<string, Partial<HumanArtic>>>;
const CAL = consonantCal as unknown as CalTable;

const byIpa = new Map<string, PhonemeDef>(BASE.map((p) => [p.ipa, p]));

/** Phoneme definition with calibrated targets for a body (falls back to defaults). */
export function phoneme(ipa: string, body: string = "male"): PhonemeDef | undefined {
  const p = byIpa.get(ipa);
  if (!p) return undefined;
  const cal = CAL[body]?.[ipa];
  return cal ? { ...p, targets: { ...p.targets, ...cal } } : p;
}

export const CONSONANTS: readonly PhonemeDef[] = BASE;
export const CONSONANT_SYMBOLS = BASE.map((p) => p.ipa);
