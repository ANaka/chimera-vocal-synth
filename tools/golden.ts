/**
 * Golden fixtures for the Rust port: runs the TypeScript engine on fixed scenarios and writes
 * what it computed to crates/chimera/tests/golden/, where `cargo test` compares the Rust engine
 * against it. Run once, before the TypeScript engine is retired: bun tools/golden.ts [section…]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { HumanVocalTract, NEUTRAL, BODY_MALE, BODY_FEMALE, BODY_CHILD, type HumanArtic, type HumanBody } from "../src/engine/anatomy/human.ts";
import { ARTIC_KEYS, ARTIC_SPECS } from "../src/engine/control/articulators.ts";
import { Rng } from "../src/engine/util/math.ts";
import TARGETS from "../src/engine/phonetics/vowelTargets.generated.json";

const OUT = "crates/chimera/tests/golden";
mkdirSync(OUT, { recursive: true });
const BODIES: Record<string, HumanBody> = { male: BODY_MALE, female: BODY_FEMALE, child: BODY_CHILD };
const sections = new Set(process.argv.slice(2));
const want = (s: string) => sections.size === 0 || sections.has(s);
const write = (name: string, data: unknown) => {
  const text = JSON.stringify(data);
  writeFileSync(`${OUT}/${name}.json`, text);
  console.log(`${name}.json  ${(text.length / 1024).toFixed(0)} KB`);
};
/** a finite float as JSON keeps all 17 significant digits; NaN/±Infinity become strings */
const num = (x: number) => (Number.isFinite(x) ? x : String(x));

function articCases(): { body: string; artic: HumanArtic }[] {
  const cases: { body: string; artic: HumanArtic }[] = [];
  const T = TARGETS as unknown as Record<string, Record<string, { artic: Partial<HumanArtic> }>>;
  for (const body of Object.keys(BODIES)) {
    cases.push({ body, artic: { ...NEUTRAL } });
    for (const v of Object.values(T[body])) cases.push({ body, artic: { ...NEUTRAL, ...v.artic } });
  }
  const rng = new Rng(2026);
  for (let i = 0; i < 45; i++) {
    const a = { ...NEUTRAL };
    for (const k of ARTIC_KEYS) {
      const s = ARTIC_SPECS[k];
      // half the cases keep the rest of the posture neutral, so contacts and closures occur
      if (i % 2 === 0 || rng.next() < 0.5) a[k] = s.min + (s.max - s.min) * rng.next();
    }
    cases.push({ body: ["male", "female", "child"][i % 3], artic: a });
  }
  return cases;
}

if (want("geometry")) {
  const tracts: Record<string, HumanVocalTract> = {};
  const out = articCases().map(({ body, artic }, i) => {
    // full drawing outlines for a few cases; area functions and contacts for all
    const pts = (ps: { x: number; y: number }[]) => (i % 12 === 0 ? ps.flatMap((p) => [p.x, p.y]) : undefined);
    const t = (tracts[body] ??= new HumanVocalTract(BODIES[body]));
    const f = t.compute(artic);
    const nPh = 18, nOr = 18;
    const ph = new Float64Array(nPh), or = new Float64Array(nOr), phMin = new Float64Array(nPh), orMin = new Float64Array(nOr);
    const { phLen, orLen } = t.resample(artic, f, nPh, nOr, ph, or, phMin, orMin);
    return {
      body,
      artic,
      grid: f.grid.map((g) => [g.region, g.d, g.area, g.s]),
      outer: pts(f.outer),
      inner: pts(f.inner),
      tongue: pts(f.tongue),
      velum: pts(f.velum),
      upperLip: pts(f.upperLip),
      lowerLip: pts(f.lowerLip),
      scalars: [f.length, f.pharynxLength, f.teethS, f.lipS, f.velumPort, f.lipArea, f.tongueRadius, f.tip.x, f.tip.y, f.splitIndex, t.contactTip, t.contactBody, t.contactTipN.x, t.contactTipN.y, t.contactBodyN.x, t.contactBodyN.y].map(num),
      resample: { phLen, orLen, ph: [...ph], or: [...or], phMin: [...phMin], orMin: [...orMin] },
    };
  });
  write("geometry", out);
}

// ------------------------------------------------------------------ audio: the human voice
import { HumanVoice } from "../src/engine/voice/humanVoice.ts";
import { planUtterance } from "../src/engine/phonetics/planner.ts";
import { tokenizeIpa } from "../src/engine/phonetics/ipa.ts";
import type { Gesture } from "../src/engine/control/score.ts";

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

if (want("voice")) {
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
    writeFileSync(`${OUT}/voice-${s.name}.f32`, Buffer.from(out.buffer));
  }
  write("voice", scenarios);
}
