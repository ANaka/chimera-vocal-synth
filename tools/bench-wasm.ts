/**
 * Real-time factor of the human voice: the wasm build (as the AudioWorklet runs it) next to the
 * TypeScript engine, on the same speech. Usage: bun tools/bench-wasm.ts (after `bun run wasm`).
 */
import { readFileSync, existsSync } from "node:fs";
import { writeGestures } from "../src/wasm/wire.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const scenario = JSON.parse(readFileSync(`${ROOT}crates/chimera/tests/golden/voice.json`, "utf8")).find((s: { name: string }) => s.name === "speech-male");
const gestures = scenario.ops[0].gestures;
const FS = 48000, SECS = 4, BLOCKS = (FS * SECS) / 128;

const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(`${ROOT}target/wasm32-unknown-unknown/release/chimera_wasm.wasm`)), {}).exports as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
const h = x.engine_new(FS);
writeGestures(x.memory.buffer, x.engine_records(h), gestures, 4000);
x.engine_schedule(h, gestures.length, 0.03, 0);
x.engine_set_gate(h, 1);
let t0 = performance.now();
for (let i = 0; i < BLOCKS; i++) x.engine_render(h, 128);
const wasm = (performance.now() - t0) / 1000;
console.log(`wasm   human male os=2: ${((100 * wasm) / SECS).toFixed(1)}% of one core`);

if (existsSync(`${ROOT}src/engine/voice/humanVoice.ts`)) {
  const { HumanVoice } = await import(`${ROOT}src/engine/voice/humanVoice.ts`);
  const v = new HumanVoice({ fsOut: FS });
  v.schedule(gestures.map((g: { t0: number; t1: number }) => ({ ...g, t0: g.t0 + 0.03, t1: g.t1 + 0.03 })));
  v.setGate(1);
  const out = new Float32Array(128);
  t0 = performance.now();
  for (let i = 0; i < BLOCKS; i++) v.render(out, 0, 128);
  const ts = (performance.now() - t0) / 1000;
  console.log(`TS     human male os=2: ${((100 * ts) / SECS).toFixed(1)}% of one core  (wasm is ${(ts / wasm).toFixed(2)}× faster)`);
}
