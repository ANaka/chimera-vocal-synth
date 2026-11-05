/**
 * Planning fixtures: the gestural planner, Klatt durations, phrases, singing, the beatbox sounds
 * and the beat sequencer, plus one beatbox bar rendered through the human voice. Input segments
 * and syllables are produced here (tokenizeIpa, G2P, lyricsToSyllables) so the Rust side tests
 * the planners alone.
 *   bun tools/golden/planning.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { planUtterance, planPhrases, isVowel, type Segment, type PlanOptions } from "../../src/engine/phonetics/planner.ts";
import { klattDurations, type SegInfo } from "../../src/engine/phonetics/durations.ts";
import { tokenizeIpa } from "../../src/engine/phonetics/ipa.ts";
import { EnglishG2P } from "../../src/engine/phonetics/english.ts";
import { lyricsToSyllables } from "../../src/engine/phonetics/syllables.ts";
import { planSong, planNoteOn, planNoteOff, planMelisma, midiToHz, type SungNote } from "../../src/engine/phonetics/sing.ts";
import { DEMO_SONGS } from "../../src/engine/phonetics/songs.ts";
import { CONSONANT_SYMBOLS, phoneme } from "../../src/engine/phonetics/inventory.ts";
import { BEAT_SOUNDS, BEAT_PRESETS, parseBeat, formatBeat, beatReady, type BeatStep } from "../../src/engine/phonetics/beatbox.ts";
import { BeatPlayer } from "../../src/engine/control/beatPlayer.ts";
import { HumanVoice } from "../../src/engine/voice/humanVoice.ts";
import type { Gesture } from "../../src/engine/control/score.ts";
import { BODIES, write, writeF32 } from "./lib.ts";

const BODY_NAMES = ["male", "female", "child"] as const;
const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync(new URL("../../public/data/cmudict.txt.gz", import.meta.url).pathname)).toString("utf8"));

// ---------------------------------------------------------------- planUtterance
type Opts = PlanOptions;
const utterances: { name: string; segments: Segment[]; opts: Opts; plan: unknown }[] = [];
const OPTION_SETS: Partial<Opts>[] = [
  {},
  { rate: 1.3, f0: 120 },
  { intonation: "question" },
  { intonation: "flat", f0: 205, accent: 0.3 },
  { rate: 0.8, openEnd: true },
  { t0: 0.5, intonation: "statement", openEnd: false },
  { f0: 260, rate: 1.1, intonation: "question", accent: 0 },
];
let oi = 0;
function addUtterance(name: string, segments: Segment[], extra: Partial<Opts> = {}, body?: string): void {
  const k = oi++;
  const opts: Opts = { body: body ?? BODY_NAMES[k % 3], t0: 0, ...OPTION_SETS[k % OPTION_SETS.length], ...extra };
  // clone: the planner must not see (or keep) the fixture's objects
  const plan = planUtterance(segments.map((s) => ({ ...s })), opts);
  utterances.push({ name, segments, opts, plan });
}
// every consonant in the inventory, between vowels, word-initially and word-finally
CONSONANT_SYMBOLS.forEach((c, i) => {
  const pos = i % 3;
  const ipa = pos === 0 ? `ˈa${c}ə` : pos === 1 ? `${c}ˈi` : `ˈu${c}`;
  addUtterance(`cons ${c}`, tokenizeIpa(ipa));
});
const PHRASES = [
  "ˈaɪ ˈaʊ ˈɔɪ",
  "ˈeɪ ˈoʊ ˈbeɪbi",
  "ˈbɝd ˈfɑɹɚ",
  "ɚ ˈwɝkɚ",
  "ˈstɹɛŋkθs",
  "ˈspɪt ˈskaɪ ˈstɑp",
  "ˌɪntɚˈnæʃənəl",
  "ˈhɛloʊ ˈwɝld",
  "ʃi ˈsɛlz ˈsiʃɛlz",
  "ˈpero ˈpeɾo",
  "ʔaʔ ʔoʊ",
  "ha ˈɦa",
  "ˈmʌni ˈtʃɪp ˈʒu ˈvæn",
  "ˈθɪŋk ə ˈbæd ˈkæt",
  "ˈjɛs, ˈnoʊ",
  "ˌkæləˈfɔɹnjə",
  "y ø ˈɨ",
  "ˈɑː ˈsiː",
  "ˈŋaŋ ˈmama ˈnana",
  "ˈwɪndoʊ ˈjɛloʊ",
  "ˈtsa ˈdza ˈpfa",
  "ˈɫul ˈlʊk",
  "ˈæ",
  "ˈstɹ",
  "",
];
PHRASES.forEach((p, i) => addUtterance(`phrase ${i}: ${p}`, tokenizeIpa(p)));
// G2P phrases (allophones: flaps, glottal stops, dark l)
for (const text of ["Little bottles of water.", "Button it up, Peter!", "Is it going to rain tomorrow?"]) {
  for (const ph of g2p.toPhrases(text)) addUtterance(`g2p ${text}`, ph.segments, { intonation: ph.intonation });
}
// per-segment overrides: explicit pitch (0 is "none" in TS), explicit durations
{
  const base = tokenizeIpa("ˈlɑlə ˈmiˌnoʊ ˈsaɪ");
  const f0s = base.map((s, i) => (isVowel(s.ipa) ? { ...s, f0: [196, 0, 220, 247, 262][i % 5] } : s));
  addUtterance("override f0", f0s);
  addUtterance("override f0 male", f0s, { intonation: "statement" }, "male");
  const durs = base.map((s, i) => (i % 2 ? { ...s, dur: 0.05 + 0.03 * i } : s));
  addUtterance("override dur", durs, {}, "female");
  addUtterance("override both", base.map((s, i) => ({ ...s, dur: 0.11, ...(isVowel(s.ipa) ? { f0: 150 + i } : {}) })), { openEnd: true }, "child");
  addUtterance("override diphthong", [{ ipa: "aɪ", dur: 0.4, f0: 180, stress: 1 }, { ipa: "s" }, { ipa: "oʊ", stress: 2, wordEnd: true }], {}, "male");
}

// ---------------------------------------------------------------- klattDurations
const MANNERS = [undefined, "stop", "nasal", "fricative", "affricate", "approximant", "lateral", "tap", "trill", "glottal"];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const klatt: { segments: Segment[]; infos: SegInfo[]; durs: number[] }[] = [];
for (let c = 0; c < 24; c++) {
  const n = 1 + Math.floor(rnd() * 12);
  const syms = ["a", "i", "ə", "aɪ", "p", "t", "s", "z", "m", "l", "ɹ", "x", "ʔ", "q", "ŋ", "ɾ", "oʊ", "ɨ"];
  const segments: Segment[] = [];
  const infos: SegInfo[] = [];
  for (let i = 0; i < n; i++) {
    const ipa = syms[Math.floor(rnd() * syms.length)];
    const s: Segment = { ipa };
    if (rnd() < 0.5) s.stress = Math.floor(rnd() * 3);
    if (rnd() < 0.25) s.wordEnd = true;
    if (rnd() < 0.1) s.dur = 0.05 + rnd() * 0.1;
    segments.push(s);
    const vowel = rnd() < 0.4;
    const info: SegInfo = { vowel };
    if (!vowel) {
      const m = MANNERS[Math.floor(rnd() * MANNERS.length)];
      if (m) info.manner = m;
      if (rnd() < 0.7) info.voiced = rnd() < 0.5;
      if (rnd() < 0.3) info.dur = 0.04 + rnd() * 0.1;
    }
    infos.push(info);
  }
  const byObj = new Map(segments.map((s, i) => [s, infos[i]]));
  klatt.push({ segments, infos, durs: klattDurations(segments, (s) => byObj.get(s)!) });
}

// ---------------------------------------------------------------- planPhrases
const phrases: { phrases: unknown[]; opts: unknown; plan: unknown }[] = [];
for (const [text, opts] of [
  ["Hello there, how are you? I am fine; thanks.", { body: "male", t0: 0 }],
  ["One, two, three!", { body: "female", t0: 0.2, f0: 205, rate: 1.2 }],
  ["The quick brown fox: jumps over the lazy dog?", { body: "child", t0: 0, f0: 260, accent: 0.2, openEnd: true }],
] as const) {
  const ps = g2p.toPhrases(text).map((p, i) => ({ segments: p.segments, intonation: p.intonation, ...(i === 1 ? { pause: 0 } : i === 2 ? {} : { pause: p.pause }) }));
  phrases.push({ phrases: ps, opts, plan: planPhrases(structuredClone(ps), opts) });
}
phrases.push({ phrases: [], opts: { body: "male", t0: 0.3 }, plan: planPhrases([], { body: "male", t0: 0.3 }) });

// ---------------------------------------------------------------- planSong
const songs: { name: string; notes: SungNote[]; opts: unknown; plan: unknown }[] = [];
for (const song of DEMO_SONGS) {
  const syl = lyricsToSyllables(song.lyrics, g2p);
  for (const body of BODY_NAMES) {
    const shift = song.octave[body] * 12;
    const notes = song.notes.map((n, i) => ({ midi: n[0] + shift, beats: n[1], syl: syl[i % syl.length] }));
    const opts = { body, bpm: song.bpm, t0: 0.35, vibrato: 35 };
    songs.push({ name: `${song.name} (${body})`, notes, opts, plan: planSong(structuredClone(notes), opts) });
  }
}
{
  // melismas, diphthongs and codas across phrase breaks
  const syl = lyricsToSyllables("I - love my - - time. Strengths, night ~ sky!", g2p);
  const notes = syl.map((s, i) => ({ midi: 57 + ((i * 5) % 12), beats: [1, 0.5, 2, 0.25][i % 4], syl: s }));
  const opts = { body: "female", bpm: 120, t0: 0.2, vibrato: 50 };
  songs.push({ name: "melisma", notes, opts, plan: planSong(structuredClone(notes), opts) });
}

// ---------------------------------------------------------------- live notes
const notes: unknown[] = [];
{
  const syl = lyricsToSyllables("night sky to strengths a oh", g2p);
  syl.forEach((s, i) => {
    const body = BODY_NAMES[i % 3];
    const midi = 52 + 3 * i;
    const from = i > 0 ? { syl: syl[i - 1], midi: midi - 2 } : undefined;
    const on = { body, vibrato: 30, tag: 10 * i };
    notes.push({ kind: "on", syl: s, midi, opts: on, gestures: planNoteOn(structuredClone(s), midi, on) });
    if (from) {
      const onL = { ...on, legatoFrom: from };
      notes.push({ kind: "on", syl: s, midi, opts: onL, gestures: planNoteOn(structuredClone(s), midi, structuredClone(onL)) });
    }
    notes.push({ kind: "off", syl: s, midi, body, gestures: planNoteOff(structuredClone(s), midi, body) });
    notes.push({ kind: "melisma", midi: midi + 0.5, opts: { vibrato: 20, tag: i }, gestures: planMelisma(midi + 0.5, { vibrato: 20, tag: i }) });
  });
}

// ---------------------------------------------------------------- beatbox sounds
const BUILDS = [{ f0: 82, len: 0.15, accent: 1 }, { f0: midiToHz(43), len: 0.05, accent: 1.3 }, { f0: 200, len: 0.4, accent: 0.7 }];
const sounds = BEAT_SOUNDS.map((s) => ({
  id: s.id,
  name: s.name,
  role: s.role,
  airstream: s.airstream,
  hint: s.hint,
  latency: s.latency,
  builds: BODY_NAMES.flatMap((body) => BUILDS.map((o) => ({ body, o, gestures: s.build(body, o) }))),
  leadIn: Object.fromEntries(BODY_NAMES.map((b) => [b, BeatPlayer.leadIn(s.id, b)])),
}));
const ready = Object.fromEntries(BODY_NAMES.map((b) => [b, beatReady(b)]));
const notation = {
  presets: BEAT_PRESETS,
  texts: ["B . t | Pf m:43 ^K> -", "b T pf k  | ^k> M:40>  x:3 :4 m:4:3 > . -", "B t Pf\tkch\nm:043", "", "|||", ...BEAT_PRESETS.map((p) => p.text)].map((text) => {
    const steps = parseBeat(text);
    return { text, steps, formatted: formatBeat(steps) };
  }),
  format: [
    [{ id: "m", note: 43.5, accent: 0.5 }, null, { id: "B", accent: 1.0001 }, { id: "t", note: 0 }, null],
  ].map((steps) => ({ steps, formatted: formatBeat(steps as (BeatStep | null)[]) })),
};

// ---------------------------------------------------------------- beat player
type PlayerOp =
  | { op: "steps"; text: string }
  | { op: "tempo"; bpm: number; swing: number }
  | { op: "start"; clock: number }
  | { op: "stop" }
  | { op: "body"; body: string }
  | { op: "run"; from: number; to: number; dt: number }
  | { op: "rebase"; delta: number }
  | { op: "rewind"; clock: number }
  | { op: "stepAt"; clocks: number[] }
  | { op: "gestures"; cell: BeatStep; hit: number; len?: number };
function runPlayer(ops: PlayerOp[]): unknown[] {
  const p = new BeatPlayer();
  const out: unknown[] = [];
  for (const o of ops) {
    if (o.op === "steps") p.steps = parseBeat(o.text).slice(0, 128);
    else if (o.op === "tempo") p.setTempo(o.bpm, o.swing);
    else if (o.op === "start") p.start(o.clock);
    else if (o.op === "stop") p.stop();
    else if (o.op === "body") p.body = o.body;
    else if (o.op === "rebase") p.rebase(o.delta);
    else if (o.op === "rewind") p.rewind(o.clock);
    else if (o.op === "stepAt") out.push(o.clocks.map((c) => p.stepAt(c)));
    else if (o.op === "gestures") out.push(o.len === undefined ? p.gestures(o.cell, o.hit) : p.gestures(o.cell, o.hit, o.len));
    else {
      const batches: { clock: number; gestures: Gesture[] }[] = [];
      for (let clock = o.from; clock < o.to; clock += o.dt) p.tick(clock, (gs) => batches.push({ clock, gestures: gs }));
      out.push(batches);
    }
  }
  return out;
}
const many = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const DT = 128 / 48000;
const playerScenarios: PlayerOp[][] = [
  // start, swing, playhead
  [{ op: "steps", text: "B t B t" }, { op: "tempo", bpm: 120, swing: 0.5 }, { op: "stepAt", clocks: [1] }, { op: "start", clock: 0 }, { op: "run", from: 0, to: 1.2, dt: DT }, { op: "stepAt", clocks: many(0, 1.4, 120) }, { op: "stop" }, { op: "stepAt", clocks: [0.5] }],
  // tempo change mid-pattern, then a pattern edit with rests (sustained sounds)
  [{ op: "steps", text: "t t t t" }, { op: "tempo", bpm: 100, swing: 0 }, { op: "start", clock: 0.1 }, { op: "run", from: 0.1, to: 0.6, dt: DT }, { op: "tempo", bpm: 160, swing: 0.3 }, { op: "run", from: 0.6, to: 1.1, dt: DT }, { op: "steps", text: "m:43 . . tss | . m . kch" }, { op: "tempo", bpm: 300, swing: 0.9 }, { op: "run", from: 1.1, to: 1.9, dt: DT }, { op: "stepAt", clocks: many(0.1, 2.0, 90) }],
  // body change: rebase + rewind (as the worklet does), with every sound
  [{ op: "steps", text: "B t Pf t | K ^K ! P! | kch m:40> tss ." }, { op: "tempo", bpm: 120, swing: 0.3 }, { op: "start", clock: 0 }, { op: "run", from: 0, to: 0.5, dt: DT }, { op: "body", body: "female" }, { op: "rebase", delta: -0.5 }, { op: "rewind", clock: 0 }, { op: "run", from: 0, to: 0.6, dt: DT }, { op: "stepAt", clocks: many(-0.1, 0.8, 60) }, { op: "body", body: "child" }, { op: "rebase", delta: 0.25 }, { op: "rewind", clock: 0.85 }, { op: "run", from: 0.85, to: 1.3, dt: 0.01 }],
  // coarse ticks (several steps per tick, some already past), stop/start, empty pattern
  [{ op: "steps", text: "B . t ." }, { op: "tempo", bpm: 180, swing: 0.6 }, { op: "start", clock: 0 }, { op: "run", from: 0, to: 2, dt: 0.37 }, { op: "stepAt", clocks: many(0, 2.2, 40) }, { op: "stop" }, { op: "run", from: 2, to: 2.5, dt: 0.1 }, { op: "start", clock: 2.5 }, { op: "steps", text: "" }, { op: "run", from: 2.5, to: 3, dt: 0.1 }, { op: "stepAt", clocks: [2.8] }, { op: "rewind", clock: 10 }],
  // single sounds (pad hits)
  [{ op: "body", body: "child" }, { op: "gestures", cell: { id: "m", note: 45, accent: 1.2 }, hit: 1.5, len: 0.18 }, { op: "gestures", cell: { id: "kch" }, hit: 0.3 }, { op: "gestures", cell: { id: "nope" }, hit: 0.3 }, { op: "tempo", bpm: 30, swing: -1 }, { op: "gestures", cell: { id: "tss", accent: 0 }, hit: 0 }],
];
const player = playerScenarios.map((ops) => ({ ops, out: runPlayer(ops) }));

// ---------------------------------------------------------------- audio: a beatbox bar
{
  const FS = 48000;
  const text = "B t tss Pf | K ^K ! P! | kch m:43 . m | B> t Pf> t";
  const v = new HumanVoice({ fsOut: FS, body: BODIES.male, oversample: 2 });
  v.setSource({ f0: 110 });
  v.setArticulation(beatReady("male"));
  const p = new BeatPlayer();
  p.steps = parseBeat(text);
  p.setTempo(110, 0.2);
  p.start(v.clock);
  const n = Math.round(2.0 * FS);
  const out = new Float32Array(n);
  const tempoAt = 400; // block
  for (let b = 0, i = 0; i < n; b++, i += 128) {
    if (b === tempoAt) p.setTempo(130, 0.1);
    p.tick(v.clock, (gs) => v.schedule(gs));
    v.render(out, i, Math.min(128, n - i));
  }
  writeF32("beatbox-bar", out);
  write("planning", { utterances, klatt, phrases, songs, notes, sounds, ready, notation, player, audio: { text, bpm: 110, swing: 0.2, tempoAt, tempo: [130, 0.1], f0: 110, samples: n, fs: FS } });
}
void phoneme;
