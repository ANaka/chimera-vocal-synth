/**
 * Generic runtime for non-human creatures: parameter smoothing, breath gate, call playback
 * (keyframed automation), control-rate scheduling, oversampled simulation, decimation, DC block,
 * limiter and fixed-size telemetry. Runs in the AudioWorklet and in Bun.
 */
import type { CreatureDef, CreatureSim, CallDef } from "./types.ts";
import { Decimator } from "../airway/decimator.ts";

export interface CreatureTelemetry {
  kind: "creature";
  id: string;
  params: Record<string, number>;
  gate: number;
  outRms: number;
  clock: number;
  /** per tube: areas (cm²) and acoustic pressure RMS (dyn/cm², static pressure removed) per node */
  tubes: Record<string, { areas: Float32Array; rms: Float32Array }>;
  source: Record<string, number>;
  call: string | null;
}

interface ActiveCall {
  def: CallDef;
  t0: number;
  pitch: number;
  amp: number;
  fired: Set<number>;
  /** params the call automates (restored to the performer's values when it ends) */
  owns: Set<string>;
  /** every key the call mentions, including "gate" and "!events" */
  names: string[];
}

export class CreatureVoice {
  readonly def: CreatureDef;
  readonly fsOut: number;
  readonly fs: number;
  readonly M: number;
  readonly sim: CreatureSim;
  /** performer settings, targets (performer or call automation) and smoothed values */
  readonly performer: Record<string, number> = {};
  readonly target: Record<string, number> = {};
  readonly value: Record<string, number> = {};
  gate = 0;
  private gateTarget = 0;
  private callGate = 0;
  clock = 0;
  private call: ActiveCall | null = null;
  private readonly dec: Decimator;
  private readonly ctrlEvery: number;
  private ctrlCounter = 0;
  private dcX = 0;
  private dcY = 0;
  private readonly dcCoef: number;
  private outAcc = 0;
  private outCount = 0;
  private readonly rmsAcc: Record<string, Float64Array> = {};
  private readonly meanAcc: Record<string, Float64Array> = {};
  private rmsCount = 0;
  private sub = 0;
  /** master trim (performer) */
  level = 1;

  constructor(def: CreatureDef, fsOut: number, initial?: Record<string, number>) {
    this.def = def;
    this.fsOut = fsOut;
    this.M = Math.max(1, Math.round(def.oversample * (fsOut > 60000 ? 0.5 : 1)));
    this.fs = fsOut * this.M;
    this.sim = def.create(this.fs);
    this.dec = new Decimator(this.M);
    this.ctrlEvery = 64 * this.M;
    this.dcCoef = Math.exp((-2 * Math.PI * 12) / fsOut);
    for (const p of def.params) {
      const x = initial?.[p.key];
      this.performer[p.key] = this.target[p.key] = this.value[p.key] = x !== undefined && Number.isFinite(x) ? Math.min(p.max, Math.max(p.min, x)) : p.default;
    }
    for (const [name, t] of Object.entries(this.sim.tubes)) {
      this.rmsAcc[name] = new Float64Array(t.n);
      this.meanAcc[name] = new Float64Array(t.n);
    }
    this.sim.control(this.value, 0, this.ctrlEvery / this.fs);
    this.sim.net?.snapToTargets();
  }

  setParams(v: Record<string, number>): void {
    for (const [k, x] of Object.entries(v)) {
      const d = this.def.params.find((p) => p.key === k);
      if (!d || !Number.isFinite(x)) continue;
      const v = Math.min(d.max, Math.max(d.min, x));
      this.performer[k] = v;
      if (!this.call?.owns.has(k)) this.target[k] = v;
    }
  }

  setGate(level: number): void {
    this.gateTarget = Math.max(0, Math.min(1.5, level));
  }

  /** Play a call; pitch scales the call's pitch params relative to its reference. */
  playCall(id: string, pitch?: number, amp = 1): void {
    const def = this.def.calls.find((c) => c.id === id);
    if (!def) return;
    const ref = def.pitchRef ?? 0;
    this.endCall();
    const owns = new Set<string>();
    const names = new Set<string>();
    for (const k of def.keys)
      for (const n of Object.keys(k.v)) {
        names.add(n);
        if (n !== "gate" && !n.startsWith("!")) owns.add(n);
      }
    this.call = { def, t0: this.clock, pitch: pitch && ref ? pitch / ref : 1, amp, fired: new Set(), owns, names: [...names] };
  }

  stopCall(): void {
    this.endCall();
  }

  /** End the active call and hand its parameters back to the performer. */
  private endCall(): void {
    if (this.call) for (const n of this.call.owns) this.target[n] = this.performer[n];
    this.call = null;
    this.callGate = 0;
  }

  get activeCall(): string | null {
    return this.call?.def.id ?? null;
  }

  /** Evaluate the active call's automation at the current clock (writes into targets). */
  private evalCall(): void {
    const c = this.call;
    if (!c) return;
    const t = this.clock - c.t0;
    const keys = c.def.keys;
    const last = keys[keys.length - 1];
    if (t > last.t + 0.05) {
      this.endCall();
      return;
    }
    for (const n of c.names) {
      // find surrounding keys that define n
      let prev: { t: number; x: number } | null = null, next: { t: number; x: number; curve?: string } | null = null;
      for (const k of keys) {
        if (!(n in k.v)) continue;
        if (k.t <= t) prev = { t: k.t, x: k.v[n] };
        else {
          next = { t: k.t, x: k.v[n], curve: k.curve };
          break;
        }
      }
      if (!prev) continue;
      let x = prev.x;
      if (next && next.curve !== "step") {
        const u = (t - prev.t) / Math.max(1e-6, next.t - prev.t);
        if (next.curve === "exp" && prev.x > 0 && next.x > 0) x = prev.x * Math.pow(next.x / prev.x, u);
        else x = prev.x + (next.x - prev.x) * u;
      }
      if (n === "gate") {
        this.callGate = x * c.amp;
        continue;
      }
      if (n.startsWith("!")) {
        // events: "!click" etc. fire once when crossing the key time with value = amount
        continue;
      }
      const d = this.def.params.find((p) => p.key === n);
      if (!d) continue;
      if (d.role === "pitch") x *= c.pitch;
      this.target[n] = Math.min(d.max, Math.max(d.min, x));
    }
    // one-shot events
    keys.forEach((k, i) => {
      if (k.t > t || c.fired.has(i)) return;
      for (const [n, amount] of Object.entries(k.v)) if (n.startsWith("!")) this.sim.trigger?.(n.slice(1), amount * c.amp);
      c.fired.add(i);
    });
  }

  private control(): void {
    const dt = this.ctrlEvery / this.fs;
    this.evalCall();
    for (const p of this.def.params) {
      const tau = p.smooth ?? 0.03;
      const a = 1 - Math.exp(-dt / Math.max(0.001, tau));
      const cur = this.value[p.key], tgt = this.target[p.key];
      this.value[p.key] = p.log && cur > 0 && tgt > 0 ? cur * Math.pow(tgt / cur, a) : cur + (tgt - cur) * a;
    }
    const goal = Math.max(this.gateTarget, this.callGate);
    const gt = this.def.gateTimes ?? { attack: 0.012, release: 0.06 };
    const tau = goal > this.gate ? gt.attack : gt.release;
    this.gate += (goal - this.gate) * (1 - Math.exp(-dt / tau));
    this.sim.control(this.value, this.gate, dt);
    this.sim.net?.beginBlock(this.ctrlEvery);
    this.ctrlCounter = this.ctrlEvery;
    this.clock += dt;
  }

  render(out: Float32Array, offset: number, n: number): void {
    const M = this.M;
    const gain = this.sim.gain * this.level;
    const tubes = Object.entries(this.sim.tubes);
    for (let i = 0; i < n; i++) {
      for (let m = 0; m < M; m++) {
        if (this.ctrlCounter <= 0) this.control();
        this.ctrlCounter--;
        const y = this.sim.sample();
        if ((++this.sub & 7) === 0 && this.sim.net) {
          const p = this.sim.net.p;
          for (const [name, t] of tubes) {
            const acc = this.rmsAcc[name], mean = this.meanAcc[name];
            for (let k = 0; k < t.n; k++) {
              const v = p[t.first + k];
              acc[k] += v * v;
              mean[k] += v;
            }
          }
          this.rmsCount++;
        }
        if (this.dec.push(y)) {
          let v = this.dec.value * gain;
          const hp = v - this.dcX + this.dcCoef * this.dcY;
          this.dcX = v;
          this.dcY = hp;
          v = hp;
          const av = Math.abs(v);
          if (av > 0.7) v = Math.sign(v) * (0.7 + 0.3 * Math.tanh((av - 0.7) / 0.3));
          if (!Number.isFinite(v)) v = 0;
          out[offset + i] = v;
          this.outAcc += v * v;
          this.outCount++;
        }
      }
    }
  }

  telemetry(): CreatureTelemetry {
    const tubes: CreatureTelemetry["tubes"] = {};
    const c = Math.max(1, this.rmsCount);
    for (const [name, t] of Object.entries(this.sim.tubes)) {
      const areas = new Float32Array(t.n);
      const rms = new Float32Array(t.n);
      const net = this.sim.net!;
      const acc = this.rmsAcc[name], mean = this.meanAcc[name];
      for (let k = 0; k < t.n; k++) {
        areas[k] = net.area[t.first + k];
        const m = mean[k] / c;
        rms[k] = Math.sqrt(Math.max(0, acc[k] / c - m * m));
      }
      acc.fill(0);
      mean.fill(0);
      tubes[name] = { areas, rms };
    }
    this.rmsCount = 0;
    const outRms = Math.sqrt(this.outAcc / Math.max(1, this.outCount));
    this.outAcc = 0;
    this.outCount = 0;
    return { kind: "creature", id: this.def.id, params: { ...this.value }, gate: this.gate, outRms, clock: this.clock, tubes, source: this.sim.sourceState?.() ?? {}, call: this.activeCall };
  }
}
