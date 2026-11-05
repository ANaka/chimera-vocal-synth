/**
 * Text-side phonetics fixtures: IPA tokenizing (including decomposed diacritics, which NFC
 * composes), G2P with and without the dictionary, phrases, lyrics → syllables, spelling splits,
 * and the demo songs and vowel reference tables.
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { tokenizeIpa } from "../../src/engine/phonetics/ipa.ts";
import { EnglishG2P, arpabetToSegments, letterToSound } from "../../src/engine/phonetics/english.ts";
import { lyricsToSyllables, splitSpelling, syllabifySegments } from "../../src/engine/phonetics/syllables.ts";
import { DEMO_SONGS } from "../../src/engine/phonetics/songs.ts";
import { VOWELS } from "../../src/engine/phonetics/vowelData.ts";
import { Rng } from "../../src/engine/util/math.ts";
import { write } from "./lib.ts";

const DICT_TEXT = gunzipSync(readFileSync(new URL("../../public/data/cmudict.txt.gz", import.meta.url))).toString("utf8");
const withDict = new EnglishG2P();
withDict.setDictionaryText(DICT_TEXT);
const noDict = new EnglishG2P();
const rng = new Rng(77);
const pick = <T>(xs: T[]) => xs[Math.floor(rng.next() * xs.length)];

// ---------------------------------------------------------------- IPA
const IPA_FIXED = [
  "", " ", "ˈhɛloʊ ˈwɝld", "ʃi sɛlz ˈɑpɑ", "ˈθɪŋk ə ˈbæd ˈkæt", "ˈmʌni ˈtʃɪp ˈʒu ˈvæn", "ˈlɑ", "ˈbɑbɑbɑbɑ",
  "ˌɪntɚˈnæʃənəl", "'ata", "a:ta", "aːːt", "ː", "tʃ dʒ ts dz pf", "aɪ aʊ ɔɪ eɪ oʊ", "t͡ʃa d͡ʒa t͡sa d͡za", "t͜ʃa", "ʧa ʤa", "ɡæp",
  "r̥ɐ̯", "ɐ̯", "a, b | c . d", ",,||", "ˈaˌbˈc", "ɸβθðʂʐçʝxɣχʁħʕhɦɬɮ", "ʈɖcɟkgqɢʔ", "mɱnɳɲŋɴ", "wʋɹɻjɰlɫɭʎɾɽrʀʙ",
  "iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɝɚ", "ã ẽ õ", "ã ẽ", "n̩", "ça", "ça", "ḉa", "ḉa",
  "ḉa", "ç̴a", "á", "áb", "a͐́", "á̕", "ệ", "ŕ̥",
  "r̴̥", "t́͡ʃ", "t́͡ʃ", "ǯ", "ǯa", "ɔ̃", "ö", "ü", "ÿ", "i̇",
  "ŋ̊", "s̪", "d̺", "kʰa", "tʰa", "pʼa", "ə˞", "ɑ̃̀", "́a", "a\u{1d165}b", "😀a😀",
  "a͏́", "A B C", "HELLO", "ˈtʃˈdʒ", "t ʃ", "taɪm", "aɪɪ", "oʊː", "ʊə", "a;b", "a\tb", "a\nb", "kʷa", "ⁿda", "ᵐba",
  "ę", "ɛ̨", "ơ", "ứ", "ặ", "ặ", "ī̱", "ǿ", "ǽ",
  "ǣ", "ǯ́", "ǵ", "ɡ́", "Å", "K", "Åx", "Kx", "ä́", "à", "ç̨", "ç̴",
];
const IPA_ALPHABET = [..."iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɝɚpbtdʈɖcɟkgqɢʔmɱnɳɲŋɴɸβfvθðszʃʒʂʐçʝxɣχʁħʕhɦɬɮwʋɹɻjɰlɫɭʎɾɽrʀʙɡʧʤ", "ˈ", "ˌ", "'", " ", ".", "|", ",", "ː", ":", "͡", "͜", "̃", "́", "̀", "̂", "̈", "̧", "̥", "̯", "̩", "̣", "̱", "̌", "̆", "̄", "̨", "̴", "͐", "̕", "́", "ʰ", "ʷ", "x", "Q", "é", "ñ", "ü"];
const ipaCases: string[] = [...IPA_FIXED];
for (let k = 0; k < 400; k++) {
  const n = 1 + Math.floor(rng.next() * 14);
  let s = "";
  for (let i = 0; i < n; i++) s += pick(IPA_ALPHABET);
  ipaCases.push(s);
}
write("phonetics-ipa", ipaCases.map((input) => ({ input, segments: tokenizeIpa(input) })));

// ---------------------------------------------------------------- G2P
const dictWords = DICT_TEXT.split("\n").map((l) => l.slice(0, l.indexOf("\t"))).filter(Boolean);
const COMMON = (
  "hello world water ladder butter little bottle better city party letter matter metal pedal total model " +
  "the a an of to in on at by for from with as and or but nor so if is am are was were be been do does did has have had will " +
  "would can could should shall may might must it its i you he she we they me him her us them my your his our their this that " +
  "than then there not no who what where when why how one two three ten eleven twenty hundred thousand " +
  "wind read live lead close wound tear bass bow row sow minute object present record " +
  "people time year way day thing man woman child life hand part place case week company system program question work " +
  "government number night point home room mother area money story fact month lot right study book eye job word business " +
  "issue side kind head house service friend father power hour game line end member law car city community name president " +
  "team minute idea kid body information back parent face others level office door health person art war history party result " +
  "change morning reason research girl guy moment air teacher force education singing anywhere breathe tongue lips throat " +
  "twinkle star wonder made fire hour our flower"
).split(" ");
const UNKNOWN = "zorblat quixotical fnord blorptastic snergle wugs glimmerish thropple kniggle wrabbit phlogistic xylophonic chairsch tioner sionel ture ough augh eigh dge ngle bring rings queen yoyo crazyy cye gye cee jello hyphen-ated well-known re-read x-ray don't won't o'clock 'tis rock'n'roll".split(" ");
const ODD = ["", "'", "''", "-", "--", "a-", "-a", "'hello'", "HELLO", "Hello", "WiNd", "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype", "naïve", "café", "İstanbul", "straße", "Ωmega", "Kelvin", "jalapeño", "日本", "😀smile", "ab😀ab", "x́x", "tion", "s", "y", "e", "le", "es", "ed", "er", "ers", "ng"];
const g2pWords = [...COMMON, ...UNKNOWN, ...ODD];
for (let i = 0; i < dictWords.length; i += 600) g2pWords.push(dictWords[i]);
const segsOf = (g: EnglishG2P, w: string) => ({ reduce: g.word(w), full: g.word(w, false) });
write(
  "phonetics-g2p",
  {
    words: g2pWords.map((w) => ({ w, dict: segsOf(withDict, w), noDict: segsOf(noDict, w), lts: letterToSound(w) })),
    arpabet: ["", "  ", "HH AH0 L OW1", " W ER1 L D ", "AH0\tB\r", "XX Y1 AY12 aa1 AH3 ER0 ER2 AH2", "AY1 B\u0085C﻿D", "K AE1 T", "B0 D1 NG2 ZH"].map((p) => ({ p, segments: arpabetToSegments(p) })),
  },
);

const SENTENCES = [
  "Hello world", "water", "Is it on? Yes, it is.", "42", "The constructor is ready.", "The __proto__ is ready.",
  "What time is it? It's 3:45, I think.", "I have 1,000,000 reasons; you have 7.", "Read the lead, then close the door!",
  "Got it? Got it.", "We were disputing the matter.", "Little bottles of water, in a row...", "She said: “don't!” — and left.",
  "Is the wind live?? Really?!", "", "   ", "...", "?", "a", "The year 2026 was odd; 1999 was odder.", "0 1 19 20 21 99 100 101 110 999 1000 1001 10000 99999 100000 999999",
  "1000000 1234567 12345678901234567890 123456789012345678901234567890", "9".repeat(400), "007 and 0042", "x1y2z3",
  "Rock'n'roll isn't dead, it’s well-known.", "Twinkle twinkle little star, how I wonder what you are.",
  "Breathe in, breathe out, I am made of air. Tongue and lips and throat, singing anywhere.",
  "ZORBLAT quixotical fnord!", "Call me at 555-1234.", "İstanbul and naïve café.", "Tabs\tand\nnewlines\r\nhere.",
  "the of and to a in", "He'll go; she'd stay: they've left, we're here.", "Who? You. Do it, not me, no.",
  "The rattle at the little hotel, tell all.", "A battle; a ladder: a rider, a writer.", "Mr. Smith vs. Dr. Jones.",
];
write(
  "phonetics-phrases",
  SENTENCES.map((text) => ({ text, dict: withDict.toPhrases(text), noDict: noDict.toPhrases(text) })),
);

// ---------------------------------------------------------------- syllables
const LYRICS = [
  "Twinkle little star, how I - wonder", "Twinkle twinkle little star, how I wonder what you are.",
  "Breathe in, breathe out, I am made of air. Tongue and lips and throat, singing anywhere.",
  "ti-ger ti-ger burn-ing bright", "Oh - - say can you ~ see\nby the dawn's ear-ly light", "- leading dash", "~", "a -b c- d - e ~f g~ ~",
  "fire hour flower", "extra little twinkle", "Hello, world! Is it on? Yes; no: maybe.\n\nNew line", "don’t stop believin'",
  "constructor toString __proto__", "zorblat fnord-ish", "AMAZING grace HOW sweet", "a-", "-", "--", "x - y", "x -- y",
  "naïve café İstanbul", "yesterday all my troubles seemed so far away", "the wind and the read and the lead",
  "123 numbers 4 you", "every everything everywhere", "strength twelfths rhythm", "queue quiet quite", "",
  "la la la - - la", "Ah~ ah ~ ah", "\tTab\tseparated - words\t", "one - two", "one ~ two",
];
const SPELL: [string, number][] = [
  ["twinkle", 2], ["little", 2], ["wonder", 2], ["are", 1], ["like", 1], ["like", 2], ["fire", 2], ["anywhere", 3], ["father", 2],
  ["everything", 3], ["everything", 2], ["everything", 4], ["beautiful", 3], ["queue", 1], ["queue", 2], ["rhythm", 2], ["table", 2],
  ["able", 2], ["apple", 2], ["simple", 2], ["file", 2], ["smile", 1], ["Twinkle", 2], ["LITTLE", 2], ["CAKE", 2], ["", 2], ["a", 3],
  ["aeiou", 1], ["aeiou", 2], ["strengths", 1], ["strengths", 2], ["rocket", 2], ["hockey", 2], ["laughing", 2], ["telephone", 3],
  ["telephone", 4], ["naïve", 2], ["İstanbul", 3], ["İstanbul", 2], ["Shine", 2], ["ACHE", 2], ["thrhe", 2], ["babybaby", 4], ["x", 0],
];
const dictSource = withDict;
const noDictSource = noDict;
write("phonetics-syllables", {
  lyrics: LYRICS.map((text) => ({ text, dict: lyricsToSyllables(text, dictSource), noDict: lyricsToSyllables(text, noDictSource) })),
  spelling: SPELL.map(([word, n]) => ({ word, n, parts: splitSpelling(word, n) })),
  syllabify: ["twinkle", "extra", "strengths", "anywhere", "rhythm", "zorblat", "a", "b"].map((w) => ({ w, parts: syllabifySegments(withDict.word(w, false)) })),
});

write("phonetics-data", { songs: DEMO_SONGS, vowels: VOWELS });
