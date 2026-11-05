/** Engine types as the UI sees them (the JSON shapes of the Rust engine's serde types). */
export type ArticKey = "jaw" | "tbX" | "tbY" | "ttX" | "ttY" | "ttCurl" | "root" | "lipAp" | "lipProt" | "lipWidth" | "labiodental" | "velum" | "larynx" | "epilarynx" | "ventricular" | "lateral" | "dorsum";
export type SourceKey = "abduction" | "closure" | "breath" | "f0" | "vibrato";
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
