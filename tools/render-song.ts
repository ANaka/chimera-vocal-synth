/**
 * Render a sung melody through the real-time voice (the Sing mode's demo, or a live-style
 * key sequence), with a spectrogram.
 * Usage: bun tools/render-song.ts outdir [male|female|child]
 */
import { mkdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD } from "../src/engine/anatomy/human.ts";
import { EnglishG2P } from "../src/engine/phonetics/english.ts";
import { lyricsToSyllables } from "../src/engine/phonetics/syllables.ts";
import { planSong, planNoteOn, planNoteOff, midiToHz } from "../src/engine/phonetics/sing.ts";
import { DEMO_SONGS } from "../src/engine/phonetics/songs.ts";
import { writeWav } from "./lib/wav.ts";
import { renderSpectrogram } from "./lib/spectrogram.ts";

const outDir = process.argv[2] ?? "out/song";
const bodyName = (process.argv[3] ?? "male") as "male" | "female" | "child";
const body = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD }[bodyName];
mkdirSync(outDir, { recursive: true });
const FS = 48000;
const g2p = new EnglishG2P();
g2p.setDictionaryText(gunzipSync(readFileSync("public/data/cmudict.txt.gz")).toString("utf8"));

for (const song of DEMO_SONGS) {
  const syl = lyricsToSyllables(song.lyrics, g2p);
  const shift = song.octave[bodyName] * 12;
  const notes = song.notes.map((n, i) => ({ midi: n[0] + shift, beats: n[1], syl: syl[i % syl.length] }));
  const v = new HumanVoice({ fsOut: FS, body });
  v.setSource({ f0: midiToHz(notes[0].midi), voiced: true, pressure: 9, tension: 0.55 });
  const plan = planSong(notes, { body: bodyName, bpm: song.bpm, t0: 0.3, vibrato: 35 });
  v.schedule(plan.gestures);
  const N = Math.round(FS * (plan.end + 0.4));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i += 128) v.render(out, i, Math.min(128, N - i));
  let pk = 0;
  for (const x of out) pk = Math.max(pk, Math.abs(x));
  const slug = song.name.toLowerCase().replace(/[^a-z]+/g, "-");
  writeWav(`${outDir}/${slug}-${bodyName}.wav`, [out], FS);
  const beat = 60 / song.bpm;
  let t = 0.3;
  const marks = notes.map((n) => { const m = { t, label: "" }; t += n.beats * beat; return m; });
  renderSpectrogram(`${outDir}/${slug}-${bodyName}.png`, out, FS, { title: `${song.name} (${bodyName})`, maxFreq: 6000, windowMs: 25, marks });
  console.log(`${song.name}: ${(N / FS).toFixed(1)} s, peak ${pk.toFixed(3)}, syllables ${syl.map((s) => s.text).join(" ")}`);
}

// live-style: key presses with gaps and one legato pair, as the keyboard would send them
{
  const syl = lyricsToSyllables("hello there my friend", g2p);
  const v = new HumanVoice({ fsOut: FS, body });
  v.setSource({ f0: 130, voiced: true, pressure: 9 });
  const keys: [number, number, number][] = [[0.2, 0.55, 57], [0.6, 1.0, 59], [1.1, 1.8, 62], [1.75, 2.6, 60]]; // [down, up, midi]
  const N = Math.round(FS * 3);
  const out = new Float32Array(N);
  let tag = 2;
  let held: { syl: (typeof syl)[number]; midi: number; tag: number; up: number } | null = null;
  const events = keys.flatMap(([d, u, m], i) => [{ t: d, on: true, m, i }, { t: u, on: false, m, i }]).sort((a, b) => a.t - b.t);
  let e = 0;
  for (let i = 0; i < N; i += 128) {
    const now = v.clock;
    while (e < events.length && events[e].t <= now) {
      const ev = events[e++];
      const shift = (gs: import("../src/engine/control/score.ts").Gesture[]) => gs.map((g) => ({ ...g, t0: g.t0 + now + 0.006, t1: g.t1 + now + 0.006 }));
      if (ev.on) {
        const s = syl[ev.i];
        if (held) v.release(held.tag), v.release(held.tag + 1);
        v.schedule(shift(planNoteOn(s, ev.m, { body: bodyName, vibrato: 35, tag, legatoFrom: held ? { syl: held.syl, midi: held.midi } : undefined })));
        held = { syl: s, midi: ev.m, tag, up: 0 };
        tag += 2;
      } else if (held && held.midi === ev.m) {
        v.release(held.tag);
        v.release(held.tag + 1);
        v.schedule(shift(planNoteOff(held.syl, held.midi, bodyName)));
        held = null;
      }
    }
    v.render(out, i, Math.min(128, N - i));
  }
  writeWav(`${outDir}/live-${bodyName}.wav`, [out], FS);
  renderSpectrogram(`${outDir}/live-${bodyName}.png`, out, FS, { title: `live: hello there my friend (${bodyName})`, maxFreq: 6000, windowMs: 25, marks: keys.map(([d]) => ({ t: d, label: "" })) });
  console.log(`live: syllables ${syl.map((s) => s.text).join(" ")}`);
}
