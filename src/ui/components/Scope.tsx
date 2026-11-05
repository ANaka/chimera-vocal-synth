import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { creatureById } from "../../wasm/engine.ts";
import { liveTelemetry } from "../creatureLive.ts";
import { C } from "../colors.ts";

/** Output waveform, triggered on a rising zero crossing and spanning three cycles of the pitch. */
export function Scope() {
  const buf = useRef<Float32Array | null>(null);
  const gainRef = useRef(1);
  const ref = useCanvasLoop(({ ctx, w, h, dt }) => {
    const st = useStore.getState();
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    const an = engine.analyserScope;
    if (!an || !st.started) return;
    if (!buf.current || buf.current.length !== an.fftSize) buf.current = new Float32Array(an.fftSize);
    const b = buf.current;
    an.getFloatTimeDomainData(b as Float32Array<ArrayBuffer>);
    const sr = engine.sampleRate;
    const def = creatureById(st.creature);
    const pp = def?.params.find((p) => p.role === "pitch");
    const tele = def ? liveTelemetry(def.id) : null;
    const f0 = pp && tele ? tele.params[pp.key] : 200;
    const win = Math.round(Math.min(b.length / 2, Math.max(0.004 * sr, Math.min(0.3 * sr, (3 * sr) / f0))));
    // latest rising zero crossing that leaves a full window after it
    let start = b.length - win;
    for (let i = b.length - win; i > b.length - win - Math.min(b.length / 2, (2 * sr) / f0); i--) {
      if (b[i - 1] < 0 && b[i] >= 0) {
        start = i;
        break;
      }
    }
    let peak = 1e-4;
    for (let i = start; i < start + win; i++) peak = Math.max(peak, Math.abs(b[i]));
    // slow auto-gain so quiet calls stay visible without the trace jumping
    const want = 0.42 / Math.max(peak, 0.01);
    gainRef.current += (want - gainRef.current) * (1 - Math.exp(-dt / (want < gainRef.current ? 0.05 : 0.6)));
    const g = gainRef.current * h;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const i0 = start + Math.floor((x / w) * win), i1 = Math.max(i0 + 1, start + Math.floor(((x + 1) / w) * win));
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (b[i] < lo) lo = b[i];
        if (b[i] > hi) hi = b[i];
      }
      ctx.lineTo(x, mid - hi * g);
      if (lo < hi) ctx.lineTo(x, mid - lo * g);
    }
    ctx.strokeStyle = "rgba(232,234,235,0.85)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.font = font(10.5);
    ctx.fillStyle = C.textDim;
    const ms = (win / sr) * 1000;
    const label = ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`;
    ctx.fillText(label, w - ctx.measureText(label).width - 2, h - 4);
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Output waveform" role="img" />;
}
