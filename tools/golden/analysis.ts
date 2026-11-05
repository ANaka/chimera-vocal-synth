/**
 * Frequency-domain oracle and analysis fixtures: transfer functions (the UI's formant pipeline on
 * the human airway, and simple tube networks), findPeaks, FFT/spectra/windows, LPC, YIN and
 * Nelder–Mead. Input signals are stored with the results, so the Rust side runs each function
 * on exactly the same numbers.
 */
import { readFileSync } from "node:fs";
import { AirwayNetwork } from "../../src/engine/airway/network.ts";
import { transferFunction, findPeaks, linspace, type Peak } from "../../src/engine/airway/frequency.ts";
import { HumanAirway } from "../../src/engine/voice/humanAirway.ts";
import { NEUTRAL, type HumanArtic } from "../../src/engine/anatomy/human.ts";
import { FFT, hann, hamming, powerSpectrumDb, nextPow2 } from "../../src/engine/analysis/fft.ts";
import { autocorr, levinson, polyRoots, estimateFormants, lpcEnvelopeDb } from "../../src/engine/analysis/lpc.ts";
import { yinPitch } from "../../src/engine/analysis/pitch.ts";
import { nelderMead } from "../../src/engine/util/optimize.ts";
import { WALL_SOFT, RHO } from "../../src/engine/physics.ts";
import { Rng } from "../../src/engine/util/math.ts";
import TARGETS from "../../src/engine/phonetics/vowelTargets.generated.json";
import { BODIES, OUT, write, num } from "./lib.ts";

const arr = (x: ArrayLike<number>) => Array.from(x, num);
const peaks = (ps: Peak[]) => ps.map((p) => [p.freq, p.bw, p.db].map(num));

// ------------------------------------------------------------ the UI's transfer function
// src/ui/analysis.ts VoiceModel.transfer: 360 log-spaced frequencies, injection at the first
// pharynx node, the glottis port cut, dB with a 1e-12 floor, findPeaks(…, 150) → 5 formants.
const UI_FREQS = (() => {
  const n = 360;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 60 * Math.pow(8000 / 60, i / (n - 1));
  return out;
})();

function postures(body: string): { name: string; artic: HumanArtic }[] {
  const T = TARGETS as unknown as Record<string, Record<string, { artic: Partial<HumanArtic> }>>;
  const v = (ipa: string, extra: Partial<HumanArtic> = {}) => ({ ...NEUTRAL, ...T[body][ipa].artic, ...extra }) as HumanArtic;
  return [
    { name: "neutral", artic: { ...NEUTRAL } },
    { name: "i", artic: v("i") },
    { name: "ɑ", artic: v("ɑ") },
    { name: "u", artic: v("u") },
    { name: "ɝ", artic: v("ɝ") },
    { name: "nasal ə", artic: v("ə", { velum: 0.9 }) },
    { name: "m (lips closed)", artic: { ...NEUTRAL, lipAp: -0.2, velum: 1.0 } },
  ];
}

const human = Object.keys(BODIES).map((body) => {
  // one airway per body, applied posture after posture (as the UI's VoiceModel is)
  const airway = new HumanAirway({ fs: 96000, body: BODIES[body] });
  return {
    body,
    cases: postures(body).map(({ name, artic }) => {
      airway.apply(artic);
      const el = airway.net.linearElements();
      const H = transferFunction(el, airway.pharynx.firstNode, UI_FREQS, [airway.glottisPort]);
      const db = new Float64Array(UI_FREQS.length);
      for (let i = 0; i < UI_FREQS.length; i++) db[i] = 20 * Math.log10(H.mag[i] + 1e-12);
      const ps = findPeaks(UI_FREQS, H.mag, 150);
      return { name, artic, mag: arr(H.mag), pressureDb: arr(H.pressureDb), db: arr(db), peaks: peaks(ps), formants: ps.map((p) => p.freq).slice(0, 5) };
    }),
  };
});

// ------------------------------------------------------------ simple networks
function networks() {
  const out: { name: string; inject: number; cut: number[]; net: AirwayNetwork }[] = [];
  for (const walls of [false, true]) {
    const net = new AirwayNetwork(96000);
    const t = net.addTube({ name: "tract", n: 40, length: 17.5, area: 3, wall: walls ? WALL_SOFT : null });
    net.addRadiation(t.lastNode);
    net.finalize();
    out.push({ name: walls ? "uniform, soft walls" : "uniform, rigid", inject: t.firstNode, cut: [], net });
  }
  {
    // three-way junction, two radiating ends, one squeezed section
    const net = new AirwayNetwork(48000);
    const a = net.addTube({ name: "a", n: 12, length: 8, area: Array.from({ length: 12 }, (_, i) => 1 + 0.3 * i), wall: WALL_SOFT, wallRadiation: 0.25 });
    const b = net.addTube({ name: "b", n: 10, length: 7, area: 2 });
    const c = net.addTube({ name: "c", n: 14, length: 11, area: 1.2, wall: WALL_SOFT });
    net.connect(a.lastNode, b.firstNode);
    net.connect(a.lastNode, c.firstNode);
    net.addRadiation(b.lastNode);
    net.addRadiation(c.lastNode);
    net.finalize();
    out.push({ name: "branched", inject: a.firstNode, cut: [], net });
  }
  {
    // lungs (fixed pressure) → port → tube with a Helmholtz side cavity; then the port cut
    const net = new AirwayNetwork(48000);
    const lung = net.addPressureNode("lung");
    const t = net.addTube({ name: "t", n: 20, length: 15, area: 2.5, wall: WALL_SOFT });
    const port = net.addPort(lung, t.firstNode, { area: 0.4, length: 0.5, extraResistance: (0.5 * RHO * 35000) / 0.4 });
    const cav = net.addCavity("sinus", 12);
    net.addPort(t.node(8), cav, { area: 0.15, length: 0.6, kEntrance: 0, kExit: 0, includeHalfSections: false });
    net.addRadiation(t.lastNode);
    net.finalize();
    out.push({ name: "lungs + side cavity", inject: t.firstNode, cut: [], net });
    out.push({ name: "lungs cut + side cavity", inject: t.firstNode, cut: [port], net });
  }
  return out;
}

const NET_FREQS = linspace(20, 6000, 700);
const nets = networks().map(({ name, inject, cut, net }) => {
  const H = transferFunction(net.linearElements(), inject, NET_FREQS, cut);
  return { name, mag: arr(H.mag), pressureDb: arr(H.pressureDb), peaks: peaks(findPeaks(NET_FREQS, H.mag)) };
});

// ------------------------------------------------------------ findPeaks edge cases
const rng = new Rng(77);
const peakCases = (() => {
  const f = linspace(0, 4000, 801);
  const res = (fr: number, f0: number, bw: number) => 1 / Math.hypot(1 - (fr / f0) ** 2, (bw / f0) * (fr / f0));
  const smooth = Array.from(f, (x) => res(x, 600, 60) + 0.5 * res(x, 1700, 120) + 0.3 * res(x, 3990, 90));
  const noisy = Array.from(f, (_, i) => smooth[i] * (1 + 0.05 * rng.bipolar()));
  // a flat plateau (equal neighbours) and a peak at the last-but-one bin
  const plateau = Array.from(f, (_, i) => (i >= 300 && i < 310 ? 5 : i === 799 ? 9 : 1 + i * 1e-4));
  return [
    { name: "smooth", freqs: arr(f), mag: arr(smooth), minFreq: 80 },
    { name: "noisy", freqs: arr(f), mag: arr(noisy), minFreq: 200 },
    { name: "plateau", freqs: arr(f), mag: arr(plateau), minFreq: 0 },
  ].map((c) => ({ ...c, peaks: peaks(findPeaks(c.freqs, c.mag, c.minFreq)) }));
})();

// ------------------------------------------------------------ signals
/** Impulse train at f0 through cascaded 2-pole resonators at known formants (as tests/analysis). */
function synthVowel(sr: number, f0: number, formants: [number, number][], dur: number): Float64Array {
  const n = Math.round(sr * dur);
  let x = new Float64Array(n);
  const period = sr / f0;
  for (let k = 0; k * period < n; k++) x[Math.round(k * period)] = 1;
  for (const [f, bw] of formants) {
    const r = Math.exp((-Math.PI * bw) / sr);
    const a1 = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    const a2 = -r * r;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] + a1 * (i > 0 ? y[i - 1] : 0) + a2 * (i > 1 ? y[i - 2] : 0);
    x = y;
  }
  return x;
}
const voice = (name: string) => {
  const b = readFileSync(`${OUT}/voice-${name}.f32`);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
// a TS render of the human voice: the sustained male vowel, 48 kHz (frame read from the .f32 in Rust)
const VOICE = { name: "sustain-male", sr: 48000, offset: 9600, len: 2048 };
const voiceFrame = Array.from(voice(VOICE.name).subarray(VOICE.offset, VOICE.offset + VOICE.len));

const vowel16 = Array.from(synthVowel(16000, 110, [[730, 60], [1090, 80], [2440, 120], [3400, 150]], 0.3).subarray(1600, 2112));
const noise = Array.from({ length: 1000 }, () => rng.bipolar());

// ------------------------------------------------------------ FFT
const fftCases = (() => {
  const n = 1024;
  const sig = Array.from({ length: n }, (_, i) => Math.sin(0.05 * i) + 0.3 * Math.cos(0.71 * i + 0.2) + 0.1 * rng.bipolar());
  const re = Float64Array.from(sig), im = new Float64Array(n);
  new FFT(n).transform(re, im);
  const small = new FFT(8), sr = Float64Array.from([1, -2, 3, 0.5, 0, 0, -1, 4]), si = Float64Array.from([0, 1, 0, -1, 2, 0, 0, 0.25]);
  const sIn = { re: [...sr], im: [...si] };
  small.transform(sr, si);
  return {
    input: arr(sig),
    re: arr(re),
    im: arr(im),
    small: { ...sIn, outRe: arr(sr), outIm: arr(si) },
    hann: arr(hann(64)),
    hamming: arr(hamming(101)),
    // frame shorter than the FFT and the window (zero-padded), and a voice frame
    psdNoise: arr(powerSpectrumDb(noise, new FFT(1024), hann(1000))),
    psdVoice: arr(powerSpectrumDb(voiceFrame, new FFT(2048), hamming(2048))),
    nextPow2: [1, 2, 3, 1000, 1024, 1025, 0.5].map((x) => [x, nextPow2(x)]),
  };
})();

// ------------------------------------------------------------ LPC
function lpcCase(name: string, frame: number[], sr: number, order: number, opts: Parameters<typeof estimateFormants>[2]) {
  const r = autocorr(frame, order);
  const { a, err } = levinson(r, order);
  const roots = polyRoots(a);
  const envFreqs = linspace(0, sr / 2, 200);
  return {
    name,
    sr,
    order,
    opts,
    autocorr: arr(r),
    a: arr(a),
    err: num(err),
    rootsRe: arr(roots.re),
    rootsIm: arr(roots.im),
    envelope: arr(lpcEnvelopeDb(a, err, sr, envFreqs)),
    formants: estimateFormants(frame, sr, opts).map((f) => [f.freq, f.bw].map(num)),
  };
}
const lpc = {
  vowel16: arr(vowel16),
  noise: arr(noise),
  cases: [
    lpcCase("vowel16 order 14, no pre-emphasis", vowel16, 16000, 14, { order: 14, preEmph: 0 }),
    lpcCase("vowel16 defaults", vowel16, 16000, 18, {}),
    lpcCase("noise order 10", noise, 16000, 10, { order: 10, maxBw: 5000, minFreq: 0 }),
    lpcCase("voice order 24", voiceFrame, 48000, 24, { order: 24 }),
    lpcCase("voice defaults (order 50)", voiceFrame, 48000, 50, {}),
  ],
  // a polynomial with known roots: (z − 0.5)(z + 0.25)(z² − z + 0.5)(z² + 0.81)
  known: (() => {
    let c = [1];
    for (const q of [[1, -0.5], [1, 0.25], [1, -1, 0.5], [1, 0, 0.81]]) {
      const next = new Array(c.length + q.length - 1).fill(0);
      c.forEach((x, i) => q.forEach((y, j) => (next[i + j] += x * y)));
      c = next;
    }
    const r = polyRoots(c);
    return { c, re: arr(r.re), im: arr(r.im), short: (() => { const s = polyRoots(c, 5); return { re: arr(s.re), im: arr(s.im) }; })() };
  })(),
};

// ------------------------------------------------------------ YIN
const yinCases = [
  ...[82, 110, 220, 440, 880].map((f0) => ({ name: `vowel ${f0}`, sr: 48000, frame: Array.from(synthVowel(48000, f0, [[500, 80], [1500, 100]], 0.2).subarray(2000, 4400)), opts: { minF0: 60 } })),
  { name: "noise (unvoiced)", sr: 16000, frame: noise, opts: {} },
  { name: "too short", sr: 48000, frame: noise.slice(0, 40), opts: { minF0: 60 } },
  { name: "voice", sr: 48000, frame: null, opts: { minF0: 70, maxF0: 500, threshold: 0.1 } },
].map((c) => {
  const p = yinPitch(c.frame ?? voiceFrame, c.sr, c.opts);
  return { ...c, frame: c.frame && arr(c.frame), f0: num(p.f0), aperiodicity: num(p.aperiodicity) };
});

// ------------------------------------------------------------ Nelder–Mead
const nm = (() => {
  const rosen = (x: number[]) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2;
  const bowl = (x: number[]) => (x[0] - 3) ** 2 + 2 * (x[1] + 1) ** 2 + 0.5 * (x[2] - 0.2) ** 2 + Math.sin(3 * x[0]) * 0.1;
  const counted = (f: (x: number[]) => number) => {
    let n = 0;
    return { f: (x: number[]) => (n++, f(x)), calls: () => n };
  };
  const run = (name: string, fn: (x: number[]) => number, x0: number[], opts: Parameters<typeof nelderMead>[2]) => {
    const c = counted(fn);
    const r = nelderMead(c.f, x0, opts);
    return { name, x0, opts, x: arr(r.x), fx: num(r.fx), iters: r.iters, calls: c.calls() };
  };
  return [
    run("rosenbrock", rosen, [-1.2, 1], {}),
    run("rosenbrock, few iterations", rosen, [-1.2, 1], { maxIter: 25 }),
    run("bounded bowl", bowl, [0, 0, 0], { lo: [-1, -0.5, 0.5], hi: [2, 2, 2], step: [0.3, 0.3, 0.1], tol: 1e-10 }),
  ];
})();

write("analysis", {
  uiFreqs: arr(UI_FREQS),
  human,
  netFreqs: arr(NET_FREQS),
  nets,
  peakCases,
  voice: VOICE,
  fft: fftCases,
  lpc,
  yin: yinCases,
  nelderMead: nm,
});
