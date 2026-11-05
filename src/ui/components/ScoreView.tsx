import { useEffect, useRef } from "react";
import { useCanvasLoop, font } from "../useCanvas.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { currentPlan, onPlan, type SpokenPlan } from "../speech.ts";
import { activation, type Gesture } from "../../wasm/engine.ts";
import { C } from "../colors.ts";

const ROWS: { name: string; keys: string[] }[] = [
  { name: "Lips", keys: ["lipAp", "lipProt", "lipWidth", "labiodental"] },
  { name: "Tongue tip", keys: ["ttX", "ttY", "ttCurl", "lateral"] },
  { name: "Tongue body", keys: ["tbX", "tbY", "root"] },
  { name: "Soft palate", keys: ["velum"] },
  { name: "Glottis", keys: ["abduction", "closure"] },
];

function rowOf(g: Gesture): number {
  const keys = Object.keys(g.targets);
  // vowel gestures touch body + lips; draw them on the body row
  if (keys.includes("tbX") && keys.includes("lipAp") && keys.length > 4) return 2;
  // tip-driven segments that also round the lips (/ɹ ʃ/) belong to the tongue-tip row
  if (keys.includes("ttX") || keys.includes("ttCurl")) return 1;
  for (let r = 0; r < ROWS.length; r++) if (keys.some((k) => ROWS[r].keys.includes(k))) return r;
  return -1;
}

/** Gestural score of the current utterance (Articulatory Phonology), with live playhead. */
export function ScoreView() {
  const planRef = useRef<SpokenPlan | null>(currentPlan());
  useEffect(() => onPlan((p) => (planRef.current = p)), []);
  const ref = useCanvasLoop(({ ctx, w, h }) => {
    ctx.clearRect(0, 0, w, h);
    const sp = planRef.current;
    const left = 92, right = w - 8, top = 8, bottom = h - 30;
    const rowH = (bottom - top) / (ROWS.length + 1);
    ctx.font = font(12);
    ctx.fillStyle = C.textDim;
    ROWS.forEach((r, i) => ctx.fillText(r.name, 4, top + rowH * (i + 0.62)));
    ctx.fillText("Pitch", 4, top + rowH * (ROWS.length + 0.62));
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (let i = 0; i <= ROWS.length + 1; i++) {
      ctx.beginPath();
      ctx.moveTo(left, top + rowH * i);
      ctx.lineTo(right, top + rowH * i);
      ctx.stroke();
    }
    if (!sp) {
      ctx.fillStyle = C.textDim;
      ctx.fillText("Speak something to see its gestures: which articulator moves, when, and how they overlap.", left, h / 2);
      return;
    }
    const plan = sp.plan;
    const T0 = -0.05, T1 = plan.end + 0.15;
    const X = (t: number) => left + ((t - T0) / (T1 - T0)) * (right - left);
    const tele = engine.latest;
    const now = sp.offset !== null && tele ? tele.t.clock - sp.offset : -1;
    // gestures
    const f0s: { t: number; f: number }[] = [];
    for (const g of plan.gestures) {
      if (g.targets.f0 !== undefined) {
        f0s.push({ t: (g.t0 + g.t1) / 2, f: g.targets.f0 });
        continue;
      }
      const r = rowOf(g);
      if (r < 0) continue;
      const x0 = X(g.t0 - g.rampIn), x1 = X(g.t1 + g.rampOut);
      const xa = X(g.t0), xb = X(g.t1);
      const y = top + rowH * r + rowH * 0.18, hh = rowH * 0.64;
      const isVowel = r === 2 && Object.keys(g.targets).length > 4;
      const active = now >= g.t0 - g.rampIn && now <= g.t1 + g.rampOut ? activation(g, now) : 0;
      const base = isVowel ? "154,163,168" : "242,207,91";
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      const a = isVowel ? 0.28 : 0.5;
      grad.addColorStop(0, `rgba(${base},0)`);
      grad.addColorStop(Math.max(0, Math.min(1, (xa - x0) / Math.max(1, x1 - x0))), `rgba(${base},${a})`);
      grad.addColorStop(Math.max(0, Math.min(1, (xb - x0) / Math.max(1, x1 - x0))), `rgba(${base},${a})`);
      grad.addColorStop(1, `rgba(${base},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x0, y, Math.max(2, x1 - x0), hh, 4);
      ctx.fill();
      if (active > 0.05) {
        ctx.strokeStyle = `rgba(${base},${0.5 + 0.5 * active})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (g.label && (xb - xa > 12 || !isVowel)) {
        ctx.fillStyle = isVowel ? "rgba(232,234,235,0.85)" : "#1d1a10";
        ctx.font = font(12, 600);
        const lbl = g.label === "aspiration" || g.label === "voiceless" ? "open" : g.label === "velum" ? "lowered" : g.label;
        ctx.fillText(lbl, Math.max(x0 + 3, xa + 2), y + hh * 0.7);
      }
    }
    // pitch contour
    if (f0s.length) {
      f0s.sort((p, q) => p.t - q.t);
      const fmin = Math.min(...f0s.map((p) => p.f)) * 0.9, fmax = Math.max(...f0s.map((p) => p.f)) * 1.1;
      const yb = top + rowH * ROWS.length + rowH * 0.9, ya = top + rowH * ROWS.length + rowH * 0.1;
      ctx.beginPath();
      f0s.forEach((p, i) => {
        const x = X(p.t), y = yb - ((p.f - fmin) / Math.max(1, fmax - fmin)) * (yb - ya);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = "rgba(232,234,235,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // segment labels along the bottom
    ctx.font = font(13, 500);
    ctx.fillStyle = "rgba(232,234,235,0.9)";
    for (const s of plan.segments) {
      const x = X((s.t0 + s.t1) / 2);
      const tw = ctx.measureText(s.ipa).width;
      ctx.fillText(s.ipa, x - tw / 2, h - 10);
    }
    // playhead
    if (now >= T0 && now <= T1) {
      ctx.strokeStyle = C.caliper;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(now), top);
      ctx.lineTo(X(now), h - 24);
      ctx.stroke();
    }
  });
  return <canvas ref={ref} className="score-canvas" aria-label="Gestural score of the current utterance" role="img" />;
}
