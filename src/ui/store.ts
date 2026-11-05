import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { DEFAULT_SOURCE, type VoiceSource } from "../engine/voice/humanVoice.ts";
import { NEUTRAL, restTip, type HumanArtic } from "../engine/anatomy/human.ts";
import type { BodyName } from "../worklet/protocol.ts";
import { creatureById } from "../engine/creatures/index.ts";
import type { ParamDef } from "../engine/creatures/types.ts";
import { BEAT_PRESETS, BASS_NOTE, beatReady, parseBeat, type BeatStep } from "../engine/phonetics/beatbox.ts";
import { singNoteOn, singNoteOff, stopSinging, ensureDictionary } from "./singing.ts";
import { connectMidi, disconnectMidi, type MidiStatus } from "./midi.ts";

export const DEFAULT_F0: Record<BodyName, number> = { male: 110, female: 205, child: 260 };

export type Mode = "play" | "speak" | "sing" | "bestiary" | "beatbox";

export interface BeatState {
  steps: (BeatStep | null)[];
  bpm: number;
  swing: number;
  playing: boolean;
  /** preset the pattern came from (null once edited) */
  preset: string | null;
}

export interface ViewOptions {
  pressure: boolean;
  particles: boolean;
  grid: boolean;
  calipers: boolean;
}

interface State {
  started: boolean;
  starting: boolean;
  startError: string | null;
  body: BodyName;
  source: VoiceSource;
  artic: HumanArtic;
  tipFree: boolean;
  volume: number;
  /** sustained breath (drone) independent of keys */
  hold: boolean;
  heldNotes: number[];
  view: ViewOptions;
  mode: Mode;
  setMode: (m: Mode) => void;
  /** active non-human creature in the bestiary */
  creature: string;
  cparams: Record<string, Record<string, number>>;
  setCreature: (id: string) => void;
  setCParam: (key: string, v: number) => void;
  playCall: (id: string, pitch?: number) => void;
  /** what the keys do in the bestiary: hold the voice at a pitch (null) or trigger this call */
  keyCall: string | null;
  setKeyCall: (id: string | null) => void;
  beat: BeatState;
  /** close-mic sound (proximity bass + compression) in beatbox mode */
  mic: boolean;
  /** hum note for new hum steps: follows the last key played */
  bassNote: number;
  setBeatSteps: (steps: (BeatStep | null)[], preset?: string | null) => void;
  /** one sound per step: set it, or clear the step if that sound is already there */
  toggleBeatStep: (i: number, id: string) => void;
  setBeatTempo: (v: { bpm?: number; swing?: number }) => void;
  setBeatPlaying: (on: boolean) => void;
  loadBeatPreset: (name: string) => void;
  beatHit: (id: string) => void;
  setMic: (on: boolean) => void;
  start: () => Promise<void>;
  setBody: (b: BodyName) => void;
  setSource: (v: Partial<VoiceSource>) => void;
  setArtic: (v: Partial<HumanArtic>, tipFree?: boolean) => void;
  setVolume: (v: number) => void;
  setHold: (h: boolean) => void;
  /** a key went down (velocity 1..127; the on-screen keys send 96) */
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  midi: { status: MidiStatus; inputs: string[] };
  setMidi: (on: boolean) => void;
  setView: (v: Partial<ViewOptions>) => void;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Map a key to a creature's pitch range: shift the whole keyboard by whole octaves so middle C
 * lands near the middle of the range (adjacent octaves stay distinct), then fold stragglers in.
 */
export function creatureKeyHz(midi: number, p: Pick<ParamDef, "min" | "max">): number {
  const shift = Math.round(Math.log2(Math.sqrt(p.min * p.max) / midiToHz(60)));
  let f = midiToHz(midi) * Math.pow(2, shift);
  while (f > p.max) f /= 2;
  while (f < p.min) f *= 2;
  return Math.min(p.max, f);
}

function updateGate(s: { hold: boolean; heldNotes: number[]; mode: Mode; keyCall: string | null }) {
  // keys that trigger calls leave the breath to the call; sung notes breathe by themselves
  const keysBreathe = !(s.mode === "bestiary" && s.keyCall) && s.mode !== "sing";
  engine.gate(s.hold || (keysBreathe && s.heldNotes.length > 0) ? 1 : 0);
}

let startPromise: Promise<void> | null = null;

const FIRST_BEAT = BEAT_PRESETS[0];

export const useStore = create<State>((set, get) => ({
  started: false,
  starting: false,
  startError: null,
  body: "male",
  source: { ...DEFAULT_SOURCE },
  artic: (() => {
    const tip = restTip(NEUTRAL.jaw, NEUTRAL.tbX, NEUTRAL.tbY);
    return { ...NEUTRAL, ttX: tip.x, ttY: tip.y };
  })(),
  tipFree: true,
  volume: 0.8,
  hold: false,
  heldNotes: [],
  view: { pressure: true, particles: true, grid: false, calipers: true },
  mode: "play",
  setMode: (m) => {
    const prev = get().mode;
    if (prev === m) return;
    // notes held across the switch would keep breathing into the other voice
    set({ mode: m, heldNotes: [] });
    // speech belongs to Speak: under a creature the human clock stops and it would resume later
    if (prev === "speak" || m === "bestiary") engine.stopSpeech();
    if ((prev === "bestiary") !== (m === "bestiary")) {
      // a sustain belongs to the voice it was started on
      set({ hold: false });
      const s = get();
      engine.setCreature(m === "bestiary" ? s.creature : "human", s.cparams[s.creature]);
    }
    if (prev === "beatbox") {
      get().setBeatPlaying(false);
      engine.setMic(false);
    }
    if (prev === "sing") stopSinging();
    // speech and song breathe by themselves: a held breath would drone under them
    if (m === "speak" || m === "sing") set({ hold: false });
    if (m === "sing") ensureDictionary();
    if (m === "beatbox") {
      // a beatboxer waits with the jaw nearly closed; the sounds bring their own breath
      set({ hold: false });
      get().setArtic(beatReady(get().body));
      engine.setMic(get().mic);
    }
    updateGate(get());
  },
  creature: "songbird",
  cparams: {},
  keyCall: null,
  setKeyCall: (id) => {
    set({ keyCall: id, heldNotes: [] });
    updateGate(get());
  },
  beat: { steps: parseBeat(FIRST_BEAT.text), bpm: FIRST_BEAT.bpm, swing: FIRST_BEAT.swing, playing: false, preset: FIRST_BEAT.name },
  mic: true,
  bassNote: BASS_NOTE,
  setBeatSteps: (steps, preset = null) => {
    set((s) => ({ beat: { ...s.beat, steps, preset } }));
    engine.setBeat({ steps });
  },
  toggleBeatStep: (i, id) => {
    const steps = get().beat.steps.slice();
    steps[i] = steps[i]?.id === id ? null : id === "m" ? { id, note: get().bassNote } : { id };
    get().setBeatSteps(steps);
  },
  setBeatTempo: (v) => {
    set((s) => ({ beat: { ...s.beat, ...v } }));
    engine.setBeat(v);
  },
  setBeatPlaying: (on) => {
    if (on === get().beat.playing) return;
    set((s) => ({ beat: { ...s.beat, playing: on } }));
    if (!on) {
      engine.setBeat({ playing: false });
      return;
    }
    void get()
      .start()
      .then(() => {
        const b = get().beat;
        if (get().started && b.playing) engine.setBeat({ steps: b.steps, bpm: b.bpm, swing: b.swing, playing: true });
      });
  },
  loadBeatPreset: (name) => {
    const p = BEAT_PRESETS.find((x) => x.name === name);
    if (!p) return;
    get().setBeatSteps(parseBeat(p.text), p.name);
    get().setBeatTempo({ bpm: p.bpm, swing: p.swing });
  },
  beatHit: (id) => {
    void get()
      .start()
      .then(() => {
        if (get().started) engine.beatHit(id, id === "m" ? get().bassNote : undefined);
      });
  },
  setMic: (on) => {
    set({ mic: on });
    if (get().mode === "beatbox") engine.setMic(on);
  },
  setCreature: (id) => {
    if (id === get().creature) return;
    set({ creature: id, keyCall: null, heldNotes: [] });
    if (get().mode === "bestiary") engine.setCreature(id, get().cparams[id]);
    updateGate(get());
  },
  setCParam: (key, v) => {
    const id = get().creature;
    set((s) => ({ cparams: { ...s.cparams, [id]: { ...(s.cparams[id] ?? {}), [key]: v } } }));
    engine.setCreatureParams({ [key]: v });
  },
  playCall: (id, pitch) => {
    void get()
      .start()
      .then(() => {
        if (get().started) engine.playCall(id, pitch);
      });
  },
  start: () => {
    if (get().started) return Promise.resolve();
    if (startPromise) return startPromise;
    set({ starting: true, startError: null });
    startPromise = (async () => {
      try {
        await engine.start();
        // anything set before audio existed was not delivered: send the whole state now
        const s = get();
        engine.setVolume(s.volume);
        if (s.body !== "male") engine.setBody(s.body);
        engine.setSource(s.source);
        engine.setArtic(s.artic, s.tipFree);
        if (s.mode === "bestiary") engine.setCreature(s.creature, s.cparams[s.creature]);
        if (s.mode === "beatbox") {
          engine.setMic(s.mic);
          engine.setBeat({ steps: s.beat.steps, bpm: s.beat.bpm, swing: s.beat.swing, playing: s.beat.playing });
        }
        updateGate(s);
        set({ started: true, starting: false });
      } catch (e) {
        set({ starting: false, startError: e instanceof Error ? e.message : String(e) });
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  },
  setBody: (b) => {
    // the new voice starts without the old one's score: a sung note would hang
    if (get().mode === "sing") stopSinging();
    const f0 = DEFAULT_F0[b];
    set((s) => ({ body: b, source: { ...s.source, f0 } }));
    engine.setBody(b);
  },
  setSource: (v) => {
    set((s) => ({ source: { ...s.source, ...v } }));
    engine.setSource(v);
  },
  setArtic: (v, tipFree) => {
    set((s) => ({ artic: { ...s.artic, ...v }, tipFree: tipFree ?? s.tipFree }));
    engine.setArtic(v, tipFree);
  },
  setVolume: (v) => {
    set({ volume: v });
    engine.setVolume(v);
  },
  setHold: (h) => {
    set({ hold: h });
    updateGate(get());
  },
  noteOn: (midi, velocity = 96) => {
    const held = get().heldNotes.filter((n) => n !== midi).concat(midi);
    set({ heldNotes: held });
    const s = get();
    if (s.mode === "sing") singNoteOn(midi, velocity, s.body);
    else if (s.mode === "bestiary") {
      const pp = creatureById(s.creature)?.params.find((p) => p.role === "pitch");
      const f = pp ? creatureKeyHz(midi, pp) : undefined;
      if (s.keyCall) s.playCall(s.keyCall, f);
      else if (pp && f) s.setCParam(pp.key, f);
    } else if (s.mode === "beatbox") {
      // keys hum a bass note under the beat (lips shut, nose open); new hum steps take it too
      set({ bassNote: midi });
      if (held.length === 1) s.setArtic({ lipAp: -0.25, velum: 0.9 });
      s.setSource({ f0: midiToHz(midi) });
    } else s.setSource({ f0: midiToHz(midi) });
    updateGate(get());
  },
  noteOff: (midi) => {
    const held = get().heldNotes.filter((n) => n !== midi);
    set({ heldNotes: held });
    const s = get();
    if (s.mode === "sing") {
      singNoteOff(midi, s.body);
      return;
    }
    if (s.mode === "beatbox" && !held.length) s.setArtic({ lipAp: beatReady(s.body).lipAp, velum: NEUTRAL.velum });
    if (held.length) {
      // fall back to the most recent note still held (legato)
      const last = held[held.length - 1];
      if (s.mode !== "bestiary") s.setSource({ f0: midiToHz(last) });
      else if (!s.keyCall) {
        const pp = creatureById(s.creature)?.params.find((p) => p.role === "pitch");
        if (pp) s.setCParam(pp.key, creatureKeyHz(last, pp));
      }
    }
    updateGate(get());
  },
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  midi: { status: "off", inputs: [] },
  setMidi: (on) => {
    const noteOff = (n: number) => get().noteOff(n);
    if (!on) {
      disconnectMidi({ noteOff });
      set({ midi: { status: "off", inputs: [] } });
      return;
    }
    set({ midi: { status: "connecting", inputs: [] } });
    // the click that connects is also the gesture that may start audio
    void get().start();
    connectMidi({
      noteOn: (n, v) => {
        void get().start();
        get().noteOn(n, v);
      },
      noteOff,
      inputs: (names) => set({ midi: { status: "on", inputs: names } }),
    }).catch(() => set({ midi: { status: "denied", inputs: [] } }));
  },
}));
