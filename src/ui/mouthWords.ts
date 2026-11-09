/**
 * Words at the mouth: the syllable being sung or the word being spoken, written just in front of
 * the lips as it sounds (under the chin when there is no room in front). When the next one starts,
 * it shrinks, dims and flies away from where it was (up and away in front, downwards under the
 * chin), so a fast scat run leaves a short trail instead of a pile-up.
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
  /** `left`: when the word was sent off (null while it sounds); `spot`: where it was then */
  entries: { word: MouthWord; left: number | null; spot?: WordSpot }[];
}

/**
 * The trail at `clock` given the word sounding now: a new key starts a new entry and sends the
 * last one off; the same key coming back while its entry is still flying off brings it back
 * (a brief gap in what is being said is not a new word).
 */
export function advanceTrail(t: Trail, word: MouthWord | null, clock: number): void {
  const e = t.entries;
  const top = e[e.length - 1];
  if (top && word && top.word.key === word.key) {
    top.left = null;
    top.spot = undefined;
  } else {
    if (top && top.left === null) top.left = clock;
    if (word) e.push({ word, left: null });
  }
  while (e.length && (e.length > 8 || (e[0].left !== null && clock - e[0].left > FADE))) e.shift();
}

/** the words' full size (px) at a face drawn `cm` px per cm: 1.7 cm, but at least 26 px */
const wordSize = (cm: number) => Math.max(26, Math.min(64, cm * 1.7));

/** where the words go */
export interface WordSpot {
  /** "front": from x at the lips' height, flying up and away; "chin" (under the chin) and "neck"
   *  (below the neck): centred on x at y (moved within lo..hi to fit), falling away downwards */
  at: "front" | "chin" | "neck";
  x: number;
  y: number;
  /** the span a word may take (px): it shrinks to fit */
  lo: number;
  hi: number;
}

/**
 * Where the words at a mouth go, on a screen `w` × `h` with the lips at (`lx`, `ly`), `cm` px per
 * cm there, the face looking towards `side`, and the lips' outline reaching `edge` on that side.
 * In front of the lips (1.2 cm, and clear of their outline) when there are 60 px of room there.
 * Without them (a narrow pane, or a head whose tracked pose swings its face to the pane's edge, as
 * the duet's lead does turning and nodding with the singer in the video), they go under the chin,
 * a cm ahead of the lips and reaching no more than a cm behind them, in front of the throat. A
 * face drawn under about 12 px per cm (a phone's or a tablet's three duet panes, 6.6-11 px per cm)
 * has words taller than the room there: they go below the neck instead. `was` is the spot used
 * last (none after a silence): leaving it takes a margin, so a head swaying at a limit doesn't
 * flicker between spots. Words in front stay there down to 50 px of room and come back at 60;
 * under the chin down to 11.8 px per cm, and back from below the neck at 12.3 (a laptop's turned
 * duet face measures 12.8 and up).
 */
export function wordSpot(w: number, h: number, lx: number, ly: number, cm: number, side: 1 | -1, edge = lx, was?: WordSpot["at"]): WordSpot {
  const reach = Math.max(0, side * (edge - lx));
  const x0 = lx + side * Math.max(cm * 1.2, reach + cm * 0.6);
  const ahead = side > 0 ? w - x0 - 14 : x0 - 14;
  if (ahead >= (was === "front" ? 50 : 60)) return side > 0 ? { at: "front", x: x0, y: ly, lo: x0, hi: x0 + ahead } : { at: "front", x: x0, y: ly, lo: x0 - ahead, hi: x0 };
  if (cm < (was === "neck" ? 12.3 : 11.8)) return { at: "neck", x: lx, y: Math.min(h - 14, ly + cm * 18), lo: 8, hi: w - 8 };
  // no further back than a cm behind the lips, but at least 3 cm wide when the lips leave the pane
  const back = lx - side * cm;
  const y = Math.min(h - 14, ly + cm * 6.5);
  return side > 0
    ? { at: "chin", x: lx + cm, y, lo: Math.max(8, Math.min(back, w - 8 - 3 * cm)), hi: w - 8 }
    : { at: "chin", x: lx - cm, y, lo: 8, hi: Math.min(w - 8, Math.max(back, 8 + 3 * cm)) };
}

/**
 * An overlay writing `now()`'s word at the mouth in `color`; each call keeps its own trail.
 * `side` is where the face looks on screen: 1 writes to the right of the lips, −1 to the left (a
 * head turned to face left), so the word is in the open space in front of the mouth, or under the
 * chin on that side (see wordSpot).
 */
export function mouthWords(now: () => MouthWord | null, color: string, side: 1 | -1 = 1): OverlayFn {
  const t: Trail = { entries: [] };
  const trail = t.entries;
  let clock = 0;
  let was: WordSpot["at"] | undefined;
  return (ctx, r, m, f, a, { w, h, dt }) => {
    clock += dt;
    advanceTrail(t, now(), clock);
    if (!trail.length) {
      was = undefined;
      return;
    }
    const lips = r.handles(m, f, a).find((h) => h.id === "lips");
    if (!lips) return;
    const lx = r.X(lips.pos), ly = r.Y(lips.pos);
    const here = wordSpot(w, h, lx, ly, r.pxPerCm, side, r.mouthEdge?.(side), was);
    was = here.at;
    const base = wordSize(r.pxPerCm);
    for (const entry of trail) {
      const { word: wd, left } = entry;
      // the sounding word follows the mouth; a word sent off flies from where it was
      if (left !== null) entry.spot ??= here;
      const spot = entry.spot ?? here;
      const age = left === null ? 0 : clock - left;
      const u = Math.min(1, age / FADE);
      const text = wd.text.toUpperCase();
      ctx.font = hfont(base, "m");
      const wide = ctx.measureText(text).width * 1.08;
      const room = spot.hi - spot.lo;
      const size = (wide > room ? (base * room) / wide : base) * (1 - 0.55 * u);
      const alpha = left === null ? 1 : 0.75 * (1 - u) ** 1.5;
      const o = { size, color, weight: "m" as const, ls: 0.05, alpha, moving: left !== null };
      if (spot.at === "front") label(ctx, text, spot.x + side * age * 240, spot.y + size * 0.36 - age * 200, { ...o, align: side > 0 ? "left" : "right" });
      else {
        const half = (Math.min(wide, room) * (1 - 0.55 * u)) / 2;
        label(ctx, text, Math.min(spot.hi - half, Math.max(spot.lo + half, spot.x)), spot.y + age * 240, { ...o, align: "center" });
      }
    }
    if (here.at === "front" && trail[trail.length - 1].left === null) seg(ctx, lx + side * 10, ly, here.x - side * 10, ly, color, 1, { dash: [2, 5], alpha: 0.7 });
  };
}
