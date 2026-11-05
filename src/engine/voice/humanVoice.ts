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
import { GestureScore, type Blended, type Gesture } from "../control/score.ts";

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
  /** voice clock (s) for score playheads */
  clock: number;
  /** labels of gestures active now (most recent first) */
  active: string[];
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
  /** gestural score and voice clock (s) */
  readonly score = new GestureScore();
  clock = 0;
  private readonly tmpBlend: Blended = { value: 0, weight: 0, speed: 1 };
  private baseAbduction = 0;
  private baseClosure = 0;
  private scoreF0: number | null = null;

  constructor(opts: { fsOut: number; body?: HumanBody; oversample?: number }) {
    this.fsOut = opts.fsOut;
    this.M = opts.oversample ?? 2;
    this.fs = this.fsOut * this.M;
    this.airway = new HumanAirway({ fs: this.fs, body: opts.body ?? BODY_MALE });
    this.glottis = new ParametricGlottis(this.fs);
    this.dec = new Decimator(this.M);
    this.ctrlEvery = 64 * this.M;
    this.dcCoef = Math.exp((-2 * Math.PI * 25) / this.fsOut);
    this.limHoldN = Math.round(0.025 * this.fsOut);
    this.limRelease = Math.exp(-1 / (0.2 * this.fsOut));
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

  /** Add gestures (times on the voice clock). */
  schedule(gestures: Gesture[]): void {
    this.score.addAll(gestures);
  }

  /** End the open-ended gestures with this tag now (a sung note's key was released). */
  release(tag: number): void {
    this.score.release(tag, this.clock);
  }

  /** Cancel scheduled gestures (speech stops; the voice returns to the performer's posture). */
  cancelScore(): void {
    this.score.clear();
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
    this.baseAbduction = g.abduction;
    this.baseClosure = 0;
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

  private limEnv = 0;
  private limHold = 0;
  private readonly limHoldN: number;
  private readonly limRelease: number;

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
          // output limiter: a peak envelope held for longer than a glottal period, so a loud
          // sung vowel is turned down by a steady gain instead of being squared off; only a
          // rising level touches the soft clip
          const av = Math.abs(v);
          if (av >= this.limEnv) {
            this.limEnv = av;
            this.limHold = this.limHoldN;
          } else if (this.limHold > 0) this.limHold--;
          else this.limEnv *= this.limRelease;
          if (this.limEnv > 0.75) v *= 0.75 / this.limEnv;
          const al = Math.abs(v);
          if (al > 0.85) v = Math.sign(v) * (0.85 + 0.15 * Math.tanh((al - 0.85) / 0.15));
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
    const t = this.clock;
    const score = this.score;
    const tmp = this.tmpBlend;
    let breathAct = 0, breathVal = 0;
    let f0Target = this.source.f0;
    const gp = this.glottis.params;
    if (score.size > 0) {
      // performer's base posture keeps a small say on keys the score controls
      this.artic.step(dt, (k) => score.blend(k, t, tmp), 0.05);
      const k2 = this.airway.body.scale * this.airway.body.scale;
      const ab = score.blend("abduction", t, tmp);
      const abAct = ab.weight > 0 ? Math.min(1, ab.weight / 2) : 0;
      gp.abduction = this.baseAbduction + ab.value * abAct * k2;
      const cl = score.blend("closure", t, tmp);
      gp.closure = Math.max(this.baseClosure, cl.weight > 0 ? cl.value * Math.min(1, cl.weight / 2) : 0);
      const br = score.blend("breath", t, tmp);
      if (br.weight > 0) {
        breathAct = Math.min(1, br.weight);
        breathVal = br.value;
      }
      const vb = score.blend("vibrato", t, tmp);
      gp.vibratoDepth = vb.weight > 0 ? (this.source.vibratoDepth * 0.05 + vb.value * vb.weight) / (0.05 + vb.weight) : this.source.vibratoDepth;
      const pf = score.blend("f0", t, tmp);
      if (pf.weight > 0) {
        f0Target = (this.source.f0 * 0.02 + pf.value * pf.weight) / (0.02 + pf.weight);
        this.scoreF0 = f0Target;
      } else this.scoreF0 = null;
      if (((this.clock * 10) | 0) !== (((this.clock - dt) * 10) | 0)) score.prune(t - 0.2);
    } else {
      this.artic.step(dt);
      gp.abduction = this.baseAbduction;
      gp.closure = this.baseClosure;
      this.scoreF0 = null;
    }
    this.clock += dt;
    // contact constraint on the frame computed anyway; re-apply only if a correction was made
    this.airway.apply(this.artic.x, dt);
    if (this.enforceContacts()) this.airway.reapply(this.artic.x);
    this.airway.net.beginBlock(this.ctrlEvery);
    this.ctrlCounter = this.ctrlEvery;
    // breath: fast attack, slower release; a speaking score breathes on its own
    // a negative breath gesture (ingressive: inward K snares, gasps) overrides the performer's breath
    const scoreBreath = breathVal * breathAct;
    const gateGoal = scoreBreath < 0 ? scoreBreath : Math.max(this.gateTarget, scoreBreath);
    // a score shapes its own breath ramps (beatbox hits end their breath abruptly); the slow
    // release is for the performer's note-offs
    const tau = gateGoal > this.gate ? 0.025 : breathAct > 0 ? 0.02 : 0.07;
    this.gate += (gateGoal - this.gate) * (1 - Math.exp(-dt / tau));
    this.pLung = this.source.pressure * CM_H2O * this.gate;
    // pitch glide
    const g = Math.max(0.002, this.scoreF0 !== null ? 0.03 : this.source.glide);
    this.f0 *= Math.pow(f0Target / this.f0, 1 - Math.exp(-dt / g));
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

  /** tissue may compress this far (cm) before the palate stops the articulator */
  maxPenetration = 0.1;

  /**
   * Contact constraint: articulators cannot travel into the palate. Beyond `maxPenetration` of
   * tissue compression, the tongue tip/body is projected back along the contact normal and its
   * inward velocity removed (inelastic). Keeps held closures still (no air pumping), makes
   * releases start at the surface, and keeps the drawn anatomy physical.
   */
  private enforceContacts(): boolean {
    const tract = this.airway.tract;
    const x = this.artic.x, vel = this.artic.v;
    const k = tract.scale;
    let changed = false;
    const lim = -this.maxPenetration * k;
    const fix = (d: number, n: { x: number; y: number }, kx: "ttX" | "tbX", ky: "ttY" | "tbY") => {
      if (!(d < lim)) return;
      changed = true;
      const depth = lim - d; // > 0, body cm
      // body → template displacement (oral x is compressed by 0.86 in the template map)
      const sx = (x[kx] > 0.5 ? 1 / 0.86 : 1) / k;
      const sy = 1 / k;
      x[kx] += n.x * depth * sx;
      x[ky] += n.y * depth * sy;
      const vn = vel[kx] * n.x / sx + vel[ky] * n.y / sy; // normal velocity (body units)
      if (vn < 0) {
        vel[kx] -= vn * n.x * sx;
        vel[ky] -= vn * n.y * sy;
      }
    };
    fix(tract.contactTip, tract.contactTipN, "ttX", "ttY");
    fix(tract.contactBody, tract.contactBodyN, "tbX", "tbY");
    return changed;
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
      clock: this.clock,
      active: this.score.activeAt(this.clock).filter((g) => g.label && g.label !== "breath" && g.label !== "pitch").map((g) => g.label as string).slice(0, 4),
    };
  }
}
