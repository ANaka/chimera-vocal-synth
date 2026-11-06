/**
 * The Good Evening demo's screens (demo branch only): the words at the mouth as they are sung,
 * beatboxed or spoken; the lyrics; the piano roll and the voice's spectrogram; play and hold.
 */
import { useEffect } from "react";
import { useStore } from "../store.ts";
import { useShow, playShow, stopShow, tickShow, type Cue, type CueKind } from "../show.ts";
import { Chip, Screen } from "./Screen.tsx";
import { PianoRoll } from "./PianoRoll.tsx";
import { Spectrogram } from "./Spectrogram.tsx";
import { hfont, label, seg } from "../render/vector.ts";
import { V } from "../colors.ts";
import { noteName } from "./VoiceControls.tsx";
import type { InfoFn, OverlayFn } from "./AnatomyView.tsx";

const COLOR: Record<CueKind, string> = { sing: V.green, beat: V.amber, speech: V.white };
const PART: Record<CueKind, string> = { sing: "Singing", beat: "Beatbox", speech: "Speaking" };

/** words leaving the mouth: the one sounding, and the last few drifting off and fading */
const trail: { cue: Cue; left: number | null }[] = [];
let clock = 0;
/** how long a word takes to drift away (s) */
const FADE = 0.45;

export const showOverlay: OverlayFn = (ctx, r, m, f, a, { w, dt }) => {
  clock += dt;
  const cue = tickShow()?.cue ?? null;
  const top = trail[trail.length - 1];
  if (top && top.cue !== cue && top.left === null) top.left = clock;
  if (cue && top?.cue !== cue) trail.push({ cue, left: null });
  while (trail.length && (trail.length > 8 || (trail[0].left !== null && clock - trail[0].left > FADE))) trail.shift();
  if (!trail.length) return;
  const lips = r.handles(m, f, a).find((h) => h.id === "lips");
  if (!lips) return;
  const lx = r.X(lips.pos), ly = r.Y(lips.pos);
  const x0 = lx + r.pxPerCm * 1.2;
  const room = Math.max(60, w - x0 - 14);
  const base = Math.max(26, Math.min(64, r.pxPerCm * 1.7));
  for (const { cue: c, left } of trail) {
    const age = left === null ? 0 : clock - left;
    // a word that has been said shrinks, dims and flies up and away, clear of the next one
    const u = Math.min(1, age / FADE);
    const alpha = left === null ? 1 : 0.75 * (1 - u) ** 1.5;
    const text = c.text.toUpperCase();
    ctx.font = hfont(base, "m");
    const wide = ctx.measureText(text).width * 1.08;
    const size = (wide > room ? (base * room) / wide : base) * (1 - 0.55 * u);
    const x = x0 + age * 240, y = ly + size * 0.36 - age * 200;
    label(ctx, text, x, y, { size, color: COLOR[c.kind], weight: "m", ls: 0.05, alpha });
    if (c.sub && left === null) label(ctx, c.sub.toUpperCase(), x + 2, y + 20, { size: 11, color: COLOR[c.kind], ls: 0.2, alpha: 0.75 });
  }
  const now = trail[trail.length - 1];
  if (now.left === null) seg(ctx, lx + 10, ly, x0 - 10, ly, COLOR[now.cue.kind], 1, { dash: [2, 5], alpha: 0.7 });
};

/** the lines over the face: the part being performed and the note */
export const showInfo: InfoFn = (_m, _f, tele) => {
  const out: string[] = [];
  const s = useShow.getState();
  const cue = s.cues[s.at];
  if (s.status === "playing" && cue) out.push(PART[cue.kind]);
  if (tele && tele.t.voicing > 0.3) out.push(`Note ${noteName(tele.t.f0)} ${tele.t.f0.toFixed(0)} Hz`);
  return out;
};

/** The lyric line before, the one being performed (the cue now lit) and the next. */
function ShowLyrics() {
  const cues = useShow((s) => s.cues);
  const at = useShow((s) => s.at);
  const status = useShow((s) => s.status);
  const error = useShow((s) => s.error);
  if (error) return <p className="show-hint error">Could not play: {error}</p>;
  if (!cues.length) return <p className="show-hint">Press Play: CHIMERA sings, beatboxes and talks over the band, all from one simulated throat.</p>;
  const lines: number[] = [];
  for (const c of cues) if (lines[lines.length - 1] !== c.line) lines.push(c.line);
  const nowLine = at >= 0 ? cues[at].line : cues[0].line;
  const li = lines.indexOf(nowLine);
  const shown = [lines[li - 1], lines[li], lines[li + 1]];
  return (
    <div className="show-lyrics">
      {shown.map((line, k) => (
        <div key={`${k}-${line}`} className={`show-line${k === 1 ? " current" : ""}`}>
          {line === undefined
            ? " "
            : cues.map((c, i) =>
                c.line !== line ? null : (
                  <span key={i} className={`show-cue k-${c.kind}${i === at ? " now" : ""}${i < at ? " done" : ""}`}>
                    {c.text}
                  </span>
                ),
              )}
        </div>
      ))}
      {status === "done" && <p className="show-hint">Now grab the tongue: dragging any handle holds the voice. Space turns it off and on.</p>}
    </div>
  );
}

/** Show mode's right column. */
export function ShowRight() {
  const status = useShow((s) => s.status);
  const hold = useStore((s) => s.hold);
  const setHold = useStore((s) => s.setHold);
  // space: hold the voice (for playing with the tongue once the song is over)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, button")) return;
      e.preventDefault();
      const s = useStore.getState();
      if (useShow.getState().status === "playing") return;
      s.setHold(!s.hold);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const playing = status === "playing" || status === "loading";
  return (
    <div className="right right-show">
      <Screen
        className="s-song"
        title="Good Evening"
        sub="Sung, beatboxed and spoken live"
        tools={
          <>
            <Chip on={playing} onClick={() => (playing ? stopShow() : void playShow())}>
              {status === "loading" ? "Loading…" : playing ? "Stop" : "Play"}
            </Chip>
            <Chip on={hold} disabled={playing} onClick={() => setHold(!hold)} title="Hold the voice (Space)">
              Hold voice
            </Chip>
          </>
        }
      >
        <ShowLyrics />
      </Screen>
      <Screen className="s-roll" title="Piano roll" sub="The melody and the pitch sung">
        <PianoRoll />
      </Screen>
      <Screen className="s-wf" title="Spectrogram" sub="The voice alone">
        <Spectrogram />
      </Screen>
    </div>
  );
}

/** Grabbing a handle after the song holds the voice, so the tongue can be heard. */
export function showGrab(): void {
  const s = useStore.getState();
  if (useShow.getState().status !== "playing" && !s.hold) s.setHold(true);
}
