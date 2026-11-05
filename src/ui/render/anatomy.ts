/**
 * Vector-display midsagittal renderer for the human model (see docs/mockups/play.html).
 * The anatomy is drawn as glowing outlines: blue for the body, the four handled articulators in
 * their slot colours (tongue green, jaw red, lips pink, soft palate white). Physics overlays:
 * acoustic pressure RMS lights each cross-section line of the airway (amber heat), airflow
 * streaks move at the local particle velocity u = U/A, turbulence shows as white dots at the
 * active noise source, and the tongue, jaw and lips leave a fading afterglow.
 *
 * Everything is in CSS pixels; the caller pre-scales the context by devicePixelRatio and adds
 * the glow pass afterwards.
 */
import type { HumanArtic, HumanFrame } from "../../wasm/types.ts";
import type { Vec } from "./geom.ts";
import { rotateAbout, dist, catmullRom } from "./geom.ts";
import type { TelemetryMessage } from "../../worklet/protocol.ts";
import type { VoiceModel } from "../analysis.ts";
import { V, heat, pressureLevel } from "../colors.ts";
import { beam, beamPts, chaikin, dot, handle, ipaGlyph, label, ring, seg, type Pt } from "./vector.ts";

export type HandleId = "tongue" | "tip" | "jaw" | "lips" | "velum" | "larynx";

export interface Handle {
  id: HandleId;
  pos: Vec; // body coordinates (cm)
  label: string;
}

export interface ViewFlags {
  pressure: boolean;
  particles: boolean;
  grid: boolean;
  calipers: boolean;
}

/** an OP-1 style readout in the space under the chin */
export interface Slot {
  label: string;
  value: string;
  unit?: string;
  color: string;
  /** value is an IPA symbol, drawn as strokes */
  ipa?: boolean;
}

interface Particle {
  s: number;
  u: number; // lateral position −1..1
  life: number;
  px: number;
  py: number;
}

/** what the tongue, jaw and lips looked like a moment ago */
interface Echo {
  t: number;
  tongue: Vec[];
  jaw: Vec[];
  upperLip: Pt[];
  lowerLip: Pt[];
}

/** Body-space outlines for one frame (rebuilt when the frame changes). */
interface Geometry {
  f: HumanFrame;
  model: VoiceModel;
  skinLower: Vec[];
  skinUpper: Vec[];
  inset: Vec[];
  skull: Vec[];
  brain: Vec[];
  sulcus: Vec[];
  eye: Vec[];
  lens: Vec[];
  vertebrae: Vec[][];
  cords: Vec[][];
  nasal: Vec[];
  turbinates: Vec[][];
  palOral: Vec[];
  palNasal: Vec[];
  jawLower: Vec[];
  jawUpper: Vec[];
  hyoid: Vec[];
  thyroid: Vec[];
  trachea: Vec[][];
  rings: Vec[][];
  outerWall: Vec[];
  glottisWall: Vec[];
  fibres: Vec[][];
  folds: Vec[][];
  lowerTeeth: Vec[];
}

/** the visible part of the head, in body cm */
const VIEW = { x0: -7.5, x1: 10.25, y0: -4.55, y1: 19.9 };
const ECHO_AGES = [0.09, 0.06, 0.03];

export class AnatomyRenderer {
  private particles: Particle[] = [];
  private scale = 20;
  private ox = 0;
  private oy = 0;
  private w = 0;
  private h = 0;
  /** a narrow screen (a phone): readouts in a row above the head, slots in a row below it */
  private compact = false;
  private sparkSeed = 1;
  private geo: Geometry | null = null;
  private echoes: Echo[] = [];
  private clock = 0;
  private lastEcho = -1;

  constructor() {
    for (let i = 0; i < 170; i++) this.particles.push({ s: Math.random() * 17, u: Math.random() * 2 - 1, life: Math.random(), px: NaN, py: NaN });
  }

  /** size in CSS px */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    // the readouts need room beside the head; a narrow screen moves them above and below it
    this.compact = w < 560 || w / h < 0.95;
    const padX = 12, padT = this.compact ? 62 : 8, padB = this.compact ? 92 : 8;
    this.scale = Math.max(1, Math.min((w - 2 * padX) / (VIEW.x1 - VIEW.x0), (h - padT - padB) / (VIEW.y1 - VIEW.y0)));
    // left-aligned when there is room to spare, so the readouts get the space in front of the face
    const spare = w - 2 * padX - (VIEW.x1 - VIEW.x0) * this.scale;
    this.ox = padX + Math.min(spare / 2, Math.max(0, spare - 220)) - VIEW.x0 * this.scale;
    this.oy = padT + Math.max(0, (h - padT - padB - (VIEW.y1 - VIEW.y0) * this.scale) / 2) + VIEW.y1 * this.scale;
    for (const p of this.particles) p.px = NaN;
  }

  /** body cm → CSS px */
  X(p: Vec): number {
    return this.ox + p.x * this.scale;
  }
  Y(p: Vec): number {
    return this.oy - p.y * this.scale;
  }
  private P(p: Vec): Pt {
    return [this.ox + p.x * this.scale, this.oy - p.y * this.scale];
  }
  /** CSS px (relative to the canvas) → body cm */
  toBody(cx: number, cy: number): Vec {
    return { x: (cx - this.ox) / this.scale, y: (this.oy - cy) / this.scale };
  }
  get pxPerCm(): number {
    return this.scale;
  }

  handles(model: VoiceModel, f: HumanFrame, a: HumanArtic): Handle[] {
    const t = model.tract;
    const J = this.jawFn(model, a);
    const lips = { x: (f.upperLip[6].x + f.lowerLip[6].x) / 2 + 0.15, y: (f.upperLip[6].y + f.lowerLip[6].y) / 2 };
    return [
      { id: "tongue", pos: f.tongueCenter, label: "Tongue body" },
      { id: "tip", pos: f.tip, label: "Tongue tip" },
      { id: "jaw", pos: J(7.5, 4.9), label: "Jaw" },
      { id: "lips", pos: lips, label: "Lips" },
      { id: "velum", pos: f.velum[Math.floor(f.velum.length / 2)], label: "Soft palate" },
      { id: "larynx", pos: { x: f.glottis.x + 1.2 * t.scale, y: f.glottis.y }, label: "Larynx" },
    ];
  }

  private jawFn(model: VoiceModel, a: HumanArtic): (x: number, y: number) => Vec {
    const t = model.tract;
    const k = t.scale;
    const condyle = t.P(-2.5, 10.5);
    const jawRef = t.P(6.95, 7.75);
    const phi = (-Math.max(-0.2, Math.min(3, a.jaw)) * k) / dist(condyle, jawRef);
    return (x: number, y: number) => rotateAbout(t.P(x, y), condyle, phi);
  }

  // ------------------------------------------------------------------ geometry
  private geometry(model: VoiceModel, f: HumanFrame, a: HumanArtic): Geometry {
    if (this.geo && this.geo.f === f && this.geo.model === model) return this.geo;
    const t = model.tract;
    const P = (x: number, y: number) => t.P(x, y);
    const J = this.jawFn(model, a);
    const k = t.scale;
    const lar = a.larynx * k;
    const ph = model.bodyParams.pharynx;
    // facial profile in true body coordinates (P()'s oral-region x compression would flatten the nose)
    const B = (x: number, y: number): Vec => ({ x: x * k, y: (y < 7 ? 7 - (7 - y) * ph : y) * k });
    const ulOut = f.upperLip.slice(7); // edge → nose
    const llOut = f.lowerLip.slice(7); // edge → chin
    const neckFront = catmullRom([B(2.3, -4.6), B(2.38, -1.5), B(2.52, 0.4), B(3.0, 1.7), J(5.3, 3.0), J(7.25, 3.35), J(7.95, 4.6), J(7.55, 5.7)], 4);
    const face = catmullRom([ulOut[ulOut.length - 1], B(7.05, 10.6), B(7.75, 10.78), B(8.75, 11.05), B(9.25, 11.65), B(8.95, 12.6), B(8.35, 13.9), B(7.7, 15.0), B(7.95, 16.1), B(7.9, 18.1), B(6.9, 20.5)], 4);
    const cranium = catmullRom([B(6.9, 20.5), B(3.0, 22.9), B(-2.2, 22.7), B(-6.9, 19.6), B(-8.7, 15.4), B(-8.3, 11.9), B(-7.4, 8.9), B(-6.8, 4.8), B(-6.6, 0), B(-6.6, -4.6)], 4);
    const ellipse = (c: Vec, rx: number, ry: number, rot = 0, n = 40): Vec[] => {
      // rotation is in screen space (y down) in the MRI renderer's convention: negate for body space
      const cr = Math.cos(-rot), sr = Math.sin(-rot);
      const o: Vec[] = [];
      for (let i = 0; i <= n; i++) {
        const an = (i / n) * Math.PI * 2;
        const x = Math.cos(an) * rx, y = Math.sin(an) * ry;
        o.push({ x: c.x + x * cr - y * sr, y: c.y + x * sr + y * cr });
      }
      return o;
    };
    const roundRect = (p0: Vec, p1: Vec, r: number): Vec[] => {
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
      const rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
      const o: Vec[] = [];
      const corner = (cx: number, cy: number, a0: number) => {
        for (let i = 0; i <= 6; i++) {
          const an = a0 + (i / 6) * (Math.PI / 2);
          o.push({ x: cx + Math.cos(an) * rr, y: cy + Math.sin(an) * rr });
        }
      };
      corner(x1 - rr, y1 - rr, 0);
      corner(x0 + rr, y1 - rr, Math.PI / 2);
      corner(x0 + rr, y0 + rr, Math.PI);
      corner(x1 - rr, y0 + rr, (3 * Math.PI) / 2);
      o.push(o[0]);
      return o;
    };
    const wallX = (y: number) => -1.2 - 0.025 * y;
    const vertebrae: Vec[][] = [];
    for (let i = 0; i < 9; i++) {
      const y0 = -4.4 + i * 1.75;
      if (y0 > 10.5) break;
      const x0 = wallX(y0) - 2.25;
      vertebrae.push(roundRect(P(x0, y0 + 1.4), P(x0 + 1.6, y0), 0.32 * k));
    }
    const palRaw: [number, number][] = [[1.0, 9.6], [1.8, 9.92], [2.7, 10.18], [3.6, 10.3], [4.4, 10.25], [5.1, 10.05], [5.7, 9.72], [6.15, 9.36], [6.55, 9.15], [7.0, 9.6]];
    const palOral = palRaw.map(([x, y]) => t.P(x, y));
    // the mandible's body only: its ramus is lateral, not in the midsagittal plane
    const jb = f.jawBone.filter((p) => p.x > 0.8 * k);
    const g = f.glottis;
    const hy = { x: P(1.6, 0).x, y: P(0, 2.9).y + 0.6 * lar };
    const rings: Vec[][] = [];
    for (let i = 0; i < 4; i++) {
      const y = g.y - (0.9 + i * 1.0) * k;
      if (y < -4.4) break;
      rings.push([{ x: g.x + 0.8 * k, y }, { x: g.x + 1.05 * k, y: y - 0.05 }, { x: g.x + 1.05 * k, y: y - 0.5 * k }, { x: g.x + 0.82 * k, y: y - 0.45 * k }, { x: g.x + 0.8 * k, y }]);
    }
    const origin = J(6.0, 5.45);
    const tc = f.tongueCenter;
    const fibres: Vec[][] = [];
    for (let i = 0; i <= 16; i++) {
      const ang = Math.PI * (0.18 + (0.9 * i) / 16);
      const end = { x: tc.x + Math.cos(ang) * f.tongueRadius * 1.25, y: tc.y + Math.sin(ang) * f.tongueRadius * 1.25 };
      const ctrl = { x: tc.x, y: (tc.y + origin.y) / 2 };
      const c: Vec[] = [];
      for (let j = 0; j <= 12; j++) {
        const u = j / 12;
        c.push({ x: (1 - u) * (1 - u) * origin.x + 2 * (1 - u) * u * ctrl.x + u * u * end.x, y: (1 - u) * (1 - u) * origin.y + 2 * (1 - u) * u * ctrl.y + u * u * end.y });
      }
      fibres.push(c);
    }
    const wallAtGlottis = { x: wallX(g.y / k) * k, y: g.y };
    const geo: Geometry = {
      f,
      model,
      skinLower: [...neckFront, ...llOut.slice().reverse()],
      skinUpper: [...ulOut, ...face.slice(1), ...cranium.slice(1)],
      inset: catmullRom([B(1.85, -4.6), B(1.9, -0.8), B(2.3, 1.6), J(5.2, 3.6), J(6.9, 3.9), J(7.4, 4.9), J(7.2, 5.9), B(6.6, 9.9), B(7.6, 10.9), B(8.55, 11.5), B(8.1, 13.4), B(7.25, 15.2), B(7.45, 18.0), B(3.0, 22.2), B(-2.0, 22.0), B(-6.3, 19.2), B(-7.9, 15.3), B(-7.6, 12.0), B(-6.7, 8.7), B(-6.1, 4.6), B(-6.0, -4.6)], 3),
      skull: catmullRom([B(7.0, 16.2), B(7.3, 18.5), B(6.0, 20.7), B(3.0, 22.1), B(-2.0, 22.0), B(-6.3, 19.2), B(-7.9, 15.3), B(-7.4, 12.6), B(-4.6, 12.2), B(-2.2, 13.3), B(1.0, 13.7), B(4.1, 14.1), B(6.2, 14.9)], 4),
      brain: catmullRom([B(6.55, 16.3), B(6.75, 18.4), B(5.5, 20.1), B(2.8, 21.4), B(-1.9, 21.3), B(-5.8, 18.8), B(-7.1, 15.4), B(-6.7, 13.1), B(-4.4, 12.8), B(-2.1, 13.9), B(1.0, 14.3), B(4.0, 14.7), B(5.9, 15.4)], 4),
      sulcus: catmullRom([B(5.4, 19.4), B(2.4, 20.5), B(-1.4, 20.4), B(-4.8, 18.4)], 4),
      eye: ellipse(B(6.5, 15.4), 1.1 * k, 0.95 * k),
      lens: ellipse(B(7.35, 15.4), 0.18 * k, 0.42 * k, 0, 20),
      vertebrae,
      cords: [[P(-5.3, -4.6), P(-4.5, -4.6), P(-4.5, 11.8), P(-5.1, 12.4), P(-5.6, 11.6)], [P(-5.1, -4.6), P(-4.7, -4.6), P(-4.72, 11.4), P(-5.15, 11.6)]],
      nasal: catmullRom([B(0.3, 11.2), B(1.1, 10.25), B(2.7, 10.75), B(4.6, 10.85), B(6.4, 10.65), B(7.6, 10.85), B(8.45, 11.3), B(8.0, 12.2), B(6.7, 13.4), B(4.4, 13.9), B(1.8, 13.6), B(0.2, 12.6)], 4),
      turbinates: ([[3.0, 11.45, 2.1, 0.32], [3.5, 12.45, 1.9, 0.3], [4.0, 13.3, 1.45, 0.22]] as const).map(([cx, cy, rx, ry]) => ellipse(B(cx, cy), rx * k, ry * k, -0.04)),
      palOral,
      palNasal: palOral.map((p) => ({ x: p.x, y: p.y + 0.55 * k })),
      jawLower: jb,
      jawUpper: jb.map((p) => ({ x: p.x, y: p.y + 0.75 * k })),
      hyoid: ellipse(hy, 0.5 * k, 0.28 * k, 0.3, 28),
      thyroid: [{ x: g.x + 0.75 * k, y: g.y - 1.6 * k }, { x: g.x + 1.75 * k, y: g.y - 0.6 * k }, { x: g.x + 1.95 * k, y: g.y + 1.2 * k }, { x: g.x + 1.45 * k, y: g.y + 1.9 * k }, { x: g.x + 1.15 * k, y: g.y + 1.1 * k }, { x: g.x + 1.3 * k, y: g.y - 0.4 * k }, { x: g.x + 0.75 * k, y: g.y - 1.6 * k }],
      trachea: [[{ x: g.x - 0.65 * k, y: g.y }, { x: g.x - 0.75 * k, y: -4.8 }], [{ x: g.x + 0.75 * k, y: g.y }, { x: g.x + 0.95 * k, y: -4.8 }]],
      rings,
      outerWall: f.outer.filter((p) => p.y > g.y || p.x > 0),
      glottisWall: [wallAtGlottis, f.outer.find((p) => p.y > g.y) ?? wallAtGlottis],
      fibres,
      folds: [
        [{ x: g.x - 0.62 * k, y: g.y + 0.05 }, { x: g.x - 0.1, y: g.y + 0.12 * k }, { x: g.x - 0.62 * k, y: g.y + 0.32 * k }, { x: g.x - 0.62 * k, y: g.y + 0.05 }],
        [{ x: g.x + 0.72 * k, y: g.y + 0.05 }, { x: g.x + 0.12, y: g.y + 0.12 * k }, { x: g.x + 0.72 * k, y: g.y + 0.32 * k }, { x: g.x + 0.72 * k, y: g.y + 0.05 }],
      ],
      lowerTeeth: [...f.lowerTeeth, J(6.8, 6.0), J(6.4, 6.2), f.lowerTeeth[0]],
    };
    this.geo = geo;
    return geo;
  }

  // ------------------------------------------------------------------ main draw
  draw(
    ctx: CanvasRenderingContext2D,
    model: VoiceModel,
    f: HumanFrame,
    a: HumanArtic,
    tele: TelemetryMessage | null,
    view: ViewFlags,
    opts: { hover: HandleId | null; drag: HandleId | null; dt: number; formants: number[]; slots: Slot[]; info: string[] },
  ): void {
    this.clock += opts.dt;
    const G = this.geometry(model, f, a);
    const pts = (v: Vec[]) => v.map((p) => this.P(p));
    const line = (v: Vec[], color: string, w: number, o: { alpha?: number; hot?: boolean; close?: boolean } = {}) => beamPts(ctx, pts(v), color, w, o);

    // deep structures, dim blue
    line(G.inset, V.blueDim, 0.9, { alpha: 0.9 });
    line(G.skull, V.blueDim, 0.9, { close: true });
    line(G.brain, V.blueMid, 1.1, { close: true });
    line(G.sulcus, V.blueDim, 0.9);
    line(G.eye, V.blueMid, 1.1);
    line(G.lens, V.blueDim, 0.9);
    for (const v of G.vertebrae) line(v, V.blueDim, 1);
    line(G.cords[0], V.blueDim, 0.8, { alpha: 0.8 });
    line(G.cords[1], V.blueDim, 0.8, { alpha: 0.6 });
    line(G.nasal, V.blueMid, 1, { close: true });
    for (const tb of G.turbinates) line(tb, V.blueDim, 0.9);
    line(G.palOral, V.blueMid, 1.1);
    line(G.palNasal, V.blueMid, 1.1);
    line(G.hyoid, V.blueDim, 1);
    line(G.thyroid, V.blueDim, 1);
    for (const tr of G.trachea) line(tr, V.blueMid, 1);
    for (const r of G.rings) line(r, V.blueDim, 0.9);

    // the airway's cross-section lines: lit by sound pressure, else a dim measurement grid
    if (view.pressure && tele) this.drawPressure(ctx, model, f, tele);
    else if (view.grid) for (const gs of f.grid) seg(ctx, this.X(gs.inner), this.Y(gs.inner), this.X(gs.outer), this.Y(gs.outer), V.blueDim, 0.9, { alpha: 0.7 });
    if (view.particles && tele) this.drawParticles(ctx, model, f, tele, opts.dt);

    // afterglow: where the tongue, jaw and lips were a moment ago
    if (tele && this.clock - this.lastEcho >= 0.028) {
      this.lastEcho = this.clock;
      this.echoes.push({ t: this.clock, tongue: f.tongue.slice(), jaw: G.jawLower, upperLip: chaikin(f.upperLip.map((p) => [p.x, p.y] as Pt)), lowerLip: chaikin(f.lowerLip.map((p) => [p.x, p.y] as Pt)) });
      while (this.echoes.length && this.clock - this.echoes[0].t > 0.12) this.echoes.shift();
    }
    if (tele) {
      ECHO_AGES.forEach((age, i) => {
        const e = this.nearestEcho(this.clock - age);
        if (!e) return;
        const o = 0.1 + 0.07 * i;
        line(e.tongue, V.green, 1, { alpha: o });
        line(e.jaw, V.red, 1, { alpha: o * 0.9 });
        const lip = (q: Pt[]) => beamPts(ctx, q.map(([x, y]) => [this.ox + x * this.scale, this.oy - y * this.scale] as Pt), V.pink, 1, { alpha: o * 0.9 });
        lip(e.upperLip);
        lip(e.lowerLip);
      });
    }

    // skin, airway walls, teeth, folds
    line(G.skinLower, V.blue, 1.7, { hot: true });
    line(G.skinUpper, V.blue, 1.7, { hot: true });
    line(G.outerWall, V.blue, 1.4, { hot: true });
    line(f.inner, V.blue, 1.3, { alpha: 0.9 });
    line(G.glottisWall, V.blue, 1.2, { alpha: 0.8 });
    line(f.epiglottis.slice(0, 3), V.blue, 2.2, { alpha: 0.85 });
    line(f.upperTeeth, V.blueMid, 1.1, { close: true });
    line(G.lowerTeeth, V.blueMid, 1.1);
    for (const fo of G.folds) line(fo, V.blue, 1);

    // the four handled articulators in their slot colours
    const tongueOutline = pts(f.tongue);
    ctx.save();
    const clip = new Path2D();
    tongueOutline.forEach(([x, y], i) => (i ? clip.lineTo(x, y) : clip.moveTo(x, y)));
    clip.closePath();
    ctx.clip(clip);
    for (const fb of G.fibres) line(fb, V.green, 0.8, { alpha: 0.32 });
    ctx.restore();
    // left open: its closing chord runs along the floor of the mouth
    beamPts(ctx, tongueOutline, V.green, 1.6, { hot: true });
    line(G.jawLower, V.red, 1.5, { hot: true });
    line(G.jawUpper, V.red, 1, { alpha: 0.45 });
    const soft = (v: Vec[], it: number) => chaikin(v.map((p) => this.P(p)), it);
    beamPts(ctx, soft(f.upperLip, 2), V.pink, 1.5, { hot: true });
    beamPts(ctx, soft(f.lowerLip, 2), V.pink, 1.5, { hot: true });
    beamPts(ctx, soft(f.velum, 3), V.white, 1.25, { alpha: 0.92 });

    if (tele) this.drawTurbulence(ctx, model, f, tele);
    if (view.calipers) this.drawCalipers(ctx, f);
    this.drawHandles(ctx, model, f, a, opts.hover, opts.drag);
    this.drawReadouts(ctx, opts.formants, opts.info, opts.slots);
  }

  private nearestEcho(t: number): Echo | null {
    let best: Echo | null = null, bd = 0.016;
    for (const e of this.echoes) {
      const d = Math.abs(e.t - t);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private gridPoint(f: HumanFrame, s: number, u: number): Vec | null {
    const g = f.grid;
    if (g.length < 2) return null;
    if (s <= g[0].s) {
      const t = Math.max(0, s / Math.max(0.01, g[0].s));
      const base = f.glottis;
      const mid = { x: (g[0].inner.x + g[0].outer.x) / 2, y: (g[0].inner.y + g[0].outer.y) / 2 };
      const half = 0.35;
      return { x: base.x + (mid.x - base.x) * t + u * half * 0.5, y: base.y + (mid.y - base.y) * t };
    }
    let lo = 0, hi = g.length - 1;
    if (s >= g[hi].s) return null;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (g[m].s <= s) lo = m;
      else hi = m;
    }
    const t = (s - g[lo].s) / Math.max(1e-6, g[hi].s - g[lo].s);
    const ix = g[lo].inner.x + (g[hi].inner.x - g[lo].inner.x) * t;
    const iy = g[lo].inner.y + (g[hi].inner.y - g[lo].inner.y) * t;
    const ox = g[lo].outer.x + (g[hi].outer.x - g[lo].outer.x) * t;
    const oy = g[lo].outer.y + (g[hi].outer.y - g[lo].outer.y) * t;
    const w = 0.5 + 0.5 * u * 0.82;
    return { x: ix + (ox - ix) * w, y: iy + (oy - iy) * w };
  }

  private nodeValueAtS(values: ArrayLike<number>, nodeS: Float64Array, s: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < nodeS.length; i++) {
      const d = Math.abs(nodeS[i] - s);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return values[best] ?? 0;
  }

  private drawPressure(ctx: CanvasRenderingContext2D, model: VoiceModel, f: HumanFrame, tele: TelemetryMessage): void {
    const t = tele.t;
    const nodeS = model.nodeS(t.phLen, t.orLen);
    if (nodeS.length !== t.pressureRms.length) return;
    for (const g of f.grid) {
      const lvl = Math.pow(pressureLevel(this.nodeValueAtS(t.pressureRms, nodeS, g.s)), 0.85);
      seg(ctx, this.X(g.inner), this.Y(g.inner), this.X(g.outer), this.Y(g.outer), heat(lvl), 1.15, { alpha: 0.35 + 0.65 * lvl });
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, model: VoiceModel, f: HumanFrame, tele: TelemetryMessage, dt: number): void {
    const t = tele.t;
    const nodeS = model.nodeS(t.phLen, t.orLen);
    const areas = new Float32Array(t.phAreas.length + t.orAreas.length);
    areas.set(t.phAreas, 0);
    areas.set(t.orAreas, t.phAreas.length);
    const L = f.lipS;
    const path = [new Path2D(), new Path2D(), new Path2D()];
    for (const p of this.particles) {
      const U = this.nodeValueAtS(t.flow, nodeS, p.s);
      const A = Math.max(0.05, this.nodeValueAtS(areas, nodeS, p.s));
      const u = U / A; // particle velocity cm/s
      const vis = Math.sign(u) * 2.2 * Math.log1p(Math.abs(u) / 30); // perceptual speed (cm/s on screen)
      p.s += vis * dt;
      p.life -= dt * 0.25;
      if (p.s > L || p.s < 0 || p.life <= 0 || Math.abs(u) < 3) {
        if (!(Math.abs(u) < 3 && p.life > 0)) {
          p.s = Math.random() * 0.8;
          p.u = Math.random() * 2 - 1;
          p.life = 0.6 + Math.random() * 0.8;
          p.px = NaN;
          continue;
        }
      }
      const pos = this.gridPoint(f, p.s, p.u);
      if (!pos) continue;
      const x = this.X(pos), y = this.Y(pos);
      if (Number.isFinite(p.px)) {
        // three brightness bands, one stroke each
        const band = Math.min(2, Math.floor(Math.min(1, Math.abs(vis) / 6) * Math.min(1, p.life) * 3));
        path[band].moveTo(p.px, p.py);
        path[band].lineTo(x, y);
      }
      p.px = x;
      p.py = y;
    }
    path.forEach((pa, i) => beam(ctx, pa, "#ffe2a8", 1.1, { alpha: 0.16 + 0.2 * i }));
  }

  private drawTurbulence(ctx: CanvasRenderingContext2D, model: VoiceModel, f: HumanFrame, tele: TelemetryMessage): void {
    const t = tele.t;
    if (!(t.noiseLevel > 1) || t.noiseNode < 0) return;
    const s = model.branchS(t.noiseNode, t.phLen, t.orLen);
    if (s < 0) return;
    const intensity = Math.min(1, Math.log10(t.noiseLevel) / 3.2);
    if (intensity <= 0.05) return;
    let seed = (this.sparkSeed = (this.sparkSeed * 16807) % 2147483647);
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 30; i++) {
      const pos = this.gridPoint(f, s + 0.2 + rnd() * 1.2, rnd() * 2 - 1);
      if (!pos) continue;
      dot(ctx, this.X(pos), this.Y(pos), 0.6 + rnd() * 1.4, "#f4fbff", 0.15 + 0.7 * intensity * rnd());
    }
  }

  private drawCalipers(ctx: CanvasRenderingContext2D, f: HumanFrame): void {
    let mi = -1, ma = Infinity;
    for (let i = 2; i < f.grid.length - 1; i++) if (f.grid[i].area < ma) { ma = f.grid[i].area; mi = i; }
    if (mi < 0 || ma >= 1.2) return;
    const g = f.grid[mi];
    const [x0, y0] = this.P(g.inner), [x1, y1] = this.P(g.outer);
    seg(ctx, x0, y0, x1, y1, V.white, 1.4, { hot: true });
    const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
    for (const [x, y] of [[x0, y0], [x1, y1]]) seg(ctx, x - (nx / nl) * 4, y - (ny / nl) * 4, x + (nx / nl) * 4, y + (ny / nl) * 4, V.white, 1.2);
    const lx = Math.max(x0, x1) + 10, ly = Math.min(y0, y1) - 4;
    label(ctx, ma <= 0.0005 ? "CLOSED" : `${ma.toFixed(2)} CM²`, lx, ly, { size: 11, color: V.white, ls: 0.12 });
  }

  private drawHandles(ctx: CanvasRenderingContext2D, model: VoiceModel, f: HumanFrame, a: HumanArtic, hover: HandleId | null, drag: HandleId | null): void {
    const colour: Record<HandleId, string> = { tongue: V.green, jaw: V.red, lips: V.pink, velum: V.white, tip: V.blueMid, larynx: V.blueMid };
    const size: Record<HandleId, number> = { tongue: 8, jaw: 7, lips: 7, velum: 6, tip: 5, larynx: 5 };
    for (const h of this.handles(model, f, a)) {
      const x = this.X(h.pos), y = this.Y(h.pos);
      const active = h.id === drag || h.id === hover;
      handle(ctx, x, y, colour[h.id], size[h.id] + (active ? 2 : 0), active ? 1 : 0.9);
      if (active) {
        ring(ctx, x, y, 28, colour[h.id], 1, { alpha: 0.75 });
        label(ctx, h.label.toUpperCase(), x + 32, y - 18, { size: 12, color: colour[h.id], ls: 0.18 });
      }
    }
  }

  private drawReadouts(ctx: CanvasRenderingContext2D, formants: number[], info: string[], slots: Slot[]): void {
    if (this.compact) return this.drawReadoutsCompact(ctx, formants, info, slots);
    const fx = this.w - 18;
    let y = 26;
    if (formants.length >= 3) {
      ["F1", "F2", "F3"].forEach((lab, i) => {
        label(ctx, lab, fx - 78, y + i * 22, { size: 12, color: V.amber, ls: 0.12, alpha: 0.75 });
        label(ctx, String(Math.round(formants[i])), fx, y + i * 22, { size: 15, color: V.amber, align: "right", ls: 0.08 });
      });
      label(ctx, "HZ", fx, y + 64, { size: 10, color: V.amber, align: "right", alpha: 0.6 });
      y += 110;
    }
    for (const s of info) {
      label(ctx, s, fx, y, { size: 10, color: V.blueMid, align: "right", ls: 0.14 });
      y += 16;
    }
    if (!slots.length) return;
    // the empty space under the chin and in front of the neck
    const gx0 = this.X({ x: 3.35, y: 0 }), gy0 = this.Y({ x: 0, y: 2.05 });
    const cellW = Math.max(60, (this.w - 14 - gx0) / 2);
    const cellH = Math.max(56, Math.min(112, (this.h - 8 - gy0) / 2));
    const big = Math.max(22, Math.min(44, cellH * 0.4, cellW * 0.32));
    slots.slice(0, 4).forEach((s, i) => {
      const cx = gx0 + (i % 2) * cellW, cy = gy0 + Math.floor(i / 2) * cellH;
      dot(ctx, cx + 6, cy + 4, 4, s.color);
      label(ctx, s.label.toUpperCase(), cx + 16, cy + 8, { size: 11, color: s.color, ls: 0.2, alpha: 0.85 });
      const by = cy + 18 + big * 1.1;
      if (s.ipa) ipaGlyph(ctx, cx + big * 0.6, by, s.value, big * 1.45, s.color);
      else label(ctx, s.value.toUpperCase(), cx, by, { size: s.value.length > 3 ? big * 0.82 : big, color: s.color, weight: "m", ls: 0.04 });
      if (s.unit) label(ctx, s.unit.toUpperCase(), s.ipa ? cx + big * 1.5 : cx + (s.value.length > 3 ? 0 : big * 1.64), s.ipa || s.value.length <= 3 ? by : by + 18, { size: 11, color: s.color, ls: 0.16, alpha: 0.7 });
    });
  }

  /** narrow screens: formants and info in two rows on top, the four slots in a row at the bottom */
  private drawReadoutsCompact(ctx: CanvasRenderingContext2D, formants: number[], info: string[], slots: Slot[]): void {
    const w = this.w, h = this.h;
    if (formants.length >= 3) {
      const cw = (w - 24) / 3;
      ["F1", "F2", "F3"].forEach((lab, i) => {
        label(ctx, lab, 12 + i * cw, 18, { size: 10, color: V.amber, ls: 0.12, alpha: 0.75 });
        label(ctx, String(Math.round(formants[i])), 12 + i * cw + 26, 18, { size: 13, color: V.amber, ls: 0.06 });
      });
    }
    label(ctx, info.slice(0, 2).join("   "), 12, 36, { size: 9, color: V.blueMid, ls: 0.12 });
    if (info.length > 2) label(ctx, info.slice(2).join("   "), 12, 50, { size: 9, color: V.blueMid, ls: 0.12 });
    const four = slots.slice(0, 4);
    if (!four.length) return;
    const cw = (w - 24) / four.length, y0 = h - 82;
    const big = Math.max(16, Math.min(30, cw * 0.28));
    four.forEach((s, i) => {
      const cx = 12 + i * cw;
      dot(ctx, cx + 4, y0, 3, s.color);
      label(ctx, s.label.toUpperCase(), cx + 12, y0 + 3, { size: 8, color: s.color, ls: 0.14, alpha: 0.85 });
      const by = y0 + 18 + big;
      if (s.ipa) ipaGlyph(ctx, cx + big * 0.5, by, s.value, big * 1.4, s.color);
      else label(ctx, s.value.toUpperCase(), cx, by, { size: s.value.length > 3 ? big * 0.62 : big, color: s.color, weight: "m", ls: 0.02 });
      if (s.unit) label(ctx, s.unit.toUpperCase(), cx, by + 16, { size: 8, color: s.color, ls: 0.14, alpha: 0.7 });
    });
  }
}
