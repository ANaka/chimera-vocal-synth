import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { useModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { C } from "../colors.ts";

/**
 * Vowel map in the phonetician's orientation: F2 decreasing left→right, F1 increasing downward.
 * Calibrated vowels are plotted where this body actually produces them; dragging morphs the
 * articulation between them; the yellow ring is the live tract's measured (F1, F2).
 */
export function VowelMap() {
  const model = useModel();
  const dragging = useRef(false);
  const range = () => {
    const b = useStore.getState().body;
    return b === "male" ? { f1: [230, 950], f2: [700, 2700] } : b === "female" ? { f1: [280, 1150], f2: [800, 3200] } : { f1: [300, 1250], f2: [900, 3500] };
  };
  const toXY = (F1: number, F2: number, w: number, h: number) => {
    const r = range();
    const pad = 18;
    const x = pad + ((Math.log(r.f2[1]) - Math.log(F2)) / (Math.log(r.f2[1]) - Math.log(r.f2[0]))) * (w - 2 * pad);
    const y = pad + ((Math.log(F1) - Math.log(r.f1[0])) / (Math.log(r.f1[1]) - Math.log(r.f1[0]))) * (h - 2 * pad);
    return { x, y };
  };
  const fromXY = (x: number, y: number, w: number, h: number) => {
    const r = range();
    const pad = 18;
    const u = Math.min(1, Math.max(0, (x - pad) / (w - 2 * pad)));
    const v = Math.min(1, Math.max(0, (y - pad) / (h - 2 * pad)));
    const F2 = Math.exp(Math.log(r.f2[1]) - u * (Math.log(r.f2[1]) - Math.log(r.f2[0])));
    const F1 = Math.exp(Math.log(r.f1[0]) + v * (Math.log(r.f1[1]) - Math.log(r.f1[0])));
    return { F1, F2 };
  };
  const ref = useCanvasLoop(({ ctx, w, h }) => {
    const m = model.current;
    if (!m) return;
    const st = useStore.getState();
    ctx.clearRect(0, 0, w, h);
    // vowel trapezoid guide
    const corners = [toXY(300, 2500, w, h), toXY(320, 850, w, h), toXY(720, 1050, w, h), toXY(780, 1650, w, h)];
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.font = font(16, 500);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const v of m.vowels) {
      const p = toXY(v.F1, v.F2, w, h);
      ctx.fillStyle = "rgba(232,234,235,0.82)";
      ctx.fillText(v.ipa, p.x, p.y);
    }
    // live point
    const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
    const a = tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic;
    const fm = m.transfer(a).formants;
    if (fm.length >= 2) {
      const p = toXY(fm[0], fm[1], w, h);
      ctx.strokeStyle = C.caliper;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = C.caliper;
      ctx.fill();
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = font(10.5);
    ctx.fillStyle = C.textDim;
    ctx.fillText("F2", w - 22, h - 5);
    ctx.fillText("F1", 4, h - 5);
  });

  const apply = (e: React.PointerEvent) => {
    const m = model.current;
    if (!m) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const { F1, F2 } = fromXY(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    useStore.getState().setArtic(m.articForFormants(F1, F2), true);
  };

  return (
    <canvas
      ref={ref}
      className="vowel-map"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as Element).setPointerCapture(e.pointerId);
        apply(e);
      }}
      onPointerMove={(e) => dragging.current && apply(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      aria-label="Vowel map. Drag to morph between vowels."
      role="slider"
      aria-valuetext="vowel position"
    />
  );
}
