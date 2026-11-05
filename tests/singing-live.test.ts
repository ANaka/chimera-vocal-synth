/**
 * Sing mode's live path end to end, without a browser: the key handling in src/ui/singing.ts
 * talks to a stand-in for the audio engine that does what the worklet does with each message
 * (schedule at clock + lead, release by tag, cancel), on a real offline voice.
 */
import { describe, expect, mock, test } from "bun:test";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { midiToHz } from "../src/engine/phonetics/sing.ts";
import { activation, type Gesture } from "../src/engine/control/score.ts";

const FS = 48000;
let voice = new HumanVoice({ fsOut: FS });
const fakeEngine = {
  latest: null,
  voiceClock: () => voice.clock,
  onPlanned: () => () => {},
  scheduleGestures: (gs: Gesture[], lead = 0.006) => {
    const off = voice.clock + lead;
    voice.schedule(gs.map((g) => ({ ...g, t0: g.t0 + off, t1: g.t1 + off })));
  },
  schedule: (plan: { gestures: Gesture[] }) => {
    voice.cancelScore();
    const off = voice.clock + 0.03;
    voice.schedule(plan.gestures.map((g) => ({ ...g, t0: g.t0 + off, t1: g.t1 + off })));
    return 1;
  },
  release: (tag: number) => voice.release(tag),
  stopSpeech: () => voice.cancelScore(),
};
mock.module("../src/audio/AudioEngine.ts", () => ({ engine: fakeEngine }));
const { useSing, singNoteOn, singNoteOff, playDemo, stopSinging } = await import("../src/ui/singing.ts");
const gesturesOf = () => (voice.score as unknown as { gestures: Gesture[] }).gestures;

/** Render `sec` seconds; per 2.7 ms block: f0, voicing, output RMS, narrowest oral area. */
function run(sec: number) {
  const n = Math.round(sec * FS);
  const out = new Float32Array(n);
  const f0: number[] = [], voicing: number[] = [], rms: number[] = [], minOral: number[] = [];
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    voice.render(out, i, m);
    let e = 0;
    for (let j = i; j < i + m; j++) e += out[j] * out[j];
    rms.push(Math.sqrt(e / m));
    f0.push(voice.glottis.f0Now);
    voicing.push(voice.glottis.voicing);
    let mn = Infinity;
    for (const a of voice.airway.orAreas) mn = Math.min(mn, a);
    minOral.push(mn);
  }
  // the last 40 % of the span, where a note has settled
  const late = <T,>(xs: T[]) => xs.slice(Math.floor(xs.length * 0.6));
  return { f0, voicing, rms, minOral, late };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cents = (f: number, midi: number) => 1200 * Math.log2(f / midiToHz(midi));

describe("Sing mode, live keys", () => {
  test("each key sings the next syllable at its pitch; legato, melisma and release to silence", () => {
    voice = new HumanVoice({ fsOut: FS });
    useSing.getState().setVibrato(0);
    useSing.getState().setLyrics("la ma -");
    expect(useSing.getState().syllables.map((s) => s.text)).toEqual(["la", "ma", "~"]);
    run(0.1);

    // first key: /la/ on A2
    singNoteOn(45, 96, "male");
    expect(useSing.getState().cursor).toBe(1);
    const a = run(0.5);
    expect(Math.abs(cents(median(a.late(a.f0)), 45))).toBeLessThan(30);
    expect(Math.min(...a.late(a.voicing))).toBeGreaterThan(0.5);

    // second key pressed while the first is down: legato into /ma/ on C3 (the lips close once)
    singNoteOn(48, 96, "male");
    const b = run(0.5);
    expect(Math.abs(cents(median(b.late(b.f0)), 48))).toBeLessThan(30);
    expect(Math.min(...b.minOral)).toBeLessThan(0.05); // the /m/ closure
    expect(Math.min(...b.late(b.minOral))).toBeGreaterThan(0.2); // open again on the vowel

    // releasing the first key (no longer sounding) changes nothing
    singNoteOff(45, "male");
    const c = run(0.2);
    expect(Math.min(...c.voicing)).toBeGreaterThan(0.5);

    // melisma: the vowel carries on to E3 without a consonant
    singNoteOn(52, 96, "male");
    expect(useSing.getState().cursor).toBe(0); // wrapped round
    const d = run(0.5);
    expect(Math.abs(cents(median(d.late(d.f0)), 52))).toBeLessThan(30);
    expect(Math.min(...d.minOral)).toBeGreaterThan(0.2);
    expect(Math.min(...d.voicing)).toBeGreaterThan(0.5);

    // releasing E3 while C3 is still down glides back to C3 on the same vowel
    singNoteOff(52, "male");
    const e = run(0.4);
    expect(Math.abs(cents(median(e.late(e.f0)), 48))).toBeLessThan(30);
    expect(Math.min(...e.voicing)).toBeGreaterThan(0.5);

    // last key up: the note ends and the voice falls silent
    singNoteOff(48, "male");
    const f = run(0.6);
    let peak = 0;
    for (const r of [...a.rms, ...b.rms]) peak = Math.max(peak, r);
    expect(Math.max(...f.rms.slice(Math.floor(0.3 * FS / 128)))).toBeLessThan(peak * 0.003); // < -50 dB
  });

  test("a soft key breathes less than a hard one", () => {
    const level = (velocity: number) => {
      voice = new HumanVoice({ fsOut: FS });
      useSing.getState().setLyrics("ah");
      run(0.05);
      singNoteOn(50, velocity, "male");
      const r = run(0.5);
      singNoteOff(50, "male");
      run(0.4);
      return { p: voice.source.pressure, rms: median(r.late(r.rms)) };
    };
    const soft = level(30), hard = level(127);
    if (process.env.SING_VERBOSE) console.log(`hard vs soft key: ${(20 * Math.log10(hard.rms / soft.rms)).toFixed(1)} dB`);
    expect(hard.rms / soft.rms).toBeGreaterThan(1.6); // > 4 dB
  });

  test("a demo still waiting for audio or the dictionary is cancelled by a stop", async () => {
    voice = new HumanVoice({ fsOut: FS });
    let scheduled = 0;
    const schedule = fakeEngine.schedule;
    fakeEngine.schedule = (plan) => (scheduled++, schedule(plan));
    let go!: () => void;
    const waiting = playDemo("Made of air", "male", () => new Promise<void>((r) => (go = r)));
    stopSinging(); // e.g. the mode changed while audio was starting
    go();
    await waiting;
    expect(scheduled).toBe(0);
    expect(useSing.getState().demo).toBeNull();
    await playDemo("Made of air", "male", () => Promise.resolve());
    expect(scheduled).toBe(1);
    expect(useSing.getState().demo).toBe("Made of air");
    stopSinging();
    fakeEngine.schedule = schedule;
  });

  test("a quick next note drops the last one's breath-out; leaving Sing cancels a pending ending", () => {
    voice = new HumanVoice({ fsOut: FS });
    useSing.getState().setVibrato(0);
    useSing.getState().setLyrics("cat dog");
    run(0.05);
    singNoteOn(50, 96, "male");
    run(0.4);
    singNoteOff(50, "male"); // "cat": its /t/ and the breath-out are scheduled
    expect(gesturesOf().some((g) => g.label === "exhale")).toBe(true);
    run(0.02);
    singNoteOn(52, 96, "male"); // "dog" straight after
    expect(gesturesOf().some((g) => g.label === "exhale")).toBe(false);
    const d = run(0.4);
    expect(Math.min(...d.late(d.voicing))).toBeGreaterThan(0.5);
    singNoteOff(52, "male"); // "dog": its /g/ ending is scheduled...
    run(0.01);
    stopSinging(); // ...and the mode changes at once
    run(0.06);
    // the cancelled ending's breath is gone (the note's own breath is at the end of its 70 ms fade)
    let breath = 0;
    for (const g of voice.score.activeAt(voice.clock)) if (g.targets.breath !== undefined) breath += activation(g, voice.clock) * g.strength;
    expect(breath).toBeLessThan(0.01);
  });
});
