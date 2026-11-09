/**
 * The duet page's performance tracks (a singer's head pose and expression from a music video):
 * a file in the format samples to the pose between frames, the head eases off and back at the
 * edges of a shot the singer isn't in and over a cut rather than snapping, a moment the tracking
 * loses him is filled in, the brows and lids ease the same way where his eyes go unseen, big
 * turns are held to a range the cutaway reads in, and damaged files are refused.
 */
import { describe, expect, test } from "bun:test";
import { BRIDGE, CUT, EASE, LIMIT, Performance, restPose, softClamp, type PerformancePose } from "../src/show/performance.ts";

/** frames at 30 fps; the times are rounded to 4 decimals (so the easing checks hold to 1e-3) */
const FPS = 30;
type Col = (number | null)[];

/** the largest change of f(pose) between samples 5 ms apart over [a, b) */
function worstStep(p: Performance, f: (q: PerformancePose) => number, a = 0, b = 4): number {
  let last = f(p.pose(a)), worst = 0;
  for (let t = a; t < b; t += 0.005) {
    const v = f(p.pose(t));
    worst = Math.max(worst, Math.abs(v - last));
    last = v;
  }
  return worst;
}

/** a file of `n` frames at 30 fps from t0: yaw = i/100, pitch = −i/200, roll = i/400, brow = 0.5,
 *  blink = 0; frames in `off` have the singer off screen. No other columns: the reader needs none */
function file(n: number, o: { t0?: number; off?: (i: number) => boolean; edit?: (f: Record<string, unknown>) => void } = {}) {
  const off = o.off ?? (() => false);
  const make = (v: (i: number) => number): Col => Array.from({ length: n }, (_, i) => (off(i) ? null : v(i)));
  const f: Record<string, unknown> = {
    version: 1,
    t: Array.from({ length: n }, (_, i) => +((o.t0 ?? 0) + i / FPS).toFixed(4)),
    yaw: make((i) => i / 100),
    pitch: make((i) => -i / 200),
    roll: make((i) => i / 400),
    brow: make(() => 0.5),
    blink: make(() => 0),
  };
  o.edit?.(f);
  return f;
}

describe("Performance", () => {
  test("interpolates linearly between frames", () => {
    const p = new Performance(file(60));
    expect(p.t.length).toBe(60);
    expect(p.end).toBe(p.t[59]);
    // mid-file, far from the edges: full weight, the angles small enough to pass the clamp nearly as they are
    const q = p.pose(30.5 / FPS);
    expect(q.weight).toBe(1);
    expect(q.yaw).toBeCloseTo(softClamp(0.305, LIMIT.yaw), 3);
    expect(q.pitch).toBeCloseTo(softClamp(-0.1525, LIMIT.pitch), 3);
    expect(q.roll).toBeCloseTo(softClamp(0.07625, LIMIT.roll), 3);
    expect(q.brow).toBe(0.5);
    expect(q.blink).toBe(0);
    // exactly on a frame
    expect(p.pose(20 / FPS).yaw).toBeCloseTo(softClamp(0.2, LIMIT.yaw), 3);
  });

  test("the weight is 0 outside the file and eases in from its start and out at its end", () => {
    const p = new Performance(file(90, { t0: 1 }));
    expect(p.pose(0.5).weight).toBe(0);
    expect(p.pose(1).weight).toBe(0);
    expect(p.pose(1 + EASE / 2).weight).toBeCloseTo(0.5, 3);
    expect(p.pose(1 + EASE).weight).toBeCloseTo(1, 6);
    const end = p.t[89];
    expect(p.pose(end - EASE / 2).weight).toBeCloseTo(0.5, 3);
    expect(p.pose(end).weight).toBe(0);
    expect(p.pose(end + 0.01).weight).toBe(0);
    expect(p.pose(NaN).weight).toBe(0);
  });

  test("across a gap the head holds the nearest tracked frame while the weight goes to 0 and back", () => {
    // off screen for frames 40..59 (t 1.333..1.967)
    const p = new Performance(file(120, { off: (i) => i >= 40 && i < 60 }));
    const [lastOn, firstOff, lastOff, backOn] = [p.t[39], p.t[40], p.t[59], p.t[60]];
    expect(p.pose(1.5).weight).toBe(0);
    // just before the gap: frame 39's pose (not leaning towards the missing frame 40), nearly no weight
    const q = p.pose(lastOn + 0.5 / FPS);
    expect(q.yaw).toBeCloseTo(softClamp(0.39, LIMIT.yaw), 6);
    expect(q.brow).toBe(0.5);
    expect(q.weight).toBeGreaterThan(0);
    expect(q.weight).toBeLessThan(0.05);
    // the weight falls smoothly into the gap: 0.3 s before its first frame it is still all there
    expect(p.pose(firstOff - EASE).weight).toBeCloseTo(1, 6);
    expect(p.pose(firstOff - EASE / 2).weight).toBeCloseTo(0.5, 3);
    // and comes back the same way after it, from the last frame he was off in
    expect(p.pose(lastOff).weight).toBe(0);
    expect(p.pose(backOn).weight).toBeLessThan(0.05);
    expect(p.pose(lastOff + EASE / 2).weight).toBeCloseTo(0.5, 3);
    expect(p.pose(lastOff + EASE).weight).toBeCloseTo(1, 6);
    expect(p.pose(backOn - 0.5 / FPS).yaw).toBeCloseTo(softClamp(0.6, LIMIT.yaw), 6);
    // no step anywhere: sampled every 5 ms, the weight never jumps
    expect(worstStep(p, (q) => q.weight)).toBeLessThan(0.04);
  });

  // All Star at 41.40 s: the tracker lost him for 2 frames, then 3, inside one shot, and the head
  // swung 28° back to the voice's pose and returned in 0.8 s, a move the singer never made
  test("a moment the tracking loses him (up to BRIDGE) is filled in, not a gap", () => {
    const p = new Performance(file(90, { off: (i) => i === 30 || i === 31 || (i >= 35 && i < 38) }));
    for (let t = 25 / FPS; t < 45 / FPS; t += 0.005) expect(p.pose(t).weight).toBe(1);
    // the angles, brow and blink run straight across: frame 30 is where it would have been (to the
    // times' rounding)
    const q = p.pose(30 / FPS);
    expect(q.yaw).toBeCloseTo(softClamp(0.3, LIMIT.yaw), 4);
    expect(q.pitch).toBeCloseTo(softClamp(-0.15, LIMIT.pitch), 4);
    expect([q.brow, q.face]).toEqual([0.5, 1]);
    // dropouts of 3, 1, 1, 1 frames with single frames between (All Star at 186.25 s) are one run
    const flicker = new Performance(file(90, { off: (i) => (i >= 30 && i < 33) || i === 34 || i === 36 || i === 38 }));
    for (let t = 25 / FPS; t < 45 / FPS; t += 0.005) expect(flicker.pose(t).weight).toBe(1);
    // 6 frames missing (0.233 s between the tracked ones) is filled; 7 (0.267 s) is him gone
    expect(7 / FPS).toBeLessThanOrEqual(BRIDGE);
    expect(8 / FPS).toBeGreaterThan(BRIDGE);
    expect(new Performance(file(90, { off: (i) => i >= 40 && i < 46 })).pose(43 / FPS).weight).toBe(1);
    expect(new Performance(file(90, { off: (i) => i >= 40 && i < 47 })).pose(43 / FPS).weight).toBe(0);
  });

  // All Star at 210.37 s: a cut between two shots of him, each relative to its own median, stepped
  // the yaw 47° between two frames, and the head swung 41° in 33 ms
  test("a cut (the angles stepping past CUT between frames) eases the head off and back", () => {
    const step = (deg: number) => file(90, { edit: (f) => ((f.yaw as Col) = (f.yaw as Col).map((_, i) => (i < 45 ? 0.1 : 0.1 - (deg * Math.PI) / 180))) });
    const p = new Performance(step(40));
    const mid = (p.t[44] + p.t[45]) / 2;
    expect(p.pose(mid).weight).toBeLessThan(1e-9);
    expect(p.pose(mid - EASE / 2).weight).toBeCloseTo(0.5, 3);
    expect(p.pose(mid - EASE).weight).toBeCloseTo(1, 6);
    expect(p.pose(mid + EASE / 2).weight).toBeCloseTo(0.5, 3);
    expect(p.pose(mid + EASE).weight).toBeCloseTo(1, 6);
    // each side holds its own shot's pose up to the cut, never one between the two
    expect(p.pose(mid - 0.001).yaw).toBeCloseTo(softClamp(0.1, LIMIT.yaw), 6);
    expect(p.pose(mid + 0.001).yaw).toBeCloseTo(softClamp(0.1 - (40 * Math.PI) / 180, LIMIT.yaw), 6);
    // what the head shows (the yaw by its weight) never steps: 5 ms of the ease moves it at most
    // 0.6 rad × 1.5 × 0.005 / EASE = 0.015, where lerping across the cut stepped 0.1; the face
    // goes with it
    expect(worstStep(p, (q) => q.yaw * q.weight)).toBeLessThan(0.02);
    expect(Math.abs(p.pose(mid + 0.0025).yaw * p.pose(mid + 0.0025).weight - p.pose(mid - 0.0025).yaw * p.pose(mid - 0.0025).weight)).toBeLessThan(1e-3);
    expect(worstStep(p, (q) => q.face)).toBeLessThan(0.04);
    // a step under CUT is a movement: no easing
    expect(CUT).toBeGreaterThan((15 * Math.PI) / 180);
    expect(new Performance(step(15)).pose(mid).weight).toBe(1);
    // a cut across a short dropout leaves it a gap
    const across = step(40);
    for (const k of ["yaw", "pitch", "roll", "brow", "blink"]) (across[k] as Col)[44] = (across[k] as Col)[45] = null;
    expect(new Performance(across).pose(mid).weight).toBe(0);
  });

  test("a short shot only partly takes over the head", () => {
    // on screen for 0.4 s: the weight peaks below 1
    const p = new Performance(file(60, { off: (i) => i < 20 || i >= 32 }));
    let peak = 0;
    for (let t = 0; t < 2; t += 0.005) peak = Math.max(peak, p.pose(t).weight);
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(1);
  });

  test("turns are soft-clamped: linear when small, never past the limit", () => {
    const big = file(60, { edit: (f) => ((f.yaw as Col).fill(3), (f.pitch as Col).fill(-3), (f.roll as Col).fill(1)) });
    const q = new Performance(big).pose(1);
    expect(q.yaw).toBeLessThan(LIMIT.yaw);
    expect(q.yaw).toBeGreaterThan(0.99 * LIMIT.yaw);
    expect(q.pitch).toBeGreaterThan(-LIMIT.pitch);
    expect(q.pitch).toBeLessThan(-0.99 * LIMIT.pitch);
    expect(q.roll).toBeLessThan(LIMIT.roll);
    expect(softClamp(0.01, LIMIT.yaw)).toBeCloseTo(0.01, 5);
    expect(softClamp(-0.01, LIMIT.roll)).toBeCloseTo(-0.01, 4);
    // brows and lids keep to their ranges
    const wild = new Performance(file(60, { edit: (f) => ((f.brow as Col).fill(4), (f.blink as Col).fill(-2)) })).pose(1);
    expect([wild.brow, wild.blink]).toEqual([1, 0]);
  });

  // All Star at 216.18 s: his eyes went unseen between two tracked frames and a raised brow and
  // half-shut lid snapped to the voice's in 33 ms
  test("a tracked head whose eyes the video can't see (sunglasses) eases brows and lids to the voice", () => {
    // brow i/60, blink i/120; eyes unseen in frames 30..59
    const p = new Performance(
      file(90, {
        edit: (f) => {
          f.brow = Array.from({ length: 90 }, (_, i) => (i >= 30 && i < 60 ? null : i / 60));
          f.blink = Array.from({ length: 90 }, (_, i) => (i >= 30 && i < 60 ? null : i / 120));
        },
      }),
    );
    const [lastSeen, firstUnseen, lastUnseen] = [p.t[29], p.t[30], p.t[59]];
    // the head still turns with the video, but the brows and blinks go to the voice's ...
    const q = p.pose(45 / FPS);
    expect([q.weight, q.face]).toEqual([1, 0]);
    // ... over EASE, not a frame: the face weight is all there EASE before, half way at EASE / 2
    expect(p.pose(firstUnseen - EASE).face).toBeCloseTo(1, 6);
    expect(p.pose(firstUnseen - EASE / 2).face).toBeCloseTo(0.5, 3);
    expect(p.pose(lastUnseen + EASE / 2).face).toBeCloseTo(0.5, 3);
    expect(p.pose(lastUnseen + EASE).face).toBeCloseTo(1, 6);
    expect(worstStep(p, (q) => q.face)).toBeLessThan(0.04);
    // and as they go, they hold the last frame that saw them, not leaning towards nothing
    const r = p.pose(lastSeen + 0.5 / FPS);
    expect(r.brow).toBeCloseTo(29 / 60, 9);
    expect(r.blink).toBeCloseTo(29 / 120, 9);
    expect(worstStep(p, (q) => q.brow * q.face)).toBeLessThan(0.04);
    // the face weight is never more than the head's
    const short = new Performance(file(60, { off: (i) => i < 20 || i >= 32 }));
    for (let t = 0; t < 2; t += 0.005) expect(short.pose(t).face).toBeLessThanOrEqual(short.pose(t).weight);
  });

  test("refuses damaged files", () => {
    expect(() => new Performance(null)).toThrow(/not a JSON object/);
    expect(() => new Performance([])).toThrow(/not a JSON object/);
    expect(() => new Performance(file(10, { edit: (f) => (f.version = 2) }))).toThrow(/version 2/);
    expect(() => new Performance(file(10, { edit: (f) => (f.t = []) }))).toThrow(/no frames/);
    expect(() => new Performance(file(10, { edit: (f) => ((f.t as number[])[5] = (f.t as number[])[4]) }))).toThrow(/ascending at frame 5/);
    expect(() => new Performance(file(10, { edit: (f) => ((f.t as unknown[])[3] = null) }))).toThrow(/t\[3\]/);
    expect(() => new Performance(file(10, { edit: (f) => delete f.roll }))).toThrow(/no roll/);
    expect(() => new Performance(file(10, { edit: (f) => (f.blink as Col).pop() }))).toThrow(/blink has 9 entries for 10 frames/);
    expect(() => new Performance(file(10, { edit: (f) => ((f.yaw as unknown[])[2] = "0.1") }))).toThrow(/yaw\[2\]/);
    expect(() => new Performance(file(10, { edit: (f) => ((f.brow as unknown[])[2] = Infinity) }))).toThrow(/brow\[2\]/);
  });

  test("outside the file, and by default, the pose is the rest pose", () => {
    const out = new Performance(file(10)).pose(5, { ...restPose(), yaw: 1, weight: 1 });
    expect(out).toEqual(restPose());
    expect(new Performance(file(10)).pose(-1)).toEqual(restPose());
  });
});
