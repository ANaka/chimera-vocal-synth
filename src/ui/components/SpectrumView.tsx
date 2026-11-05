import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { useModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { C } from "../colors.ts";

const FMIN = 60, FMAX = 8000;

/** Live output spectrum (filled) with the vocal-tract transfer function and formant calipers. */
export function SpectrumView() {
  const model = useModel();
  const bins = useRef<Float32Array | null>(null);
  const ref = useCanvasLoop(({ ctx, w, h }) => {
    const st = useStore.getState();
    const m = model.current;
    if (!m) return;
    ctx.clearRect(0, 0, w, h);
    const left = 4, right = w - 4, top = 18, bot = h - 18;
    const fx = (f: number) => left + ((Math.log(f) - Math.log(FMIN)) / (Math.log(FMAX) - Math.log(FMIN))) * (right - left);
    // grid
    ctx.font = font(10.5);
    ctx.fillStyle = C.textDim;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (const f of [100, 200, 500, 1000, 2000, 5000]) {
      const x = fx(f);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bot);
      ctx.stroke();
      const t = f >= 1000 ? `${f / 1000}k` : `${f}`;
      ctx.fillText(t, x - ctx.measureText(t).width / 2, h - 4);
    }
    // live FFT
    const an = engine.analyser;
    if (an && st.started) {
      if (!bins.current || bins.current.length !== an.frequencyBinCount) bins.current = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(bins.current as Float32Array<ArrayBuffer>);
      const b = bins.current;
      const sr = engine.sampleRate;
      ctx.beginPath();
      ctx.moveTo(left, bot);
      for (let x = left; x <= right; x += 1.5) {
        const f = Math.exp(Math.log(FMIN) + ((x - left) / (right - left)) * (Math.log(FMAX) - Math.log(FMIN)));
        const k = Math.min(b.length - 1, Math.round((f / sr) * 2 * b.length));
        const db = Math.max(-110, b[k]);
        const y = bot - ((db + 110) / 100) * (bot - top);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(right, bot);
      ctx.closePath();
      ctx.fillStyle = "rgba(154,163,168,0.28)";
      ctx.fill();
    }
    // transfer function of the current tract
    const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
    const a = tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic;
    const tf = m.transfer(a);
    let mx = -Infinity;
    for (const d of tf.db) mx = Math.max(mx, d);
    ctx.beginPath();
    for (let i = 0; i < tf.freqs.length; i++) {
      const x = fx(tf.freqs[i]);
      const y = top + ((mx - tf.db[i]) / 50) * (bot - top) * 0.9;
      if (i === 0) ctx.moveTo(x, Math.min(bot, y));
      else ctx.lineTo(x, Math.min(bot, y));
    }
    ctx.strokeStyle = "rgba(232,234,235,0.92)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // formant calipers
    ctx.font = font(11, 550);
    tf.formants.slice(0, 4).forEach((F, i) => {
      const x = fx(F);
      ctx.strokeStyle = C.caliper;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top - 2);
      ctx.lineTo(x, top + 8);
      ctx.stroke();
      ctx.fillStyle = C.caliper;
      const label = `F${i + 1}`;
      ctx.fillText(label, x - ctx.measureText(label).width / 2, top - 5);
    });
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Output spectrum and vocal tract transfer function" role="img" />;
}
