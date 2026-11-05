/**
 * Creature fixtures: timed operations on a CreatureVoice (calls, gates, parameter changes, stops),
 * the audio it rendered and telemetry snapshots; plus unit sequences for the valve sources.
 *
 * Audio is long (every call of every creature), so the .f32 file keeps 10 ms windows selectively:
 * the first five, every twelfth, and the two around each operation. The JSON lists the kept
 * windows and the RMS of every window, so the whole render's envelope is still compared.
 */
import { writeFileSync } from "node:fs";
import { CREATURES } from "../../src/engine/creatures/index.ts";
import { CreatureVoice, type CreatureTelemetry } from "../../src/engine/creatures/voice.ts";
import type { CreatureDef } from "../../src/engine/creatures/types.ts";
import { LipReed, Whistle, ClickTrain, Bubble } from "../../src/engine/sources/valves.ts";
import { SyrinxLabia } from "../../src/engine/sources/syrinx.ts";
import { OUT, write, num } from "./lib.ts";

type Op =
  | { at: number; op: "params"; values: Record<string, number | string> }
  | { at: number; op: "gate"; level: number }
  | { at: number; op: "call"; id: string; pitch?: number; amp?: number }
  | { at: number; op: "stop" }
  | { at: number; op: "telemetry" };

interface Scenario {
  name: string;
  creature: string;
  fsOut: number;
  samples: number;
  initial?: Record<string, number | string>;
  ops: Op[];
}

const parse = (x: number | string) => (typeof x === "string" ? Number(x) : x);
const parseRec = (r: Record<string, number | string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, parse(v)]));

function snap(t: CreatureTelemetry) {
  const tubes: Record<string, { areas: number[]; rms: number[] }> = {};
  for (const [k, v] of Object.entries(t.tubes)) tubes[k] = { areas: Array.from(v.areas), rms: Array.from(v.rms) };
  return { ...t, tubes };
}

function run(s: Scenario, def: CreatureDef) {
  const v = new CreatureVoice(def, s.fsOut, s.initial ? parseRec(s.initial) : undefined);
  const out = new Float32Array(s.samples);
  const ops = [...s.ops].sort((a, b) => a.at - b.at);
  const snaps: unknown[] = [];
  let i = 0, oi = 0;
  while (i < s.samples) {
    while (oi < ops.length && ops[oi].at <= i) {
      const o = ops[oi++];
      if (o.op === "params") v.setParams(parseRec(o.values));
      else if (o.op === "gate") v.setGate(o.level);
      else if (o.op === "call") v.playCall(o.id, o.pitch, o.amp);
      else if (o.op === "stop") v.stopCall();
      else snaps.push(snap(v.telemetry()));
    }
    const next = Math.min(s.samples, i + 128, oi < ops.length ? Math.max(i + 1, ops[oi].at) : Infinity);
    v.render(out, i, next - i);
    i = next;
  }
  // telemetry ops at the very end
  while (oi < ops.length) {
    if (ops[oi++].op === "telemetry") snaps.push(snap(v.telemetry()));
  }
  return { out, snaps };
}

const callLength = (def: CreatureDef, id: string) => Math.max(...def.calls.find((c) => c.id === id)!.keys.map((k) => k.t));

// per creature: a pitched call, a param that its calls own, and a param they leave alone
const EXTRA: Record<string, { pitched: [string, number, number]; stop: string; owned: [string, number]; free: [string, number]; held: Record<string, number>[]; initial: Record<string, number | string> }> = {
  songbird: { pitched: ["trill", 4100, 0.7], stop: "flute", owned: ["pitch", 3100], free: ["gape", 0.9], held: [{ pitch: 3400, interval: -5 }, { drive: 0.8, tension: 0.7, voices: 0.9 }, { purity: 0.1, oec: 1.2, pressure: 1.6 }], initial: { pitch: 5200, drive: 2, voices: "NaN", gape: 0.2 } },
  seal: { pitched: ["zap", 4200, 0.8], stop: "trill", owned: ["pitch", 700], free: ["bright", 0.95], held: [{ pitch: 2400, pulse: 0.1 }, { pulseRate: 40, duty: 0.3, rough: 0.6 }, { mouth: 0.9, pressure: 20 }], initial: { pitch: 300, pulseRate: 1, rough: "NaN", mouth: 0.8 } },
  alligator: { pitched: ["growl", 70, 0.6], stop: "bellow", owned: ["chaos", 0.2], free: ["nostrils", 0.1], held: [{ pitch: 45, chaos: 0.3 }, { hiss: 0.6, mouth: 0.5 }, { pressure: 35, nostrils: 0.2 }], initial: { pitch: 60, chaos: 0.1, hiss: 5, pressure: "NaN" } },
  elephant: { pitched: ["rumble", 22, 0.8], stop: "trumpet", owned: ["lipPitch", 600], free: ["trunk", 0.3], held: [{ mode: 1, lipPitch: 420, pressure: 30 }, { chaos: 0.7, lipPitch: 610 }, { mode: 0.4, trunk: 0.2 }], initial: { mode: 1, lipPitch: 350, trunk: -3, chaos: "NaN" } },
};

function scenarios(): Scenario[] {
  const FS = 48000;
  const sec = (x: number, fs = FS) => Math.round(x * fs);
  const list: Scenario[] = [];
  for (const def of CREATURES) {
    const x = EXTRA[def.id];
    def.calls.forEach((c, ci) => {
      const len = callLength(def, c.id) + 0.17;
      const ops: Op[] = [{ at: 0, op: "call", id: c.id }, { at: sec(len * 0.5), op: "telemetry" }];
      // the very first scenario of each creature also captures the preview (telemetry before audio)
      if (ci === 0) ops.unshift({ at: 0, op: "telemetry" });
      list.push({ name: `${def.id}-call-${c.id}`, creature: def.id, fsOut: FS, samples: sec(len), ops });
    });
    const [pid, pitch, amp] = x.pitched;
    list.push({ name: `${def.id}-pitched`, creature: def.id, fsOut: FS, samples: sec(Math.min(0.9, callLength(def, pid) + 0.17)), ops: [{ at: 0, op: "call", id: pid, pitch, amp }, { at: sec(0.3), op: "telemetry" }] });
    list.push({
      name: `${def.id}-held`,
      creature: def.id,
      fsOut: FS,
      samples: sec(0.7),
      ops: [
        { at: 0, op: "gate", level: 1 },
        { at: sec(0.12), op: "params", values: x.held[0] },
        { at: sec(0.12), op: "telemetry" },
        { at: sec(0.25) + 37, op: "params", values: x.held[1] },
        { at: sec(0.4) + 5, op: "params", values: x.held[2] },
        { at: sec(0.4) + 5, op: "telemetry" },
        { at: sec(0.5), op: "gate", level: 0 },
        { at: sec(0.7), op: "telemetry" },
      ],
    });
    // a call replaced by another, performer changes to an owned and a free param during the call, then a stop
    list.push({
      name: `${def.id}-stop`,
      creature: def.id,
      fsOut: FS,
      samples: sec(0.6),
      ops: [
        { at: 0, op: "call", id: def.calls[def.calls.length - 1].id },
        { at: sec(0.08), op: "call", id: x.stop, amp: 1.2 },
        { at: sec(0.15) + 11, op: "params", values: Object.fromEntries([x.owned, x.free]) },
        { at: sec(0.3) + 3, op: "stop" },
        { at: sec(0.3) + 3, op: "telemetry" },
        { at: sec(0.32), op: "gate", level: 0.8 },
        { at: sec(0.45), op: "gate", level: 0 },
      ],
    });
    list.push({ name: `${def.id}-initial`, creature: def.id, fsOut: FS, samples: sec(0.4), initial: x.initial, ops: [{ at: 0, op: "telemetry" }, { at: 0, op: "gate", level: 2 }, { at: sec(0.3), op: "gate", level: 0 }, { at: sec(0.4), op: "telemetry" }] });
  }
  // 96 kHz: the oversampling factor halves
  list.push({ name: "songbird-96k", creature: "songbird", fsOut: 96000, samples: sec(0.5, 96000), ops: [{ at: 0, op: "call", id: "chirps", pitch: 3800 }, { at: sec(0.25, 96000), op: "telemetry" }] });
  list.push({ name: "elephant-96k", creature: "elephant", fsOut: 96000, samples: sec(0.4, 96000), ops: [{ at: 0, op: "call", id: "squeak" }, { at: sec(0.3, 96000), op: "telemetry" }] });
  return list;
}

function keptWindows(s: Scenario, win: number): number[] {
  const n = Math.ceil(s.samples / win);
  const keep = new Set<number>();
  for (let w = 0; w < n; w++) if (w < 5 || w % 12 === 0) keep.add(w);
  for (const o of s.ops) {
    const w = Math.floor(o.at / win);
    if (w < n) keep.add(w);
    if (w + 1 < n) keep.add(w + 1);
  }
  return [...keep].sort((a, b) => a - b);
}

{
  const all = scenarios();
  const fixtures: unknown[] = [];
  const chunks: Float32Array[] = [];
  let offset = 0;
  for (const s of all) {
    const def = CREATURES.find((c) => c.id === s.creature)!;
    const { out, snaps } = run(s, def);
    const win = Math.round(s.fsOut / 100);
    const windows = keptWindows(s, win);
    const env: number[] = [];
    for (let a = 0; a < s.samples; a += win) {
      let e = 0;
      const b = Math.min(s.samples, a + win);
      for (let i = a; i < b; i++) e += out[i] * out[i];
      env.push(Math.sqrt(e / (b - a)));
    }
    let len = 0;
    for (const w of windows) {
      const part = out.subarray(w * win, Math.min(s.samples, (w + 1) * win));
      chunks.push(part);
      len += part.length;
    }
    fixtures.push({ ...s, win, windows, offset, length: len, env, snaps });
    offset += len;
  }
  const audio = new Float32Array(offset);
  let o = 0;
  for (const c of chunks) {
    audio.set(c, o);
    o += c.length;
  }
  writeFileSync(`${OUT}/creatures.f32`, Buffer.from(audio.buffer));
  console.log(`creatures.f32  ${(audio.byteLength / 1024).toFixed(0)} KB`);
  write("creatures", fixtures);
}

// --- valve sources: per-sample sequences ---------------------------------------------------------
{
  const N = 2000;
  const NB = 4000;
  const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => num(f(i)));
  const out: Record<string, unknown> = {};
  {
    const fs = 48000;
    const a = new LipReed(fs);
    out.lipDefault = seq(N, (i) => a.next(2500 + 3000 * Math.sin((2 * Math.PI * 180 * i) / fs)));
    const b = new LipReed(fs);
    b.f = 470;
    b.zeta = 0.08;
    b.h0 = 0.003;
    b.width = 2.4;
    b.surfacePerMass = 40;
    // a buzzing valve: the pressure drop follows the opening (a crude tube load)
    let y = 0;
    out.lipBuzz = seq(N, (i) => {
      const dp = (i < Math.floor((N * 2) / 3) ? 400 : -300) - 2e3 * y;
      y = b.next(dp);
      return y;
    });
  }
  {
    const fs = 96000;
    const w = new Whistle(fs);
    w.f = 1800;
    out.whistle = seq(N, (i) => w.next(i < Math.floor((N * 11) / 15) ? 0.8 : 0.01, 900 * Math.sin((2 * Math.PI * 1750 * i) / fs), 1.5));
  }
  {
    const fs = 48000;
    const c = new ClickTrain(fs);
    c.click(0.001);
    c.click(0.0012, 0.5);
    c.click(0.004, -0.8);
    out.clicksPlain = seq(400, () => c.next());
    c.ring = 3200;
    c.ringDecay = 0.0015;
    c.click(0.0005, 1);
    c.click(0.003, 0.6);
    c.click(0.0031, 0.3);
    const ring = seq(1200, () => c.next());
    c.click(0.002);
    c.clear();
    out.clicksRing = [...ring, ...seq(200, () => c.next())];
  }
  {
    const fs = 96000;
    const b = new Bubble(fs);
    const ys: (number | string)[] = [];
    const rs: (number | string)[] = [];
    for (let i = 0; i < NB; i++) {
      if (i === 100) b.snap(0.8);
      if (i === Math.floor((NB * 7) / 12)) b.snap(0.3, 0.002);
      ys.push(num(b.next()));
      rs.push(num(b.radius));
    }
    out.bubble = ys;
    out.bubbleRadius = rs;
  }
  {
    const fs = 192000;
    const l = new SyrinxLabia(fs, 1);
    out.syrinx = seq(N, (i) => {
      l.drive = i < Math.floor(N / 2) ? 0.3 : 0.9;
      l.tension = i < Math.floor(N / 3) ? 0.4 : 0.05;
      l.f0 = 2500 + i;
      l.gate = i < Math.floor((N * 5) / 6) ? 1 : 0.2;
      return l.next();
    });
  }
  out.defs = JSON.parse(JSON.stringify(CREATURES.map(({ visual, create, ...rest }) => rest)));
  write("creature-units", out);
}
