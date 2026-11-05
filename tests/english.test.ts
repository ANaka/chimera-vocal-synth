import { test, expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { EnglishG2P, letterToSound } from "../src/engine/phonetics/english.ts";

const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync("public/data/cmudict.txt.gz")).toString("utf8"));
const ipa = (s: { ipa: string }[]) => s.map((x) => x.ipa).join("");

test("dictionary words with stress and allophones", () => {
  const [p] = g2p.toPhrases("Hello world");
  expect(ipa(p.segments)).toBe("həloʊwɝɫd");
  expect(p.segments.find((s) => s.ipa === "oʊ")?.stress).toBe(1);
  const [w] = g2p.toPhrases("water");
  expect(ipa(w.segments)).toBe("wɔɾɚ");
});

test("punctuation makes phrases and question intonation", () => {
  const ph = g2p.toPhrases("Is it on? Yes, it is.");
  expect(ph.length).toBe(3);
  expect(ph[0].intonation).toBe("question");
  expect(ph[2].intonation).toBe("statement");
});

test("numbers are spelled out and unknown words fall back to rules", () => {
  const [p] = g2p.toPhrases("42");
  expect(p.words).toEqual(["forty", "two"]);
  expect(ipa(letterToSound("zorblat")).length).toBeGreaterThan(4);
});

test("words that are also object property names do not break the front end", () => {
  for (const w of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype"]) {
    const [p] = g2p.toPhrases(`The ${w} is ready.`);
    expect(p.segments.length).toBeGreaterThan(5);
  }
  expect(new EnglishG2P().toPhrases("constructor")[0].segments.length).toBeGreaterThan(3); // no dictionary
});
