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

/** An overlay writing `now()`'s word at the mouth in `color`; each call keeps its own trail. */
export function mouthWords(now: () => MouthWord | null, color: string): OverlayFn {
  const trail: { word: MouthWord; left: number | null }[] = [];
  let clock = 0;
  return (ctx, r, m, f, a, { w, dt }) => {
    clock += dt;
    const word = now();
    const top = trail[trail.length - 1];
    if (top && top.left === null && top.word.key !== word?.key) top.left = clock;
    if (word && top?.word.key !== word.key) trail.push({ word, left: null });
    while (trail.length && (trail.length > 8 || (trail[0].left !== null && clock - trail[0].left > FADE))) trail.shift();
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
      label(ctx, text, x0 + age * 240, ly + size * 0.36 - age * 200, { size, color, weight: "m", ls: 0.05, alpha });
    }
    if (trail[trail.length - 1].left === null) seg(ctx, lx + 10, ly, x0 - 10, ly, color, 1, { dash: [2, 5], alpha: 0.7 });
  };
}
