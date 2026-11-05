/**
 * CHIMERA AudioWorklet processor. Execution contract: message handlers only record state;
 * all DSP happens in process(); telemetry is fixed-size and rate-limited (~60 Hz).
 */
import { HumanVoice } from "../engine/voice/humanVoice.ts";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD, type HumanBody } from "../engine/anatomy/human.ts";
import type { ToWorklet, FromWorklet, BodyName } from "./protocol.ts";
import { CreatureVoice } from "../engine/creatures/voice.ts";
import { creatureById } from "../engine/creatures/index.ts";
import { BeatPlayer } from "../engine/control/beatPlayer.ts";

// Minimal AudioWorkletGlobalScope typings
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const BODIES: Record<BodyName, HumanBody> = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD };
const DEFAULT_F0: Record<BodyName, number> = { male: 110, female: 205, child: 260 };

class ChimeraProcessor extends AudioWorkletProcessor {
  private voice: HumanVoice;
  private body: BodyName = "male";
  private telemetryOn = true;
  private blocks = 0;
  private load = 0;
  private pendingBody: BodyName | null = null;
  private creature: CreatureVoice | null = null;
  private pendingCreature: string | null = null;
  /** params and a call that arrived while a creature switch was pending */
  private pendingCreatureParams: Record<string, number> = {};
  private pendingCall: { id: string; pitch?: number; amp?: number } | null = null;
  private gateLevel = 0;
  private beat = new BeatPlayer();

  constructor() {
    super();
    this.voice = this.makeVoice("male");
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
    this.post({ type: "ready", sampleRate, body: this.body, nPh: this.voice.airway.nPh, nOr: this.voice.airway.nOr, creature: "human" });
  }

  private makeVoice(body: BodyName): HumanVoice {
    const v = new HumanVoice({ fsOut: sampleRate, body: BODIES[body], oversample: sampleRate > 60000 ? 1 : 2 });
    v.setSource({ f0: DEFAULT_F0[body] });
    return v;
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg);
  }

  private onMessage(m: ToWorklet): void {
    switch (m.type) {
      case "body":
        this.pendingBody = m.body;
        break;
      case "artic":
        this.voice.setArticulation(m.values, m.tipFree);
        break;
      case "source":
        this.voice.setSource(m.values);
        break;
      case "gate":
        this.gateLevel = m.level;
        this.voice.setGate(m.level);
        this.creature?.setGate(m.level);
        break;
      case "creature":
        this.pendingCreature = m.id;
        this.pendingCreatureParams = { ...(m.params ?? {}) };
        this.pendingCall = null;
        break;
      case "cparams":
        if (this.pendingCreature !== null) Object.assign(this.pendingCreatureParams, m.values);
        else this.creature?.setParams(m.values);
        break;
      case "call":
        if (this.pendingCreature !== null) this.pendingCall = { id: m.id, pitch: m.pitch, amp: m.amp };
        else this.creature?.playCall(m.id, m.pitch, m.amp);
        break;
      case "stopCall":
        if (this.pendingCreature !== null) this.pendingCall = null;
        else this.creature?.stopCall();
        break;
      case "telemetry":
        this.telemetryOn = m.enabled;
        break;
      case "schedule": {
        // O(n) time shift onto the voice clock; planning happened on the main thread
        const off = this.voice.clock + 0.03;
        const gs = m.gestures.slice(0, 4000);
        for (const g of gs) {
          g.t0 += off;
          g.t1 += off;
        }
        if (m.replace) this.voice.cancelScore();
        this.voice.schedule(gs);
        this.post({ type: "planned", id: m.id, t0: off, end: m.end + off, segments: m.segments.map((s) => ({ ...s, t0: s.t0 + off, t1: s.t1 + off })) });
        break;
      }
      case "stopSpeech":
        this.voice.cancelScore();
        break;
      case "beat": {
        const b = this.beat;
        if (m.steps) b.steps = m.steps.slice(0, 128);
        if (m.bpm !== undefined || m.swing !== undefined) b.setTempo(m.bpm ?? b.bpm, m.swing ?? b.swing);
        if (m.playing === true && !b.playing) b.start(this.voice.clock);
        if (m.playing === false && b.playing) {
          b.stop();
          // hits already scheduled within the horizon would still sound
          this.voice.cancelScore();
        }
        break;
      }
      case "beatHit": {
        const hit = this.voice.clock + BeatPlayer.leadIn(m.id, this.body);
        this.voice.schedule(this.beat.gestures({ id: m.id, note: m.note, accent: m.accent }, hit, 0.18));
        break;
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    if (this.pendingBody) {
      // carry the performer's settings across the body change
      const prev = this.voice;
      this.body = this.pendingBody;
      this.pendingBody = null;
      this.voice = this.makeVoice(this.body);
      // the new voice's clock starts at zero: keep the beat's phase across the switch, and
      // queue again the hits the old voice's score was holding (built for the new body)
      this.beat.body = this.body;
      this.beat.rebase(this.voice.clock - prev.clock);
      this.beat.rewind(this.voice.clock);
      this.voice.setSource({ ...prev.source, f0: DEFAULT_F0[this.body] });
      this.voice.setArticulation({ ...prev.artic.target }, prev.artic.tipFree);
      // the performer's breath, not the voice's (which includes breath from the score)
      this.voice.setGate(this.gateLevel);
      this.post({ type: "ready", sampleRate, body: this.body, nPh: this.voice.airway.nPh, nOr: this.voice.airway.nOr, creature: this.creature ? this.creature.def.id : "human" });
    }
    if (this.pendingCreature !== null) {
      const id = this.pendingCreature;
      this.pendingCreature = null;
      if (id === "human") this.creature = null;
      else {
        const def = creatureById(id);
        if (def) {
          this.creature = new CreatureVoice(def, sampleRate, this.pendingCreatureParams);
          this.creature.setGate(this.gateLevel);
          if (this.pendingCall) this.creature.playCall(this.pendingCall.id, this.pendingCall.pitch, this.pendingCall.amp);
        }
      }
      this.pendingCreatureParams = {};
      this.pendingCall = null;
      this.post({ type: "ready", sampleRate, body: this.body, nPh: this.voice.airway.nPh, nOr: this.voice.airway.nOr, creature: this.creature ? this.creature.def.id : "human" });
    }
    const ch0 = out[0];
    if (!this.creature) this.beat.tick(this.voice.clock, (gs) => this.voice.schedule(gs));
    const t0 = Date.now();
    try {
      if (this.creature) this.creature.render(ch0, 0, ch0.length);
      else this.voice.render(ch0, 0, ch0.length);
    } catch (err) {
      ch0.fill(0);
      this.post({ type: "error", message: String(err) });
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    const dt = Date.now() - t0;
    const budget = (ch0.length / sampleRate) * 1000;
    this.load += 0.05 * (dt / budget - this.load);
    if (this.telemetryOn && ++this.blocks % 6 === 0) {
      if (this.creature) this.post({ type: "ctelemetry", t: this.creature.telemetry(), load: this.load });
      else this.post({ type: "telemetry", t: this.voice.telemetry(), load: this.load, body: this.body, nPh: this.voice.airway.nPh, nOr: this.voice.airway.nOr, beatStep: this.beat.stepAt(this.voice.clock) });
    }
    return true;
  }
}

registerProcessor("chimera", ChimeraProcessor);
