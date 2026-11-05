import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { C, hot } from "../colors.ts";

const FMIN = 15, FMAX = 16000;
const SPEED = 64; // px per second
const DB_LO = -100, DB_HI = -30;

/** Scrolling spectrogram of the output on a log-frequency axis, energy in the hot scale. */
export function Spectrogram() {
  const st = useRef<{ off: HTMLCanvasElement | null; bins: Float32Array | null; rows: Int32Array | null; acc: number }>({ off: null, bins: null, rows: null, acc: 0 });
  const ref = useCanvasLoop(({ ctx, w, h, dt }) => {
    const s = st.current;
    const axisW = 30;
    const pw = Math.max(1, Math.floor(w - axisW)), ph = Math.max(1, Math.floor(h - 4));
    if (!s.off || s.off.width !== pw || s.off.height !== ph) {
      s.off = document.createElement("canvas");
      s.off.width = pw;
      s.off.height = ph;
      const oc = s.off.getContext("2d")!;
      oc.fillStyle = "#000";
      oc.fillRect(0, 0, pw, ph);
      s.rows = null;
    }
    const oc = s.off.getContext("2d")!;
    const an = engine.analyserFast;
    s.acc += dt * SPEED;
    const cols = Math.min(pw, Math.floor(s.acc));
    s.acc -= cols;
    if (cols > 0) {
      oc.drawImage(s.off, -cols, 0);
      const img = oc.createImageData(cols, ph);
      if (an && useStore.getState().started) {
        const n = an.frequencyBinCount;
        if (!s.bins || s.bins.length !== n) s.bins = new Float32Array(n);
        an.getFloatFrequencyData(s.bins as Float32Array<ArrayBuffer>);
        const binHz = engine.sampleRate / an.fftSize;
        if (!s.rows || s.rows.length !== ph * 2) {
          // bin range covered by each pixel row (top = high frequencies)
          s.rows = new Int32Array(ph * 2);
          for (let y = 0; y < ph; y++) {
            const fHi = FMAX * Math.pow(FMIN / FMAX, y / ph), fLo = FMAX * Math.pow(FMIN / FMAX, (y + 1) / ph);
            const k0 = Math.max(1, Math.floor(fLo / binHz)), k1 = Math.min(n - 1, Math.max(k0, Math.ceil(fHi / binHz)));
            s.rows[2 * y] = k0;
            s.rows[2 * y + 1] = k1;
          }
        }
        const b = s.bins, rows = s.rows;
        for (let y = 0; y < ph; y++) {
          let db = -Infinity;
          for (let k = rows[2 * y]; k <= rows[2 * y + 1]; k++) if (b[k] > db) db = b[k];
          const u = (db - DB_LO) / (DB_HI - DB_LO);
          const [r, g, bl] = hot(u > 0 ? Math.pow(u, 1.5) : 0);
          for (let x = 0; x < cols; x++) {
            const i = (y * cols + x) * 4;
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = bl;
            img.data[i + 3] = 255;
          }
        }
      } else for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      oc.putImageData(img, pw - cols, 0);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(s.off, 0, 2);
    // frequency axis
    ctx.font = font(10.5);
    ctx.fillStyle = C.textDim;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    const fy = (f: number) => 2 + (Math.log(FMAX / f) / Math.log(FMAX / FMIN)) * ph;
    for (const [f, label] of [[20, "20"], [100, "100"], [1000, "1k"], [10000, "10k"]] as const) {
      const y = fy(f);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(pw, y);
      ctx.stroke();
      ctx.fillText(label, pw + 5, Math.min(h - 2, Math.max(10, y + 4)));
    }
  });
  return <canvas ref={ref} className="instrument-canvas" aria-label="Spectrogram of the output" role="img" />;
}
