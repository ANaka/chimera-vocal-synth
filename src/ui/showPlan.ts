/**
 * The Good Evening demo's score (see show.ts): the melody, the beat and the punchline on the
 * song's clock, and the words to show. Pure planning (no audio), so it can be checked in bun.
 */
import { call } from "../wasm/chimera.ts";
import { BEAT_SOUNDS, lyricsToSyllables, parseBeat, planPhrases, planSong } from "../wasm/engine.ts";
import type { BodyMix, Gesture, Phrase, SungNote } from "../wasm/types.ts";

export interface ShowData {
  title: string;
  bpm: number;
  body: string;
  melody: { bpm: number; t0: number; vibrato: number; lyrics: string; notes: [number, number][] };
  beatbox: { pattern: string; bpm: number; at: number };
  speech: { text: string; f0: number; t0: number; shift: number };
  gains: { sing: number; beatbox: number; speech: number };
  reverb: { send: number; irScale: number };
  master: { clip: number; knee: number };
  /** the band's rimshot after the punchline (s) */
  sting: number;
  /** length of the backing (s) */
  end: number;
}

export type CueKind = "sing" | "beat" | "speech";

/** One word, syllable or beat sound, on the song's clock (s). */
export interface Cue {
  t: number;
  end: number;
  text: string;
  kind: CueKind;
  /** the beat sound's name */
  sub?: string;
  /** the lyric line it belongs to */
  line: number;
}

/** What the beat sounds look like written down. */
const BEAT_TEXT: Record<string, string> = { B: "boom", t: "ts", tss: "tsss", Pf: "pff", K: "k!", "^K": "khh", "!": "tok", "P!": "pop", kch: "kshh", m: "mmm" };

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export interface ShowPlan {
  gestures: Gesture[];
  cues: Cue[];
  /** sung notes for the piano roll, on the song's clock */
  notes: { midi: number; t0: number; t1: number; text: string }[];
  /** when each part starts and the voice is free again (song clock, s) */
  beatAt: number;
  speechAt: number;
  speechEnd: number;
  firstHz: number;
}

/** The whole score on the song's clock (time 0 = the backing's first sample). Needs the dictionary for the CLI's syllables. */
export function planShow(d: ShowData, body: BodyMix, toPhrases: (text: string) => Phrase[]): ShowPlan {
  const gestures: Gesture[] = [];
  const cues: Cue[] = [];
  const notes: ShowPlan["notes"] = [];
  // ---- the song: phrases split at rests, as `chimera render notes` plans them
  const m = d.melody;
  const beat = 60 / m.bpm;
  const syl = lyricsToSyllables(m.lyrics);
  let t = m.t0, beats = 0, k = 0;
  let phrase: SungNote[] = [];
  let start = t;
  const flush = () => {
    if (!phrase.length) return;
    gestures.push(...planSong(phrase, { body, bpm: m.bpm, t0: start, vibrato: m.vibrato }).gestures);
    phrase = [];
  };
  for (const [midi, b] of m.notes) {
    if (midi > 0) {
      if (!phrase.length) start = t;
      const s = syl[k++];
      phrase.push({ midi, beats: b, syl: s });
      notes.push({ midi, t0: t, t1: t + b * beat - 0.02, text: s.melisma ? "~" : s.text });
      const last = cues[cues.length - 1];
      if (s.melisma && last) last.end = t + b * beat;
      else cues.push({ t, end: t + b * beat, text: s.text + (s.wordEnd ? "" : "-"), kind: "sing", line: Math.floor(beats / 4 + 1e-9) });
    } else flush();
    t += b * beat;
    beats += b;
  }
  flush();
  // ---- one pass of the beat, its first step on the downbeat
  const bb = d.beatbox;
  const steps = parseBeat(bb.pattern);
  const step = 60 / bb.bpm / 4;
  gestures.push(...call<Gesture[]>("planBeat", { text: bb.pattern, bpm: bb.bpm, t0: bb.at, body }));
  const songBeat = (s: number) => s / beat;
  steps.forEach((s, n) => {
    if (!s) return;
    let next = n + 1;
    while (next < steps.length && !steps[next]) next++;
    const at = bb.at + n * step;
    cues.push({ t: at, end: bb.at + next * step, text: BEAT_TEXT[s.id] ?? s.id, sub: BEAT_SOUNDS.find((x) => x.id === s.id)?.name, kind: "beat", line: Math.floor(songBeat(at) / 4 + 1e-9) });
  });
  // ---- the punchline, as `chimera render text` plans it, moved onto the song's clock
  const sp = d.speech;
  const phrases = toPhrases(sp.text);
  const plan = planPhrases(
    phrases.map((p) => ({ segments: p.segments, intonation: p.intonation, pause: p.pause })),
    { body, t0: sp.t0, f0: sp.f0 },
  );
  for (const g of plan.gestures) gestures.push({ ...g, t0: g.t0 + sp.shift, t1: g.t1 + sp.shift });
  // words: the planned segments follow the phrase's, a word ending at each wordEnd
  const shown = sp.text.split(/\s+/).filter(Boolean);
  const speechLine = 1000; // its own line, whatever bar it falls in
  const segs = phrases.flatMap((p) => p.segments);
  const planned = plan.segments.filter((s) => s.kind !== "pause" && s.kind !== "silence");
  let w = 0, first: number | null = null;
  for (let i = 0; i < segs.length && i < planned.length; i++) {
    if (first === null) first = planned[i].t0;
    if (segs[i].wordEnd || i === segs.length - 1) {
      cues.push({ t: first + sp.shift, end: planned[i].t1 + sp.shift, text: shown[w] ?? "", kind: "speech", line: speechLine });
      w++;
      first = null;
    }
  }
  cues.sort((a, b) => a.t - b.t);
  return { gestures, cues, notes, beatAt: bb.at, speechAt: sp.shift + sp.t0, speechEnd: plan.end + sp.shift, firstHz: midiHz(m.notes.find((n) => n[0] > 0)![0]) };
}

