/**
 * English text → phoneme segments: CMUdict (ARPAbet with stress) when loaded, letter-to-sound
 * rules otherwise; American flapping and dark /l/; numbers spelled out; punctuation → phrase
 * breaks and intonation.
 */
import type { Segment } from "./planner.ts";

const ARPA: Record<string, string> = {
  AA: "ɑ", AE: "æ", AH: "ʌ", AO: "ɔ", AW: "aʊ", AY: "aɪ", EH: "ɛ", ER: "ɝ", EY: "eɪ", IH: "ɪ", IY: "i", OW: "oʊ", OY: "ɔɪ", UH: "ʊ", UW: "u",
  B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "g", HH: "h", JH: "dʒ", K: "k", L: "l", M: "m", N: "n", NG: "ŋ", P: "p", R: "ɹ", S: "s", SH: "ʃ", T: "t", TH: "θ", V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ",
};
const VOWELS = new Set(["ɑ", "æ", "ʌ", "ə", "ɔ", "aʊ", "aɪ", "ɛ", "ɝ", "ɚ", "eɪ", "ɪ", "i", "oʊ", "ɔɪ", "ʊ", "u"]);
/**
 * The dictionary keeps one pronunciation per word; for these homographs it kept the rarer one
 * (the verb "wind", past-tense "read"). Telling them apart needs grammar; the common reading wins.
 */
const HOMOGRAPHS: Record<string, string> = {
  wind: "W IH1 N D",
  read: "R IY1 D",
  live: "L IH1 V",
  lead: "L IY1 D",
  close: "K L OW1 Z",
  wound: "W UW1 N D",
};

/** monosyllabic function words are unstressed in running speech (and reduce) */
const FUNCTION_WORDS = new Set("a an the of to in on at by for from with as and or but nor so if is am are was were be been do does did has have had will would can could should shall may might must it its i you he she we they me him her us them my your his our their this that than then there not no".split(" "));
const REDUCE: Record<string, string> = { ʌ: "ə", æ: "ə", ɑ: "ə", ɛ: "ə", ɔ: "ə", u: "ə", ʊ: "ə" };

export interface Phrase {
  segments: Segment[];
  intonation: "statement" | "question";
  /** pause after the phrase (s) */
  pause: number;
  words: string[];
}

export class EnglishG2P {
  private dict: Map<string, string> | null = null;
  private loading: Promise<void> | null = null;

  get loaded(): boolean {
    return !!this.dict;
  }

  /** Load the gzipped dictionary ("word\tPHONES" lines). Browser: fetch + DecompressionStream. */
  load(url = "/data/cmudict.txt.gz"): Promise<void> {
    if (this.dict) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`dictionary ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // servers differ: some send Content-Encoding: gzip (already inflated by the browser)
      let text: string;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
      } else text = new TextDecoder().decode(bytes);
      this.setDictionaryText(text);
      } catch (e) {
        this.loading = null; // allow a retry
        throw e;
      }
    })();
    return this.loading;
  }

  setDictionaryText(text: string): void {
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) m.set(line.slice(0, tab), line.slice(tab + 1));
    }
    this.dict = m;
  }

  /** Text → phrases of segments. */
  toPhrases(text: string): Phrase[] {
    const phrases: Phrase[] = [];
    const normalized = expandNumbers(text.replace(/[’']/g, "'"));
    // split on phrase punctuation, keeping the delimiter
    const parts = normalized.split(/([.!?;:,]+)/);
    let words: string[] = [];
    const flush = (delim: string) => {
      if (!words.length) return;
      const segs: Segment[] = [];
      for (const w of words) {
        const ws = this.word(w);
        if (!ws.length) continue;
        ws[ws.length - 1].wordEnd = true;
        segs.push(...ws);
      }
      applyAllophones(segs);
      const q = delim.includes("?");
      const pause = /[.!?]/.test(delim) ? 0.35 : delim ? 0.18 : 0.3;
      if (segs.length) phrases.push({ segments: segs, intonation: q ? "question" : "statement", pause, words });
      words = [];
    };
    for (const part of parts) {
      if (/^[.!?;:,]+$/.test(part)) flush(part);
      else words.push(...part.toLowerCase().split(/[^a-z'\-]+/).filter(Boolean));
    }
    flush("");
    return phrases;
  }

  /** One word → segments with lexical stress. `reduce`: weak forms of function words (speech). */
  word(w: string, reduce = true): Segment[] {
    const clean = w.toLowerCase().replace(/^'+|'+$/g, "");
    const entry = HOMOGRAPHS[clean] ?? this.dict?.get(clean);
    if (entry) {
      const segs = arpabetToSegments(entry);
      if (reduce && FUNCTION_WORDS.has(clean)) {
        const nv = segs.filter((s) => VOWELS.has(s.ipa)).length;
        for (const s of segs) {
          s.stress = 0;
          // short function words reduce toward schwa ("of" → əv, "and" → ənd), except /i ɪ eɪ aɪ oʊ/
          if (nv === 1 && REDUCE[s.ipa] && !["you", "do", "to", "who", "not", "no"].includes(clean)) s.ipa = REDUCE[s.ipa];
        }
      }
      return segs;
    }
    // hyphenated compounds
    if (clean.includes("-")) return clean.split("-").flatMap((p) => this.word(p, reduce));
    return letterToSound(clean);
  }
}

export function arpabetToSegments(phones: string): Segment[] {
  const out: Segment[] = [];
  for (const ph of phones.trim().split(/\s+/)) {
    const m = ph.match(/^([A-Z]+)([012])?$/);
    if (!m) continue;
    const base = m[1];
    const stress = m[2] === "1" ? 1 : m[2] === "2" ? 2 : 0;
    let ipa = ARPA[base];
    if (!ipa) continue;
    if (base === "AH" && stress === 0) ipa = "ə";
    if (base === "ER" && stress === 0) ipa = "ɚ";
    out.push({ ipa, stress: VOWELS.has(ipa) ? stress : 0 });
  }
  return out;
}

/** American English allophones: flapping and velarised coda /l/ (in place). */
function applyAllophones(segs: Segment[]): void {
  for (let i = 1; i < segs.length - 1; i++) {
    const s = segs[i];
    const prev = segs[i - 1], next = segs[i + 1];
    const pv = VOWELS.has(prev.ipa) || prev.ipa === "ɹ";
    const nv = VOWELS.has(next.ipa);
    // /t d/ between a vowel and an unstressed vowel → tap ("water", "ladder", "got it"), but not
    // at the start of a word ("were disputing" keeps its /d/)
    if ((s.ipa === "t" || s.ipa === "d") && pv && nv && !next.stress && !prev.wordEnd) s.ipa = "ɾ";
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.ipa !== "l") continue;
    const next = segs[i + 1];
    // coda /l/ (before a consonant, pause, or word end) is velarised
    if (!next || !VOWELS.has(next.ipa) || s.wordEnd) s.ipa = "ɫ";
  }
}

// ---------------------------------------------------------------- numbers
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberWords(n % 100) : "");
  if (n < 1e6) return numberWords(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + numberWords(n % 1000) : "");
  return n.toString().split("").map((d) => ONES[+d]).join(" ");
}
function expandNumbers(t: string): string {
  return t.replace(/\d+/g, (d) => " " + numberWords(parseInt(d, 10)) + " ");
}

// ---------------------------------------------------------------- letter-to-sound fallback
/**
 * Compact rule set for words missing from the dictionary. Rules are tried longest-first at each
 * position; context classes: '#' word boundary, 'V' vowel letter, 'C' consonant letter.
 */
type Rule = [pre: string, grapheme: string, post: string, phones: string];
const RULES: Rule[] = [
  ["", "tion", "", "ʃ ə n"], ["", "sion", "", "ʒ ə n"], ["", "ture", "", "tʃ ɚ"], ["", "ough", "#", "oʊ"], ["", "augh", "", "ɔ"],
  ["", "igh", "", "aɪ"], ["", "eigh", "", "eɪ"], ["", "tch", "", "tʃ"], ["", "dge", "", "dʒ"], ["", "sch", "", "s k"],
  ["", "ch", "", "tʃ"], ["", "sh", "", "ʃ"], ["", "th", "", "θ"], ["", "ph", "", "f"], ["", "wh", "", "w"], ["", "ck", "", "k"],
  ["", "ng", "#", "ŋ"], ["", "ng", "", "ŋ g"], ["", "qu", "", "k w"], ["#", "kn", "", "n"], ["#", "wr", "", "ɹ"], ["", "gh", "", ""],
  ["", "ee", "", "i"], ["", "ea", "", "i"], ["", "oo", "", "u"], ["", "ou", "", "aʊ"], ["", "ow", "#", "oʊ"], ["", "ow", "", "aʊ"],
  ["", "oi", "", "ɔɪ"], ["", "oy", "", "ɔɪ"], ["", "ai", "", "eɪ"], ["", "ay", "", "eɪ"], ["", "au", "", "ɔ"], ["", "aw", "", "ɔ"],
  ["", "ie", "#", "aɪ"], ["", "ie", "", "i"], ["", "ei", "", "eɪ"], ["", "ey", "#", "i"], ["", "oa", "", "oʊ"], ["", "ue", "#", "u"],
  ["", "er", "#", "ɚ"], ["", "er", "C", "ɝ"], ["", "ir", "", "ɝ"], ["", "ur", "", "ɝ"], ["", "or", "", "ɔ ɹ"], ["", "ar", "", "ɑ ɹ"],
  ["", "le", "#", "ə ɫ"], ["", "ed", "#", "d"], ["", "es", "#", "z"], ["C", "s", "#", "s"], ["V", "s", "#", "z"], ["", "y", "#", "i"],
  ["#", "y", "", "j"], ["C", "y", "", "aɪ"], ["", "e", "#", ""],
  ["", "a", "CV", "eɪ"], ["", "a", "", "æ"], ["", "e", "", "ɛ"], ["", "i", "CV", "aɪ"], ["", "i", "", "ɪ"], ["", "o", "CV", "oʊ"],
  ["", "o", "", "ɑ"], ["", "u", "CV", "u"], ["", "u", "", "ʌ"], ["", "y", "", "ɪ"],
  ["", "c", "e", "s"], ["", "c", "i", "s"], ["", "c", "y", "s"], ["", "c", "", "k"], ["", "g", "e", "dʒ"], ["", "g", "i", "dʒ"], ["", "g", "", "g"],
  ["", "x", "", "k s"], ["", "j", "", "dʒ"], ["", "q", "", "k"], ["", "b", "", "b"], ["", "d", "", "d"], ["", "f", "", "f"], ["", "h", "", "h"],
  ["", "k", "", "k"], ["", "l", "", "l"], ["", "m", "", "m"], ["", "n", "", "n"], ["", "p", "", "p"], ["", "r", "", "ɹ"], ["", "s", "", "s"],
  ["", "t", "", "t"], ["", "v", "", "v"], ["", "w", "", "w"], ["", "z", "", "z"],
];
const isV = (ch: string | undefined) => !!ch && "aeiouy".includes(ch);
function matchCtx(word: string, i: number, ctx: string, dir: 1 | -1): boolean {
  if (!ctx) return true;
  let pos = i;
  for (let k = 0; k < ctx.length; k++) {
    const c = dir === 1 ? ctx[k] : ctx[ctx.length - 1 - k];
    const ch = word[pos];
    if (c === "#") {
      if (ch !== undefined) return false;
    } else if (c === "V") {
      if (!isV(ch)) return false;
    } else if (c === "C") {
      if (!ch || isV(ch)) return false;
    } else if (ch !== c) return false;
    pos += dir;
  }
  return true;
}
export function letterToSound(word: string): Segment[] {
  const phones: string[] = [];
  let i = 0;
  while (i < word.length) {
    let done = false;
    for (const [pre, g, post, ph] of RULES) {
      if (!word.startsWith(g, i)) continue;
      if (!matchCtx(word, i - 1, pre, -1)) continue;
      if (!matchCtx(word, i + g.length, post, 1)) continue;
      if (ph) phones.push(...ph.split(" "));
      i += g.length;
      done = true;
      break;
    }
    if (!done) i++;
  }
  // stress the first vowel (crude but serviceable)
  let stressed = false;
  return phones.map((ipa) => {
    const v = VOWELS.has(ipa);
    const seg: Segment = { ipa, stress: v && !stressed ? 1 : 0 };
    if (v) stressed = true;
    return seg;
  });
}
