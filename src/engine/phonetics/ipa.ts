/** IPA string → segments (stress ˈ ˌ, length ː, tie bars, affricates, diphthongs, word gaps). */
import type { Segment } from "./planner.ts";
import { CONSONANT_SYMBOLS } from "./inventory.ts";

const VOWEL_CHARS = "iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɝɚ";
const MULTI = ["tʃ", "dʒ", "ts", "dz", "pf", "aɪ", "aʊ", "ɔɪ", "eɪ", "oʊ"];
const ALIASES: Record<string, string> = { "t͡ʃ": "tʃ", "d͡ʒ": "dʒ", "t͡s": "ts", "d͡z": "dz", ɡ: "g", ʧ: "tʃ", ʤ: "dʒ", r̥: "r", ɐ̯: "ɐ" };

export function tokenizeIpa(input: string): Segment[] {
  let s = input.normalize("NFC");
  for (const [a, b] of Object.entries(ALIASES)) s = s.split(a).join(b);
  s = s.replace(/[͜͡]/g, ""); // tie bars
  const out: Segment[] = [];
  let stress = 0;
  let i = 0;
  const known = new Set([...CONSONANT_SYMBOLS, ...VOWEL_CHARS.split(""), ...MULTI]);
  while (i < s.length) {
    const ch = s[i];
    if (ch === "ˈ" || ch === "'") {
      stress = 1;
      i++;
      continue;
    }
    if (ch === "ˌ") {
      stress = 2;
      i++;
      continue;
    }
    if (ch === " " || ch === "." || ch === "|" || ch === ",") {
      if (out.length) out[out.length - 1].wordEnd = true;
      if (ch === "," || ch === "|") out.push({ ipa: "_", dur: 0.16 });
      i++;
      continue;
    }
    if (ch === "ː" || ch === ":") {
      const last = out[out.length - 1];
      if (last) last.dur = (last.dur ?? (VOWEL_CHARS.includes(last.ipa[0]) ? 0.15 : 0.09)) * 1.7;
      i++;
      continue;
    }
    let tok = "";
    for (const m of MULTI) if (s.startsWith(m, i)) tok = m;
    if (!tok) tok = ch;
    i += tok.length;
    // skip combining diacritics we do not model
    while (i < s.length && /[̀-ͯ]/.test(s[i])) i++;
    if (!known.has(tok)) continue;
    const isV = VOWEL_CHARS.includes(tok[0]) && !CONSONANT_SYMBOLS.includes(tok);
    out.push({ ipa: tok, stress: isV ? stress : 0 });
    if (isV) stress = 0;
  }
  return out.filter((x) => x.ipa !== "_" || true);
}
