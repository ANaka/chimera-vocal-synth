/**
 * Main-thread side of the audio engine: AudioContext + worklet node + analyser, coalesced
 * parameter messages (at most one per animation frame per kind) and telemetry fan-out.
 */
import workletUrl from "../worklet/processor.ts?worker&url";
import type { ToWorklet, FromWorklet, TelemetryMessage, BodyName, PlannedMessage, CreatureTelemetryMessage } from "../worklet/protocol.ts";
import type { HumanArtic } from "../engine/anatomy/human.ts";
import type { VoiceSource } from "../engine/voice/humanVoice.ts";

type Listener = (t: TelemetryMessage) => void;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  /** unsmoothed, short-window analyser for the spectrogram */
  analyserFast: AnalyserNode | null = null;
  /** long time-domain window for the waveform scope */
  analyserScope: AnalyserNode | null = null;
  private master: GainNode | null = null;
  latest: TelemetryMessage | null = null;
  latestCreature: CreatureTelemetryMessage | null = null;
  /** load of the most recent telemetry of either kind */
  load = 0;
  sampleRate = 48000;
  private listeners = new Set<Listener>();
  private pendingArtic: Partial<HumanArtic> | null = null;
  private pendingTipFree: boolean | undefined;
  private pendingSource: Partial<VoiceSource> | null = null;
  private pendingCParams: Record<string, number> | null = null;
  private flushScheduled = false;
  private readyListeners = new Set<() => void>();
  private plannedListeners = new Set<(p: PlannedMessage) => void>();
  /** most recent planned utterance (for timelines) */
  lastPlan: PlannedMessage | null = null;
  private speakId = 0;
  error: string | null = null;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node = node;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    this.master = master;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    this.analyser = analyser;
    const fast = ctx.createAnalyser();
    fast.fftSize = 2048;
    fast.smoothingTimeConstant = 0;
    this.analyserFast = fast;
    const scope = ctx.createAnalyser();
    scope.fftSize = 16384;
    this.analyserScope = scope;
    node.connect(master);
    master.connect(ctx.destination);
    master.connect(analyser);
    master.connect(fast);
    master.connect(scope);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      const m = e.data;
      if (m.type === "telemetry") {
        this.latest = m;
        this.latestCreature = null;
        this.load = m.load;
        for (const l of this.listeners) l(m);
      } else if (m.type === "ctelemetry") {
        this.latestCreature = m;
        this.latest = null;
        this.load = m.load;
      } else if (m.type === "planned") {
        this.lastPlan = m;
        for (const l of this.plannedListeners) l(m);
      } else if (m.type === "ready") {
        for (const l of this.readyListeners) l();
      } else if (m.type === "error") {
        this.error = m.message;
        console.error("worklet:", m.message);
      }
    };
    await ctx.resume();
  }

  onTelemetry(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onPlanned(l: (p: PlannedMessage) => void): () => void {
    this.plannedListeners.add(l);
    return () => this.plannedListeners.delete(l);
  }

  /** Send a gestural plan (times relative to now). Returns the request id. */
  schedule(plan: { gestures: import("../engine/control/score.ts").Gesture[]; segments: import("../engine/phonetics/planner.ts").PlannedSegment[]; end: number }, replace = true): number {
    const id = ++this.speakId;
    this.send({ type: "schedule", gestures: plan.gestures, segments: plan.segments, end: plan.end, id, replace });
    return id;
  }

  /** Switch voice ("human" or a creature id), starting the creature from the given settings. */
  setCreature(id: string, params?: Record<string, number>): void {
    // settings still waiting for the next frame belong to the previous creature
    this.pendingCParams = null;
    this.send({ type: "creature", id, params });
  }

  setCreatureParams(values: Record<string, number>): void {
    this.pendingCParams = { ...(this.pendingCParams ?? {}), ...values };
    this.scheduleFlush();
  }

  playCall(id: string, pitch?: number, amp?: number): void {
    this.send({ type: "call", id, pitch, amp });
  }

  stopCall(): void {
    this.send({ type: "stopCall" });
  }

  stopSpeech(): void {
    this.send({ type: "stopSpeech" });
  }

  onReady(l: () => void): () => void {
    this.readyListeners.add(l);
    return () => this.readyListeners.delete(l);
  }

  private send(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }

  setVolume(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setBody(body: BodyName): void {
    this.send({ type: "body", body });
  }

  gate(level: number): void {
    this.send({ type: "gate", level });
  }

  /** Coalesced: many calls within a frame become one message. */
  setArtic(values: Partial<HumanArtic>, tipFree?: boolean): void {
    this.pendingArtic = { ...(this.pendingArtic ?? {}), ...values };
    if (tipFree !== undefined) this.pendingTipFree = tipFree;
    this.scheduleFlush();
  }

  setSource(values: Partial<VoiceSource>): void {
    this.pendingSource = { ...(this.pendingSource ?? {}), ...values };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      if (this.pendingArtic || this.pendingTipFree !== undefined) {
        this.send({ type: "artic", values: this.pendingArtic ?? {}, tipFree: this.pendingTipFree });
        this.pendingArtic = null;
        this.pendingTipFree = undefined;
      }
      if (this.pendingSource) {
        this.send({ type: "source", values: this.pendingSource });
        this.pendingSource = null;
      }
      if (this.pendingCParams) {
        this.send({ type: "cparams", values: this.pendingCParams });
        this.pendingCParams = null;
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }
}

export const engine = new AudioEngine();
