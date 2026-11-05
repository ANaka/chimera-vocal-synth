import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { roll, tickSinging } from "../singing.ts";
import { C } from "../colors.ts";

/** pixels per second of voice time */
const SPEED = 96;
/** the "now" line, as a fraction of the width: the rest shows what is coming */
const NOW_AT = 0.7;
/** semitones shown */
const SPAN = 25;
const BLACK = [1, 3, 6, 8, 10];
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const KEY_CENTRE: Record<string, number> = { male: 54, female: 66, child: 70 };

const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

/**
 * Scrolling piano roll for Sing mode: the notes asked for (bars, with their syllables) and the
 * pitch the vocal folds actually produced (a trace that shows the onsets, glides and vibrato).
 */
export function PianoRoll() {
  const st = useRef({ centre: NaN, trace: [] as { t: number; m: number; v: number }[], lastClock: -1 });
  const ref = useCanvasLoop(({ ctx, w, h, dt }) => {
    tickSinging();
    const s = st.current;
    const body = useStore.getState().body;
    const tele = engine.latest?.t;
    const clock = engine.voiceClock() ?? 0;
    // sung pitch, sampled as telemetry arrives
    if (tele && tele.clock !== s.lastClock) {
      s.lastClock = tele.clock;
      s.trace.push({ t: tele.clock, m: tele.f0 > 20 ? hzToMidi(tele.f0) : NaN, v: tele.voicing });
      const cut = tele.clock - (w * NOW_AT) / SPEED - 1;
      while (s.trace.length && s.trace[0].t < cut) s.trace.shift();
    }
    const tLeft = clock - (w * NOW_AT) / SPEED, tRight = clock + (w * (1 - NOW_AT)) / SPEED;
    const x = (t: number) => (t - tLeft) * SPEED;
    // follow the notes on screen (slowly), else rest on the keyboard's middle
    let lo = Infinity, hi = -Infinity;
    for (const n of roll.notes) {
      if ((n.t1 ?? clock) < tLeft || n.t0 > tRight) continue;
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    const want = lo <= hi ? (lo + hi) / 2 : KEY_CENTRE[body] ?? 60;
    if (!Number.isFinite(s.centre)) s.centre = want;
    s.centre += (want - s.centre) * (1 - Math.exp(-dt / 0.6));
    const bottom = s.centre - SPAN / 2;
    const rowH = h / SPAN;
    const y = (m: number) => h - (m - bottom + 0.5) * rowH;

    ctx.fillStyle = C.black;
    ctx.fillRect(0, 0, w, h);
    // keyboard rows: black-key rows a shade lighter, a line and a name at each C
    ctx.font = font(10.5, 500);
    ctx.textBaseline = "middle";
    for (let m = Math.floor(bottom) - 1; m <= Math.ceil(bottom + SPAN) + 1; m++) {
      const pc = ((m % 12) + 12) % 12;
      const yc = y(m);
      if (BLACK.includes(pc)) {
        ctx.fillStyle = "#0b0d0e";
        ctx.fillRect(0, yc - rowH / 2, w, rowH);
      }
      if (pc === 0) {
        ctx.fillStyle = C.line;
        ctx.fillRect(0, Math.round(yc + rowH / 2) - 0.5, w, 1);
        ctx.fillStyle = C.textDim;
        ctx.fillText(`${NAMES[pc]}${Math.floor(m / 12) - 1}`, 6, yc);
      }
    }
    // notes
    const barH = Math.max(3, rowH - 2);
    ctx.textBaseline = "alphabetic";
    ctx.font = font(12, 550);
    for (const n of roll.notes) {
      const t1 = n.t1 ?? clock;
      if (t1 < tLeft || n.t0 > tRight) continue;
      const x0 = x(n.t0), x1 = Math.max(x0 + 3, x(t1));
      const yc = y(n.midi);
      const live = n.t0 <= clock && clock <= t1;
      ctx.fillStyle = live ? C.caliper : n.t0 > clock ? "rgba(242, 207, 91, 0.32)" : "rgba(242, 207, 91, 0.58)";
      ctx.beginPath();
      ctx.roundRect(x0, yc - barH / 2, x1 - x0, barH, Math.min(3, barH / 2));
      ctx.fill();
      if (n.text && n.text !== "~") {
        ctx.fillStyle = live ? C.text : C.textDim;
        ctx.fillText(n.text, x0 + 1, yc - barH / 2 - 4);
      }
    }
    // the pitch actually sung
    ctx.strokeStyle = "rgb(240, 88, 28)";
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (const p of s.trace) {
      if (!(p.v > 0.3) || !Number.isFinite(p.m) || p.t < tLeft) {
        pen = false;
        continue;
      }
      const px = x(p.t), py = y(p.m);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
    // now
    ctx.fillStyle = C.caliperDim;
    ctx.fillRect(Math.round(w * NOW_AT) - 0.5, 0, 1, h);
  });
  return <canvas ref={ref} className="instrument-canvas roll-canvas" aria-label="Piano roll: the notes played, their syllables, and the pitch actually sung" />;
}
