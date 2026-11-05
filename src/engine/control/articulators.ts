/**
 * Articulator dynamics: each articulator is a critically damped second-order system tracking
 * its target (Task-Dynamics style), with physiological natural frequencies. Runs at control
 * rate. Velocities are bounded implicitly by the dynamics, so UI drags and gestures produce
 * physiologically plausible motion (and therefore plausible dV/dt in the airway).
 */
import type { HumanArtic } from "../anatomy/human.ts";
import { NEUTRAL, restTip } from "../anatomy/human.ts";

export type ArticKey = keyof HumanArtic;

export const ARTIC_KEYS: ArticKey[] = ["jaw", "tbX", "tbY", "ttX", "ttY", "ttCurl", "root", "lipAp", "lipProt", "lipWidth", "labiodental", "velum", "larynx", "epilarynx", "ventricular", "lateral", "dorsum"];

export interface ArticSpec {
  min: number;
  max: number;
  /** natural frequency (Hz) of the critically damped tracking dynamics */
  hz: number;
}

export const ARTIC_SPECS: Record<ArticKey, ArticSpec> = {
  jaw: { min: -0.1, max: 2.6, hz: 5 },
  tbX: { min: 1.0, max: 4.8, hz: 6.5 },
  tbY: { min: 4.8, max: 9.2, hz: 6.5 },
  ttX: { min: 3.5, max: 8.0, hz: 13 },
  ttY: { min: 5.0, max: 10.8, hz: 13 },
  ttCurl: { min: 0, max: 1, hz: 9 },
  root: { min: -1, max: 1, hz: 5 },
  lipAp: { min: -0.4, max: 2.4, hz: 11 },
  lipProt: { min: -0.2, max: 1.5, hz: 7 },
  lipWidth: { min: 0, max: 1, hz: 7 },
  labiodental: { min: 0, max: 1, hz: 10 },
  velum: { min: 0, max: 1.4, hz: 5 },
  larynx: { min: -1.6, max: 1.6, hz: 3.5 },
  epilarynx: { min: 0, max: 1, hz: 6 },
  ventricular: { min: 0, max: 1, hz: 6 },
  lateral: { min: 0, max: 1, hz: 10 },
  dorsum: { min: 0, max: 1, hz: 9 },
};

export class ArticulatorBank {
  readonly x: HumanArtic = { ...NEUTRAL };
  readonly v: Record<ArticKey, number>;
  readonly target: HumanArtic = { ...NEUTRAL };
  /** when true the tongue tip rests behind the lower incisors (follows jaw & tongue body) */
  tipFree = true;
  /** per-articulator speed multiplier (gestures can request faster/slower motion) */
  readonly speed: Record<ArticKey, number>;
  private readonly omega: Record<ArticKey, number>;

  constructor() {
    this.v = Object.fromEntries(ARTIC_KEYS.map((k) => [k, 0])) as Record<ArticKey, number>;
    this.speed = Object.fromEntries(ARTIC_KEYS.map((k) => [k, 1])) as Record<ArticKey, number>;
    this.omega = Object.fromEntries(ARTIC_KEYS.map((k) => [k, 2 * Math.PI * ARTIC_SPECS[k].hz])) as Record<ArticKey, number>;
    const tip = restTip(NEUTRAL.jaw, NEUTRAL.tbX, NEUTRAL.tbY);
    this.x.ttX = this.target.ttX = tip.x;
    this.x.ttY = this.target.ttY = tip.y;
  }

  setTarget(values: Partial<HumanArtic>): void {
    for (const k of Object.keys(values) as ArticKey[]) {
      const val = values[k];
      if (val === undefined || !Number.isFinite(val)) continue;
      const s = ARTIC_SPECS[k];
      if (!s) continue;
      this.target[k] = Math.min(s.max, Math.max(s.min, val));
    }
  }

  /** Jump immediately (no dynamics), e.g. on voice creation. */
  snap(values: Partial<HumanArtic>): void {
    this.setTarget(values);
    for (const k of ARTIC_KEYS) {
      this.x[k] = this.target[k];
      this.v[k] = 0;
    }
  }

  step(dt: number): void {
    if (this.tipFree) {
      const tip = restTip(this.x.jaw, this.x.tbX, this.x.tbY);
      this.target.ttX = tip.x;
      this.target.ttY = tip.y;
    }
    for (const k of ARTIC_KEYS) {
      const w = this.omega[k] * this.speed[k];
      // semi-implicit Euler on x'' = w²(T − x) − 2w x'  (stable for w·dt < 1)
      const acc = w * w * (this.target[k] - this.x[k]) - 2 * w * this.v[k];
      this.v[k] += acc * dt;
      this.x[k] += this.v[k] * dt;
    }
  }
}
