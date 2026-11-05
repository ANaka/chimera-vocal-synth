import { memo } from "react";
import { useStore } from "../store.ts";
import { CREATURES, creatureById } from "../../wasm/engine.ts";
import type { CreatureDef } from "../../wasm/types.ts";
import { useLiveCreature } from "../creatureLive.ts";
import { Slider } from "./Controls.tsx";
import { Keys } from "./Keys.tsx";

/** Scout-image thumbnail: the creature's outline with its airway traced in black. */
const Thumb = memo(function Thumb({ def }: { def: CreatureDef }) {
  const v = def.visual;
  const vw = v.view.x1 - v.view.x0, vh = v.view.y1 - v.view.y0;
  const pad = Math.max(vw, vh) * 0.06;
  const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${-y}`).join(" ");
  return (
    <svg className="thumb" viewBox={`${v.view.x0 - pad} ${-v.view.y1 - pad} ${vw + 2 * pad} ${vh + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <polygon points={pts(v.silhouette)} fill="#8a8a8a" stroke="#bdbdbd" strokeWidth={Math.max(vw, vh) * 0.012} strokeLinejoin="round" />
      {v.tubes.map((t) => (
        <polyline key={t.tube} points={pts(t.path)} fill="none" stroke="#000" strokeWidth={Math.max(vw, vh) * 0.022} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
});

function Gallery() {
  const creature = useStore((s) => s.creature);
  const setCreature = useStore((s) => s.setCreature);
  return (
    <div className="panel gallery">
      <h2>Creatures</h2>
      <div className="specimens">
        {CREATURES.map((c) => (
          <button key={c.id} className={`specimen${c.id === creature ? " on" : ""}`} onClick={() => setCreature(c.id)} aria-pressed={c.id === creature}>
            <Thumb def={c} />
            <span className="specimen-name">{c.name}</span>
            <span className="specimen-latin">{c.latin}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Calls({ def }: { def: CreatureDef }) {
  const playCall = useStore((s) => s.playCall);
  const hold = useStore((s) => s.hold);
  const setHold = useStore((s) => s.setHold);
  const keyCall = useStore((s) => s.keyCall);
  const setKeyCall = useStore((s) => s.setKeyCall);
  const live = useLiveCreature(def.id);
  return (
    <div className="panel calls-panel">
      <h2>Calls</h2>
      <div className="calls">
        {def.calls.map((c) => (
          <button key={c.id} className={`call${live?.call === c.id ? " playing" : ""}`} onClick={() => playCall(c.id)}>
            <span className="call-name">{c.name}</span>
            <span className="call-hint">{c.hint}</span>
          </button>
        ))}
        <button className={`call sustain${hold ? " on" : ""}`} onClick={() => setHold(!hold)} aria-pressed={hold}>
          <span className="call-name">{hold ? "Stop sustaining" : "Sustain"}</span>
          <span className="call-hint">Keep the breath on and shape the sound with the sliders</span>
        </button>
      </div>
      <div className="keys-mode" role="radiogroup" aria-label="What the keys play">
        <span className="dim">Keys play</span>
        <button role="radio" aria-checked={keyCall === null} className={`chip${keyCall === null ? " on" : ""}`} onClick={() => setKeyCall(null)}>
          Held voice
        </button>
        {def.calls.map((c) => (
          <button key={c.id} role="radio" aria-checked={keyCall === c.id} className={`chip${keyCall === c.id ? " on" : ""}`} onClick={() => setKeyCall(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function fmt(v: number, p: CreatureDef["params"][number]): string {
  const digits = p.digits ?? (p.max - p.min <= 2 ? 2 : v < 100 && p.log ? 1 : 0);
  return `${v.toFixed(digits)}${p.unit ? " " + p.unit : ""}`;
}

function Params({ def }: { def: CreatureDef }) {
  const cparams = useStore((s) => s.cparams[def.id]);
  const setCParam = useStore((s) => s.setCParam);
  const live = useLiveCreature(def.id);
  // while a call plays, the sliders follow its automation; afterwards they return to yours
  const calling = !!live?.call;
  return (
    <div className="panel creature-params">
      <h2>{def.name}</h2>
      <p className="creature-role">{def.role}</p>
      <p className="creature-blurb">{def.blurb}</p>
      <div className="creature-sliders">
        {def.params.map((p) => {
          const mine = cparams?.[p.key] ?? p.default;
          const value = calling ? (live!.params[p.key] ?? mine) : mine;
          return <Slider key={p.key} label={p.label} value={value} min={p.min} max={p.max} log={p.log} onChange={(v) => setCParam(p.key, v)} format={(v) => fmt(v, p)} />;
        })}
      </div>
    </div>
  );
}

export function BestiaryPanel() {
  const creature = useStore((s) => s.creature);
  const def = creatureById(creature);
  return (
    <>
      <section className="bestiary">
        <Gallery />
        {def && <Calls def={def} />}
        {def && <Params def={def} />}
      </section>
      <footer className="keys-bar">
        <Keys />
      </footer>
    </>
  );
}
