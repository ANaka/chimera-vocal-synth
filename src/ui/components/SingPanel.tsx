import { useStore } from "../store.ts";
import { useSing, playDemo, stopSinging, DEMO_SONGS } from "../singing.ts";
import { Slider, Toggle } from "./Controls.tsx";
import { Keys } from "./Keys.tsx";
import { PianoRoll } from "./PianoRoll.tsx";

/** epilarynx narrowing for the singer's ring (measured: +3 to +12 dB at 2.4–3.6 kHz, adult male) */
const RING = 0.85;

function Lyrics() {
  const lyrics = useSing((s) => s.lyrics);
  const syllables = useSing((s) => s.syllables);
  const cursor = useSing((s) => s.cursor);
  const demo = useSing((s) => s.demo);
  const demoAt = useSing((s) => s.demoAt);
  const setLyrics = useSing((s) => s.setLyrics);
  const setCursor = useSing((s) => s.setCursor);
  const at = demo ? demoAt : -1;
  return (
    <div className="panel lyrics-panel">
      <h2>Lyrics</h2>
      <textarea
        value={lyrics}
        onChange={(e) => setLyrics(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        rows={2}
        aria-label="Lyrics to sing"
        placeholder="Type the words to sing"
      />
      <div className="syllables" role="group" aria-label="Syllables. Each note sings the marked one; choose another to start there.">
        {syllables.map((s, i) => (
          <span key={i} className={`syl-wrap${s.wordEnd ? " word-end" : ""}`}>
            <button
              className={`syl${!demo && i === cursor ? " next" : ""}${i === at ? " now" : ""}${s.melisma ? " held" : ""}`}
              onClick={() => setCursor(i)}
              aria-current={!demo && i === cursor ? "step" : undefined}
              title={s.melisma ? "Held vowel: carries the previous syllable onto this note" : `Sing from “${s.text}”`}
            >
              {s.text}
            </button>
            {s.phraseEnd && (
              <span className="breath-mark" aria-label="breath">
                ’
              </span>
            )}
          </span>
        ))}
        {!syllables.length && <span className="dim">No words: the keys sing “ah”.</span>}
      </div>
      <div className="row">
        <button className="ghost" onClick={() => setCursor(0)} disabled={cursor === 0 && !demo}>
          Back to the first syllable
        </button>
      </div>
      <p className="dim">
        Each note sings the next syllable. Hold a key while you press the next one to sing legato. A lone “-” between words holds a vowel over several notes; hyphens split a word your way (“ti-ger”).
      </p>
    </div>
  );
}

function SongAndVoice() {
  const body = useStore((s) => s.body);
  const start = useStore((s) => s.start);
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const epilarynx = useStore((s) => s.artic.epilarynx);
  const setArtic = useStore((s) => s.setArtic);
  const demo = useSing((s) => s.demo);
  const vibrato = useSing((s) => s.vibrato);
  const setVibrato = useSing((s) => s.setVibrato);
  return (
    <div className="panel song-panel">
      <h2>Songs</h2>
      <div className="examples" role="group" aria-label="Demo songs">
        {DEMO_SONGS.map((s) => (
          <button
            key={s.name}
            className={`chip${demo === s.name ? " on" : ""}`}
            aria-pressed={demo === s.name}
            onClick={async () => {
              if (demo === s.name) {
                stopSinging();
                return;
              }
              await start();
              await playDemo(s.name, body);
            }}
          >
            {demo === s.name ? `Stop “${s.name}”` : s.name}
          </button>
        ))}
      </div>
      <h2>Voice</h2>
      <Slider label="Vibrato depth" value={vibrato} min={0} max={80} onChange={(v) => setVibrato(Math.round(v))} format={(v) => `${Math.round(v)} cents`} />
      <Slider label="Vibrato rate" value={source.vibratoRate} min={3.5} max={7.5} onChange={(v) => setSource({ vibratoRate: v })} format={(v) => `${v.toFixed(1)} Hz`} />
      <Slider label="Breathiness" value={source.breathiness} min={0} max={1} onChange={(v) => setSource({ breathiness: v })} format={(v) => `${Math.round(v * 100)} %`} />
      <Toggle label="Singer’s ring" checked={epilarynx >= RING - 0.05} onChange={(on) => setArtic({ epilarynx: on ? RING : 0 })} />
      <p className="dim">Narrows the tube just above the vocal folds, adding the bright ring near 3 kHz that lets an opera voice carry.</p>
    </div>
  );
}

export function SingPanel() {
  return (
    <>
      <section className="sing">
        <Lyrics />
        <SongAndVoice />
        <figure className="instrument roll-panel">
          <figcaption>Notes, and the pitch actually sung</figcaption>
          <PianoRoll />
        </figure>
      </section>
      <footer className="keys-bar">
        <Keys />
      </footer>
    </>
  );
}
