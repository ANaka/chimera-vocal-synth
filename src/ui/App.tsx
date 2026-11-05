import { useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { engine } from "../audio/AudioEngine.ts";
import { AnatomyView } from "./components/AnatomyView.tsx";
import { TubeView } from "./components/TubeView.tsx";
import { Stroboscope } from "./components/Stroboscope.tsx";
import { SpectrumView } from "./components/SpectrumView.tsx";
import { VowelMap } from "./components/VowelMap.tsx";
import { VoicePanel } from "./components/VoicePanel.tsx";
import { ArticPanel } from "./components/ArticPanel.tsx";
import { Keys } from "./components/Keys.tsx";
import { Segmented, Toggle } from "./components/Controls.tsx";
import { SpeakPanel } from "./components/SpeakPanel.tsx";
import type { Mode } from "./store.ts";
import type { BodyName } from "../worklet/protocol.ts";

function TopBar() {
  const started = useStore((s) => s.started);
  const starting = useStore((s) => s.starting);
  const start = useStore((s) => s.start);
  const body = useStore((s) => s.body);
  const setBody = useStore((s) => s.setBody);
  const volume = useStore((s) => s.volume);
  const setVolume = useStore((s) => s.setVolume);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const [load, setLoad] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLoad(engine.latest?.load ?? 0), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="wordmark">Chimera</span>
        <span className="tagline">A voice grown from a simulated airway</span>
      </div>
      <Segmented<Mode>
        label="Mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: "play", label: "Play" },
          { value: "speak", label: "Speak" },
        ]}
      />
      <Segmented<BodyName>
        label="Body"
        value={body}
        onChange={setBody}
        options={[
          { value: "male", label: "Adult male" },
          { value: "female", label: "Adult female" },
          { value: "child", label: "Child" },
        ]}
      />
      <div className="topbar-right">
        <label className="volume">
          <span>Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} style={{ "--pos": `${volume * 100}%` } as React.CSSProperties} />
        </label>
        {started ? (
          <span className="load" title="Share of the audio thread's time budget used by the simulation">
            Engine load {Math.round(load * 100)} %
          </span>
        ) : (
          <button className="primary" onClick={() => void start()} disabled={starting}>
            {starting ? "Starting…" : "Start audio"}
          </button>
        )}
      </div>
    </header>
  );
}

function ViewToggles() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <div className="view-toggles">
      <Toggle label="Sound pressure" checked={view.pressure} onChange={(v) => setView({ pressure: v })} />
      <Toggle label="Airflow" checked={view.particles} onChange={(v) => setView({ particles: v })} />
      <Toggle label="Measurements" checked={view.calipers} onChange={(v) => setView({ calipers: v })} />
      <Toggle label="Grid" checked={view.grid} onChange={(v) => setView({ grid: v })} />
    </div>
  );
}

function StartPrompt() {
  const started = useStore((s) => s.started);
  const starting = useStore((s) => s.starting);
  const err = useStore((s) => s.startError);
  const start = useStore((s) => s.start);
  const setHold = useStore((s) => s.setHold);
  if (started) return null;
  return (
    <div className="start-prompt">
      <p>Every sound here is produced by simulating air moving through a throat, mouth and nose.</p>
      <button
        className="primary large"
        disabled={starting}
        onClick={async () => {
          await start();
          setHold(true);
        }}
      >
        {starting ? "Starting…" : "Breathe in and start"}
      </button>
      {err ? <p className="error">Audio could not start: {err}. Reload the page and try again.</p> : <p className="hint">Then drag the tongue, lips or jaw, or play the keys.</p>}
    </div>
  );
}

function Deck() {
  const mode = useStore((s) => s.mode);
  if (mode === "speak") return <SpeakPanel />;
  return (
    <>
      <section className="deck">
        <div className="panel vowel-panel">
          <h2>Vowels</h2>
          <VowelMap />
        </div>
        <VoicePanel />
        <ArticPanel />
      </section>
      <footer className="keys-bar">
        <Keys />
      </footer>
    </>
  );
}

export function App() {
  return (
    <div className="app">
      <TopBar />
      <main className="stage">
        <section className="viewport" aria-label="Live vocal tract">
          <AnatomyView />
          <StartPrompt />
          <ViewToggles />
        </section>
        <aside className="instruments">
          <figure className="instrument">
            <figcaption>Tube, glottis to lips</figcaption>
            <TubeView />
          </figure>
          <figure className="instrument">
            <figcaption>Vocal folds, slowed down</figcaption>
            <Stroboscope />
          </figure>
          <figure className="instrument">
            <figcaption>Spectrum and resonances</figcaption>
            <SpectrumView />
          </figure>
        </aside>
      </main>
      <Deck />
    </div>
  );
}
