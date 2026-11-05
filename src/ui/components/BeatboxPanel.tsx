import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { BEAT_SOUNDS, BEAT_PRESETS, formatBeat, parseBeat, type Airstream } from "../../engine/phonetics/beatbox.ts";
import { Slider, Toggle } from "./Controls.tsx";
import { Keys } from "./Keys.tsx";

const AIR: Record<Airstream, string> = {
  pulmonic: "Breath out",
  ejective: "Larynx piston",
  click: "Tongue suction",
  ingressive: "Breath in",
  voiced: "Voice",
};

const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const noteName = (m: number) => `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** Step under the playhead, polled from telemetry (re-renders only when it changes). */
export function useBeatStep(): number {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = engine.latest?.beatStep ?? -1;
      setStep((prev) => (prev === s ? prev : s));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return step;
}

function Pads() {
  const beatHit = useStore((s) => s.beatHit);
  const [lit, setLit] = useState<string | null>(null);
  const timer = useRef(0);
  const hit = (id: string) => {
    beatHit(id);
    setLit(id);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLit(null), 160);
  };
  const hitRef = useRef(hit);
  hitRef.current = hit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && (t as HTMLInputElement).type !== "range" && (t as HTMLInputElement).type !== "checkbox") return;
      const i = "1234567890".indexOf(e.key);
      if (i >= 0 && i < BEAT_SOUNDS.length) {
        hitRef.current(BEAT_SOUNDS[i].id);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="panel pads-panel">
      <h2>Sounds</h2>
      <div className="pads">
        {BEAT_SOUNDS.map((s, i) => (
          <button key={s.id} className={`pad pad-${s.role}${lit === s.id ? " lit" : ""}`} onPointerDown={() => hit(s.id)} title={s.hint} aria-label={`${s.name}: ${s.hint}. Key ${(i + 1) % 10}`}>
            <span className="pad-sym">{s.id}</span>
            <span className="pad-name">{s.name}</span>
            <span className="pad-air">{AIR[s.airstream]}</span>
            <span className="pad-key" aria-hidden="true">
              {(i + 1) % 10}
            </span>
          </button>
        ))}
      </div>
      <p className="dim">Pads play a sound as soon as the mouth can shape it, about a tenth of a second. Keys hum a bass note under the beat.</p>
    </div>
  );
}

function Sequencer() {
  const beat = useStore((s) => s.beat);
  const toggle = useStore((s) => s.toggleBeatStep);
  const setTempo = useStore((s) => s.setBeatTempo);
  const setPlaying = useStore((s) => s.setBeatPlaying);
  const setSteps = useStore((s) => s.setBeatSteps);
  const loadPreset = useStore((s) => s.loadBeatPreset);
  const mic = useStore((s) => s.mic);
  const setMic = useStore((s) => s.setMic);
  const now = useBeatStep();
  const [text, setText] = useState(() => formatBeat(beat.steps));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(formatBeat(beat.steps));
  }, [beat.steps]);
  const n = beat.steps.length;
  return (
    <div className="panel seq-panel">
      <div className="transport">
        <button className={`primary play${beat.playing ? " on" : ""}`} onClick={() => setPlaying(!beat.playing)} aria-pressed={beat.playing}>
          {beat.playing ? "Stop" : "Play beat"}
        </button>
        <div className="transport-sliders">
          <Slider label="Tempo" value={beat.bpm} min={60} max={180} onChange={(v) => setTempo({ bpm: Math.round(v) })} format={(v) => `${Math.round(v)} bpm`} />
          <Slider label="Swing" value={beat.swing} min={0} max={0.6} onChange={(v) => setTempo({ swing: v })} format={(v) => `${Math.round(v * 100)} %`} />
        </div>
        <Toggle label="Close mic" checked={mic} onChange={setMic} />
      </div>
      <div className="examples presets" role="group" aria-label="Example beats">
        {BEAT_PRESETS.map((p) => (
          <button key={p.name} className={`chip${beat.preset === p.name ? " on" : ""}`} onClick={() => loadPreset(p.name)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="seq-grid" style={{ "--steps": n } as React.CSSProperties} role="grid" aria-label="Beat pattern: one sound per step">
        {BEAT_SOUNDS.map((s) => (
          <div className="seq-row" role="row" key={s.id}>
            <span className="seq-label" role="rowheader">
              <b>{s.id}</b> {s.name}
            </span>
            {beat.steps.map((st, i) => {
              const on = st?.id === s.id;
              return (
                <button
                  key={i}
                  role="gridcell"
                  className={`cell${on ? " on" : ""}${i === now ? " now" : ""}${i % 4 === 0 ? " downbeat" : ""}`}
                  onClick={() => toggle(i, s.id)}
                  aria-pressed={on}
                  aria-label={`${s.name}, step ${i + 1}`}
                >
                  {on && s.id === "m" && st?.note !== undefined ? <span className="cell-note">{noteName(st.note)}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <label className="sbn">
        <span className="dim">Beat as text: B kick, t hat, Pf snare, K rimshot, ^K inward, ! click, m hum (m:43 sets its note), . rest</span>
        <input
          value={text}
          spellCheck={false}
          onFocus={() => (editing.current = true)}
          onBlur={() => {
            editing.current = false;
            setText(formatBeat(beat.steps));
          }}
          onChange={(e) => {
            setText(e.target.value);
            const steps = parseBeat(e.target.value);
            if (steps.length) setSteps(steps);
          }}
        />
      </label>
    </div>
  );
}

export function BeatboxPanel() {
  return (
    <>
      <section className="beatbox">
        <Pads />
        <Sequencer />
      </section>
      <footer className="keys-bar">
        <Keys />
      </footer>
    </>
  );
}

/** The symbol of the sound being made, large over the anatomy, fading after each hit. */
export function BeatOverlay() {
  const steps = useStore((s) => s.beat.steps);
  const playing = useStore((s) => s.beat.playing);
  const now = useBeatStep();
  const cell = now >= 0 ? steps[now] : null;
  if (!playing || !cell) return null;
  const s = BEAT_SOUNDS.find((x) => x.id === cell.id);
  return (
    <div className="beat-overlay" aria-hidden="true" key={now}>
      <span className="beat-sym">{cell.id}</span>
      <span className="beat-name">{s?.name}</span>
    </div>
  );
}
