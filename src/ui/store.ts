import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { DEFAULT_SOURCE, type VoiceSource } from "../engine/voice/humanVoice.ts";
import { NEUTRAL, restTip, type HumanArtic } from "../engine/anatomy/human.ts";
import type { BodyName } from "../worklet/protocol.ts";

export const DEFAULT_F0: Record<BodyName, number> = { male: 110, female: 205, child: 260 };

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

function updateGate(s: { hold: boolean; heldNotes: number[] }) {
  engine.gate(s.hold || s.heldNotes.length > 0 ? 1 : 0);
}

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
  start: async () => {
    if (get().started || get().starting) return;
    set({ starting: true, startError: null });
    try {
      await engine.start();
      const s = get();
      engine.setSource(s.source);
      engine.setVolume(s.volume);
      set({ started: true, starting: false });
    } catch (e) {
      set({ starting: false, startError: e instanceof Error ? e.message : String(e) });
    }
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
    updateGate({ ...get(), hold: h });
  },
  noteOn: (midi) => {
    const held = get().heldNotes.filter((n) => n !== midi).concat(midi);
    set({ heldNotes: held });
    get().setSource({ f0: midiToHz(midi) });
    updateGate({ ...get(), heldNotes: held });
  },
  noteOff: (midi) => {
    const held = get().heldNotes.filter((n) => n !== midi);
    set({ heldNotes: held });
    if (held.length) get().setSource({ f0: midiToHz(held[held.length - 1]) });
    updateGate({ ...get(), heldNotes: held });
  },
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
}));
