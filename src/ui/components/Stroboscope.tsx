import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { C } from "../colors.ts";

/**
 * High-speed-video style view of the vocal folds from above, replayed slowly from the
 * phase-locked glottal area trace (two cycles), plus area/flow waveforms with a playhead.
 */
export function Stroboscope() {
  const phase = useRef(0);
  const ref = useCanvasLoop(({ ctx, w, h, dt }) => {
    const st = useStore.getState();
    ctx.clearRect(0, 0, w, h);
    const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
    const area = tele?.t.glottalArea;
    const flow = tele?.t.glottalFlow;
    const n = area?.length ?? 0;
    // apparent strobe rate: one simulated cycle per ~0.9 s
    phase.current = (phase.current + dt / 1.8) % 1;
    const idx = n ? Math.floor(phase.current * n) % n : 0;
    let maxA = 0.02;
    if (area) for (let i = 0; i < n; i++) maxA = Math.max(maxA, area[i]);
    const a = area ? area[idx] : 0;
    // --- endoscopic circle
    const R = Math.min(h * 0.42, w * 0.2);
    const cx = R + 10, cy = h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const bg = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    bg.addColorStop(0, "#9a9a9a");
    bg.addColorStop(1, "#2a2a2a");
    ctx.fillStyle = bg;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    // glottis slit: anterior (top) to posterior (bottom); opening ∝ area
    const len = R * 1.25;
    const open = Math.min(1, a / Math.max(0.12, maxA)) * R * 0.42;
    const chink = tele ? Math.min(R * 0.06, (Math.min(...Array.from(area!)) / 0.05) * R * 0.08) : 0;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(cx, cy - len / 2);
    ctx.quadraticCurveTo(cx + open + chink, cy + len * 0.05, cx + chink * 0.8, cy + len / 2);
    ctx.lineTo(cx - chink * 0.8, cy + len / 2);
    ctx.quadraticCurveTo(cx - open - chink, cy + len * 0.05, cx, cy - len / 2);
    ctx.fill();
    // fold edges (ligament highlights)
    ctx.strokeStyle = "rgba(235,235,235,0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - len / 2);
    ctx.quadraticCurveTo(cx + open + chink, cy + len * 0.05, cx + chink * 0.8, cy + len / 2);
    ctx.moveTo(cx, cy - len / 2);
    ctx.quadraticCurveTo(cx - open - chink, cy + len * 0.05, cx - chink * 0.8, cy + len / 2);
    ctx.stroke();
    // arytenoids
    ctx.fillStyle = "rgba(60,60,60,0.9)";
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + sgn * (R * 0.22 + chink), cy + len / 2 + R * 0.08, R * 0.2, R * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // --- waveforms
    const x0 = cx + R + 16, x1 = w - 8;
    const top = 16, bot = h - 18;
    ctx.font = font(11);
    ctx.fillStyle = C.textDim;
    ctx.fillText("Glottal area", x0, 12);
    ctx.fillStyle = "rgba(232,234,235,0.85)";
    ctx.fillText("flow", x0 + 76, 12);
    if (area && flow && n > 1) {
      let maxF = 1;
      for (let i = 0; i < n; i++) maxF = Math.max(maxF, Math.abs(flow[i]));
      const plot = (arr: Float32Array, mx: number, color: string, wdt: number) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = x0 + ((x1 - x0) * i) / (n - 1);
          const y = bot - (arr[i] / mx) * (bot - top);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = wdt;
        ctx.stroke();
      };
      plot(area, maxA * 1.05, C.textDim, 1.25);
      plot(flow, maxF * 1.05, "rgba(232,234,235,0.9)", 1.6);
      const px = x0 + ((x1 - x0) * idx) / (n - 1);
      ctx.strokeStyle = C.caliper;
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bot);
      ctx.stroke();
      ctx.fillStyle = C.textDim;
      ctx.fillText(`${(a * 100).toFixed(1)} mm²`, x0, h - 4);
      const oq = Array.from(area).filter((v) => v > Math.min(...Array.from(area)) + 0.002).length / n;
      const t = `Open ${Math.round(oq * 100)} %`;
      ctx.fillText(t, x1 - ctx.measureText(t).width, h - 4);
    } else {
      ctx.fillStyle = C.textDim;
      ctx.fillText("Start audio to see the folds vibrate", x0, h / 2);
    }
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Vocal fold stroboscope and glottal waveforms" role="img" />;
}
