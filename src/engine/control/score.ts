/**
 * Gestural score (Articulatory-Phonology style). A gesture drives a subset of control keys
 * toward targets over an activation interval with smooth ramps and a blending strength.
 * At each control step, every key's target is the strength-weighted mean of the active
 * gestures' targets, blended with the performer's base value (weight 1 when nothing is active).
 * Consonant gestures use high strength on their articulators; vowel gestures are long and
 * overlapping, so the tongue body keeps moving vowel-to-vowel through consonants (coarticulation).
 */
import type { ArticKey } from "./articulators.ts";

/** Non-articulator control channels a gesture may drive. */
export type SourceKey =
  /** extra glottal abduction (cm², body-scaled at use) */
  | "abduction"
  /** forced glottal closure 0..1 (glottal stop, ejectives) */
  | "closure"
  /** breath pressure multiplier (0 = no breath, 1 = performer's pressure, <0 = ingressive) */
  | "breath"
  /** pitch in Hz (absolute) */
  | "f0"
  /** vibrato depth (cents): singers let it bloom a few hundred ms into a held note */
  | "vibrato";

export type ControlKey = ArticKey | SourceKey;

export interface Gesture {
  t0: number;
  t1: number;
  rampIn: number;
  rampOut: number;
  strength: number;
  targets: Partial<Record<ControlKey, number>>;
  /** articulator speed multiplier while active and during `releaseHold` seconds after t1 */
  speed?: number;
  releaseHold?: number;
  /** label for visualisation (phoneme / gesture name) */
  label?: string;
  /** open-ended gestures (a sung note held until its key is released) end via release(tag) */
  tag?: number;
}

export interface Blended {
  value: number;
  /** total active weight (0 = no gesture controls this key) */
  weight: number;
  speed: number;
}

/** Smooth activation 0..1..0 with cosine ramps. */
export function activation(g: Gesture, t: number): number {
  if (t <= g.t0 - g.rampIn || t >= g.t1 + g.rampOut) return 0;
  if (t < g.t0) {
    const u = (t - (g.t0 - g.rampIn)) / Math.max(1e-6, g.rampIn);
    return 0.5 - 0.5 * Math.cos(Math.PI * u);
  }
  if (t > g.t1) {
    const u = (t - g.t1) / Math.max(1e-6, g.rampOut);
    return 0.5 + 0.5 * Math.cos(Math.PI * u);
  }
  return 1;
}

export class GestureScore {
  private gestures: Gesture[] = [];
  /** end time of the latest gesture (s) */
  end = 0;

  add(g: Gesture): void {
    this.gestures.push(g);
    this.end = Math.max(this.end, g.t1 + g.rampOut + (g.releaseHold ?? 0));
  }

  addAll(gs: Gesture[]): void {
    for (const g of gs) this.add(g);
  }

  clear(): void {
    this.gestures.length = 0;
    this.end = 0;
  }

  /** End every gesture with this tag at time t (those already ended are left alone). */
  release(tag: number, t: number): void {
    for (const g of this.gestures)
      if (g.tag === tag && g.t1 > t) {
        g.t1 = Math.max(g.t0, t);
      }
    let end = 0;
    for (const g of this.gestures) end = Math.max(end, g.t1 + g.rampOut + (g.releaseHold ?? 0));
    this.end = end;
  }

  /** Drop gestures that have fully finished before time t. */
  prune(t: number): void {
    if (this.gestures.length === 0) return;
    this.gestures = this.gestures.filter((g) => g.t1 + g.rampOut + (g.releaseHold ?? 0) > t);
  }

  get size(): number {
    return this.gestures.length;
  }

  /** Active gestures at time t (for visualisation). */
  activeAt(t: number): Gesture[] {
    return this.gestures.filter((g) => activation(g, t) > 0);
  }

  /** Blend for one key at time t. */
  blend(key: ControlKey, t: number, out: Blended): Blended {
    let wsum = 0, vsum = 0, speed = 1;
    for (let i = 0; i < this.gestures.length; i++) {
      const g = this.gestures[i];
      const target = g.targets[key];
      if (target === undefined) continue;
      const act = activation(g, t);
      if (g.speed && g.speed > speed && t >= g.t0 - g.rampIn && t <= g.t1 + g.rampOut + (g.releaseHold ?? 0)) speed = g.speed;
      if (act <= 0) continue;
      const w = act * g.strength;
      wsum += w;
      vsum += w * target;
    }
    out.value = wsum > 0 ? vsum / wsum : 0;
    out.weight = wsum;
    out.speed = speed;
    return out;
  }
}
