/**
 * Words at the mouth: the syllable being sung or the word being spoken, written just in front of
 * the lips as it sounds. When the next one starts, it shrinks, dims and flies up and away, so a
 * fast scat run leaves a short trail instead of a pile-up.
 */
import { hfont, label, seg } from "./render/vector.ts";
import type { OverlayFn } from "./components/AnatomyView.tsx";

/** What is being said now. `key` changes with each new syllable or word (equal text may repeat). */
export interface MouthWord {
  key: unknown;
  text: string;
}

/** how long a word takes to fly off (s) */
const FADE = 0.45;

export interface Trail {
  entries: { word: MouthWord; left: number | null }[];
}

/**
 * The trail at `clock` given the word sounding now: a new key starts a new entry and sends the
 * last one off; the same key coming back while its entry is still flying off brings it back
 * (a brief gap in what is being said is not a new word).
 */
export function advanceTrail(t: Trail, word: MouthWord | null, clock: number): void {
  const e = t.entries;
  const top = e[e.length - 1];
  if (top && word && top.word.key === word.key) top.left = null;
  else {
    if (top && top.left === null) top.left = clock;
    if (word) e.push({ word, left: null });
  }
  while (e.length && (e.length > 8 || (e[0].left !== null && clock - e[0].left > FADE))) e.shift();
}

/** where the words go: in front of the mouth, or under the chin */
export interface WordSpot {
  /** "front": from x at the lips' height, flying up and away; "under": centred on x at y, falling
   *  away downwards */
  at: "front" | "under";
  x: number;
  y: number;
  /** the width a word may take at full size before it shrinks to fit (px) */
  room: number;
}

/**
 * Where the words at a mouth go, on a screen `w` × `h` with the lips at (`lx`, `ly`), `cm` px per
 * cm there, the face looking towards `side`, and the lips' outline reaching `edge` on that side:
 * in front of the lips (1.2 cm, and clear of their outline) when there is room, else under the
 * chin, a cm ahead of the lips, in front of the throat. A narrow pane the head fills has no room in
 * front, and nor does a head whose tracked pose swings its face to the pane's edge (the duet's
 * lead, turning and nodding with the singer in the video).
 */
export function wordSpot(w: number, h: number, lx: number, ly: number, cm: number, side: 1 | -1, edge = lx): WordSpot {
  const reach = Math.max(0, side * (edge - lx));
  const x0 = lx + side * Math.max(cm * 1.2, reach + cm * 0.6);
  const ahead = side > 0 ? w - x0 - 14 : x0 - 14;
  if (ahead >= 60) return { at: "front", x: x0, y: ly, room: ahead };
  return { at: "under", x: lx + side * cm, y: Math.min(h - 14, ly + cm * 6.5), room: w - 16 };
}

/**
 * An overlay writing `now()`'s word at the mouth in `color`; each call keeps its own trail.
 * `side` is where the face looks on screen: 1 writes to the right of the lips, −1 to the left (a
 * head turned to face left), so the word is always in the open space in front of the mouth.
 */
export function mouthWords(now: () => MouthWord | null, color: string, side: 1 | -1 = 1): OverlayFn {
  const t: Trail = { entries: [] };
  const trail = t.entries;
  let clock = 0;
  return (ctx, r, m, f, a, { w, h, dt }) => {
    clock += dt;
    advanceTrail(t, now(), clock);
    if (!trail.length) return;
    const lips = r.handles(m, f, a).find((h) => h.id === "lips");
    if (!lips) return;
    const lx = r.X(lips.pos), ly = r.Y(lips.pos);
    const spot = wordSpot(w, h, lx, ly, r.pxPerCm, side, r.mouthEdge?.(side));
    const { room } = spot;
    const base = Math.max(26, Math.min(64, r.pxPerCm * 1.7));
    for (const { word: wd, left } of trail) {
      const age = left === null ? 0 : clock - left;
      const u = Math.min(1, age / FADE);
      const text = wd.text.toUpperCase();
      ctx.font = hfont(base, "m");
      const wide = ctx.measureText(text).width * 1.08;
      const size = (wide > room ? (base * room) / wide : base) * (1 - 0.55 * u);
      const alpha = left === null ? 1 : 0.75 * (1 - u) ** 1.5;
      const o = { size, color, weight: "m" as const, ls: 0.05, alpha, moving: left !== null };
      if (spot.at === "front") label(ctx, text, spot.x + side * age * 240, ly + size * 0.36 - age * 200, { ...o, align: side > 0 ? "left" : "right" });
      else {
        const half = (Math.min(wide, room) * (1 - 0.55 * u)) / 2;
        label(ctx, text, Math.min(w - 8 - half, Math.max(8 + half, spot.x)), spot.y + age * 240, { ...o, align: "center" });
      }
    }
    if (spot.at === "front" && trail[trail.length - 1].left === null) seg(ctx, lx + side * 10, ly, spot.x - side * 10, ly, color, 1, { dash: [2, 5], alpha: 0.7 });
  };
}
