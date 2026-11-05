import { useCanvasLoop, font } from "../useCanvas.ts";
import { useStore } from "../store.ts";
import { creatureById } from "../../wasm/engine.ts";
import { liveTelemetry, previewTelemetry } from "../creatureLive.ts";
import { C, hot, pressureLevel } from "../colors.ts";

const a2d = (A: number) => 2 * Math.sqrt(Math.max(0, A) / Math.PI);

/** Each airway tube unrolled into a lane: diameter profile (shared scale) lit by acoustic pressure. */
export function CreatureTubes() {
  const ref = useCanvasLoop(({ ctx, w, h }) => {
    const st = useStore.getState();
    const def = creatureById(st.creature);
    ctx.clearRect(0, 0, w, h);
    if (!def) return;
    const live = liveTelemetry(def.id);
    const tele = live ?? previewTelemetry(def, st.cparams[def.id]);
    const lanes = def.visual.tubes.filter((t) => tele.tubes[t.tube]);
    if (!lanes.length) return;
    let dMax = 0.01;
    for (const l of lanes) for (const a of tele.tubes[l.tube].areas) dMax = Math.max(dMax, a2d(a));
    const labelW = 92;
    const laneH = (h - 2) / lanes.length;
    ctx.font = font(11);
    lanes.forEach((l, li) => {
      const data = tele.tubes[l.tube];
      const y = 1 + laneH * (li + 0.5);
      ctx.fillStyle = C.textDim;
      ctx.fillText(l.label ?? l.tube, 0, y + 4);
      const n = data.areas.length;
      const x0 = labelW, x1 = w - 2;
      const dx = (x1 - x0) / n;
      for (let k = 0; k < n; k++) {
        const d = Math.max(1, (a2d(data.areas[k]) / dMax) * (laneH - 4));
        if (live) {
          const [r, g, b] = hot(0.08 + 0.92 * pressureLevel(data.rms[k] * 0.6));
          ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        } else ctx.fillStyle = "#5b6368";
        ctx.fillRect(x0 + k * dx, y - d / 2, Math.max(1, dx - 0.6), d);
      }
    });
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Airway tubes unrolled, lit by sound pressure" role="img" />;
}
