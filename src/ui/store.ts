import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { DEFAULT_SOURCE, type VoiceSource } from "../engine/voice/humanVoice.ts";
import { NEUTRAL, restTip, type HumanArtic } from "../engine/anatomy/human.ts";
import type { BodyName } from "../worklet/protocol.ts";
import { creatureById } from "../engine/creatures/index.ts";
import type { ParamDef } from "../engine/creatures/types.ts";

export const DEFAULT_F0: Record<BodyName, number> = { male: 110, female: 205, child: 260 };

export type Mode = "play" | "speak" | "bestiary";

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
  start: () => Promise<void>;
  setBody: (b: BodyName) => void;
  setSource: (v: Partial<VoiceSource>) => void;
  setArtic: (v: Partial<HumanArtic>, tipFree?: boolean) => void;
  setVolume: (v: number) => void;
  setHold: (h: boolean) => void;
  noteOn: (midi: number) => void;
  noteOff: (midi: number) => void;
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
  // keys that trigger calls leave the breath to the call
  const keysBreathe = !(s.mode === "bestiary" && s.keyCall);
  engine.gate(s.hold || (keysBreathe && s.heldNotes.length > 0) ? 1 : 0);
}

let startPromise: Promise<void> | null = null;

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
    if ((prev === "bestiary") !== (m === "bestiary")) {
      // a sustain belongs to the voice it was started on
      set({ hold: false });
      const s = get();
      engine.setCreature(m === "bestiary" ? s.creature : "human", s.cparams[s.creature]);
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
  noteOn: (midi) => {
    const held = get().heldNotes.filter((n) => n !== midi).concat(midi);
    set({ heldNotes: held });
    const s = get();
    if (s.mode === "bestiary") {
      const pp = creatureById(s.creature)?.params.find((p) => p.role === "pitch");
      const f = pp ? creatureKeyHz(midi, pp) : undefined;
      if (s.keyCall) s.playCall(s.keyCall, f);
      else if (pp && f) s.setCParam(pp.key, f);
    } else s.setSource({ f0: midiToHz(midi) });
    updateGate(get());
  },
  noteOff: (midi) => {
    const held = get().heldNotes.filter((n) => n !== midi);
    set({ heldNotes: held });
    const s = get();
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
}));
