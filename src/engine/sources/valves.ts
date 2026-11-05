/**
 * Flow-induced and driven sources beyond the vocal folds.
 *  - LipReed: outward-striking "brass player's lips" valve (elephant trumpet, beatbox lip buzz)
 *  - Whistle: aerodynamic whistle at a narrow constriction (elk bugle), a van der Pol oscillator
 *    coupled to the local acoustic pressure so it pulls toward and locks onto tract resonances
 *  - ClickTrain: impulsive sources (sperm-whale phonic lips, cicada tymbal ribs)
 *  - Bubble: cavitation bubble (Rayleigh–Plesset) for the snapping shrimp
 */

/** Outward-striking lip valve: m·h'' + r·h' + k·(h − h0) = S·(p_up − p_down). Opening area = w·max(h, 0). */
export class LipReed {
  private h = 0;
  private v = 0;
  /** natural frequency (Hz) of the lip mass–spring */
  f = 400;
  /** damping ratio */
  zeta = 0.12;
  /** rest opening (cm): >0 leaks, <0 pressed together */
  h0 = -0.01;
  /** lip width (cm) */
  width = 1.2;
  /** effective pressure surface per unit mass (cm²/g) */
  surfacePerMass = 0.08;
  private readonly dt: number;
  opening = 0;

  constructor(fs: number) {
    this.dt = 1 / fs;
  }

  /** Advance one sample with the pressure difference across the lips; returns the opening area (cm²). */
  next(dp: number): number {
    const w = 2 * Math.PI * this.f;
    const acc = this.surfacePerMass * dp - 2 * this.zeta * w * this.v - w * w * (this.h - this.h0);
    // semi-implicit Euler (stable for w·dt < 1 at the internal rate)
    this.v += acc * this.dt;
    this.h += this.v * this.dt;
    // the lips cannot interpenetrate: inelastic collision at h = 0 with tissue compliance
    if (this.h < -0.05) {
      this.h = -0.05;
      if (this.v < 0) this.v = 0;
    }
    if (this.h > 0.8) {
      this.h = 0.8;
      if (this.v > 0) this.v = 0;
    }
    const a = this.h > 0 ? this.h * this.width : 0;
    this.opening = a;
    return a;
  }
}

/**
 * Supraglottal whistle: van der Pol oscillator excited by the jet (flow through the constriction)
 * and coupled to the local acoustic pressure, so its frequency is pulled toward the tract's
 * resonances (the elk bugle's G0 hops between formants as the tract lengthens).
 */
export class Whistle {
  private x = 0.01;
  private v = 0;
  /** target frequency (Hz) */
  f = 2200;
  /** coupling to the local pressure (frequency pulling) */
  coupling = 0.6;
  private readonly dt: number;
  out = 0;

  constructor(fs: number) {
    this.dt = 1 / fs;
  }

  /** drive 0..1 (jet strength), pLocal = acoustic pressure at the whistle (dyn/cm²). Returns a pressure source (dyn/cm²). */
  next(drive: number, pLocal: number, gain: number): number {
    const w = 2 * Math.PI * this.f;
    const mu = 0.15 * drive;
    // x'' − μ w (1 − x²) x' + w² x = c·w²·p̂
    const pn = Math.max(-1, Math.min(1, pLocal / 2000));
    const acc = mu * w * (1 - this.x * this.x) * this.v - w * w * this.x + this.coupling * w * w * pn * drive;
    this.v += acc * this.dt;
    this.x += this.v * this.dt;
    if (!Number.isFinite(this.x) || Math.abs(this.x) > 5) {
      this.x = 0.01;
      this.v = 0;
    }
    if (drive < 0.02) {
      this.x *= 0.999;
      this.v *= 0.999;
    }
    this.out = this.x * gain * drive;
    return this.out;
  }
}

/** Impulse source: smooth pulses (raised cosine) triggered by events, optionally ringing (tymbal ribs). */
export class ClickTrain {
  private readonly fs: number;
  private pending: { at: number; amp: number }[] = [];
  private t = 0;
  /** click width (s) */
  width = 0.0004;
  /** ring frequency (Hz) and decay (s) for each click; ring = 0 → plain pulse */
  ring = 0;
  ringDecay = 0.002;
  private active: { start: number; amp: number }[] = [];

  constructor(fs: number) {
    this.fs = fs;
  }

  /** Schedule a click after `delay` seconds. */
  click(delay: number, amp = 1): void {
    this.pending.push({ at: this.t + delay, amp });
  }

  clear(): void {
    this.pending.length = 0;
    this.active.length = 0;
  }

  /** Advance one sample; returns the source value (unit-ish). */
  next(): number {
    const t = this.t;
    if (this.pending.length) {
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].at <= t) {
          this.active.push({ start: this.pending[i].at, amp: this.pending[i].amp });
          this.pending.splice(i, 1);
        }
      }
    }
    let y = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      const age = t - c.start;
      const life = this.ring > 0 ? this.width + 6 * this.ringDecay : this.width;
      if (age > life) {
        this.active.splice(i, 1);
        continue;
      }
      if (this.ring > 0) {
        const env = age < this.width ? age / this.width : Math.exp(-(age - this.width) / this.ringDecay);
        y += c.amp * env * Math.sin(2 * Math.PI * this.ring * age);
      } else {
        y += c.amp * 0.5 * (1 - Math.cos((2 * Math.PI * age) / this.width));
      }
    }
    this.t += 1 / this.fs;
    return y;
  }
}

/**
 * Cavitation bubble in water (Rayleigh–Plesset):
 *   R R'' + 1.5 R'² = (p_gas(R) − p∞(t) − 2σ/R − 4μ R'/R) / ρ
 * A "snap" drops the ambient pressure (the claw's jet), the bubble grows, then collapses violently.
 * Radiated pressure ∝ d²V/dt² = 4π(R²R'' + 2RR'²).
 */
export class Bubble {
  private R: number;
  private Rd = 0;
  /** equilibrium radius (m) */
  R0 = 0.0005;
  private readonly dt: number;
  private tension = 0.072;
  private viscosity = 0.0015; // effective, includes thermal/acoustic damping
  private rho = 1000;
  private p0 = 101325;
  private kappa = 1.33;
  /** ambient pressure drop (Pa) while the jet passes, and its time course */
  private dropUntil = 0;
  private dropAmount = 0;
  private t = 0;
  out = 0;

  constructor(fs: number) {
    this.dt = 1 / fs;
    this.R = this.R0;
  }

  /** Trigger a snap: the ambient pressure falls for `dur` seconds (larger drop → larger bubble). */
  snap(strength: number, dur = 0.0012): void {
    this.dropAmount = this.p0 * (0.9 + 0.09 * Math.max(0, Math.min(1, strength)));
    this.dropUntil = this.t + dur;
    this.R = Math.max(this.R, this.R0);
  }

  private acc(R: number, Rd: number, pinf: number): number {
    const pg = (this.p0 + (2 * this.tension) / this.R0) * Math.pow(this.R0 / R, 3 * this.kappa);
    return ((pg - pinf - (2 * this.tension) / R - (4 * this.viscosity * Rd) / R) / this.rho - 1.5 * Rd * Rd) / R;
  }

  /** Advance one audio sample (with adaptive sub-stepping for the collapse); returns radiated pressure (arb.). */
  next(): number {
    const pinf = this.t < this.dropUntil ? this.p0 - this.dropAmount : this.p0;
    let R = this.R, Rd = this.Rd;
    // sub-steps: the collapse is stiff
    const speed = Math.abs(Rd) / Math.max(R, 1e-6);
    const n = Math.min(64, Math.max(2, Math.ceil(speed * this.dt * 20)));
    const h = this.dt / n;
    let a = 0;
    for (let i = 0; i < n; i++) {
      // velocity-Verlet-like midpoint step
      const a1 = this.acc(R, Rd, pinf);
      const Rm = R + 0.5 * h * Rd;
      const Rdm = Rd + 0.5 * h * a1;
      a = this.acc(Math.max(Rm, this.R0 * 0.02), Rdm, pinf);
      R += h * Rdm;
      Rd += h * a;
      if (R < this.R0 * 0.02) {
        R = this.R0 * 0.02;
        Rd = Math.abs(Rd) * 0.3; // lossy rebound
      }
    }
    if (!Number.isFinite(R) || !Number.isFinite(Rd)) {
      R = this.R0;
      Rd = 0;
    }
    this.R = R;
    this.Rd = Rd;
    this.t += this.dt;
    // d²V/dt² / 4π
    const y = R * R * a + 2 * R * Rd * Rd;
    this.out = y;
    return y;
  }

  get radius(): number {
    return this.R;
  }
}
