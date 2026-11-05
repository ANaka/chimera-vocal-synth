import { useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { useStore } from "../store.ts";
import { creatureById } from "../../engine/creatures/index.ts";
import type { CreatureDef } from "../../engine/creatures/types.ts";
import { liveTelemetry, previewTelemetry } from "../creatureLive.ts";
import { C, hot, pressureLevel } from "../colors.ts";

type P = [number, number];

/** Catmull-Rom through the points; closed shapes wrap around. */
function smooth(pts: P[], per: number, closed: boolean): P[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: P[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

interface TubeGeom {
  tube: string;
  label?: string;
  inView: boolean;
  pts: P[];
  cum: number[];
  length: number;
}

interface Geom {
  silhouette: P[];
  parts: { shade: number; pts: P[] }[];
  tubes: TubeGeom[];
}

const geoms = new Map<string, Geom>();
function geometry(def: CreatureDef): Geom {
  let g = geoms.get(def.id);
  if (g) return g;
  const v = def.visual;
  g = {
    silhouette: smooth(v.silhouette, 8, true),
    parts: (v.parts ?? []).map((p) => ({ shade: p.shade, pts: smooth(p.pts, 6, true) })),
    tubes: v.tubes.map((t) => {
      const pts = smooth(t.path, 6, false);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { tube: t.tube, label: t.label, inView: t.inView !== false, pts, cum, length: cum[cum.length - 1] };
    }),
  };
  geoms.set(def.id, g);
  return g;
}

function pointAt(t: TubeGeom, s: number): P {
  let i = 1;
  while (i < t.cum.length - 1 && t.cum[i] < s) i++;
  const u = Math.max(0, Math.min(1, (s - t.cum[i - 1]) / Math.max(1e-9, t.cum[i] - t.cum[i - 1])));
  return [t.pts[i - 1][0] + (t.pts[i][0] - t.pts[i - 1][0]) * u, t.pts[i - 1][1] + (t.pts[i][1] - t.pts[i - 1][1]) * u];
}

/**
 * Creature cross-section in the same visual language as the human MRI view: tissue silhouette,
 * black airway channels whose width follows the simulated cross-section, acoustic pressure in
 * the hot scale, and source glyphs whose ripples follow the vibration.
 */
export function CreatureView() {
  const grainRef = useRef<CanvasPattern | null>(null);
  const glyph = useRef<{ peak: Record<string, number>; phase: Record<string, number> }>({ peak: {}, phase: {} });
  const ref = useCanvasLoop(({ ctx, w, h, dt }) => {
    const st = useStore.getState();
    const def = creatureById(st.creature);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (!def) return;
    const vis = def.visual;
    const geo = geometry(def);
    const live = liveTelemetry(def.id);
    const tele = live ?? previewTelemetry(def, st.cparams[def.id]);
    const vw = vis.view.x1 - vis.view.x0, vh = vis.view.y1 - vis.view.y0;
    const sc = Math.min((w * 0.84) / vw, (h * 0.7) / vh);
    const ox = w / 2 - ((vis.view.x0 + vis.view.x1) / 2) * sc;
    const oy = h * 0.53 + ((vis.view.y0 + vis.view.y1) / 2) * sc;
    const X = (x: number) => ox + x * sc;
    const Y = (y: number) => oy - y * sc;
    if (!grainRef.current) {
      const g = document.createElement("canvas");
      g.width = g.height = 160;
      const gc = g.getContext("2d")!;
      const img = gc.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      gc.putImageData(img, 0, 0);
      grainRef.current = ctx.createPattern(g, "repeat");
    }
    const path = (pts: P[]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.closePath();
    };
    // tissue: bright subcutaneous fat rim around darker muscle, T1-like
    const span = Math.min(vw * sc, vh * sc * 2.5);
    ctx.save();
    path(geo.silhouette);
    ctx.clip();
    ctx.fillStyle = C.muscle;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.strokeStyle = C.fat;
    ctx.lineWidth = Math.max(5, span * 0.018);
    ctx.stroke();
    ctx.strokeStyle = C.skin;
    ctx.lineWidth = Math.max(2, span * 0.006);
    ctx.stroke();
    for (const part of geo.parts) {
      path(part.pts);
      const v = Math.round(part.shade * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fill();
    }
    if (grainRef.current) {
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = grainRef.current;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
    // airway channels: drawn wider than life so narrow tubes stay legible
    const exaggerate = vis.tubeScale ?? 1.6;
    ctx.lineCap = "round";
    const labels: { text: string; x: number; y: number }[] = [];
    for (const tg of geo.tubes) {
      const data = tele.tubes[tg.tube];
      if (!data) continue;
      const n = data.areas.length;
      const width = (k: number) => 2 * Math.sqrt(Math.max(0, data.areas[k]) / Math.PI) * exaggerate * sc;
      // walls first (mucosa), then lumen, then pressure
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 0; k < n; k++) {
          const a = pointAt(tg, (k / n) * tg.length), b = pointAt(tg, ((k + 1) / n) * tg.length);
          const d = width(k);
          ctx.beginPath();
          ctx.moveTo(X(a[0]), Y(a[1]));
          ctx.lineTo(X(b[0]), Y(b[1]));
          if (pass === 0) {
            ctx.strokeStyle = C.mucosa;
            ctx.lineWidth = d + 3;
          } else if (pass === 1) {
            ctx.strokeStyle = "#000";
            ctx.lineWidth = Math.max(1.5, d);
          } else {
            if (!live || !st.view.pressure) break;
            const lvl = pressureLevel(data.rms[k] * 0.6);
            if (lvl < 0.02) continue;
            const [r, g, bb] = hot(lvl);
            ctx.strokeStyle = `rgba(${r | 0},${g | 0},${bb | 0},${0.5 + 0.5 * lvl})`;
            ctx.lineWidth = Math.max(1.2, d - 1);
          }
          ctx.stroke();
        }
      }
      if (tg.label && tg.inView) {
        const m = pointAt(tg, tg.length * 0.5);
        labels.push({ text: tg.label, x: X(m[0]) + 10, y: Y(m[1]) - 10 });
      }
    }
    // source glyphs: a ring sized by the vibration envelope, ripples paced by the pitch
    const pp = def.params.find((p) => p.role === "pitch");
    const pitch = pp ? (live ? live.params[pp.key] : (st.cparams[def.id]?.[pp.key] ?? pp.default)) : 200;
    const rate = 1.2 + 4.8 * Math.max(0, Math.min(1, Math.log(pitch / 10) / Math.log(900)));
    for (const s of vis.sources ?? []) {
      const raw = Math.max(0, Math.min(1, live?.source[s.key] ?? 0));
      const pk = Math.max(raw, (glyph.current.peak[s.key] ?? 0) * Math.exp(-dt / 0.18));
      glyph.current.peak[s.key] = pk;
      const ph = ((glyph.current.phase[s.key] ?? 0) + dt * rate) % 1;
      glyph.current.phase[s.key] = ph;
      const x = X(s.at[0]), y = Y(s.at[1]);
      const r0 = 3.5 + 6 * pk;
      if (pk > 0.04) {
        for (let j = 0; j < 3; j++) {
          const u = (ph + j / 3) % 1;
          ctx.beginPath();
          ctx.arc(x, y, r0 + u * 24, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(242,207,91,${(1 - u) * Math.min(1, pk * 1.3) * 0.7})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.arc(x, y, r0, 0, Math.PI * 2);
      ctx.strokeStyle = C.caliper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = C.caliper;
      ctx.fill();
      labels.push({ text: s.label, x: x + 14, y: y + 18 });
    }
    if (st.view.calipers) {
      // place labels, nudging down past any earlier label they would overlap
      ctx.font = font(11.5);
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (const l of labels) {
        const tw = ctx.measureText(l.text).width;
        const x = Math.min(w - tw - 6, l.x);
        let y = l.y;
        for (let guard = 0; guard < 8; guard++) {
          const hit = placed.find((r) => x < r.x1 + 4 && x + tw > r.x0 - 4 && y - 11 < r.y1 && y + 2 > r.y0);
          if (!hit) break;
          y = hit.y1 + 12;
        }
        placed.push({ x0: x, x1: x + tw, y0: y - 11, y1: y + 2 });
        const isSource = (vis.sources ?? []).some((s) => s.label === l.text);
        ctx.lineJoin = "round";
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(l.text, x, y);
        ctx.fillStyle = isSource ? C.caliper : "rgba(232,234,235,0.82)";
        ctx.fillText(l.text, x, y);
      }
    }
    // corner overlays
    ctx.font = font(14, 600, 112);
    ctx.fillStyle = "rgba(232,234,235,0.9)";
    ctx.fillText(def.name, 14, 26);
    ctx.font = `italic ${font(12.5)}`;
    ctx.fillStyle = C.textDim;
    ctx.fillText(def.latin, 14, 44);
    ctx.textAlign = "right";
    ctx.font = font(12.5);
    ctx.fillStyle = "rgba(232,234,235,0.85)";
    if (pp) ctx.fillText(`${pitch.toFixed(pp.digits ?? (pitch < 100 ? 1 : 0))} ${pp.unit ?? ""}`.trim(), w - 14, 26);
    const state = live ? (live.call ? (def.calls.find((c) => c.id === live.call)?.name ?? live.call) : live.gate > 0.05 ? "Sustaining" : "At rest") : "Not started";
    ctx.fillStyle = C.textDim;
    ctx.fillText(state, w - 14, 44);
    ctx.textAlign = "left";
  });
  return <canvas ref={ref} className="creature-canvas" aria-label="Creature airway cross-section" role="img" />;
}
