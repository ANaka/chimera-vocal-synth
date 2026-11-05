/** Messages between the main thread and the CHIMERA AudioWorklet. */
import type { HumanArtic } from "../engine/anatomy/human.ts";
import type { VoiceSource, VoiceTelemetry } from "../engine/voice/humanVoice.ts";

export type BodyName = "male" | "female" | "child";

export type ToWorklet =
  | { type: "body"; body: BodyName }
  | { type: "artic"; values: Partial<HumanArtic>; tipFree?: boolean }
  | { type: "source"; values: Partial<VoiceSource> }
  | { type: "gate"; level: number }
  | { type: "telemetry"; enabled: boolean };

export interface TelemetryMessage {
  type: "telemetry";
  t: VoiceTelemetry;
  /** fraction of the render-quantum budget used by the engine (smoothed) */
  load: number;
  body: BodyName;
  nPh: number;
  nOr: number;
}

export type FromWorklet = { type: "ready"; sampleRate: number; body: BodyName; nPh: number; nOr: number } | TelemetryMessage | { type: "error"; message: string };
