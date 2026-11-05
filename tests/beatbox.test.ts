import { describe, expect, test } from "bun:test";
import { BEAT_PRESETS, BEAT_SOUNDS, formatBeat, parseBeat } from "../src/engine/phonetics/beatbox.ts";
import { BeatPlayer } from "../src/engine/control/beatPlayer.ts";
import type { Gesture } from "../src/engine/control/score.ts";

/** Hit time of each scheduled sound: the planned hit is where its gestures were shifted to. */
function run(p: BeatPlayer, from: number, to: number, dt = 128 / 48000): { t: number; label: string }[] {
  const hits: { t: number; label: string }[] = [];
  for (let clock = from; clock < to; clock += dt)
    p.tick(clock, (gs: Gesture[]) => {
      const ref = p.gestures({ id: gs[0].label === "m" ? "m" : (gs[0].label as string) }, 0);
      hits.push({ t: gs[0].t0 - ref[0].t0, label: gs[0].label as string });
    });
  return hits;
}

describe("beat notation", () => {
  test("parses symbols, rests, notes, accents and bar lines", () => {
    const s = parseBeat("B . t | Pf m:43 ^K> -");
    expect(s.map((x) => x?.id ?? null)).toEqual(["B", null, "t", "Pf", "m", "^K", null]);
    expect(s[4]?.note).toBe(43);
    expect(s[5]?.accent).toBeGreaterThan(1);
  });
  test("format and parse round-trip every preset", () => {
    for (const p of BEAT_PRESETS) {
      const steps = parseBeat(p.text);
      expect(steps.length).toBe(16);
      expect(parseBeat(formatBeat(steps))).toEqual(steps);
    }
  });
  test("every sound builds gestures that start before and end after its hit", () => {
    for (const s of BEAT_SOUNDS)
      for (const body of ["male", "female", "child"]) {
        const gs = s.build(body, { f0: 82, len: 0.15, accent: 1 });
        expect(gs.length).toBeGreaterThan(0);
        expect(Math.min(...gs.map((g) => g.t0 - g.rampIn))).toBeLessThan(0);
        expect(Math.max(...gs.map((g) => g.t1 + g.rampOut))).toBeGreaterThan(0);
        // everything a sound needs fits inside the sequencer's look-ahead
        expect(BeatPlayer.leadIn(s.id, body)).toBeLessThan(new BeatPlayer().horizon);
      }
  });
});

describe("beat player", () => {
  test("schedules each step once, on the grid, with swing on the off-beats", () => {
    const p = new BeatPlayer();
    p.steps = parseBeat("B t B t");
    p.setTempo(120, 0.5);
    p.start(0);
    const hits = run(p, 0, 2.2);
    const step = 60 / 120 / 4;
    // 2 s of sixteenths at 120 bpm = 16 steps, starting one horizon in
    expect(hits.length).toBeGreaterThanOrEqual(15);
    hits.slice(0, 8).forEach((h, n) => {
      const want = p.horizon + n * step + (n % 2 ? 0.25 * step : 0);
      expect(Math.abs(h.t - want)).toBeLessThan(1e-9);
    });
  });
  test("tempo changes keep the next step's time (no jump)", () => {
    const p = new BeatPlayer();
    p.steps = parseBeat("t t t t");
    p.setTempo(100, 0);
    p.start(0);
    const before = run(p, 0, 0.6);
    const last = before[before.length - 1].t;
    p.setTempo(160, 0);
    const after = run(p, 0.6, 1.2);
    const gap = after[0].t - last;
    // the first step after the change is spaced by at most one old step, then the new tempo
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(60 / 100 / 4 + 1e-9);
    expect(after[2].t - after[1].t).toBeCloseTo(60 / 160 / 4, 9);
  });
  test("reports the step under the playhead and nothing when stopped", () => {
    const p = new BeatPlayer();
    p.steps = parseBeat("B . t .");
    p.setTempo(120, 0);
    expect(p.stepAt(1)).toBe(-1);
    p.start(0);
    expect(p.stepAt(p.horizon + 0.01)).toBe(0);
    expect(p.stepAt(p.horizon + 3 * 0.125 + 0.01)).toBe(3);
    expect(p.stepAt(p.horizon + 4 * 0.125 + 0.01)).toBe(0);
    p.stop();
    expect(p.stepAt(1)).toBe(-1);
  });
});
