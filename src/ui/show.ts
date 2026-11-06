/**
 * "Good Evening": a ~33 s song CHIMERA sings, beatboxes and speaks live over a band, with the
 * words shown at the mouth. This is a demo branch only (not for main). The song, the backing and
 * the mix levels come from soundfont-music's projects/good_evening/song.py; copy its demo/ folder
 * to public/demo/good-evening/.
 *
 * The voice gets one score holding all three parts: the melody planned as `chimera render notes`
 * plans it, one pass of the beat pattern, and the punchline planned as `chimera render text`
 * plans it. The backing starts on the AudioContext clock at the moment the score's time 0
 * reaches the voice. Through the song, the voice's level follows the mp3 mix part by part, and
 * the mix goes through the same soft clip as the mp3's master.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { g2p } from "./speech.ts";
import { roll, stopSinging } from "./singing.ts";
import { useStore } from "./store.ts";
import { PRESETS, sameBody } from "./body.ts";
import { DEFAULT_SOURCE, NEUTRAL, beatReady, restTip } from "../wasm/engine.ts";
import { planShow, type Cue, type ShowData, type ShowPlan } from "./showPlan.ts";

export type { Cue, CueKind } from "./showPlan.ts";

export const SHOW_BASE = "/demo/good-evening/";


interface Loaded {
  data: ShowData;
  backing: AudioBuffer;
  ir: AudioBuffer;
}

interface Run {
  /** the voice clock at song time 0 */
  at: number;
  /** the AudioContext time the backing starts (song time 0) */
  T0: number;
  plan: ShowPlan;
  src: AudioBufferSourceNode;
  nodes: AudioNode[];
  timers: number[];
}

export type ShowStatus = "idle" | "loading" | "playing" | "done";

interface ShowState {
  status: ShowStatus;
  error: string | null;
  cues: Cue[];
  /** the cue being sung, beatboxed or spoken (−1: none) */
  at: number;
}

export const useShow = create<ShowState>(() => ({ status: "idle", error: null, cues: [], at: -1 }));

let loaded: Promise<Loaded> | null = null;
let run: Run | null = null;
let token = 0;

function load(ctx: AudioContext): Promise<Loaded> {
  loaded ??= (async () => {
    const get = async (f: string) => {
      const r = await fetch(SHOW_BASE + f);
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r;
    };
    const data = (await (await get("demo.json")).json()) as ShowData;
    const [backing, ir] = await Promise.all(["backing.wav", "reverb.wav"].map(async (f) => ctx.decodeAudioData(await (await get(f)).arrayBuffer())));
    return { data, backing, ir };
  })().catch((e) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

/** sfkit's master: softclip(u × c) / c on the mix at its gain (tanh above the knee), over ±4 after the bus's ¼ */
function masterCurve(c: number, knee: number): Float32Array<ArrayBuffer> {
  const n = 4097;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(v * 4 * c);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    out[i] = (Math.sign(v) * y) / c;
  }
  return out;
}

const waitFor = (ok: () => boolean, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (ok()) resolve(true);
      else if (performance.now() - t0 > ms) resolve(false);
      else requestAnimationFrame(tick);
    };
    tick();
  });

const restArtic = () => {
  const tip = restTip(NEUTRAL.jaw, NEUTRAL.tbX, NEUTRAL.tbY);
  return { ...NEUTRAL, ttX: tip.x, ttY: tip.y };
};

/** Play the song from the top (starting audio if needed). */
export async function playShow(): Promise<void> {
  const st = useStore.getState();
  stopShow();
  const my = ++token;
  useShow.setState({ status: "loading", error: null });
  try {
    await st.start();
    const ctx = engine.ctx!;
    stopSinging();
    st.setHold(false);
    const [l] = await Promise.all([load(ctx), g2p.load().catch(() => undefined)]);
    if (my !== token) return;
    const male = PRESETS.male;
    if (!sameBody(useStore.getState().body, male)) useStore.getState().setBody(male);
    if (!(await waitFor(() => !!engine.latest && sameBody(engine.latest.body, male), 3000))) throw new Error("the voice did not switch to the male body");
    if (my !== token) return;
    const d = l.data;
    const plan = planShow(d, male, (t) => g2p.toPhrases(t));
    const now = engine.voiceClock()!;
    const at = now + 0.7;
    // the source the CLI sings with, at rest
    engine.gate(0);
    engine.setArtic(restArtic(), true);
    engine.setSource({ ...DEFAULT_SOURCE, f0: plan.firstHz, voiced: true, pressure: 9, tension: 0.55 });
    const CHUNK = 3500;
    for (let i = 0; i < plan.gestures.length; i += CHUNK) engine.scheduleAt(plan.gestures.slice(i, i + CHUNK), at, i === 0);
    const T0 = engine.ctxTimeOf(at)!;
    // the mix: backing and voice into the master's soft clip; a reverb send on the voice
    const bus = engine.bus!, master = engine.master!;
    bus.gain.setValueAtTime(0.25, ctx.currentTime);
    engine.shaper!.curve = masterCurve(d.master.clip, d.master.knee);
    const src = ctx.createBufferSource();
    src.buffer = l.backing;
    src.connect(bus);
    src.start(T0);
    const send = ctx.createGain();
    send.gain.value = d.reverb.send * d.reverb.irScale;
    const verb = ctx.createConvolver();
    verb.normalize = false;
    verb.buffer = l.ir;
    master.connect(send).connect(verb).connect(bus);
    const g = master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(d.gains.sing, ctx.currentTime);
    const beatSwitch = plan.beatAt - 0.25, speechSwitch = plan.speechAt - 0.1, free = plan.speechEnd + 0.15;
    g.setTargetAtTime(d.gains.beatbox, T0 + beatSwitch, 0.01);
    g.setTargetAtTime(d.gains.speech, T0 + speechSwitch, 0.01);
    // posture and source per part, sent ahead of time on the main thread (they fall in rests)
    const timers: number[] = [];
    const atSong = (t: number, f: () => void) => timers.push(window.setTimeout(f, Math.max(0, (T0 + t - ctx.currentTime) * 1000)));
    atSong(beatSwitch, () => {
      engine.setArtic(beatReady(male));
      engine.setSource({ f0: 100, pressure: 8 });
    });
    atSong(speechSwitch - 0.05, () => {
      engine.setArtic(restArtic(), true);
      engine.setSource({ ...DEFAULT_SOURCE, f0: d.speech.f0 });
    });
    // the song is over for the voice: hand it back to the page (hold it and drag the tongue)
    atSong(free, () => {
      const s = useStore.getState();
      engine.setArtic(s.artic, s.tipFree);
      engine.setSource(s.source);
      g.cancelScheduledValues(ctx.currentTime);
      g.setTargetAtTime(s.volume, ctx.currentTime, 0.05);
      useShow.setState({ status: "done" });
    });
    atSong(d.end, () => {
      if (run?.src === src) teardown();
    });
    // the piano roll shows the melody coming
    roll.notes = roll.notes.filter((n) => !n.demo);
    for (const n of plan.notes) roll.notes.push({ midi: n.midi, t0: at + n.t0, t1: at + n.t1, text: n.text, demo: true });
    run = { at, T0, plan, src, nodes: [send, verb], timers };
    useShow.setState({ status: "playing", cues: plan.cues, at: -1 });
  } catch (e) {
    if (my === token) useShow.setState({ status: "idle", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Audio graph back to normal (the backing stops). */
function teardown(): void {
  const r = run;
  if (!r) return;
  run = null;
  for (const t of r.timers) clearTimeout(t);
  try {
    r.src.stop();
  } catch {
    // never started
  }
  r.src.disconnect();
  for (const n of r.nodes) n.disconnect();
  const ctx = engine.ctx;
  if (ctx && engine.bus && engine.shaper) {
    engine.bus.gain.setValueAtTime(1, ctx.currentTime);
    engine.shaper.curve = null;
  }
}

/** Stop the song wherever it is; the voice goes back to the page's settings. */
export function stopShow(): void {
  token++;
  const wasPlaying = run !== null && useShow.getState().status === "playing";
  teardown();
  if (wasPlaying) {
    engine.stopSpeech();
    const s = useStore.getState();
    engine.setArtic(s.artic, s.tipFree);
    engine.setSource(s.source);
    const ctx = engine.ctx;
    if (ctx && engine.master) {
      engine.master.gain.cancelScheduledValues(ctx.currentTime);
      engine.master.gain.setTargetAtTime(s.volume, ctx.currentTime, 0.03);
    }
    const t = engine.voiceClock() ?? 0;
    roll.notes = roll.notes.filter((n) => !(n.demo && n.t0 > t));
  }
  if (useShow.getState().status !== "idle") useShow.setState({ status: "idle", at: -1 });
}

/** Where song time 0 is on the voice clock and the AudioContext clock (for checking sync). */
export const showClocks = () => (run ? { at: run.at, T0: run.T0 } : null);

/** Song time now (s), or null when the song isn't playing. */
export function showTime(): number | null {
  const c = engine.voiceClock();
  return run && c !== null ? c - run.at : null;
}

/** Called every frame: which cue is sounding. Returns it and the song time. */
export function tickShow(): { cue: Cue | null; index: number; t: number } | null {
  const t = showTime();
  if (t === null) return null;
  const cues = useShow.getState().cues;
  let i = -1;
  while (i + 1 < cues.length && cues[i + 1].t <= t) i++;
  const cue = i >= 0 && t < cues[i].end + 0.25 ? cues[i] : null;
  if (i !== useShow.getState().at) useShow.setState({ at: i });
  return { cue, index: i, t };
}

// for scripted checks (headless sync measurement): the live instances, whatever URL the dev server gave this module
Object.assign(globalThis, { __show: { useShow, showTime, showClocks, engine } });
