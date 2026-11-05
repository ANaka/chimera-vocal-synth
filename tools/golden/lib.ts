/**
 * Golden fixtures for the Rust port: each file in tools/golden/ runs the TypeScript engine on
 * fixed scenarios and writes what it computed to crates/chimera/tests/golden/, where `cargo test`
 * compares the Rust engine against it. Run before the TypeScript engine is retired:
 *   bun tools/golden/<area>.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { BODY_MALE, BODY_FEMALE, BODY_CHILD, type HumanBody } from "../../src/engine/anatomy/human.ts";

export const OUT = new URL("../../crates/chimera/tests/golden/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
export const BODIES: Record<string, HumanBody> = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD };

/** Write `<name>.json` (finite floats keep all 17 significant digits). */
export function write(name: string, data: unknown): void {
  const text = JSON.stringify(data);
  writeFileSync(`${OUT}/${name}.json`, text);
  console.log(`${name}.json  ${(text.length / 1024).toFixed(0)} KB`);
}

/** Write `<name>.f32` (little-endian float32 samples). */
export function writeF32(name: string, data: Float32Array): void {
  writeFileSync(`${OUT}/${name}.f32`, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  console.log(`${name}.f32  ${(data.byteLength / 1024).toFixed(0)} KB`);
}

/** NaN and ±Infinity as strings (JSON has no literal for them). */
export const num = (x: number) => (Number.isFinite(x) ? x : String(x));
