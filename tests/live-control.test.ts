/**
 * Ownership and ordering of live control: tagged releases never let a gesture rise again, the
 * worklet applies score messages sent during a body change to the new voice, and MIDI notes
 * held on several keyboards/channels end only when the last one lets go.
 */
import { describe, expect, test } from "bun:test";
import { GestureScore, activation } from "../src/engine/control/score.ts";
import { planNoteOn } from "../src/engine/phonetics/sing.ts";
import type { Syllable } from "../src/engine/phonetics/syllables.ts";
import type { HumanVoice } from "../src/engine/voice/humanVoice.ts";

describe("tagged release", () => {
  test("a note released early drops what has not begun and fades what has, never rising again", () => {
    // /strɑ/ held, released 30 ms in: the vowel and its pitch have not begun yet
    const syl: Syllable = { text: "stra", onset: [{ ipa: "s" }, { ipa: "t" }, { ipa: "ɹ" }], nucleus: { ipa: "ɑ", stress: 1 }, coda: [], wordEnd: true, phraseEnd: false };
    const gs = planNoteOn(syl, 57, { body: "male", vibrato: 30, tag: 4 });
    const score = new GestureScore();
    score.addAll(gs.map((g) => ({ ...g, t0: g.t0 + 0.05, t1: g.t1 + 0.05 })));
    const t = 0.08;
    const before = new Map(score.activeAt(t).map((g) => [g, activation(g, t)]));
    score.release(4, t);
    score.release(5, t);
    for (const g of score.activeAt(t)) expect(activation(g, t)).toBeCloseTo(before.get(g) ?? 0, 6); // continuous
    // after the release, no released gesture's activation exceeds what it had at the release
    for (let tt = t; tt < t + 0.5; tt += 0.002)
      for (const g of score.activeAt(tt)) if (g.tag === 4 || g.tag === 5) expect(activation(g, tt)).toBeLessThanOrEqual((before.get(g) ?? 0) + 1e-9);
    // the vowel (not begun at 80 ms) is gone, and everything is over soon after
    expect(score.activeAt(0.3).length).toBe(0);
  });
});

describe("worklet ordering", () => {
  test("a note scheduled right after a body change plays on the new voice", async () => {
    let Proc: (new () => { port: { onmessage: ((e: { data: unknown }) => void) | null }; process: (i: unknown, o: Float32Array[][]) => boolean }) | null = null;
    const g = globalThis as Record<string, unknown>;
    g.sampleRate = 48000;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null as unknown, postMessage: () => {} };
    };
    g.registerProcessor = (_name: string, ctor: typeof Proc) => (Proc = ctor);
    await import("../src/worklet/processor.ts");
    const p = new Proc!();
    const send = (data: unknown) => p.port.onmessage!({ data });
    const breath = { t0: 0, t1: 1, rampIn: 0.04, rampOut: 0.05, strength: 1, targets: { breath: 1 }, label: "breath" };
    send({ type: "body", body: "female" });
    send({ type: "schedule", gestures: [breath], segments: [], end: 1, id: 1, replace: false, lead: 0.006 });
    p.process([], [[new Float32Array(128)]]);
    const voice = (p as unknown as { voice: HumanVoice }).voice;
    expect(voice.airway.body.scale).toBeLessThan(1); // the new (female) voice
    expect(voice.score.size).toBe(1); // holding the note
  });
});

describe("MIDI ownership", () => {
  type Listener = ((e: { data: Uint8Array }) => void) | null;
  function fakeMidi() {
    const inputs = new Map<string, { id: string; name: string; state: string; onmidimessage: Listener }>();
    const access = { inputs, onstatechange: null as null | (() => void) };
    let resolve!: (a: typeof access) => void;
    let requests = 0;
    Object.defineProperty(globalThis.navigator, "requestMIDIAccess", {
      configurable: true,
      value: () => {
        requests++;
        return new Promise((r) => (resolve = r));
      },
    });
    const plug = (id: string) => inputs.set(id, { id, name: id, state: "connected", onmidimessage: null });
    const msg = (id: string, ...bytes: number[]) => inputs.get(id)!.onmidimessage?.({ data: Uint8Array.from(bytes) });
    return { access, plug, msg, grant: () => resolve(access), requests: () => requests };
  }

  test("one note per pitch across keyboards and channels; unplugging releases; disconnect cancels a pending request", async () => {
    const midi = await import("../src/ui/midi.ts");
    const f = fakeMidi();
    f.plug("A");
    f.plug("B");
    const log: string[] = [];
    let names: string[] = [];
    const h = { noteOn: (n: number) => log.push(`on ${n}`), noteOff: (n: number) => log.push(`off ${n}`), inputs: (x: string[]) => (names = x) };
    const c = midi.connectMidi(h);
    void midi.connectMidi(h); // a second click while the browser is asking
    expect(f.requests()).toBe(1);
    f.grant();
    await c;
    expect(names).toEqual(["A", "B"]);
    f.msg("A", 0x90, 60, 100); // A holds C4
    f.msg("B", 0x90, 60, 90); // B holds C4 too
    f.msg("A", 0x91, 60, 80); // and A again, on channel 2
    f.msg("A", 0x80, 60, 0);
    f.msg("A", 0x91, 60, 0); // note-on with velocity 0 = note-off
    expect(log).toEqual(["on 60"]); // B still holds it
    f.msg("B", 0x90, 64, 70);
    f.access.inputs.delete("B"); // B unplugged
    f.access.onstatechange!();
    expect(log).toEqual(["on 60", "on 64", "off 60", "off 64"]);
    midi.disconnectMidi();

    // disconnect while the browser is still asking: the late grant must not connect
    const g2 = fakeMidi();
    g2.plug("C");
    let late: string[] | null = null;
    const pending = midi.connectMidi({ ...h, inputs: (x) => (late = x) });
    midi.disconnectMidi();
    g2.grant();
    await pending;
    expect(late).toBeNull();
    expect(g2.access.inputs.get("C")!.onmidimessage).toBeNull();
  });
});
