import { useEffect, useState } from "react";
import { useStore } from "../store.ts";
import { speakText, speakPhrases, stopSpeaking, onPlan, currentPlan } from "../speech.ts";
import { tokenizeIpa } from "../../engine/phonetics/ipa.ts";
import { Slider, Toggle } from "./Controls.tsx";
import { ScoreView } from "./ScoreView.tsx";

const EXAMPLES = ["Hello. Can you hear me?", "She sells sea shells by the sea shore.", "Every sound here is air moving through a throat.", "The quick brown fox jumps over the lazy dog."];

// IPA pulmonic consonant chart (rows = manner, columns = place); empty cells are null
const PLACES = ["Bilabial", "Labiodental", "Dental", "Alveolar", "Postalveolar", "Retroflex", "Palatal", "Velar", "Uvular", "Pharyngeal", "Glottal"];
const CHART: [string, (string | null)[][]][] = [
  ["Plosive", [["p", "b"], [null, null], [null, null], ["t", "d"], [null, null], ["ʈ", "ɖ"], ["c", "ɟ"], ["k", "g"], ["q", "ɢ"], [null, null], ["ʔ", null]]],
  ["Nasal", [[null, "m"], [null, "ɱ"], [null, null], [null, "n"], [null, null], [null, "ɳ"], [null, "ɲ"], [null, "ŋ"], [null, "ɴ"], [null, null], [null, null]]],
  ["Trill", [[null, "ʙ"], [null, null], [null, null], [null, "r"], [null, null], [null, null], [null, null], [null, null], [null, "ʀ"], [null, null], [null, null]]],
  ["Tap", [[null, null], [null, null], [null, null], [null, "ɾ"], [null, null], [null, "ɽ"], [null, null], [null, null], [null, null], [null, null], [null, null]]],
  ["Fricative", [["ɸ", "β"], ["f", "v"], ["θ", "ð"], ["s", "z"], ["ʃ", "ʒ"], ["ʂ", "ʐ"], ["ç", "ʝ"], ["x", "ɣ"], ["χ", "ʁ"], ["ħ", "ʕ"], ["h", "ɦ"]]],
  ["Lateral fricative", [[null, null], [null, null], [null, null], ["ɬ", "ɮ"], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]]],
  ["Approximant", [[null, null], [null, "ʋ"], [null, null], [null, "ɹ"], [null, null], [null, "ɻ"], [null, "j"], [null, "ɰ"], [null, null], [null, null], [null, null]]],
  ["Lateral", [[null, null], [null, null], [null, null], [null, "l"], [null, null], [null, "ɭ"], [null, "ʎ"], [null, null], [null, null], [null, null], [null, null]]],
];

export function SpeakPanel() {
  const body = useStore((s) => s.body);
  const f0 = useStore((s) => s.source.f0);
  const start = useStore((s) => s.start);
  const [text, setText] = useState(EXAMPLES[0]);
  const [ipa, setIpa] = useState(false);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);
  const [trans, setTrans] = useState(currentPlan()?.transcription ?? "");
  const [vowel, setVowel] = useState("ɑ");
  useEffect(() => onPlan((p) => setTrans(p?.transcription ?? "")), []);

  const speak = async () => {
    setBusy(true);
    try {
      await start();
      await speakText(text, { ipa, body, rate, f0 });
    } finally {
      setBusy(false);
    }
  };
  const pad = async (c: string) => {
    await start();
    speakPhrases([{ segments: tokenizeIpa(`ˈ${vowel}${c}${vowel}`), intonation: "flat" }], { body, rate, f0 });
  };

  return (
    <div className="speak">
      <div className="panel speak-input">
        <h2>Say something</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void speak();
            e.stopPropagation();
          }}
          rows={3}
          spellCheck={!ipa}
          aria-label={ipa ? "IPA to speak" : "Text to speak"}
          placeholder={ipa ? "Type IPA, for example ˈhɛloʊ" : "Type something for the voice to say"}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => { setText(ex); setIpa(false); }}>
              {ex}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="primary" onClick={() => void speak()} disabled={busy}>
            {busy ? "Preparing…" : "Speak"}
          </button>
          <button className="ghost" onClick={stopSpeaking}>Stop</button>
          <Toggle label="Text is IPA" checked={ipa} onChange={setIpa} />
        </div>
        <Slider label="Speaking rate" value={rate} min={0.5} max={1.8} onChange={setRate} format={(v) => `${v.toFixed(2)}×`} />
        <p className="transcription" aria-live="polite">{trans ? `/${trans}/` : "The transcription appears here."}</p>
      </div>
      <div className="panel chart-panel">
        <h2>Consonants, between two vowels</h2>
        <div className="chart-scroll">
          <table className="ipa-chart">
            <thead>
              <tr>
                <th />
                {PLACES.map((p) => (
                  <th key={p} scope="col">{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CHART.map(([manner, cells]) => (
                <tr key={manner}>
                  <th scope="row">{manner}</th>
                  {cells.map((pair, i) => (
                    <td key={i}>
                      {pair.map((sym, j) =>
                        sym ? (
                          <button key={j} className="ipa" onClick={() => void pad(sym)} title={`Say ${vowel}${sym}${vowel}`}>
                            {sym}
                          </button>
                        ) : (
                          <span key={j} className="ipa-empty" />
                        ),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <span className="dim">Vowel around it</span>
          {["ɑ", "i", "u", "ə"].map((v) => (
            <button key={v} className={`chip${vowel === v ? " on" : ""}`} onClick={() => setVowel(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="panel score-panel">
        <h2>Gestural score</h2>
        <ScoreView />
      </div>
    </div>
  );
}
