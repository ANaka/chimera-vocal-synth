/**
 * Lyrics → sung syllables. Words come from the pronouncing dictionary (unreduced: sung function
 * words keep full vowels), are split into syllables by the maximal-onset principle with English
 * onset clusters, and the spelling is split to match for display ("twin-kle").
 * Typed hyphens force syllable breaks; a lone "-" (or "~") holds the previous vowel onto the
 * next note (melisma), as in vocaloid editors.
 */
import type { Segment } from "./planner.ts";
import { isVowel } from "./planner.ts";

export interface Syllable {
  /** lyric text shown on the note */
  text: string;
  onset: Segment[];
  /** vowel (a diphthong stays one nucleus: "aɪ") */
  nucleus: Segment;
  coda: Segment[];
  /** continue the previous syllable's vowel at a new pitch */
  melisma?: boolean;
  /** last syllable of a word (codas sound here; phrase breaks follow punctuation) */
  wordEnd: boolean;
  /** a breath follows (comma, full stop, line break) */
  phraseEnd: boolean;
}

// English onsets (IPA), longest first matters only for the search below
const ONSETS = new Set([
  "p", "b", "t", "d", "k", "g", "f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ", "h", "m", "n", "l", "ɹ", "w", "j", "tʃ", "dʒ",
  "pl", "bl", "kl", "gl", "fl", "sl", "pɹ", "bɹ", "tɹ", "dɹ", "kɹ", "gɹ", "fɹ", "θɹ", "ʃɹ",
  "sp", "st", "sk", "sm", "sn", "sw", "sf", "tw", "kw", "dw", "gw", "θw",
  "pj", "bj", "kj", "gj", "mj", "nj", "fj", "vj", "hj", "lj",
  "spl", "spɹ", "stɹ", "skɹ", "skw", "skj", "spj",
]);

/** Split one word's segments into onset / nucleus / coda syllables. */
export function syllabifySegments(segs: Segment[]): { onset: Segment[]; nucleus: Segment; coda: Segment[] }[] {
  const vi = segs.map((s, i) => (isVowel(s.ipa) ? i : -1)).filter((i) => i >= 0);
  if (!vi.length) return [];
  const out: { onset: Segment[]; nucleus: Segment; coda: Segment[] }[] = [];
  let start = 0;
  vi.forEach((v, n) => {
    const next = vi[n + 1];
    let end = segs.length; // exclusive end of this syllable
    if (next !== undefined) {
      // consonants between this vowel and the next: the longest legal onset goes right
      const between = segs.slice(v + 1, next);
      let k = 0;
      for (let len = Math.min(3, between.length); len >= 1; len--) {
        if (ONSETS.has(between.slice(between.length - len).map((s) => s.ipa).join(""))) {
          k = len;
          break;
        }
      }
      end = next - k;
    }
    out.push({ onset: segs.slice(start, v), nucleus: segs[v], coda: segs.slice(v + 1, end) });
    start = end;
  });
  return out;
}

const V = /[aeiouy]+/g;

/** Split a written word into n chunks at its vowel groups (approximate hyphenation). */
export function splitSpelling(word: string, n: number): string[] {
  if (n <= 1) return [word];
  const groups: [number, number][] = [];
  for (const m of word.toLowerCase().matchAll(V)) groups.push([m.index!, m.index! + m[0].length]);
  // a final silent e ("like") is not a syllable, but consonant + "le" is ("twin-kle", "lit-tle")
  if (groups.length > 1 && /[^aeiouy]e$/i.test(word) && !/[^aeiouyl]le$/i.test(word) && groups[groups.length - 1][0] === word.length - 1) groups.pop();
  if (groups.length < n) {
    // fewer written vowels than sung syllables (e.g. "fire"): hold the word, then continue marks
    return [word, ...Array(n - 1).fill("~")];
  }
  while (groups.length > n) {
    const last = groups.pop()!;
    groups[groups.length - 1][1] = last[1];
  }
  const cuts: number[] = [0];
  for (let i = 0; i < groups.length - 1; i++) {
    const a = groups[i][1], b = groups[i + 1][0]; // consonant letters a..b between vowel groups
    // a digraph stays together on the right ("any-where", "fa-ther"); otherwise one consonant
    // goes right and longer runs split in the middle ("lit-tle", "won-der")
    const gap = b - a;
    const dig = gap >= 2 && /^(th|sh|ch|ph|wh|ck|gh)$/i.test(word.slice(b - 2, b));
    cuts.push(dig ? b - 2 : a + (gap <= 1 ? 0 : Math.floor(gap / 2)));
  }
  cuts.push(word.length);
  return cuts.slice(0, -1).map((c, i) => word.slice(c, cuts[i + 1]));
}

export interface WordSource {
  word(w: string, reduce?: boolean): Segment[];
}

/** Lyrics text → syllables (needs the pronouncing dictionary for real words). */
export function lyricsToSyllables(text: string, g2p: WordSource): Syllable[] {
  const out: Syllable[] = [];
  // words, melisma marks and phrase punctuation, in order
  const tokens = text.replace(/[’']/g, "'").match(/[A-Za-z'][A-Za-z'\-]*|(?<=\s|^)[~-](?=\s|$)|[.,;:!?\n]/g) ?? [];
  for (const tok of tokens) {
    if (/^[.,;:!?\n]$/.test(tok)) {
      if (out.length) out[out.length - 1].phraseEnd = true;
      continue;
    }
    if (tok === "-" || tok === "~") {
      const prev = out[out.length - 1];
      if (prev) out.push({ text: "~", onset: [], nucleus: prev.nucleus, coda: [], melisma: true, wordEnd: prev.wordEnd, phraseEnd: false });
      continue;
    }
    // typed hyphens split syllables explicitly ("ti-ger"); otherwise the dictionary decides
    const parts = tok.split("-").filter(Boolean);
    const syls: Syllable[] = [];
    for (const part of parts) {
      const sy = syllabifySegments(g2p.word(part.toLowerCase(), false));
      const spell = parts.length > 1 ? [part, ...Array(Math.max(0, sy.length - 1)).fill("~")] : splitSpelling(part, sy.length);
      sy.forEach((s, i) => syls.push({ ...s, text: spell[i] ?? "~", wordEnd: false, phraseEnd: false }));
    }
    if (syls.length) syls[syls.length - 1].wordEnd = true;
    out.push(...syls);
  }
  return out;
}
