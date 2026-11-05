/** Human-voice audio fixtures: timed operations on a voice, and the samples it rendered. */
import { HumanVoice } from "../../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../../src/engine/phonetics/ipa.ts";
import type { Gesture } from "../../src/engine/control/score.ts";
import type { HumanArtic } from "../../src/engine/anatomy/human.ts";
import { BODIES, write, writeF32 } from "./lib.ts";


/** One timed operation on a voice, applied before rendering sample `at`. */
type VoiceOp =
  | { at: number; op: "gate"; level: number }
  | { at: number; op: "artic"; values: Partial<HumanArtic>; tipFree?: boolean }
  | { at: number; op: "source"; values: Record<string, number | boolean> }
  | { at: number; op: "schedule"; gestures: Gesture[]; offset: number }
  | { at: number; op: "release"; tag: number }
  | { at: number; op: "cancel" };
interface VoiceScenario {
  name: string;
  body: string;
  fsOut: number;
  oversample: number;
  samples: number;
  ops: VoiceOp[];
}

function runVoice(s: VoiceScenario): Float32Array {
  const v = new HumanVoice({ fsOut: s.fsOut, body: BODIES[s.body], oversample: s.oversample });
  const out = new Float32Array(s.samples);
  const ops = [...s.ops].sort((a, b) => a.at - b.at);
  let i = 0, oi = 0;
  while (i < s.samples) {
    while (oi < ops.length && ops[oi].at <= i) {
      const o = ops[oi++];
      if (o.op === "gate") v.setGate(o.level);
      else if (o.op === "artic") v.setArticulation(o.values, o.tipFree);
      else if (o.op === "source") v.setSource(o.values);
      else if (o.op === "schedule") v.schedule(o.gestures.map((g) => ({ ...g, targets: { ...g.targets }, t0: g.t0 + v.clock + o.offset, t1: g.t1 + v.clock + o.offset })));
      else if (o.op === "release") v.release(o.tag);
      else v.cancelScore();
    }
    const next = Math.min(s.samples, i + 128, oi < ops.length ? Math.max(i + 1, ops[oi].at) : Infinity);
    v.render(out, i, next - i);
    i = next;
  }
  return out;
}

function plan(ipa: string, body: string, f0: number) {
  return planUtterance(tokenizeIpa(ipa), { body, t0: 0, f0 }).gestures;
}

{
  const FS = 48000;
  const sec = (x: number) => Math.round(x * FS);
  const scenarios: VoiceScenario[] = [
    { name: "sustain-male", body: "male", fsOut: FS, oversample: 2, samples: sec(0.6), ops: [{ at: 0, op: "gate", level: 1 }, { at: sec(0.45), op: "gate", level: 0 }] },
    {
      name: "artic-sweep",
      body: "male",
      fsOut: FS,
      oversample: 2,
      samples: sec(0.8),
      ops: [
        { at: 0, op: "source", values: { f0: 140, breathiness: 0.4, roughness: 0.6, vibratoDepth: 40, fry: 0.2 } },
        { at: 0, op: "gate", level: 1 },
        { at: sec(0.15), op: "artic", values: { tbX: 4.2, tbY: 8.4, jaw: 0.3, lipWidth: 1 } },
        { at: sec(0.35), op: "artic", values: { tbX: 1.6, tbY: 6.0, jaw: 1.6, lipAp: 0.4, lipProt: 0.9 }, tipFree: true },
        { at: sec(0.5), op: "artic", values: { ttX: 7.0, ttY: 9.0, velum: 0.8 }, tipFree: false },
        { at: sec(0.65), op: "source", values: { voiced: false, pressure: 12 } },
      ],
    },
    { name: "speech-male", body: "male", fsOut: FS, oversample: 2, samples: sec(1.6), ops: [{ at: 0, op: "schedule", offset: 0.03, gestures: plan("ˈhɛloʊ ˈwɝld ʃi sɛlz ˈɑpɑ", "male", 110) }] },
    { name: "speech-female-96k", body: "female", fsOut: 96000, oversample: 1, samples: 96000, ops: [{ at: 0, op: "schedule", offset: 0.03, gestures: plan("ˈθɪŋk ə ˈbæd ˈkæt", "female", 205) }] },
    { name: "speech-child", body: "child", fsOut: FS, oversample: 2, samples: sec(1.0), ops: [{ at: 0, op: "schedule", offset: 0.03, gestures: plan("ˈmʌni ˈtʃɪp ˈʒu ˈvæn", "child", 260) }] },
  ];
  // a held note released early (tags), and a cancel mid-phrase
  const held = plan("ˈlɑ", "male", 196).map((g) => (g.t1 >= 0.15 ? { ...g, t1: 1e9, tag: 7 } : g));
  scenarios.push({ name: "release-cancel", body: "male", fsOut: FS, oversample: 2, samples: sec(1.2), ops: [{ at: 0, op: "schedule", offset: 0.01, gestures: held }, { at: sec(0.4), op: "release", tag: 7 }, { at: sec(0.6), op: "schedule", offset: 0.02, gestures: plan("ˈbɑbɑbɑbɑ", "male", 110) }, { at: sec(0.9), op: "cancel" }] });
  for (const s of scenarios) {
    const out = runVoice(s);
    writeF32(`voice-${s.name}`, out);
  }
  write("voice", scenarios);
}
