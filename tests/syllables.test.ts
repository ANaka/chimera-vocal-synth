import { describe, expect, test } from "bun:test";
import { arpabetToSegments } from "../src/engine/phonetics/english.ts";
import { lyricsToSyllables, splitSpelling, syllabifySegments } from "../src/engine/phonetics/syllables.ts";

// a few CMUdict entries, enough to test without loading the dictionary
const DICT: Record<string, string> = {
  twinkle: "T W IH1 NG K AH0 L",
  little: "L IH1 T AH0 L",
  star: "S T AA1 R",
  how: "HH AW1",
  i: "AY1",
  wonder: "W AH1 N D ER0",
  what: "W AH1 T",
  you: "Y UW1",
  are: "AA1 R",
  extra: "EH1 K S T R AH0",
  of: "AH1 V",
};
const g2p = { word: (w: string) => (DICT[w] ? arpabetToSegments(DICT[w]) : []) };
const ipa = (xs: { ipa: string }[]) => xs.map((x) => x.ipa).join("");

describe("syllables", () => {
  test("maximal onset with legal English clusters", () => {
    const tw = syllabifySegments(g2p.word("twinkle"));
    expect(tw.map((s) => [ipa(s.onset), s.nucleus.ipa, ipa(s.coda)])).toEqual([
      ["tw", "ɪ", "ŋ"],
      ["k", "ə", "l"],
    ]);
    // "extra": k + str → ek-stra (str is a legal onset)
    const ex = syllabifySegments(g2p.word("extra"));
    expect(ex.map((s) => ipa(s.onset))).toEqual(["", "stɹ"]);
    expect(ipa(ex[0].coda)).toBe("k");
  });
  test("spelling splits to match", () => {
    expect(splitSpelling("twinkle", 2)).toEqual(["twin", "kle"]);
    expect(splitSpelling("little", 2)).toEqual(["lit", "tle"]);
    expect(splitSpelling("wonder", 2)).toEqual(["won", "der"]);
    expect(splitSpelling("are", 1)).toEqual(["are"]);
  });
  test("lyrics: words, melisma, phrase ends, unreduced function words", () => {
    const syl = lyricsToSyllables("Twinkle little star, how I - wonder", g2p);
    expect(syl.map((s) => s.text)).toEqual(["Twin", "kle", "lit", "tle", "star", "how", "I", "~", "won", "der"]);
    expect(syl[4].phraseEnd).toBe(true);
    expect(syl[7].melisma).toBe(true);
    expect(syl[7].nucleus.ipa).toBe("aɪ");
    expect(syl[1].wordEnd && !syl[0].wordEnd).toBe(true);
  });
});
