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

/** An overlay writing `now()`'s word at the mouth in `color`; each call keeps its own trail. */
export function mouthWords(now: () => MouthWord | null, color: string): OverlayFn {
  const t: Trail = { entries: [] };
  const trail = t.entries;
  let clock = 0;
  return (ctx, r, m, f, a, { w, dt }) => {
    clock += dt;
    advanceTrail(t, now(), clock);
    if (!trail.length) return;
    const lips = r.handles(m, f, a).find((h) => h.id === "lips");
    if (!lips) return;
    const lx = r.X(lips.pos), ly = r.Y(lips.pos);
    const x0 = lx + r.pxPerCm * 1.2;
    const room = Math.max(60, w - x0 - 14);
    const base = Math.max(26, Math.min(64, r.pxPerCm * 1.7));
    for (const { word: wd, left } of trail) {
      const age = left === null ? 0 : clock - left;
      const u = Math.min(1, age / FADE);
      const text = wd.text.toUpperCase();
      ctx.font = hfont(base, "m");
      const wide = ctx.measureText(text).width * 1.08;
      const size = (wide > room ? (base * room) / wide : base) * (1 - 0.55 * u);
      const alpha = left === null ? 1 : 0.75 * (1 - u) ** 1.5;
      label(ctx, text, x0 + age * 240, ly + size * 0.36 - age * 200, { size, color, weight: "m", ls: 0.05, alpha, moving: left !== null });
    }
    if (trail[trail.length - 1].left === null) seg(ctx, lx + 10, ly, x0 - 10, ly, color, 1, { dash: [2, 5], alpha: 0.7 });
  };
}
