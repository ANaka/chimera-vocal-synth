import { useEffect, useRef } from "react";
import { VoiceModel } from "./analysis.ts";
import { useStore } from "./store.ts";
import { engine } from "../audio/AudioEngine.ts";

/** Shared main-thread acoustic model for the current body (rebuilt on body / sample-rate change). */
const cache = new Map<string, VoiceModel>();

export function getModel(body: string, sampleRate: number): VoiceModel {
  const key = `${body}@${sampleRate}`;
  let m = cache.get(key);
  if (!m) {
    m = new VoiceModel(body as "male" | "female" | "child", sampleRate);
    cache.set(key, m);
  }
  return m;
}

export function useModel(): React.MutableRefObject<VoiceModel | null> {
  const body = useStore((s) => s.body);
  const started = useStore((s) => s.started);
  const ref = useRef<VoiceModel | null>(null);
  ref.current = getModel(body, started ? engine.sampleRate : 48000);
  useEffect(() => {
    ref.current = getModel(body, started ? engine.sampleRate : 48000);
  }, [body, started]);
  return ref;
}
