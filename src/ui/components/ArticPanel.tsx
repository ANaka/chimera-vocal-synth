import { useStore } from "../store.ts";
import { Slider } from "./Controls.tsx";

/** Precision controls for articulators that have no handle (or need exact values). */
export function ArticPanel() {
  const a = useStore((s) => s.artic);
  const set = useStore((s) => s.setArtic);
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const cm = (v: number) => `${v.toFixed(2)} cm`;
  return (
    <div className="panel artic-panel">
      <h2>Throat and mouth</h2>
      <Slider label="Lip rounding" value={1 - a.lipWidth} min={0} max={1} onChange={(v) => set({ lipWidth: 1 - v })} format={pct} />
      <Slider label="Lip opening" value={a.lipAp} min={-0.3} max={2.2} onChange={(v) => set({ lipAp: v })} format={cm} />
      <Slider label="Lip protrusion" value={a.lipProt} min={-0.1} max={1.4} onChange={(v) => set({ lipProt: v })} format={cm} />
      <Slider label="Jaw opening" value={a.jaw} min={0} max={2.4} onChange={(v) => set({ jaw: v })} format={cm} />
      <Slider label="Tongue root" value={a.root} min={-0.9} max={0.9} onChange={(v) => set({ root: v })} format={(v) => (v >= 0 ? `+${v.toFixed(2)} cm` : `${v.toFixed(2)} cm`)} />
      <Slider label="Tip curl" value={a.ttCurl} min={0} max={1} onChange={(v) => set({ ttCurl: v })} format={pct} />
      <Slider label="Soft palate opening" value={a.velum} min={-0.25} max={1.2} onChange={(v) => set({ velum: v })} format={(v) => (v <= 0 ? "Closed" : `${v.toFixed(2)} cm²`)} />
      <Slider label="Larynx height" value={a.larynx} min={-1.5} max={1.5} onChange={(v) => set({ larynx: v })} format={(v) => (v >= 0 ? `+${v.toFixed(2)} cm` : `${v.toFixed(2)} cm`)} />
      <Slider label="Twang (epilarynx)" value={a.epilarynx} min={0} max={1} onChange={(v) => set({ epilarynx: v })} format={pct} />
      <Slider label="False folds" value={a.ventricular} min={0} max={1} onChange={(v) => set({ ventricular: v })} format={pct} />
    </div>
  );
}
