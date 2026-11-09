/**
 * A singer's performance, tracked from a music video: how the head turns, nods and tilts, and what
 * the brows and eyelids do, one entry per video frame. The duet page plays it on the voice's 3D
 * head in place of the voice-driven nods and sways; the engine still drives the mouth.
 *
 * The file (`performance.json`) holds columnar arrays of equal length, ascending in `t`:
 *
 *   { "version": 1, "t": [...], "yaw": [...], "pitch": [...], "roll": [...],
 *     "brow": [...], "blink": [...] }
 *
 * `t` is seconds on the record's clock (the show's audio). The angles are radians in the singer's
 * own frame, relative to the median pose of his shot: yaw + turns his head towards his own left,
 * pitch + lifts the chin, roll + tilts it towards his left shoulder. `brow` is −1..1 (+ raised, −
 * lowered and knit, as Expression.brow) and `blink` 0 open .. 1 shut (as Expression.lid). Where
 * the singer is off screen the angles are null; where he is on screen but his eyes aren't seen
 * (sunglasses, a small face), brow and blink are null. Other columns (the tracker writes `jaw` and
 * `confidence`) are ignored.
 *
 * The file is made outside this repo, by a face tracker (MediaPipe face landmarks over the video,
 * the singer picked per shot by lip-sync with the vocal stem); this header is the format's record.
 * It marks no cuts: a shot change with him on screen on both sides shows only as the angles
 * jumping (each shot has its own median), which the reader takes for a cut (see CUT).
 */

export const PERFORMANCE_VERSION = 1;

/** the head's pose at a moment: radians and expression as above; `weight` 0..1 is how much of it
 *  to show (0 off screen, easing in and out at the edges), `face` how much of the brows and
 *  blink (at most the weight, easing to 0 where the video can't see his eyes) */
export interface PerformancePose {
  yaw: number;
  pitch: number;
  roll: number;
  brow: number;
  blink: number;
  weight: number;
  face: number;
}

/** the pose that shows nothing (all 0) */
export const restPose = (): PerformancePose => ({ yaw: 0, pitch: 0, roll: 0, brow: 0, blink: 0, weight: 0, face: 0 });

/** how long the head takes to go over to the video's pose, or back, at a gap's edge (s) */
export const EASE = 0.3;
/** the most the head turns (radians): yaw 35°, pitch 20°, roll 15°, approached softly */
export const LIMIT = { yaw: (35 * Math.PI) / 180, pitch: (20 * Math.PI) / 180, roll: (15 * Math.PI) / 180 };
/** a gap whose tracked frames either side are at most this far apart (s; 6 missing frames at 30
 *  fps) is the tracker losing him for a moment, not him leaving: it is filled in between them */
export const BRIDGE = 0.25;
/** an angle step bigger than this (radians, on any axis) between tracked frames next to each other
 *  or either side of a short gap is a cut, not a movement: the head eases off and back over it.
 *  In All Star the one cut steps 47°; the most a head moved in a frame was 12°, across a gap 16° */
export const CUT = (20 * Math.PI) / 180;

const NUMERIC = ["yaw", "pitch", "roll", "brow", "blink"] as const;

/** x towards ±lim, linear near 0 and never past it (so a big turn still shows the face) */
export const softClamp = (x: number, lim: number) => lim * Math.tanh(x / lim);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const smoothstep = (x: number) => {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
};

export class Performance {
  readonly t: Float64Array;
  /** the time of the last frame he is on screen in (−∞ if none) */
  readonly end: number;
  private readonly yaw: Float64Array;
  private readonly pitch: Float64Array;
  private readonly roll: Float64Array;
  private readonly brow: Float64Array;
  private readonly blink: Float64Array;
  /** the singer is on screen at frame i (tracked, or a short gap filled in) */
  private readonly present: Uint8Array;
  /** ... and his brows and eyes are seen */
  private readonly eyes: Uint8Array;
  /** a cut between frames i − 1 and i, both on screen */
  private readonly cut: Uint8Array;
  /** the time of the last frame at or before i (the first after i) he was off screen, the
   *  midpoint of a cut, or the recording's edge: the weight eases from there. The same for his
   *  eyes, which the face weight eases from */
  private readonly offBefore: Float64Array;
  private readonly offAfter: Float64Array;
  private readonly eyesOffBefore: Float64Array;
  private readonly eyesOffAfter: Float64Array;

  /** `json`: the parsed file. Throws on a damaged or unexpected one rather than replay garbage. */
  constructor(json: unknown) {
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("performance file is not a JSON object");
    const o = json as Record<string, unknown>;
    if (o.version !== PERFORMANCE_VERSION) throw new Error(`performance file version ${String(o.version)}; this app reads ${PERFORMANCE_VERSION}`);
    const t = o.t;
    if (!Array.isArray(t) || t.length < 1) throw new Error("performance file has no frames (t)");
    const n = t.length;
    for (let i = 0; i < n; i++) {
      if (typeof t[i] !== "number" || !Number.isFinite(t[i])) throw new Error(`performance file: t[${i}] is not a number`);
      if (i > 0 && t[i] <= t[i - 1]) throw new Error(`performance file: t is not ascending at frame ${i}`);
    }
    const col = (k: (typeof NUMERIC)[number]): (number | null)[] => {
      const a = o[k];
      if (!Array.isArray(a)) throw new Error(`performance file has no ${k}`);
      if (a.length !== n) throw new Error(`performance file: ${k} has ${a.length} entries for ${n} frames`);
      a.forEach((x, i) => {
        if (x !== null && (typeof x !== "number" || !Number.isFinite(x))) throw new Error(`performance file: ${k}[${i}] is neither a number nor null`);
      });
      return a as (number | null)[];
    };
    const [yaw, pitch, roll, brow, blink] = NUMERIC.map(col);
    const T = (this.t = Float64Array.from(t as number[]));
    const present = (this.present = Uint8Array.from(yaw, (y, i) => (y !== null && pitch[i] !== null && roll[i] !== null ? 1 : 0)));
    // a missing brow or blink with the head tracked (his eyes unseen) leaves the brows and lids to
    // the voice; off screen everything holds 0 (the weight is 0 there)
    const eyes = (this.eyes = Uint8Array.from(yaw, (_, i) => (present[i] && brow[i] !== null && blink[i] !== null ? 1 : 0)));
    const num = (a: (number | null)[], m: Uint8Array) => Float64Array.from(a, (x, i) => (m[i] && x !== null ? x : 0));
    const Y = (this.yaw = num(yaw, present)), P = (this.pitch = num(pitch, present)), R = (this.roll = num(roll, present));
    const B = (this.brow = num(brow, eyes).map((x) => clamp(x, -1, 1))), K = (this.blink = num(blink, eyes).map((x) => clamp(x, 0, 1)));
    // between each pair of tracked frames, a and b: a cut where the angles step, or a short gap
    // filled in linearly (and the eyes with it where both frames see them)
    const cut = (this.cut = new Uint8Array(n));
    for (let a = -1, b = 0; b < n; b++) {
      if (!present[b]) continue;
      if (a >= 0 && (b === a + 1 || T[b] - T[a] <= BRIDGE)) {
        if (Math.max(Math.abs(Y[b] - Y[a]), Math.abs(P[b] - P[a]), Math.abs(R[b] - R[a])) > CUT) {
          // a cut across a gap leaves the gap as it is
          if (b === a + 1) cut[b] = 1;
        } else
          for (let k = a + 1; k < b; k++) {
            const u = (T[k] - T[a]) / (T[b] - T[a]);
            [Y[k], P[k], R[k], present[k]] = [lerp(Y[a], Y[b], u), lerp(P[a], P[b], u), lerp(R[a], R[b], u), 1];
            if (eyes[a] && eyes[b]) [B[k], K[k], eyes[k]] = [lerp(B[a], B[b], u), lerp(K[a], K[b], u), 1];
          }
      }
      a = b;
    }
    let end = -Infinity;
    for (let i = 0; i < n; i++) if (present[i]) end = T[i];
    this.end = end;
    [this.offBefore, this.offAfter] = this.edges(present);
    [this.eyesOffBefore, this.eyesOffAfter] = this.edges(eyes);
  }

  /** for each frame, when the run of frames in `m` it is in begins and ends: the frame before (or
   *  after) it that isn't in `m`, the midpoint of a cut, or the recording's edge */
  private edges(m: Uint8Array): [Float64Array, Float64Array] {
    const T = this.t, n = T.length, before = new Float64Array(n), after = new Float64Array(n);
    let off = T[0];
    for (let i = 0; i < n; i++) before[i] = off = !m[i] ? T[i] : this.cut[i] ? (T[i - 1] + T[i]) / 2 : off;
    off = T[n - 1];
    for (let i = n - 1; i >= 0; i--) after[i] = off = !m[i] ? T[i] : i + 1 < n && this.cut[i + 1] ? (T[i] + T[i + 1]) / 2 : off;
    return [before, after];
  }

  /** the last frame at or before time t, or −1 before the first */
  private indexAt(t: number): number {
    let lo = 0, hi = this.t.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k;
  }

  /**
   * The pose at time t (s, record clock), interpolated between frames. Beside a frame he is off
   * screen in, the pose holds the nearest frame he is on (never leans towards nothing), and each
   * side of a cut holds its own frame; the weight is 0 off screen, at a cut, and before the first
   * or after the last frame, and eases over EASE seconds from each of those. A short gap in the
   * tracking (BRIDGE) is filled in and doesn't count. The brows and blink do the same by where his
   * eyes are seen, under the weight. The angles are soft-clamped to LIMIT.
   */
  pose(t: number, out: PerformancePose = restPose()): PerformancePose {
    const T = this.t, n = T.length;
    const i = this.indexAt(t);
    if (!Number.isFinite(t) || i < 0 || t > T[n - 1]) {
      out.yaw = out.pitch = out.roll = out.brow = out.blink = out.weight = out.face = 0;
      return out;
    }
    const j = Math.min(n - 1, i + 1);
    const pi = this.present[i], pj = this.present[j];
    // the share of frame j: the time between the two, or all of whichever one he is on; across a
    // cut, each side's own frame up to the midpoint
    const cut = j > i && this.cut[j], mid = (T[i] + T[j]) / 2;
    const u = cut ? (t < mid ? 0 : 1) : pi && pj ? (j > i ? (t - T[i]) / (T[j] - T[i]) : 0) : pj ? 1 : 0;
    out.yaw = softClamp(lerp(this.yaw[i], this.yaw[j], u), LIMIT.yaw);
    out.pitch = softClamp(lerp(this.pitch[i], this.pitch[j], u), LIMIT.pitch);
    out.roll = softClamp(lerp(this.roll[i], this.roll[j], u), LIMIT.roll);
    // the brows and lids likewise between the frames that see his eyes (never towards the 0 a
    // frame that doesn't holds)
    const ei = this.eyes[i], ej = this.eyes[j], ue = ei && ej ? u : ej ? 1 : 0;
    out.brow = lerp(this.brow[i], this.brow[j], ue);
    out.blink = lerp(this.blink[i], this.blink[j], ue);
    // how far t is from being off screen (or unseen), either way: the frame after i settles the
    // way ahead, but across a cut each side's run ends at the midpoint
    const a = cut && u ? j : i, b = cut && !u ? i : j;
    const away = (on: boolean, before: Float64Array, after: Float64Array) => (on ? Math.min(t - before[a], after[b] - t) : 0);
    out.weight = smoothstep(away(!!(pi || pj), this.offBefore, this.offAfter) / EASE);
    out.face = Math.min(out.weight, smoothstep(away(!!(ei || ej), this.eyesOffBefore, this.eyesOffAfter) / EASE));
    return out;
  }
}
