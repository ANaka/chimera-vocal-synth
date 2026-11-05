/**
 * Real-time human voice: lungs → parametric glottis → articulated airway, rendered at an
 * oversampled internal rate and decimated. Runs identically in the AudioWorklet and in Bun.
 */
import { HumanAirway } from "./humanAirway.ts";
import { ParametricGlottis } from "../sources/glottis.ts";
import { ArticulatorBank, ARTIC_KEYS } from "../control/articulators.ts";
import { Decimator } from "../airway/decimator.ts";
import { BODY_MALE, type HumanArtic, type HumanBody } from "../anatomy/human.ts";
import { CM_H2O } from "../physics.ts";
import { clamp } from "../util/math.ts";

export interface VoiceSource {
  /** target fundamental frequency (Hz) */
  f0: number;
  /** pitch glide time constant (s) */
  glide: number;
  /** lung pressure while breathing out (cmH2O); negative = ingressive */
  pressure: number;
  /** 0..1 breathy (abducted, chink) */
  breathiness: number;
  /** 0 lax … 1 pressed */
  tension: number;
  /** vocal fry 0..1 */
  fry: number;
  /** jitter / shimmer / period doubling 0..1 */
  roughness: number;
  vibratoDepth: number;
  vibratoRate: number;
  /** random pitch drift (cents) */
  drift: number;
  /** false → whisper (no fold vibration) */
  voiced: boolean;
}

export const DEFAULT_SOURCE: VoiceSource = {
  f0: 110,
  glide: 0.06,
  pressure: 8,
  breathiness: 0.15,
  tension: 0.5,
  fry: 0,
  roughness: 0.1,
  vibratoDepth: 0,
  vibratoRate: 5.5,
  drift: 5,
  voiced: true,
};

export interface VoiceTelemetry {
  artic: Float32Array;
  phAreas: Float32Array;
  orAreas: Float32Array;
  phLen: number;
  orLen: number;
  pressureRms: Float32Array;
  flow: Float32Array;
  velumPort: number;
  glottalArea: Float32Array;
  glottalFlow: Float32Array;
  f0: number;
  voicing: number;
  pLung: number;
  outRms: number;
  noiseLevel: number;
  noiseNode: number;
  gate: number;
}

const SCOPE_LEN = 4096;
const SCOPE_POINTS = 256;

export class HumanVoice {
  readonly fsOut: number;
  readonly M: number;
  readonly fs: number;
  readonly airway: HumanAirway;
  readonly glottis: ParametricGlottis;
  readonly artic = new ArticulatorBank();
  readonly source: VoiceSource = { ...DEFAULT_SOURCE };
  private readonly dec: Decimator;
  private readonly ctrlEvery: number; // internal samples per control step
  private ctrlCounter = 0;
  /** breath gate 0..1 (note on/off) */
  gate = 0;
  private gateTarget = 0;
  private pLung = 0;
  private f0 = DEFAULT_SOURCE.f0;
  outputGain = 5.5e-7;
  private dcX = 0;
  private dcY = 0;
  private readonly dcCoef: number;
  // telemetry accumulators
  private readonly rmsAcc: Float64Array;
  private rmsCount = 0;
  private readonly flowSm: Float64Array;
  private readonly scopeArea = new Float32Array(SCOPE_LEN);
  private readonly scopeFlow = new Float32Array(SCOPE_LEN);
  private scopePos = 0;
  private readonly cycleStarts = new Int32Array(8);
  private cycleIdx = 0;
  private lastPhase = 0;
  private outAcc = 0;
  private outCount = 0;
  private sub = 0;

  constructor(opts: { fsOut: number; body?: HumanBody; oversample?: number }) {
    this.fsOut = opts.fsOut;
    this.M = opts.oversample ?? 2;
    this.fs = this.fsOut * this.M;
    this.airway = new HumanAirway({ fs: this.fs, body: opts.body ?? BODY_MALE });
    this.glottis = new ParametricGlottis(this.fs);
    this.dec = new Decimator(this.M);
    this.ctrlEvery = 64 * this.M;
    this.dcCoef = Math.exp((-2 * Math.PI * 25) / this.fsOut);
    const nTract = this.airway.nPh + this.airway.nOr;
    this.rmsAcc = new Float64Array(nTract);
    this.flowSm = new Float64Array(nTract);
    this.airway.apply(this.artic.x);
    this.airway.net.snapToTargets();
    // smaller bodies radiate more high-frequency (derivative) energy at their higher f0
    this.outputGain *= this.airway.body.scale < 0.95 ? 0.55 : 1;
    this.applySource();
  }

  setArticulation(values: Partial<HumanArtic>, tipFree?: boolean): void {
    if (tipFree !== undefined) this.artic.tipFree = tipFree;
    this.artic.setTarget(values);
  }

  setSource(values: Partial<VoiceSource>): void {
    Object.assign(this.source, values);
    this.applySource();
  }

  /** breath/voice on (1) or off (0); intermediate values scale the pressure */
  setGate(level: number): void {
    this.gateTarget = clamp(level, 0, 1.5);
  }

  private applySource(): void {
    const s = this.source;
    const g = this.glottis.params;
    const k2 = this.airway.body.scale * this.airway.body.scale;
    g.amplitude = 0.17 * k2 * (s.voiced ? 1 : 0);
    g.abduction = (s.voiced ? 0.1 * s.breathiness * s.breathiness : 0.2 + 0.1 * s.breathiness) * k2;
    g.chink = (0.004 + 0.03 * s.breathiness) * k2;
    g.openQuotient = 0.78 - 0.36 * s.tension;
    g.closureSharpness = 0.25 + 0.7 * s.tension;
    g.skew = 0.56 + 0.16 * s.tension;
    g.fry = s.fry;
    g.jitter = 0.003 + 0.035 * s.roughness;
    g.shimmer = 0.02 + 0.22 * s.roughness;
    g.diplophonia = s.roughness > 0.5 ? (s.roughness - 0.5) * 1.4 : 0;
    g.vibratoDepth = s.vibratoDepth;
    g.vibratoRate = s.vibratoRate;
    g.drift = s.drift;
    g.effort = clamp((Math.abs(s.pressure) - 3) / 10, 0, 1);
  }

  /** Render n output samples into out[offset..]. */
  render(out: Float32Array, offset: number, n: number): void {
    const air = this.airway;
    const net = air.net;
    const M = this.M;
    const lungs = air.lungs;
    const sub = air.trachea.lastNode;
    const supra = air.pharynx.firstNode;
    const gp = air.glottisPort;
    const glot = this.glottis;
    const nPh = air.nPh;
    const nOr = air.nOr;
    const phFirst = air.pharynx.firstNode;
    const orFirst = air.oral.firstNode;
    const p = net.p;
    for (let i = 0; i < n; i++) {
      for (let m = 0; m < M; m++) {
        if (this.ctrlCounter <= 0) this.control();
        this.ctrlCounter--;
        net.setFixedPressure(lungs, this.pLung);
        const a = glot.next(p[sub] - p[supra]);
        net.setPortArea(gp, a);
        const y = net.step();
        if (this.dec.push(y)) {
          // output sample
          let v = this.dec.value * this.outputGain;
          // DC blocker
          const hp = v - this.dcX + this.dcCoef * this.dcY;
          this.dcX = v;
          this.dcY = hp;
          v = hp;
          // soft limiter
          const av = Math.abs(v);
          if (av > 0.7) v = Math.sign(v) * (0.7 + 0.3 * Math.tanh((av - 0.7) / 0.3));
          out[offset + i] = v;
          this.outAcc += v * v;
          this.outCount++;
          // glottal scope at output rate
          this.scopeArea[this.scopePos] = a;
          this.scopeFlow[this.scopePos] = net.U[gp];
          const ph = glot.cyclePhase;
          if (ph < this.lastPhase) {
            this.cycleStarts[this.cycleIdx & 7] = this.scopePos;
            this.cycleIdx++;
          }
          this.lastPhase = ph;
          this.scopePos = (this.scopePos + 1) % SCOPE_LEN;
        }
        // decimated RMS accumulation for the pressure visualisation
        if ((++this.sub & 3) === 0) {
          for (let k = 0; k < nPh; k++) {
            const v = p[phFirst + k];
            this.rmsAcc[k] += v * v;
          }
          for (let k = 0; k < nOr; k++) {
            const v = p[orFirst + k];
            this.rmsAcc[nPh + k] += v * v;
          }
          this.rmsCount++;
        }
      }
    }
  }

  /** Control-rate update: articulator dynamics, geometry → areas, breath, pitch. */
  private control(): void {
    const dt = this.ctrlEvery / this.fs;
    this.artic.step(dt);
    this.airway.apply(this.artic.x, dt);
    this.airway.net.beginBlock(this.ctrlEvery);
    this.ctrlCounter = this.ctrlEvery;
    // breath: fast attack, slower release
    const tau = this.gateTarget > this.gate ? 0.025 : 0.07;
    this.gate += (this.gateTarget - this.gate) * (1 - Math.exp(-dt / tau));
    this.pLung = this.source.pressure * CM_H2O * this.gate;
    // pitch glide
    const g = Math.max(0.002, this.source.glide);
    this.f0 *= Math.pow(this.source.f0 / this.f0, 1 - Math.exp(-dt / g));
    this.glottis.params.f0 = this.f0;
    // smoothed mean flow per tract node (for particle speeds)
    const U = this.airway.net.U;
    const a = 1 - Math.exp(-dt / 0.03);
    const nPh = this.airway.nPh;
    for (let k = 0; k < nPh + this.airway.nOr; k++) {
      const br = k < nPh ? this.airway.branchOf(this.airway.pharynx, k) : this.airway.branchOf(this.airway.oral, k - nPh);
      this.flowSm[k] += a * (U[br] - this.flowSm[k]);
    }
  }

  telemetry(): VoiceTelemetry {
    const air = this.airway;
    const nT = air.nPh + air.nOr;
    const artic = new Float32Array(ARTIC_KEYS.length);
    ARTIC_KEYS.forEach((k, i) => (artic[i] = this.artic.x[k]));
    const rms = new Float32Array(nT);
    const c = Math.max(1, this.rmsCount);
    for (let k = 0; k < nT; k++) rms[k] = Math.sqrt(this.rmsAcc[k] / c);
    this.rmsAcc.fill(0);
    this.rmsCount = 0;
    // phase-locked glottal scope: two most recent complete cycles
    const ga = new Float32Array(SCOPE_POINTS);
    const gf = new Float32Array(SCOPE_POINTS);
    let start = (this.scopePos - 1024 + SCOPE_LEN) % SCOPE_LEN;
    let len = 1024;
    if (this.cycleIdx >= 3 && this.glottis.voicing > 0.2) {
      const c2 = this.cycleStarts[(this.cycleIdx - 3) & 7];
      const c0 = this.cycleStarts[(this.cycleIdx - 1) & 7];
      const span = (c0 - c2 + SCOPE_LEN) % SCOPE_LEN;
      if (span > 8 && span < SCOPE_LEN / 2) {
        start = c2;
        len = span;
      }
    }
    for (let i = 0; i < SCOPE_POINTS; i++) {
      const idx = (start + Math.floor((i * len) / SCOPE_POINTS)) % SCOPE_LEN;
      ga[i] = this.scopeArea[idx];
      gf[i] = this.scopeFlow[idx];
    }
    let noiseLevel = 0;
    let noiseNode = -1;
    for (const s of air.net.noiseSources) {
      if (s.level > noiseLevel) {
        noiseLevel = s.level;
        noiseNode = s.src;
      }
    }
    const outRms = Math.sqrt(this.outAcc / Math.max(1, this.outCount));
    this.outAcc = 0;
    this.outCount = 0;
    return {
      artic,
      phAreas: Float32Array.from(air.phAreas),
      orAreas: Float32Array.from(air.orAreas),
      phLen: air.phLen,
      orLen: air.orLen,
      pressureRms: rms,
      flow: Float32Array.from(this.flowSm),
      velumPort: air.frame?.velumPort ?? 0,
      glottalArea: ga,
      glottalFlow: gf,
      f0: this.glottis.f0Now,
      voicing: this.glottis.voicing,
      pLung: this.pLung / CM_H2O,
      outRms,
      noiseLevel,
      noiseNode,
      gate: this.gate,
    };
  }
}
