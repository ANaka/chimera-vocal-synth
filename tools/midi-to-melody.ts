/**
 * One track of a standard MIDI file + a hand-written lyric sheet → the melody file that
 * `chimera render notes` sings: `{"bpm", "t0", "lyrics", "notes": [[midi, beats], ...]}`.
 *
 *   bun tools/midi-to-melody.ts <in.mid> --tracks
 *   bun tools/midi-to-melody.ts <in.mid> --track N [--channel C] --phrases [--gap 0.5]
 *   bun tools/midi-to-melody.ts <in.mid> --track N [--channel C] --sheet sheet.txt --out melody.json
 *       [--gap 0.5] [--transpose N] [--tempo-scale X]
 *
 * Phrases: the track's notes (with --channel, only channel C's, 1-based as --tracks prints it) in
 * onset order (one voice: of notes starting on the same tick the highest is kept, and an onset ends
 * any note still sounding), split wherever the gap from one note's end to the next note's start is
 * at least --gap beats. `--phrases` prints them, the skeleton for a sheet.
 *
 * The sheet: one line per phrase, every phrase once and in order, `P<i> | tokens` ("#" starts a
 * comment anywhere on a line).
 * Tokens consume the phrase's notes left to right: a word as many notes as the engine gives it
 * syllables; "~" one note holding the previous syllable's vowel (a melisma, after a word); "_" one
 * note merged into the previous note (no new syllable); "." one note left unsung (a rest); a lone
 * "-" as the whole line leaves the phrase unsung. Other punctuation is ignored; a token with a digit
 * or a non-ASCII letter is refused (spell it out).
 *
 * Inside a phrase a sung note lasts until the next note's onset (legato), the phrase's last note
 * keeps its own end; between phrases and for unsung notes, rests. Note times come from the tempo
 * map; the melody's bpm is the first tempo times --tempo-scale, so --tempo-scale 0.9 sings the
 * same beats 10% slower. The lyrics carry no phrase punctuation: the rests split the phrases.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Melody } from "../src/show/words.ts";

// ------------------------------------------------------------------ MIDI

export interface MidiNote {
  /** onset and end (ticks) */
  tick: number;
  end: number;
  midi: number;
  channel: number;
}

export interface MidiTrack {
  /** the track name (FF 03), or "" */
  name: string;
  /** channels its notes use (0-based) */
  channels: number[];
  /** every note, sorted by onset (then pitch, highest first) */
  notes: MidiNote[];
}

export interface Tempo {
  tick: number;
  /** microseconds per quarter note */
  usPerBeat: number;
}

export interface TimeSignature {
  tick: number;
  numerator: number;
  denominator: number;
}

/** What timing needs from a MIDI file. */
export interface Timing {
  /** ticks per quarter note */
  division: number;
  /** tempo changes from every track, by tick (120 bpm before the first) */
  tempos: Tempo[];
  /** time signatures from every track, by tick (4/4 when there are none) */
  timeSignatures: TimeSignature[];
}

export interface MidiFile extends Timing {
  format: number;
  tracks: MidiTrack[];
}

const DEFAULT_US_PER_BEAT = 500000; // 120 bpm

/** Parse a standard MIDI file (format 0 or 1, ticks per quarter note). */
export function parseMidi(bytes: Uint8Array): MidiFile {
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const u32 = (at: number) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
  const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1];
  if (bytes.length < 14 || tag(0) !== "MThd") throw new Error("not a standard MIDI file (no MThd)");
  const headerLength = u32(4);
  const format = u16(8);
  const division = u16(12);
  if (division & 0x8000) throw new Error("SMPTE time division is not supported (only ticks per quarter note)");
  if (division === 0) throw new Error("MIDI division is 0");
  const tempos: Tempo[] = [];
  const timeSignatures: TimeSignature[] = [];
  const tracks: MidiTrack[] = [];
  let pos = 8 + headerLength;
  while (pos + 8 <= bytes.length) {
    const type = tag(pos);
    const length = u32(pos + 4);
    const start = pos + 8;
    const stop = Math.min(start + length, bytes.length);
    pos = start + length;
    if (type !== "MTrk") continue; // unknown chunks are skipped
    tracks.push(parseTrack(bytes, start, stop, tracks.length, tempos, timeSignatures));
  }
  // stable sorts: events on one tick keep file order (the last one wins)
  tempos.sort((a, b) => a.tick - b.tick);
  timeSignatures.sort((a, b) => a.tick - b.tick);
  return { format, division, tempos, timeSignatures, tracks };
}

function parseTrack(bytes: Uint8Array, start: number, stop: number, index: number, tempos: Tempo[], sigs: TimeSignature[]): MidiTrack {
  let i = start;
  const byte = () => {
    if (i >= stop) throw new Error(`MIDI track ${index}: truncated event`);
    return bytes[i++];
  };
  const vlq = () => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = byte();
      v = v * 128 + (c & 0x7f);
      if (c < 0x80) return v;
    }
    throw new Error(`MIDI track ${index}: variable-length quantity longer than 4 bytes`);
  };
  let tick = 0;
  let status = 0;
  let name = "";
  const notes: MidiNote[] = [];
  // channel * 128 + pitch → its held notes, oldest first: a note-off ends the oldest
  const held = new Map<number, MidiNote[]>();
  while (i < stop) {
    tick += vlq();
    if (i >= stop) throw new Error(`MIDI track ${index}: truncated event`);
    const c = bytes[i];
    if (c === 0xff) {
      i++;
      const type = byte();
      const len = vlq();
      if (i + len > stop) throw new Error(`MIDI track ${index}: truncated meta event`);
      const data = bytes.subarray(i, i + len);
      i += len;
      if (type === 0x2f) break; // end of track
      if (type === 0x03 && !name) name = String.fromCharCode(...data);
      else if (type === 0x51 && len >= 3) tempos.push({ tick, usPerBeat: (data[0] << 16) | (data[1] << 8) | data[2] });
      else if (type === 0x58 && len >= 2) sigs.push({ tick, numerator: data[0], denominator: 2 ** data[1] });
      continue;
    }
    if (c === 0xf0 || c === 0xf7) {
      i++;
      const len = vlq(); // (read first: `i += vlq()` would add to the old i)
      i += len; // sysex: skipped
      continue;
    }
    if (c >= 0xf0) throw new Error(`MIDI track ${index}: unexpected status byte ${c.toString(16)} at tick ${tick}`);
    if (c & 0x80) {
      status = c;
      i++;
    } else if (!status) throw new Error(`MIDI track ${index}: data byte ${c} with no running status`);
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const a = byte();
    const b = kind === 0xc0 || kind === 0xd0 ? 0 : byte();
    const key = channel * 128 + a;
    if (kind === 0x90 && b > 0) {
      const n: MidiNote = { tick, end: tick, midi: a, channel };
      notes.push(n);
      if (held.has(key)) held.get(key)!.push(n);
      else held.set(key, [n]);
    } else if (kind === 0x80 || kind === 0x90) {
      const n = held.get(key)?.shift();
      if (n) n.end = tick;
    }
  }
  for (const q of held.values()) for (const n of q) n.end = tick; // still held at the end of the track
  notes.sort((x, y) => x.tick - y.tick || y.midi - x.midi);
  const channels = [...new Set(notes.map((n) => n.channel))].sort((x, y) => x - y);
  return { name, channels, notes };
}

/** seconds at a tick, through the tempo map */
export function secondsAt(tick: number, timing: Timing): number {
  let sec = 0;
  let last = 0;
  let us = DEFAULT_US_PER_BEAT;
  for (const t of timing.tempos) {
    if (t.tick >= tick) break;
    sec += ((t.tick - last) * us) / (timing.division * 1e6);
    last = t.tick;
    us = t.usPerBeat;
  }
  return sec + ((tick - last) * us) / (timing.division * 1e6);
}

/** the first tempo (bpm): the last FF 51 event on the lowest tick (the one secondsAt plays), else 120 */
export function firstTempo(timing: Timing): number {
  const t = timing.tempos;
  const first = t.filter((x) => x.tick === t[0]?.tick).pop();
  return 60e6 / (first?.usPerBeat ?? DEFAULT_US_PER_BEAT);
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** "C4" for 60 */
export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** 6 significant digits, no trailing zeros */
export const fmtG = (x: number) => String(Number(x.toPrecision(6)));

/** One line per track: index, name, channels, note count, range, chords (ticks with several onsets). */
export function formatTracks(midi: MidiFile): string {
  const lines = [`format ${midi.format}, ${midi.division} ticks per beat, ${midi.tracks.length} tracks`];
  midi.tracks.forEach((t, i) => {
    const onsets = new Map<number, number>();
    for (const n of t.notes) onsets.set(n.tick, (onsets.get(n.tick) ?? 0) + 1);
    const chords = [...onsets.values()].filter((v) => v > 1).length;
    const pitches = t.notes.map((n) => n.midi);
    const range = pitches.length ? `${noteName(Math.min(...pitches))}-${noteName(Math.max(...pitches))}` : "-";
    const ch = t.channels.length ? t.channels.map((c) => c + 1).join(",") : "-";
    lines.push(`[${i}] ${JSON.stringify(t.name)}  ch ${ch}  ${t.notes.length} notes  range ${range}  chords ${chords}`);
  });
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ phrases

export const SIGNATURES_WARNING = "the time signature changes: bar numbers use the first one only, so check show.json's downbeat by hand";

export interface PhraseNote {
  /** onset and end (ticks); the end is cut at the next onset */
  tick: number;
  end: number;
  midi: number;
}

export interface Phrase {
  index: number;
  notes: PhraseNote[];
}

/**
 * A track's notes (only `channel`'s, 0-based, when given) as one voice, split into phrases
 * wherever the gap from a note's end to the next onset is at least `gap` beats.
 */
export function trackPhrases(track: MidiTrack, division: number, gap = 0.5, channel?: number): Phrase[] {
  if (!(gap > 0)) throw new Error(`the gap must be > 0 beats, got ${gap}`);
  const voice: PhraseNote[] = [];
  for (const n of track.notes) {
    if (n.end <= n.tick || (channel !== undefined && n.channel !== channel)) continue; // no length, or another channel
    const prev = voice[voice.length - 1];
    if (prev && prev.tick === n.tick) continue; // a chord: notes are sorted highest first
    if (prev && prev.end > n.tick) prev.end = n.tick; // an onset ends the note before
    voice.push({ tick: n.tick, end: n.end, midi: n.midi });
  }
  const phrases: Phrase[] = [];
  let prev: PhraseNote | null = null;
  for (const n of voice) {
    if (!prev || (n.tick - prev.end) / division >= gap) phrases.push({ index: phrases.length, notes: [] });
    phrases[phrases.length - 1].notes.push(n);
    prev = n;
  }
  return phrases;
}

/** The phrase dump a sheet is written against. */
export function formatPhrases(trackIndex: number, phrases: Phrase[], timing: Timing, gap = 0.5): string {
  const div = timing.division;
  const sig = timing.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  const bar = (sig.numerator * 4) / sig.denominator;
  const count = phrases.reduce((s, p) => s + p.notes.length, 0);
  let out =
    `# track ${trackIndex}: ${count} notes, ${phrases.length} phrases (a gap of ${fmtG(gap)} beat or more starts a phrase). ` +
    `${sig.numerator}/${sig.denominator}, bar = ${fmtG(bar)} beats, beat 0 = bar 1.\n` +
    (timing.timeSignatures.length > 1 ? `# ${SIGNATURES_WARNING}\n` : "") +
    "# each note: start beat (bar.beat) pitch duration-in-beats\n";
  const barBeat = (t: number) => `${Math.floor(t / bar) + 1}.${fmtG((t % bar) + 1)}`;
  phrases.forEach((p, i) => {
    const first = p.notes[0].tick / div;
    const last = p.notes[p.notes.length - 1].end / div;
    const prevEnd = i ? phrases[i - 1].notes[phrases[i - 1].notes.length - 1].end / div : 0;
    out += `\nP${p.index} start ${fmtG(first)} (bar ${barBeat(first)}) end ${fmtG(last)}, ${p.notes.length} notes, gap before ${fmtG(first - prevEnd)}\n`;
    out += "  " + p.notes.map((n) => `${fmtG(n.tick / div)}:${noteName(n.midi)}:${fmtG(n.end / div - n.tick / div)}`).join("  ") + "\n";
  });
  return out;
}

// ------------------------------------------------------------------ the lyric sheet

export type SheetToken = { kind: "word"; text: string } | { kind: "melisma" } | { kind: "merge" } | { kind: "unsung" };

export interface SheetLine {
  /** 1-based line number in the sheet */
  line: number;
  phrase: number;
  /** a lone "-": the phrase is not sung */
  unsung: boolean;
  tokens: SheetToken[];
}

/** a written word as the lyrics carry it: letters, apostrophes and in-word hyphens */
export function cleanWord(w: string): string {
  return w
    .replace(/’/g, "'")
    .replace(/[^A-Za-z'-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse a lyric sheet. Phrases must come once each, in order, from P0. */
export function parseSheet(text: string): SheetLine[] {
  const out: SheetLine[] = [];
  text.split(/\r?\n/).forEach((raw, k) => {
    const line = k + 1;
    const s = raw.replace(/#.*/, "").trim();
    if (!s) return;
    const m = /^P(\d+)\s*\|(.*)$/.exec(s);
    if (!m) throw new Error(`sheet line ${line}: expected "P<i> | words", got ${JSON.stringify(s.slice(0, 40))}`);
    const phrase = Number(m[1]);
    const expected = out.length ? out[out.length - 1].phrase + 1 : 0;
    if (phrase !== expected) throw new Error(`sheet line ${line}: P${phrase} where P${expected} should be (every phrase once, in order)`);
    const parts = m[2].trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1 && parts[0] === "-") {
      out.push({ line, phrase, unsung: true, tokens: [] });
      return;
    }
    const tokens: SheetToken[] = [];
    for (const p of parts) {
      if (p === "~") tokens.push({ kind: "melisma" });
      else if (p === "_") tokens.push({ kind: "merge" });
      else if (p === ".") tokens.push({ kind: "unsung" });
      else if (p === "-") throw new Error(`sheet line ${line}: a lone "-" must be the whole line (the phrase unsung); use "~" for a melisma`);
      else if (/\p{N}|\p{M}|(?![A-Za-z])\p{L}/u.test(p)) throw new Error(`sheet line ${line}: ${JSON.stringify(p)} has a digit or a non-ASCII letter: spell it out`);
      else {
        const w = cleanWord(p);
        if (/[A-Za-z]/.test(w)) tokens.push({ kind: "word", text: w }); // else punctuation: ignored
      }
    }
    out.push({ line, phrase, unsung: false, tokens });
  });
  return out;
}

// ------------------------------------------------------------------ the melody

export interface BuildOptions {
  timing: Timing;
  /** semitones added to every note (default 0) */
  transpose?: number;
  /** the melody's tempo over the MIDI's (default 1; 0.5 sings at half speed) */
  tempoScale?: number;
  /** whether a word is in the pronouncing dictionary (else its syllables are a letter-to-sound guess) */
  inDictionary?: (word: string) => boolean;
}

export interface MelodyFile extends Melody {
  t0: number;
}

export interface MelodyReport {
  sounding: number;
  rests: number;
  /** end of the last note on the render clock (s) */
  duration: number;
  /** lowest and highest sung note (after --transpose) */
  range: [string, string];
  /** sung notes shorter than 0.12 s (consonants get squeezed) */
  short: { phrase: number; word: string; seconds: number }[];
  /** words the dictionary doesn't have (needs `inDictionary`) */
  unknownWords: string[];
  /** render-clock time (s) of the MIDI's beat 0 (0 when it falls before the render starts), for show.json */
  downbeat: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * The melody for a track's phrases and a sheet. `syllableCount(word)` is the engine's count
 * (lyricsToSyllables(word).length). Throws listing every phrase the sheet doesn't fit.
 */
export function buildMelody(
  phrases: Phrase[],
  sheet: SheetLine[],
  options: BuildOptions,
  syllableCount: (word: string) => number,
): { melody: MelodyFile; report: MelodyReport } {
  const { timing, transpose = 0, tempoScale = 1, inDictionary } = options;
  if (!(tempoScale > 0)) throw new Error(`tempo scale must be > 0, got ${tempoScale}`);
  if (sheet.length !== phrases.length) {
    const last = sheet[sheet.length - 1];
    throw new Error(
      sheet.length < phrases.length
        ? `the sheet ends at ${last ? `P${last.phrase} (line ${last.line})` : "its start"}, but the track has ${phrases.length} phrases (P0-P${phrases.length - 1})`
        : `sheet line ${sheet[phrases.length].line}: P${sheet[phrases.length].phrase}, but the track has only ${phrases.length} phrases (P0-P${phrases.length - 1})`,
    );
  }
  // each note's part: a new syllable (word or "~"), merged into the note before, or unsung
  type Part = { kind: "sing"; word: string; melisma: boolean } | { kind: "merge" } | { kind: "rest" };
  const errors: string[] = [];
  const parts: Part[][] = [];
  const lyricTokens: string[] = [];
  phrases.forEach((p, i) => {
    const s = sheet[i];
    const id = `P${p.index} (line ${s.line})`;
    if (s.unsung) {
      parts.push(p.notes.map((): Part => ({ kind: "rest" })));
      return;
    }
    const out: Part[] = [];
    const words: string[] = [];
    let prevSung = false;
    let bad = "";
    for (const t of s.tokens) {
      if (t.kind === "word") {
        const n = syllableCount(t.text);
        words.push(`${t.text} ${n}${inDictionary && !inDictionary(t.text) ? "?" : ""}`); // "?": a guess
        for (let k = 0; k < n; k++) out.push({ kind: "sing", word: t.text, melisma: false });
        if (n > 0) prevSung = true;
      } else if (t.kind === "melisma") {
        words.push("~ 1");
        if (!prevSung && !bad) bad = `"~" must follow a sung word in its phrase`;
        out.push({ kind: "sing", word: "~", melisma: true });
      } else if (t.kind === "merge") {
        words.push("_ 1");
        if (!prevSung && !bad) bad = `"_" must follow a sung note in its phrase`;
        out.push({ kind: "merge" });
      } else {
        words.push(". 1");
        out.push({ kind: "rest" });
        prevSung = false;
      }
    }
    if (out.length !== p.notes.length) errors.push(`${id}: ${p.notes.length} notes, the sheet consumes ${out.length}: ${words.join(", ")}`);
    else if (bad) errors.push(`${id}: ${bad}`);
    else {
      for (const t of s.tokens) if (t.kind === "word" || t.kind === "melisma") lyricTokens.push(t.kind === "word" ? t.text : "~");
    }
    parts.push(out);
  });
  if (errors.length) {
    const n = errors.length;
    throw new Error(`the sheet doesn't fit the notes in ${n} phrase${n === 1 ? "" : "s"}:\n  ${errors.join("\n  ")}`);
  }

  // sung notes on the MIDI clock (s); "_" lengthens the note before
  type Sung = { phrase: number; word: string; midi: number; start: number; end: number };
  const sung: Sung[] = [];
  phrases.forEach((p, i) => {
    p.notes.forEach((n, k) => {
      const part = parts[i][k];
      if (part.kind === "rest") return;
      // legato: up to the next note's onset; the phrase's last note keeps its own end
      const next = p.notes[k + 1];
      const end = secondsAt(next ? next.tick : n.end, timing);
      if (part.kind === "merge") sung[sung.length - 1].end = end;
      else sung.push({ phrase: p.index, word: part.word, midi: n.midi + transpose, start: secondsAt(n.tick, timing), end });
    });
  });
  if (!sung.length) throw new Error("the sheet sings no notes");

  const bpm0 = firstTempo(timing);
  const bpm = bpm0 * tempoScale;
  const toBeats = (sec: number) => (sec * bpm0) / 60; // the same at any tempo scale
  const first = sung[0].start;
  const t0 = round6(Math.max(0.3, first / tempoScale));
  // positions are rounded, not lengths, so rounding doesn't drift
  const pos = (sec: number) => round6(toBeats(sec - first));
  const notes: [number, number][] = [];
  let cursor = 0; // beats from the first sung note
  let rests = 0;
  const short: MelodyReport["short"] = [];
  for (const s of sung) {
    const a = pos(s.start);
    const b = pos(s.end);
    if (a > cursor) {
      notes.push([0, round6(a - cursor)]);
      rests++;
    }
    const start = Math.max(a, cursor);
    const beats = round6(b - start);
    notes.push([s.midi, beats]);
    const seconds = (beats * 60) / bpm;
    if (seconds < 0.12) short.push({ phrase: s.phrase, word: s.word, seconds: round6(seconds) });
    cursor = Math.max(cursor, b);
  }
  const lyrics = lyricTokens.join(" ");
  // the MIDI's beat 0 on the render clock (rounding t0 can put it a hair below 0)
  const downbeat = round6(Math.max(0, t0 - first / tempoScale));
  const pitches = sung.map((s) => s.midi);
  const unknownWords = inDictionary ? [...new Set(lyricTokens.filter((t) => t !== "~" && !inDictionary(t)).map((t) => t.toLowerCase()))] : [];
  const melody: MelodyFile = { bpm, t0, lyrics, notes };
  const report: MelodyReport = {
    sounding: sung.length,
    rests,
    duration: round6(t0 + (cursor * 60) / bpm),
    range: [noteName(Math.min(...pitches)), noteName(Math.max(...pitches))],
    short,
    unknownWords,
    downbeat,
  };
  return { melody, report };
}

// ------------------------------------------------------------------ the dictionary

/** The words a CMUdict text has ("word\tPHONES" lines; "word(2)" variants folded). */
export function dictionaryWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) words.add(line.slice(0, tab).toLowerCase().replace(/\(\d+\)$/, ""));
  }
  return words;
}

/** Whether the engine finds a lyric word in the dictionary: each hyphenated part, apostrophes at its ends trimmed. */
export function inDictionaryOf(words: Set<string>): (word: string) => boolean {
  return (word) =>
    word
      .toLowerCase()
      .split("-")
      .filter(Boolean)
      .every((p) => words.has(p.replace(/^'+|'+$/g, "")));
}

// ------------------------------------------------------------------ the command line

const USAGE = `usage:
  bun tools/midi-to-melody.ts <in.mid> --tracks
  bun tools/midi-to-melody.ts <in.mid> --track N [--channel C] --phrases [--gap 0.5]
  bun tools/midi-to-melody.ts <in.mid> --track N [--channel C] --sheet sheet.txt --out melody.json [--gap 0.5] [--transpose N] [--tempo-scale X]`;

const FLAGS = ["--tracks", "--track", "--channel", "--phrases", "--gap", "--sheet", "--out", "--transpose", "--tempo-scale"];

/** Refuses a flag the tool doesn't know (a typo would otherwise be ignored silently). */
export function checkFlags(args: string[]): void {
  const unknown = args.filter((a) => a.startsWith("--") && !FLAGS.includes(a));
  if (unknown.length) throw new Error(`unknown option ${unknown.join(", ")}\n${USAGE}`);
}

function numberFlag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  if (args[i + 1] === undefined || !Number.isFinite(v)) throw new Error(`${name} needs a number`);
  return v;
}

function stringFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

async function main(args: string[]): Promise<void> {
  const input = args[0];
  if (!input || input.startsWith("--")) throw new Error(USAGE);
  checkFlags(args);
  const midi = parseMidi(new Uint8Array(readFileSync(input)));
  if (args.includes("--tracks")) {
    process.stdout.write(formatTracks(midi));
    return;
  }
  const trackIndex = numberFlag(args, "--track", NaN);
  if (!Number.isInteger(trackIndex)) throw new Error(`--track N is needed (see --tracks)\n${USAGE}`);
  const track = midi.tracks[trackIndex];
  if (!track) throw new Error(`no track ${trackIndex}: the file has ${midi.tracks.length} (0-${midi.tracks.length - 1})`);
  const channel = args.includes("--channel") ? numberFlag(args, "--channel", 0) : undefined; // 1-based
  if (channel !== undefined && !(Number.isInteger(channel) && channel >= 1 && channel <= 16)) throw new Error(`--channel takes 1-16, got ${channel}`);
  const gap = numberFlag(args, "--gap", 0.5);
  const phrases = trackPhrases(track, midi.division, gap, channel === undefined ? undefined : channel - 1);
  if (!phrases.length) throw new Error(`track ${trackIndex} has no notes${channel === undefined ? "" : ` on channel ${channel}`}`);
  if (args.includes("--phrases")) {
    process.stdout.write(formatPhrases(trackIndex, phrases, midi, gap));
    return;
  }
  const sheetPath = stringFlag(args, "--sheet");
  const outPath = stringFlag(args, "--out");
  if (!sheetPath || !outPath) throw new Error(USAGE);

  const root = new URL("..", import.meta.url).pathname;
  const wasm = `${root}src/wasm/chimera.wasm`;
  if (!existsSync(wasm)) throw new Error(`${wasm} is missing: build the engine with "bun run wasm"`);
  const { initChimera } = await import("../src/wasm/chimera.ts");
  await initChimera(readFileSync(wasm));
  const { EnglishG2P, lyricsToSyllables } = await import("../src/wasm/engine.ts");
  const { sungWords } = await import("../src/show/words.ts");
  const dictText = gunzipSync(readFileSync(`${root}public/data/cmudict.txt.gz`)).toString();
  new EnglishG2P().setDictionaryText(dictText);
  const known = inDictionaryOf(dictionaryWords(dictText));

  const sheet = parseSheet(readFileSync(sheetPath, "utf8"));
  const { melody, report } = buildMelody(
    phrases,
    sheet,
    {
      timing: midi,
      transpose: numberFlag(args, "--transpose", 0),
      tempoScale: numberFlag(args, "--tempo-scale", 1),
      inDictionary: known,
    },
    (w) => lyricsToSyllables(w).length,
  );
  sungWords(melody, lyricsToSyllables(melody.lyrics)); // the check the show page makes: throws on a mismatch
  writeFileSync(outPath, JSON.stringify(melody) + "\n");

  const sec = (x: number) => x.toFixed(2);
  console.log(`${outPath}: ${report.sounding} sung notes, ${report.rests} rests, ${sec(report.duration)} s, bpm ${fmtG(melody.bpm)}, t0 ${sec(melody.t0)} s`);
  console.log(`range ${report.range[0]}-${report.range[1]}`);
  if (report.short.length)
    console.log(`${report.short.length} notes shorter than 0.12 s: ${report.short.map((s) => `P${s.phrase} ${s.word} ${s.seconds.toFixed(3)}`).join(", ")}`);
  if (report.unknownWords.length) console.log(`not in the dictionary (letter-to-sound): ${report.unknownWords.join(", ")}`);
  console.log(`downbeat ${report.downbeat} s (show.json)`);
  if (midi.timeSignatures.length > 1) console.log(SIGNATURES_WARNING);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
