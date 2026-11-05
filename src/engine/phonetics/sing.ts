/**
 * Singing: syllables on notes, through the same gestural planner as speech.
 *  - A note's vowel lands on the beat. Its onset consonants are sung just before it (they take
 *    their time from the previous note, as singers do), its coda just before the next onset.
 *  - Diphthongs sustain their first vowel and glide to the second at the end of the note.
 *  - A melisma ("-") carries the vowel onto further notes; the coda waits for the last of them.
 *  - Vibrato blooms a quarter of a second into a held vowel.
 * Live playing uses open-ended notes: a key press sings the onset and starts a vowel that lasts
 * until the key is released (tagged gestures, ended with GestureScore.release), and the release
 * sings the glide and the coda.
 */
import { planUtterance, diphthongParts, type Plan, type PlannedSegment, type Segment } from "./planner.ts";
import { phoneme } from "./inventory.ts";
import type { Gesture } from "../control/score.ts";
import type { Syllable } from "./syllables.ts";

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** sung consonants are a little shorter than spoken ones */
const cdur = (ipa: string, body: string, k = 0.8) => (phoneme(ipa, body)?.dur ?? 0.07) * k;
const consonants = (segs: Segment[], body: string, k = 0.8): Segment[] => segs.map((c) => ({ ipa: c.ipa, dur: cdur(c.ipa, body, k) }));
const total = (segs: Segment[]) => segs.reduce((s, c) => s + (c.dur ?? 0), 0);

const vibratoGesture = (t0: number, t1: number, depth: number, tag?: number): Gesture => ({ t0: t0 + 0.22, t1, rampIn: 0.3, rampOut: 0.06, strength: 4, targets: { vibrato: depth }, label: "vibrato", tag });

export interface SungNote {
  midi: number;
  /** length in beats */
  beats: number;
  syl: Syllable;
}

export interface SongOptions {
  body: string;
  bpm: number;
  /** plan time of the first note's beat (its onset consonants come before) */
  t0: number;
  /** vibrato depth (cents) on held vowels */
  vibrato: number;
}

/** Plan a whole melody: one utterance per phrase, so each phrase gets its own breath. */
export function planSong(notes: SungNote[], o: SongOptions): Plan {
  const beat = 60 / o.bpm;
  const gestures: Gesture[] = [];
  const segments: PlannedSegment[] = [];
  const times: number[] = [];
  let t = o.t0;
  for (const n of notes) {
    times.push(t);
    t += n.beats * beat;
  }
  let end = t;
  let i = 0;
  while (i < notes.length) {
    let j = i;
    while (j < notes.length - 1 && !notes[j].syl.phraseEnd) j++;
    const segs: Segment[] = [];
    const vowelSpans: [number, number][] = [];
    const onsetOf = (k: number) => (notes[k].syl.melisma ? [] : consonants(notes[k].syl.onset, o.body));
    for (let k = i; k <= j; k++) {
      const n = notes[k];
      const hz = midiToHz(n.midi);
      const nextMelisma = k < j && notes[k + 1].syl.melisma;
      const coda = nextMelisma ? [] : consonants(lastOfChain(notes, k).coda, o.body);
      const onset = onsetOf(k);
      // vowel from this note's beat to the next note's onset (less this note's coda);
      // the phrase's last vowel leaves a short breath before the next phrase
      const noteEnd = k < j ? times[k + 1] - total(onsetOf(k + 1)) : times[j] + notes[j].beats * beat - Math.min(0.12, 0.3 * notes[j].beats * beat);
      const vdur = Math.max(0.05, noteEnd - times[k] - total(coda));
      segs.push(...onset);
      const parts = diphthongParts(n.syl.nucleus.ipa);
      if (parts && !nextMelisma) {
        segs.push({ ipa: parts[0], dur: vdur * 0.8, f0: hz, stress: 1 }, { ipa: parts[1], dur: vdur * 0.2, f0: hz, stress: 1 });
      } else segs.push({ ipa: parts ? parts[0] : n.syl.nucleus.ipa, dur: vdur, f0: hz, stress: 1 });
      segs.push(...coda);
      vowelSpans.push([times[k], times[k] + vdur]);
    }
    if (segs.length) {
      // the planner lays segments out from t0 + 0.06: start so the first vowel lands on its beat
      const plan = planUtterance(segs, { body: o.body, t0: times[i] - total(onsetOf(i)) - 0.06, f0: midiToHz(notes[i].midi), intonation: "flat" });
      gestures.push(...plan.gestures);
      segments.push(...plan.segments);
      for (const [a, b] of vowelSpans) if (b - a > 0.3) gestures.push(vibratoGesture(a, b, o.vibrato));
      end = Math.max(end, plan.end);
    }
    i = j + 1;
  }
  return { gestures, segments, end };
}

/** The syllable whose coda ends a melisma chain starting at note k. */
function lastOfChain(notes: SungNote[], k: number): Syllable {
  let b = k;
  while (b > 0 && notes[b].syl.melisma) b--;
  return notes[b].syl;
}

/** Live: gestures relative to "now" (the planner's 60 ms lead is mostly taken back). */
const LIVE_T0 = -0.045;
/** a held vowel lasts at most this long (s) */
const HOLD = 30;

/**
 * Key pressed: sing the previous syllable's glide and coda if it is still sounding (legato),
 * then this syllable's onset, then its vowel held open-ended. Every gesture gets `tag`; the
 * pitch and vibrato get `tag + 1`, so a melisma can change pitch without ending the vowel.
 */
export function planNoteOn(syl: Syllable, midi: number, o: { body: string; vibrato: number; tag: number; legatoFrom?: { syl: Syllable; midi: number } }): Gesture[] {
  const hz = midiToHz(midi);
  const segs: Segment[] = [];
  if (o.legatoFrom) segs.push(...tail(o.legatoFrom.syl, o.body, midiToHz(o.legatoFrom.midi)));
  segs.push(...consonants(syl.onset, o.body, 0.7));
  const parts = diphthongParts(syl.nucleus.ipa);
  segs.push({ ipa: parts ? parts[0] : syl.nucleus.ipa, dur: HOLD, f0: hz, stress: 1 });
  const plan = planUtterance(segs, { body: o.body, t0: LIVE_T0, f0: hz, intonation: "flat", openEnd: true });
  const vowel = plan.segments[plan.segments.length - 1];
  const out: Gesture[] = plan.gestures.map((g) => ({ ...g, tag: g.targets.f0 !== undefined ? o.tag + 1 : o.tag }));
  out.push(vibratoGesture(vowel.t0, vowel.t1, o.vibrato, o.tag + 1));
  return out;
}

/** Melisma, live: the held vowel moves to a new pitch (release tag + 1 first). */
export function planMelisma(midi: number, o: { vibrato: number; tag: number }): Gesture[] {
  return [
    { t0: 0, t1: HOLD, rampIn: 0.05, rampOut: 0.06, strength: 6, targets: { f0: midiToHz(midi) }, label: "pitch", tag: o.tag + 1 },
    vibratoGesture(0, HOLD, o.vibrato, o.tag + 1),
  ];
}

/** Key released: the diphthong's glide and the coda (release the note's tags first). */
export function planNoteOff(syl: Syllable, midi: number, body: string): Gesture[] {
  const hz = midiToHz(midi);
  const segs = tail(syl, body, hz);
  if (!segs.length) return [];
  return planUtterance(segs, { body, t0: LIVE_T0, f0: hz, intonation: "flat" }).gestures;
}

/** What follows a held vowel: the diphthong's glide (at the note's pitch) and the coda. */
function tail(syl: Syllable, body: string, hz: number): Segment[] {
  const parts = diphthongParts(syl.nucleus.ipa);
  const out: Segment[] = [];
  if (parts) out.push({ ipa: parts[1], dur: 0.07, stress: 1, f0: hz });
  out.push(...consonants(syl.coda, body, 0.7));
  return out;
}
