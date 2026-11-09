/**
 * tools/midi-to-melody.ts: a MIDI track and a lyric sheet → the melody `chimera render notes` sings,
 * on a small SMF written here (Twinkle, Twinkle, Little Star: public domain), with syllable counts
 * from the engine and its dictionary.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { EnglishG2P, lyricsToSyllables } = await import("../src/wasm/engine.ts");
const { sungWords } = await import("../src/show/words.ts");
const { parseMidi, formatTracks, trackPhrases, formatPhrases, parseSheet, buildMelody, dictionaryWords, inDictionaryOf, SIGNATURES_WARNING, checkFlags } = await import(
  "../tools/midi-to-melody.ts"
);
const dictText = gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString();
new EnglishG2P().setDictionaryText(dictText);
const inDictionary = inDictionaryOf(dictionaryWords(dictText));
const count = (w: string) => lyricsToSyllables(w).length;

// ---- a standard MIDI file, written byte by byte
const DIV = 96;
const at = (beat: number) => Math.round(beat * DIV);
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const be = (n: number, size: number) => Array.from({ length: size }, (_, i) => (n >>> (8 * (size - 1 - i))) & 0xff);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
type Ev = { tick: number; data: number[] };
const meta = (tick: number, type: number, data: number[]): Ev => ({ tick, data: [0xff, type, ...vlq(data.length), ...data] });
/** events → an MTrk chunk (same-tick events keep their order; channel messages use running status) */
function trackChunk(events: Ev[]): number[] {
  const sorted = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || a.i - b.i);
  const body: number[] = [];
  let last = 0;
  let status = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - last));
    last = e.tick;
    const s = e.data[0];
    if (s < 0xf0 && s === status) body.push(...e.data.slice(1));
    else {
      body.push(...e.data);
      status = s < 0xf0 ? s : 0;
    }
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...ascii("MTrk"), ...be(body.length, 4), ...body];
}
function smf(tracks: Ev[][], format = 1, division = DIV): Uint8Array {
  return new Uint8Array([...ascii("MThd"), ...be(6, 4), ...be(format, 2), ...be(tracks.length, 2), ...be(division, 2), ...tracks.flatMap(trackChunk)]);
}
const on = (tick: number, midi: number, channel = 0): Ev => ({ tick, data: [0x90 | channel, midi, 100] });
const off = (tick: number, midi: number, channel = 0): Ev => ({ tick, data: [0x80 | channel, midi, 64] });
/** the notes of a one-track file (120 bpm) as [tick, end] */
const spans = (events: Ev[]) => parseMidi(smf([events])).tracks[0].notes.map((n) => [n.tick, n.end]);

// [start beat, beats, midi]
const NOTES: [number, number, number][] = [
  // P0 "Twin-kle twin-kle lit-tle star ~": the first C overlaps nothing, the second stops a quarter
  // beat short of the G (a gap legato absorbs), a low G under the second G (a chord: the top note
  // is kept), and the last G runs past the F's onset (cut there); the F is the melisma
  [0.5, 1, 60], [1.5, 0.75, 60], [2.5, 1, 67], [3.5, 1, 67], [3.5, 1.5, 55], [4.5, 1, 69], [5.5, 1, 69], [6.5, 1.75, 67], [8, 0.5, 65],
  // P1 "how I won-der _ what you are .": a doubled E after "der" (merged), the last C crosses the
  // tempo change at beat 16, and a high C nobody sings
  [9.5, 1, 65], [10.5, 1, 65], [11.5, 1, 64], [12.5, 0.5, 64], [13, 0.5, 64], [13.5, 1, 62], [14.5, 1, 62], [15.5, 1.5, 60], [17, 0.5, 72],
  // P2: an instrumental fill (not sung)
  [19, 1, 48], [20, 1, 50],
  // P3 "up a-bove"
  [22, 1, 67], [23, 1, 67], [24, 2, 65],
];
// 120 bpm, 4/4, then 60 bpm from beat 16
const conductor = [meta(0, 0x03, ascii("Twinkle")), meta(0, 0x51, be(500000, 3)), meta(0, 0x58, [4, 2, 24, 8]), meta(at(16), 0x51, be(1000000, 3))];
const melodyTrack: Ev[] = [meta(0, 0x03, ascii("Melody")), { tick: 0, data: [0xc0, 0] }, { tick: 0, data: [0xf0, 4, 0x7e, 0x7f, 0x09, 0xf7] }];
for (const [start, beats, midi] of NOTES) {
  melodyTrack.push({ tick: at(start), data: [0x90, midi, 100] });
  // note off both ways: 0x80, and note on with velocity 0
  melodyTrack.push({ tick: at(start + beats), data: midi < 55 ? [0x80, midi, 64] : [0x90, midi, 0] });
}
const file = parseMidi(smf([conductor, melodyTrack]));
const phrases = trackPhrases(file.tracks[1], file.division);

const SHEET = `# Twinkle, Twinkle, Little Star (public domain)
P0 | Twinkle, twinkle, little star ~
P1 | how I wonder _ what you are .

P2 | -
P3 | Up above!
`;

describe("the MIDI file", () => {
  test("tracks, tempo map and time signature", () => {
    expect(file.format).toBe(1);
    expect(file.division).toBe(DIV);
    expect(file.tracks.map((t) => t.name)).toEqual(["Twinkle", "Melody"]);
    expect(file.tracks[1].channels).toEqual([0]);
    expect(file.tracks[1].notes.length).toBe(NOTES.length);
    expect(file.tempos).toEqual([{ tick: 0, usPerBeat: 500000 }, { tick: at(16), usPerBeat: 1000000 }]);
    expect(file.timeSignatures).toEqual([{ tick: 0, numerator: 4, denominator: 4 }]);
  });

  test("note-offs end the oldest held note of their key", () => {
    // a retrigger whose note-off comes after the new note-on, on the same tick
    const retrigger = [on(0, 60), on(96, 60), off(96, 60), off(192, 60)];
    expect(spans(retrigger)).toEqual([[0, 96], [96, 192]]);
    const t = parseMidi(smf([retrigger]));
    const p = trackPhrases(t.tracks[0], DIV);
    expect(p.map((x) => x.notes.length)).toEqual([2]);
    expect(buildMelody(p, parseSheet("P0 | la la"), { timing: t }, count).melody.notes).toEqual([[60, 1], [60, 1]]);
    // a doubled unison is one note
    const unison = parseMidi(smf([[on(96, 60), on(96, 60), off(192, 60), off(192, 60)]]));
    expect(trackPhrases(unison.tracks[0], DIV)[0].notes).toEqual([{ tick: 96, end: 192, midi: 60 }]);
    // an overlapping legato repeat: the second onset cuts the first
    const legato = parseMidi(smf([[on(0, 60), on(90, 60), off(100, 60), off(190, 60)]]));
    expect(trackPhrases(legato.tracks[0], DIV)[0].notes.map((n) => [n.tick, n.end])).toEqual([[0, 90], [90, 190]]);
    // a zero-length note on top of a chord is dropped, not kept in place of the real note
    expect(trackPhrases(parseMidi(smf([[on(0, 67), off(0, 67), on(0, 60), off(96, 60)]])).tracks[0], DIV)[0].notes).toEqual([{ tick: 0, end: 96, midi: 60 }]);
  });

  test("format 0: --channel picks the melody out of one track", () => {
    const events = [meta(0, 0x51, be(500000, 3))];
    for (const [beat, midi] of [[0, 72], [1, 74], [3, 76], [4, 77]]) events.push(on(at(beat), midi), off(at(beat + 1), midi));
    for (const [beat, midi] of [[0.5, 40], [2.5, 43]]) events.push(on(at(beat), midi, 1), off(at(beat + 3), midi, 1));
    const f0 = parseMidi(smf([events], 0));
    expect(f0.format).toBe(0);
    expect(formatTracks(f0)).toContain("ch 1,2");
    const melody = trackPhrases(f0.tracks[0], DIV, 0.5, 0);
    expect(melody.map((p) => p.notes.map((n) => n.midi))).toEqual([[72, 74], [76, 77]]);
    expect(trackPhrases(f0.tracks[0], DIV).flatMap((p) => p.notes.map((n) => n.midi))).toContain(40);
  });

  test("a gap of exactly the threshold splits, at any division", () => {
    // 24/120 = 0.2 beats; 144/120 - 120/120 is 0.19999999999999996
    const f = parseMidi(smf([[on(0, 60), off(120, 60), on(144, 62), off(264, 62)]], 1, 120));
    expect(f.division).toBe(120);
    expect(trackPhrases(f.tracks[0], 120, 0.2).length).toBe(2);
  });

  test("the gap must be > 0; a second time signature is flagged", () => {
    expect(() => trackPhrases(file.tracks[1], DIV, 0)).toThrow("gap must be > 0");
    expect(formatPhrases(1, phrases, file)).not.toContain(SIGNATURES_WARNING);
    const changing = { ...file, timeSignatures: [...file.timeSignatures, { tick: at(16), numerator: 3, denominator: 4 }] };
    expect(formatPhrases(1, phrases, changing)).toContain(SIGNATURES_WARNING);
  });

  test("phrases: one voice, split at gaps of half a beat", () => {
    expect(phrases.map((p) => p.notes.length)).toEqual([8, 9, 2, 3]);
    // the chord's low G is gone, and the long G is cut at the F
    expect(phrases[0].notes.map((n) => n.midi)).toEqual([60, 60, 67, 67, 69, 69, 67, 65]);
    expect(phrases[0].notes[6]).toEqual({ tick: at(6.5), end: at(8), midi: 67 });
    expect(formatPhrases(1, phrases, file)).toBe(
      `# track 1: 22 notes, 4 phrases (a gap of 0.5 beat or more starts a phrase). 4/4, bar = 4 beats, beat 0 = bar 1.
# each note: start beat (bar.beat) pitch duration-in-beats

P0 start 0.5 (bar 1.1.5) end 8.5, 8 notes, gap before 0.5
  0.5:C4:1  1.5:C4:0.75  2.5:G4:1  3.5:G4:1  4.5:A4:1  5.5:A4:1  6.5:G4:1.5  8:F4:0.5

P1 start 9.5 (bar 3.2.5) end 17.5, 9 notes, gap before 1
  9.5:F4:1  10.5:F4:1  11.5:E4:1  12.5:E4:0.5  13:E4:0.5  13.5:D4:1  14.5:D4:1  15.5:C4:1.5  17:C5:0.5

P2 start 19 (bar 5.4) end 21, 2 notes, gap before 1.5
  19:C3:1  20:D3:1

P3 start 22 (bar 6.3) end 26, 3 notes, gap before 1
  22:G4:1  23:G4:1  24:F4:2
`,
    );
  });
});

describe("the melody", () => {
  test("the engine counts the two-syllable words", () => {
    for (const w of ["twinkle", "little", "wonder", "above"]) expect(count(w)).toBe(2);
  });

  test("notes, rests and beats from the tempo map, legato inside a phrase", () => {
    const { melody, report } = buildMelody(phrases, parseSheet(SHEET), { timing: file, inDictionary }, count);
    expect(melody.bpm).toBe(120);
    expect("vibrato" in melody).toBe(false); // `chimera render notes` has its own default
    // the first sung note is at 0.25 s: raised to 0.3 s
    expect(melody.t0).toBeCloseTo(0.3, 9);
    expect(melody.lyrics).toBe("Twinkle twinkle little star ~ how I wonder what you are Up above");
    expect(melody.notes).toEqual([
      // P0: the short C lasts to the G's onset, the G to the F's (beats at 120 bpm)
      [60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 1.5], [65, 0.5],
      [0, 1],
      // P1: "der" takes the doubled E; "are" is 0.25 s at 120 and 1 s at 60 bpm (1.25 s = 2.5
      // beats of 120); the unsung C and the fill rest until P3
      [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2.5],
      [0, 10],
      [67, 2], [67, 2], [65, 4],
    ]);
    expect(report.sounding).toBe(18);
    expect(report.rests).toBe(2);
    expect(report.duration).toBeCloseTo(0.3 + 35.5 * 0.5, 9);
    expect(report.range).toEqual(["C4", "A4"]);
    expect(report.short).toEqual([]);
    expect(report.unknownWords).toEqual([]);
    // the MIDI's beat 0 is 0.25 s before the first note, which sings at 0.3 s
    expect(report.downbeat).toBeCloseTo(0.05, 9);

    // what `chimera render notes` and the show page check
    const syls = lyricsToSyllables(melody.lyrics);
    expect(syls.length).toBe(melody.notes.filter(([m]) => m > 0).length);
    expect(syls.some((s) => s.phraseEnd)).toBe(false);
    expect(syls[7].melisma).toBe(true);
    const words = sungWords(melody, syls);
    expect(words.times[0]).toEqual([0.3, 0.8]);
    expect(words.parent[7]).toBe(6); // the melisma sings "star"
  });

  test("tempo scale stretches time, not beats; transpose moves the pitch", () => {
    const sheet = parseSheet(SHEET);
    const slow = buildMelody(phrases, sheet, { timing: file, tempoScale: 0.5, transpose: 2 }, count);
    expect(slow.melody.bpm).toBe(60);
    expect(slow.melody.t0).toBeCloseTo(0.5, 9);
    const plain = buildMelody(phrases, sheet, { timing: file }, count).melody;
    expect(slow.melody.notes).toEqual(plain.notes.map(([m, b]) => [m > 0 ? m + 2 : 0, b]));
    expect(slow.report.range).toEqual(["D4", "B4"]);
    expect(slow.report.downbeat).toBeCloseTo(0, 9);

    // four times as fast: the melisma's half beat is 1/16 s
    const fast = buildMelody(phrases, sheet, { timing: file, tempoScale: 4 }, count);
    expect(fast.melody.t0).toBeCloseTo(0.3, 9);
    expect(fast.report.short).toEqual([{ phrase: 0, word: "~", seconds: 0.0625 }]);
    expect(fast.report.downbeat).toBeCloseTo(0.3 - 0.25 / 4, 9);
  });

  test("the downbeat isn't moved a bar late when rounding t0 puts it a hair below 0", () => {
    // 0.25 s / 0.3 = 0.8333333 s, t0 rounds to 0.833333: the old code added a whole bar
    expect(buildMelody(phrases, parseSheet(SHEET), { timing: file, tempoScale: 0.3 }, count).report.downbeat).toBe(0);
    // a first note at tick 79 of 96 (0.4114583 s at 120 bpm)
    const late = parseMidi(smf([[on(79, 60), off(79 + 96, 60)]]));
    const { melody, report } = buildMelody(trackPhrases(late.tracks[0], DIV), parseSheet("P0 | la"), { timing: late }, count);
    expect(melody.t0).toBe(0.411458);
    expect(report.downbeat).toBe(0);
  });

  test("the bpm is the tempo the notes play at when two tempos share tick 0", () => {
    // 100 bpm then 150 bpm on tick 0: the last one plays
    const twoTempos = parseMidi(smf([[meta(0, 0x51, be(600000, 3)), meta(0, 0x51, be(400000, 3))], [on(0, 60), off(96, 60), on(96, 62), off(192, 62), on(192, 64), off(384, 64)]]));
    const { melody } = buildMelody(trackPhrases(twoTempos.tracks[1], DIV), parseSheet("P0 | la la la"), { timing: twoTempos }, count);
    expect(melody.bpm).toBe(150);
    expect(melody.notes).toEqual([[60, 1], [62, 1], [64, 2]]);
  });

  test("a sheet that doesn't fit names every bad phrase", () => {
    const bad = parseSheet("P0 | Twinkle twinkle little star\nP1 | how I wonder what you are .\nP2 | -\nP3 | Up above the zzyzxq\n");
    let message = "";
    try {
      buildMelody(phrases, bad, { timing: file, inDictionary }, count);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("3 phrases");
    expect(message).toContain("P0 (line 1): 8 notes, the sheet consumes 7: Twinkle 2, twinkle 2, little 2, star 1");
    expect(message).toContain("P1 (line 2): 9 notes, the sheet consumes 8:");
    expect(message).toContain("P3 (line 4): 3 notes");
    expect(message).toMatch(/zzyzxq \d+\?/); // not in the dictionary: a guess
    expect(message).not.toContain("P2");
  });

  test("digits and non-ASCII letters are refused; '#' starts a comment anywhere", () => {
    expect(() => parseSheet("P0 | the 1st one")).toThrow("spell it out");
    expect(() => parseSheet("P0 | caf\u00e9")).toThrow("spell it out");
    expect(() => parseSheet("P0 | cafe\u0301")).toThrow("spell it out"); // a combining accent
    expect(parseSheet("P0 | \u201cUp,\u201d a-bove! # twinkle 2")[0].tokens).toEqual([
      { kind: "word", text: "Up" },
      { kind: "word", text: "a-bove" },
    ]);
  });

  test("the sheet's phrases come once each, in order", () => {
    expect(() => parseSheet("P0 | Twinkle\nP2 | how")).toThrow("sheet line 2: P2 where P1 should be");
    expect(() => parseSheet("P0 | Twinkle - twinkle")).toThrow("sheet line 1");
    expect(() => buildMelody(phrases, parseSheet("P0 | Twinkle twinkle little star ~\nP1 | -"), { timing: file }, count)).toThrow("the track has 4 phrases");
    // "_" and "~" need a sung note before them in the phrase
    const sheet = parseSheet("P0 | Twinkle twinkle little star ~\nP1 | . _ how I wonder what you are\nP2 | -\nP3 | Up above");
    expect(() => buildMelody(phrases, sheet, { timing: file }, count)).toThrow(`P1 (line 2): "_" must follow a sung note`);
  });

  test("an unknown option is refused, not ignored (a typo would sing at the wrong tempo)", () => {
    expect(() => checkFlags(["in.mid", "--track", "1", "--tempo-scal", "0.85", "--transpose", "-12"])).toThrow("unknown option --tempo-scal");
    expect(() => checkFlags(["in.mid", "--track", "1", "--transpose", "-12", "--tempo-scale", "0.85"])).not.toThrow();
  });
});
