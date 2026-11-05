/**
 * Segment durations by the Klatt (1979) / MITalk rules (Allen, Hunnicutt & Klatt 1987, ch. 9):
 *   DUR = MIN + (INH − MIN) · PRCNT
 * with PRCNT the product of context factors: phrase-final lengthening, non-final shortening,
 * non-word-final and polysyllabic shortening, unstressed shortening (MIN halved), the vowel
 * length cue of the following consonant (bat/bad), cluster shortening, and aspiration.
 * Inherent / minimum durations (ms) per phoneme follow Klatt's table.
 */
import type { Segment } from "./planner.ts";

const T: Record<string, [number, number]> = {
  // vowels
  i: [155, 55], ɪ: [135, 40], e: [190, 70], eɪ: [190, 70], ɛ: [150, 70], æ: [230, 80], a: [230, 80], ɑ: [240, 100], ɒ: [240, 100],
  ɔ: [240, 100], o: [220, 80], oʊ: [220, 80], ʊ: [160, 60], u: [210, 70], ʌ: [140, 60], ə: [120, 60], ɚ: [180, 80], ɝ: [180, 80],
  aɪ: [250, 150], aʊ: [240, 100], ɔɪ: [280, 150], ɨ: [110, 40],
  // consonants
  p: [85, 50], t: [75, 50], k: [80, 60], b: [85, 60], d: [75, 50], g: [80, 60], ʔ: [40, 30],
  tʃ: [70, 50], dʒ: [50, 30],
  f: [100, 80], v: [60, 40], θ: [90, 60], ð: [50, 30], s: [105, 60], z: [75, 40], ʃ: [105, 80], ʒ: [70, 40], h: [80, 20],
  m: [70, 60], n: [60, 50], ŋ: [95, 45], l: [80, 40], ɫ: [80, 40], ɹ: [80, 30], w: [80, 60], j: [80, 40], ɾ: [20, 20],
};

export interface SegInfo {
  vowel: boolean;
  manner?: string;
  voiced?: boolean;
  /** fallback inherent duration (s) for phonemes outside the table */
  dur?: number;
}

/** Durations (s) for one phrase of segments (explicit `dur` values are kept). */
export function klattDurations(segs: Segment[], info: (s: Segment) => SegInfo): number[] {
  const n = segs.length;
  const inf = segs.map(info);
  // words: index ranges split after wordEnd
  const word = new Array<number>(n);
  const wordStart: number[] = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || segs[i - 1].wordEnd) wordStart.push(i);
    word[i] = wordStart.length - 1;
    if (segs[i].wordEnd) w++;
  }
  void w;
  const vowelsInWord = new Map<number, number>();
  for (let i = 0; i < n; i++) if (inf[i].vowel) vowelsInWord.set(word[i], (vowelsInWord.get(word[i]) ?? 0) + 1);
  let lastVowel = -1;
  for (let i = 0; i < n; i++) if (inf[i].vowel) lastVowel = i;

  return segs.map((s, i) => {
    if (s.dur !== undefined) return s.dur;
    const [inh0, min0] = T[s.ipa] ?? [1000 * (inf[i].dur ?? 0.08), 600 * (inf[i].dur ?? 0.08)];
    let inh = inh0, min = min0, p = 1;
    if (inf[i].vowel) {
      const stress = s.stress ?? 0;
      const finalSyl = i === lastVowel;
      let wordFinalSyl = true;
      for (let k = i + 1; k < n && word[k] === word[i]; k++) if (inf[k].vowel) wordFinalSyl = false;
      if (finalSyl) p *= 1.4; // clause-final lengthening
      else p *= 0.6; // non-phrase-final shortening
      if (!wordFinalSyl) p *= 0.85; // non-word-final shortening
      if ((vowelsInWord.get(word[i]) ?? 1) > 1) p *= 0.8; // polysyllabic shortening
      if (stress === 0) {
        min *= 0.5; // unstressed: minimum halved, shortened
        p *= 0.7;
      }
      // the following consonant (same word): voiced fricatives lengthen, voiceless stops shorten
      const nx = i + 1 < n && word[i + 1] === word[i] && !inf[i + 1].vowel ? inf[i + 1] : null;
      if (nx) {
        let f = 1;
        if (nx.manner === "fricative") f = nx.voiced ? 1.6 : 1;
        else if (nx.manner === "stop" || nx.manner === "affricate") f = nx.voiced ? 1.2 : 0.7;
        else if (nx.manner === "nasal") f = 0.85;
        p *= finalSyl ? f : 0.7 + 0.3 * f;
      }
      // vowel next to vowel
      if (i + 1 < n && inf[i + 1].vowel) p *= 1.2;
      if (i > 0 && inf[i - 1].vowel) p *= 0.7;
      let d = min + (inh - min) * p;
      // aspiration after a voiceless stop eats into a stressed vowel's onset: give it back
      const pv = i > 0 ? inf[i - 1] : null;
      if (stress > 0 && pv && pv.manner === "stop" && !pv.voiced) d += 20;
      return d / 1000;
    }
    // consonants
    const wordInitial = i === wordStart[word[i]];
    if (i > lastVowel && (inf[i].manner === "nasal" || inf[i].manner === "lateral" || inf[i].manner === "approximant")) p *= 1.4;
    if (!wordInitial) p *= 0.85;
    const prevC = i > 0 && !inf[i - 1].vowel;
    const nextC = i + 1 < n && !inf[i + 1].vowel;
    if (prevC && nextC) p *= 0.5;
    else if (prevC || nextC) p *= 0.7;
    return (min + (inh - min) * p) / 1000;
  });
}
