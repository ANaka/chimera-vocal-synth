import { useEffect, useRef, useState } from "react";
import { AnatomyRenderer, type HandleId } from "../render/anatomy.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { VoiceModel } from "../analysis.ts";
import { useModel } from "../useModel.ts";
import type { HumanArtic } from "../../wasm/types.ts";

const BODY_LABEL = { male: "Human, adult male", female: "Human, adult female", child: "Human, child" } as const;

export function AnatomyView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const model = useModel();
  const [hover, setHover] = useState<HandleId | null>(null);
  const dragRef = useRef<{ id: HandleId; start: { x: number; y: number }; artic: HumanArtic } | null>(null);
  const hoverRef = useRef<HandleId | null>(null);
  hoverRef.current = hover;
  const rendererRef = useRef<AnatomyRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const r = new AnatomyRenderer(canvas);
    rendererRef.current = r;
    const ro = new ResizeObserver(() => {
      const b = wrap.getBoundingClientRect();
      r.resize(b.width, b.height, Math.min(2, window.devicePixelRatio || 1));
    });
    ro.observe(wrap);
    let raf = 0;
    let last = performance.now();
    let fTick = 0;
    let formants: number[] = [];
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = useStore.getState();
      const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
      const a = tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic;
      const m = model.current;
      if (m) {
        const f = m.frame(a);
        if (++fTick % 4 === 0 || formants.length === 0) formants = m.transfer(a).formants;
        r.draw(m, f, a, tele, st.view, { hover: hoverRef.current, drag: dragRef.current?.id ?? null, dt, bodyLabel: BODY_LABEL[st.body], formants });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [model]);

  const pick = (e: React.PointerEvent): HandleId | null => {
    const r = rendererRef.current;
    const m = model.current;
    if (!r || !m) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    const p = r.toBody(e.clientX - rect.left, e.clientY - rect.top);
    const st = useStore.getState();
    const tele = engine.latest && engine.latest.body === st.body ? engine.latest : null;
    const a = tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic;
    const f = m.frame(a);
    let best: HandleId | null = null;
    let bd = 22 / r.pxPerCm; // 22 px hit radius
    for (const h of r.handles(m, f, a)) {
      const d = Math.hypot(h.pos.x - p.x, h.pos.y - p.y);
      if (d < bd) {
        bd = d;
        best = h.id;
      }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent) => {
    const id = pick(e);
    if (!id) return;
    const r = rendererRef.current!;
    const rect = canvasRef.current!.getBoundingClientRect();
    const p = r.toBody(e.clientX - rect.left, e.clientY - rect.top);
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { id, start: p, artic: { ...useStore.getState().artic } };
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const r = rendererRef.current;
    const m = model.current;
    if (!d) {
      const id = pick(e);
      if (id !== hover) setHover(id);
      return;
    }
    if (!r || !m) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const p = r.toBody(e.clientX - rect.left, e.clientY - rect.top);
    const t = m.tract;
    const k = t.scale;
    const dx = (p.x - d.start.x) / k;
    const dy = (p.y - d.start.y) / k;
    const set = useStore.getState().setArtic;
    const a0 = d.artic;
    switch (d.id) {
      case "tongue": {
        const q = t.unP(p.x, p.y);
        set({ tbX: q.x, tbY: q.y });
        break;
      }
      case "tip": {
        const q = t.unP(p.x, p.y);
        set({ ttX: q.x, ttY: q.y }, false);
        break;
      }
      case "jaw":
        set({ jaw: clamp(a0.jaw - dy, -0.1, 2.6) });
        break;
      case "lips":
        if (e.shiftKey) set({ lipWidth: clamp(a0.lipWidth + dx * 0.6, 0, 1) });
        else set({ lipAp: clamp(a0.lipAp - dy * 1.2, -0.4, 2.4), lipProt: clamp(a0.lipProt + dx, -0.2, 1.5) });
        break;
      case "velum":
        set({ velum: clamp(a0.velum - dy * 0.9, 0, 1.4) });
        break;
      case "larynx":
        set({ larynx: clamp(a0.larynx + dy, -1.6, 1.6) });
        break;
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (dragRef.current) (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const onDouble = (e: React.MouseEvent) => {
    const id = pick(e as unknown as React.PointerEvent);
    if (id === "tip") useStore.getState().setArtic({}, true);
  };

  return (
    <div ref={wrapRef} className="anatomy" data-hover={hover ?? undefined}>
      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDouble}
        aria-label="Vocal tract cross-section. Drag the tongue, tongue tip, jaw, lips, soft palate or larynx handles."
        role="img"
      />
    </div>
  );
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
