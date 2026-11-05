import { useStore } from "../store.ts";
import { Slider, Toggle } from "./Controls.tsx";

const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const noteName = (f: number) => {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
};

export function VoicePanel() {
  const s = useStore((st) => st.source);
  const set = useStore((st) => st.setSource);
  const hold = useStore((st) => st.hold);
  const setHold = useStore((st) => st.setHold);
  return (
    <div className="panel voice-panel">
      <h2>Voice</h2>
      <Slider label="Pitch" value={s.f0} min={40} max={1100} log onChange={(v) => set({ f0: v })} format={(v) => `${v.toFixed(0)} Hz, ${noteName(v)}`} />
      <Slider label="Breath pressure" value={s.pressure} min={2} max={22} onChange={(v) => set({ pressure: v })} format={(v) => `${v.toFixed(1)} cmH₂O`} />
      <Slider label="Breathiness" value={s.breathiness} min={0} max={1} onChange={(v) => set({ breathiness: v })} format={(v) => `${Math.round(v * 100)} %`} />
      <Slider label="Lax to pressed" value={s.tension} min={0} max={1} onChange={(v) => set({ tension: v })} format={(v) => `${Math.round(v * 100)} %`} />
      <Slider label="Roughness" value={s.roughness} min={0} max={1} onChange={(v) => set({ roughness: v })} format={(v) => `${Math.round(v * 100)} %`} />
      <Slider label="Vocal fry" value={s.fry} min={0} max={1} onChange={(v) => set({ fry: v })} format={(v) => `${Math.round(v * 100)} %`} />
      <Slider label="Vibrato" value={s.vibratoDepth} min={0} max={120} onChange={(v) => set({ vibratoDepth: v })} format={(v) => `${v.toFixed(0)} cents`} />
      <Slider label="Glide" value={s.glide} min={0.005} max={0.6} log onChange={(v) => set({ glide: v })} format={(v) => `${(v * 1000).toFixed(0)} ms`} />
      <div className="row">
        <Toggle label="Hold breath" checked={hold} onChange={setHold} />
        <Toggle label="Whisper" checked={!s.voiced} onChange={(v) => set({ voiced: !v })} />
      </div>
    </div>
  );
}
