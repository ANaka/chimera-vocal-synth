import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { useModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { C, hot, pressureLevel } from "../colors.ts";

/** The simulated tube: diameter profile along the tract, lit by acoustic pressure, nasal branch above. */
export function TubeView() {
  const model = useModel();
  const ref = useCanvasLoop(({ ctx, w, h }) => {
    const st = useStore.getState();
    const m = model.current;
    if (!m) return;
    ctx.clearRect(0, 0, w, h);
    const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
    let ph: ArrayLike<number>, or: ArrayLike<number>, phLen: number, orLen: number;
    let rms: Float32Array | null = null;
    if (tele) {
      ph = tele.t.phAreas;
      or = tele.t.orAreas;
      phLen = tele.t.phLen;
      orLen = tele.t.orLen;
      rms = tele.t.pressureRms;
    } else {
      m.airway.apply(st.artic);
      ph = m.airway.phAreas;
      or = m.airway.orAreas;
      phLen = m.airway.phLen;
      orLen = m.airway.orLen;
    }
    const nPh = ph.length, nOr = or.length;
    const total = phLen + orLen;
    const padL = 12, padR = 12;
    const axisY = h * 0.62;
    const sx = (w - padL - padR) / total;
    // diameter scale: 4 cm diameter → 34% of height
    const dScale = (h * 0.34) / 4;
    const a2d = (A: number) => 2 * Math.sqrt(Math.max(0, A) / Math.PI);
    // nasal branch (fixed profile) above, from the velum junction
    const velum = tele ? tele.t.velumPort : m.frame(st.artic).velumPort;
    const naX0 = padL + phLen * sx;
    const naY = axisY - h * 0.36;
    const naLen = 11.4 * m.airway.body.scale;
    const nasalLit = Math.min(1, velum / 0.4);
    ctx.strokeStyle = `rgba(160,170,175,${0.25 + 0.5 * nasalLit})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(naX0, axisY - a2d(ph[nPh - 1]) * dScale * 0.5);
    ctx.lineTo(naX0, naY + 6);
    ctx.stroke();
    const naW = Math.min(w - padR - naX0, naLen * sx * 0.75);
    ctx.fillStyle = `rgba(120,130,135,${0.18 + 0.35 * nasalLit})`;
    ctx.beginPath();
    ctx.roundRect(naX0, naY - 5, naW, 10, 5);
    ctx.fill();
    ctx.fillStyle = C.textDim;
    ctx.font = font(11);
    ctx.fillText(velum > 0.02 ? `Nasal, port ${velum.toFixed(2)} cm²` : "Nasal, closed", naX0 + 4, naY - 10);
    // sections
    const draw = (areas: ArrayLike<number>, s0: number, len: number, n: number, off: number) => {
      const dx = len / n;
      for (let i = 0; i < n; i++) {
        const x = padL + (s0 + i * dx) * sx;
        const ww = Math.max(1, dx * sx - 1);
        const d = a2d(areas[i]) * dScale;
        const lvl = rms ? pressureLevel(rms[off + i]) : 0;
        const [r, g, b] = hot(0.08 + 0.92 * lvl);
        ctx.fillStyle = rms ? `rgb(${r | 0},${g | 0},${b | 0})` : "#5b6368";
        ctx.fillRect(x, axisY - d / 2, ww, Math.max(0.5, d));
      }
    };
    draw(ph, 0, phLen, nPh, 0);
    draw(or, phLen, orLen, nOr, nPh);
    // landmarks
    const f = m.frame(tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic);
    const marks: [number, string][] = [[0, "Glottis"], [phLen, "Velum"], [total, "Lips"]];
    if ((total - f.teethS) * sx > 46) marks.splice(2, 0, [f.teethS, "Teeth"]);
    ctx.font = font(11);
    ctx.fillStyle = C.textDim;
    ctx.strokeStyle = "rgba(154,163,168,0.4)";
    let lastRight = -Infinity;
    for (const [s, name] of marks) {
      const x = padL + s * sx;
      const twCheck = ctx.measureText(name).width;
      if (x - twCheck / 2 < lastRight + 6) continue;
      lastRight = x + twCheck / 2;
      ctx.beginPath();
      ctx.moveTo(x, h - 22);
      ctx.lineTo(x, h - 16);
      ctx.stroke();
      const tw = ctx.measureText(name).width;
      ctx.fillText(name, Math.min(w - tw - 2, Math.max(2, x - tw / 2)), h - 4);
    }
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Area function of the simulated tube" role="img" />;
}
