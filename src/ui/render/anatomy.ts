/**
 * Real-time-MRI style midsagittal renderer for the human model.
 * Tissue: T1-like grayscale (fat/marrow bright, muscle mid, cortical bone & teeth & air black)
 * with soft edges and film grain. Physics overlays: acoustic pressure RMS (hot scale) inside
 * the airway, airflow particles at local particle velocity u = U/A, turbulence at the active
 * noise source. Handles for direct manipulation.
 */
import type { HumanArtic, HumanFrame } from "../../wasm/types.ts";
import type { Vec } from "./geom.ts";
import { rotateAbout, dist, catmullRom } from "./geom.ts";
import type { TelemetryMessage } from "../../worklet/protocol.ts";
import type { VoiceModel } from "../analysis.ts";
import { C, hot, pressureLevel } from "../colors.ts";

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

interface Particle {
  s: number;
  u: number; // lateral position −1..1
  life: number;
  px: number;
  py: number;
}

const VIEW = { x0: -7.2, x1: 12.2, y0: -4.2, y1: 15.8 };

export class AnatomyRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private grain: CanvasPattern | null = null;
  /** tissue shapes, drawn sharp */
  private tissue: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;
  /** the tissue layer softened by one blur pass, with film grain (what gets drawn) */
  private soft: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  /** what the tissue layer was last drawn for: an unchanged frame needs no redraw */
  private tissueFor: { model: VoiceModel; f: HumanFrame } | null = null;
  private particles: Particle[] = [];
  private scale = 20;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private sparkSeed = 1;
  private readonly canFilter: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.tissue = document.createElement("canvas");
    this.tctx = this.tissue.getContext("2d")!;
    this.soft = document.createElement("canvas");
    this.sctx = this.soft.getContext("2d")!;
    this.canFilter = typeof this.tctx.filter === "string";
    this.makeGrain();
    for (let i = 0; i < 170; i++) this.particles.push({ s: Math.random() * 17, u: Math.random() * 2 - 1, life: Math.random(), px: NaN, py: NaN });
  }

  private makeGrain(): void {
    const g = document.createElement("canvas");
    g.width = g.height = 192;
    const gc = g.getContext("2d")!;
    const img = gc.createImageData(192, 192);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gc.putImageData(img, 0, 0);
    this.grain = this.ctx.createPattern(g, "repeat");
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.tissue.width = this.canvas.width;
    this.tissue.height = this.canvas.height;
    this.soft.width = this.canvas.width;
    this.soft.height = this.canvas.height;
    this.tissueFor = null;
    const sx = w / (VIEW.x1 - VIEW.x0);
    const sy = h / (VIEW.y1 - VIEW.y0);
    this.scale = Math.min(sx, sy) * dpr;
    this.ox = (this.canvas.width - (VIEW.x1 - VIEW.x0) * this.scale) / 2 - VIEW.x0 * this.scale;
    this.oy = (this.canvas.height - (VIEW.y1 - VIEW.y0) * this.scale) / 2 + VIEW.y1 * this.scale;
  }

  /** body cm → canvas px */
  X(p: Vec): number {
    return this.ox + p.x * this.scale;
  }
  Y(p: Vec): number {
    return this.oy - p.y * this.scale;
  }
  /** client px → body cm */
  toBody(cx: number, cy: number): Vec {
    return { x: (cx * this.dpr - this.ox) / this.scale, y: (this.oy - cy * this.dpr) / this.scale };
  }
  get pxPerCm(): number {
    return this.scale / this.dpr;
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

  // ------------------------------------------------------------------ drawing helpers
  private path(c: CanvasRenderingContext2D, pts: Vec[], close = true): void {
    c.beginPath();
    c.moveTo(this.X(pts[0]), this.Y(pts[0]));
    for (let i = 1; i < pts.length; i++) c.lineTo(this.X(pts[i]), this.Y(pts[i]));
    if (close) c.closePath();
  }

  private fill(c: CanvasRenderingContext2D, pts: Vec[], color: string): void {
    if (pts.length < 3) return;
    this.path(c, pts);
    c.fillStyle = color;
    c.fill();
  }

  private stroke(c: CanvasRenderingContext2D, pts: Vec[], color: string, w: number, close = false): void {
    if (pts.length < 2) return;
    this.path(c, pts, close);
    c.strokeStyle = color;
    c.lineWidth = w * this.dpr;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.stroke();
  }

  // ------------------------------------------------------------------ main draw
  draw(model: VoiceModel, f: HumanFrame, a: HumanArtic, tele: TelemetryMessage | null, view: ViewFlags, opts: { hover: HandleId | null; drag: HandleId | null; dt: number; bodyLabel: string; formants: number[] }): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this.tissueFor || this.tissueFor.f !== f || this.tissueFor.model !== model) {
      this.drawTissue(model, f, a);
      this.tissueFor = { model, f };
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = C.black;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.soft, 0, 0);

    // acoustic energy inside the airway (section-wise projection of the 1D simulation)
    if (view.pressure && tele) this.drawPressure(model, f, tele);
    if (view.grid) {
      for (const g of f.grid) {
        ctx.beginPath();
        ctx.moveTo(this.X(g.inner), this.Y(g.inner));
        ctx.lineTo(this.X(g.outer), this.Y(g.outer));
        ctx.strokeStyle = "rgba(150, 170, 180, 0.35)";
        ctx.lineWidth = 1 * this.dpr;
        ctx.stroke();
      }
    }
    if (view.particles && tele) this.drawParticles(model, f, tele, opts.dt);
    if (tele) this.drawTurbulence(model, f, tele);
    if (view.calipers) this.drawCalipers(f, tele);
    this.drawHandles(model, f, a, opts.hover, opts.drag);
    this.drawOverlay(f, a, tele, opts.bodyLabel, opts.formants);
  }

  private drawTissue(model: VoiceModel, f: HumanFrame, a: HumanArtic): void {
    const c = this.tctx;
    const t = model.tract;
    const P = (x: number, y: number) => t.P(x, y);
    const J = this.jawFn(model, a);
    const k = t.scale;
    const lar = a.larynx * k;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, this.tissue.width, this.tissue.height);

    const ulOut = f.upperLip.slice(7); // edge → nose
    const llOut = f.lowerLip.slice(7); // edge → chin
    const ulEdge = f.upperLip[6];
    const llEdge = f.lowerLip[6];
    // ---- head silhouette (skin + subcutaneous fat)
    // facial profile in true body coordinates (the oral-region x compression of P() would
    // flatten the nose): subnasale → nose tip → nasion → forehead
    const ph = model.bodyParams.pharynx;
    const B = (x: number, y: number): Vec => ({ x: x * k, y: (y < 7 ? 7 - (7 - y) * ph : y) * k });
    const neckFront = catmullRom([B(2.3, -4.6), B(2.38, -1.5), B(2.52, 0.4), B(3.0, 1.7), J(5.3, 3.0), J(7.25, 3.35), J(7.95, 4.6), J(7.55, 5.7)], 4);
    const face = catmullRom([ulOut[ulOut.length - 1], B(7.05, 10.6), B(7.75, 10.78), B(8.75, 11.05), B(9.25, 11.65), B(8.95, 12.6), B(8.35, 13.9), B(7.7, 15.0), B(7.95, 16.1), B(7.9, 18.1), B(6.9, 20.5)], 4);
    const cranium = catmullRom([B(6.9, 20.5), B(3.0, 22.9), B(-2.2, 22.7), B(-6.9, 19.6), B(-8.7, 15.4), B(-8.3, 11.9), B(-7.4, 8.9), B(-6.8, 4.8), B(-6.6, 0), B(-6.6, -4.6)], 4);
    const head: Vec[] = [...neckFront, ...llOut.slice().reverse(), llEdge, ulEdge, ...ulOut, ...face.slice(1), ...cranium.slice(1)];
    void B;
    this.fill(c, head, C.skin);
    // deeper soft tissue (muscle) leaving a bright fat rim under the skin
    const inset = catmullRom([B(1.85, -4.6), B(1.9, -0.8), B(2.3, 1.6), J(5.2, 3.6), J(6.9, 3.9), J(7.4, 4.9), J(7.2, 5.9), B(6.6, 9.9), B(7.6, 10.9), B(8.55, 11.5), B(8.1, 13.4), B(7.25, 15.2), B(7.45, 18.0), B(3.0, 22.2), B(-2.0, 22.0), B(-6.3, 19.2), B(-7.9, 15.3), B(-7.6, 12.0), B(-6.7, 8.7), B(-6.1, 4.6), B(-6.0, -4.6)], 3);
    this.fill(c, inset, C.muscle);
    // brain (with skull: dark cortex, bright diploë)
    const skull = catmullRom([B(7.0, 16.2), B(7.3, 18.5), B(6.0, 20.7), B(3.0, 22.1), B(-2.0, 22.0), B(-6.3, 19.2), B(-7.9, 15.3), B(-7.4, 12.6), B(-4.6, 12.2), B(-2.2, 13.3), B(1.0, 13.7), B(4.1, 14.1), B(6.2, 14.9)], 4);
    this.fill(c, skull, C.marrow);
    const brain = catmullRom([B(6.55, 16.3), B(6.75, 18.4), B(5.5, 20.1), B(2.8, 21.4), B(-1.9, 21.3), B(-5.8, 18.8), B(-7.1, 15.4), B(-6.7, 13.1), B(-4.4, 12.8), B(-2.1, 13.9), B(1.0, 14.3), B(4.0, 14.7), B(5.9, 15.4)], 4);
    this.fill(c, brain, C.brain);
    this.stroke(c, catmullRom([B(5.4, 19.4), B(2.4, 20.5), B(-1.4, 20.4), B(-4.8, 18.4)], 4), "rgba(255,255,255,0.08)", 3);
    // eye (vitreous dark)
    c.beginPath();
    c.ellipse(this.X(B(6.5, 15.4)), this.Y(B(6.5, 15.4)), 1.1 * this.scale * k, 0.95 * this.scale * k, 0, 0, Math.PI * 2);
    c.fillStyle = "#262626";
    c.fill();
    // cervical spine: vertebral bodies (marrow) with dark cortex, discs, cord
    const wallX = (y: number) => -1.2 - 0.025 * y;
    for (let i = 0; i < 9; i++) {
      const y0 = -4.4 + i * 1.75;
      if (y0 > 10.5) break;
      const x0 = wallX(y0) - 2.25;
      const p0 = P(x0, y0 + 1.4), p1 = P(x0 + 1.6, y0);
      const rr = 0.32 * this.scale * k;
      c.beginPath();
      c.roundRect(this.X(p0), this.Y(p0), this.X(p1) - this.X(p0), this.Y(p1) - this.Y(p0), rr);
      c.fillStyle = C.cortex;
      c.fill();
      const q0 = P(x0 + 0.13, y0 + 1.27), q1 = P(x0 + 1.47, y0 + 0.13);
      c.beginPath();
      c.roundRect(this.X(q0), this.Y(q0), this.X(q1) - this.X(q0), this.Y(q1) - this.Y(q0), rr * 0.7);
      c.fillStyle = C.marrow;
      c.fill();
    }
    this.fill(c, [P(-5.3, -4.6), P(-4.5, -4.6), P(-4.5, 11.8), P(-5.1, 12.4), P(-5.6, 11.6)], "#2e2e2e");
    this.fill(c, [P(-5.1, -4.6), P(-4.7, -4.6), P(-4.72, 11.4), P(-5.15, 11.6)], "#6f6f6f");
    // nasal cavity (air) with turbinates
    const pal = f.outer.slice(f.outer.length - 30); // palate region points (approx)
    void pal;
    const nasalAir = catmullRom([B(0.3, 11.2), B(1.1, 10.25), B(2.7, 10.75), B(4.6, 10.85), B(6.4, 10.65), B(7.6, 10.85), B(8.45, 11.3), B(8.0, 12.2), B(6.7, 13.4), B(4.4, 13.9), B(1.8, 13.6), B(0.2, 12.6)], 4);
    this.fill(c, nasalAir, C.black);
    for (const [cx, cy, rx, ry] of [[3.0, 11.45, 2.1, 0.32], [3.5, 12.45, 1.9, 0.3], [4.0, 13.3, 1.45, 0.22]] as const) {
      c.beginPath();
      c.ellipse(this.X(B(cx, cy)), this.Y(B(cx, cy)), rx * this.scale * k, ry * this.scale * k, -0.04, 0, Math.PI * 2);
      c.fillStyle = "#7d7d7d";
      c.fill();
    }
    // hard palate bone band
    const palOral = this.palatePoints(model);
    const palNasal = palOral.map((p) => ({ x: p.x, y: p.y + 0.55 * k }));
    this.fill(c, [...palOral, ...palNasal.slice().reverse()], C.cortex);
    this.fill(c, [...palOral.map((p) => ({ x: p.x, y: p.y + 0.14 * k })), ...palNasal.map((p) => ({ x: p.x, y: p.y - 0.14 * k })).reverse()], C.marrow);
    // mandible
    const jb = f.jawBone;
    const jbIn = jb.map((p) => ({ x: p.x - 0.0, y: p.y + 0.75 * k }));
    this.fill(c, [...jb, ...jbIn.slice().reverse()], C.cortex);
    this.fill(c, [...jb.map((p) => ({ x: p.x, y: p.y + 0.15 * k })), ...jbIn.map((p) => ({ x: p.x, y: p.y - 0.15 * k })).reverse()], C.marrow);
    // hyoid + thyroid cartilage + trachea
    c.beginPath();
    const hy = { x: P(1.6, 0).x + 0.0, y: P(0, 2.9).y + 0.6 * lar };
    c.ellipse(this.X(hy), this.Y(hy), 0.5 * this.scale * k, 0.28 * this.scale * k, 0.3, 0, Math.PI * 2);
    c.fillStyle = C.marrow;
    c.fill();
    const g = f.glottis;
    const thyroid = [{ x: g.x + 0.75 * k, y: g.y - 1.6 * k }, { x: g.x + 1.75 * k, y: g.y - 0.6 * k }, { x: g.x + 1.95 * k, y: g.y + 1.2 * k }, { x: g.x + 1.45 * k, y: g.y + 1.9 * k }, { x: g.x + 1.15 * k, y: g.y + 1.1 * k }, { x: g.x + 1.3 * k, y: g.y - 0.4 * k }];
    this.fill(c, thyroid, C.cartilage);
    // trachea (air) below the glottis
    const trachea = [{ x: g.x - 0.65 * k, y: g.y }, { x: g.x + 0.75 * k, y: g.y }, { x: g.x + 0.95 * k, y: -4.8 }, { x: g.x - 0.75 * k, y: -4.8 }];
    this.fill(c, trachea, C.black);
    for (let i = 0; i < 4; i++) {
      const y = g.y - (0.9 + i * 1.0) * k;
      if (y < -4.4) break;
      this.fill(c, [{ x: g.x + 0.8 * k, y }, { x: g.x + 1.05 * k, y: y - 0.05 }, { x: g.x + 1.05 * k, y: y - 0.5 * k }, { x: g.x + 0.82 * k, y: y - 0.45 * k }], C.cartilage);
    }
    // ---- airway (carve to black): outer wall, mouth opening, inner wall reversed, epilarynx
    const airway: Vec[] = [];
    const wallAtGlottis = { x: wallX(g.y / k) * k, y: g.y };
    airway.push(g, wallAtGlottis);
    for (const p of f.outer) if (p.y > g.y || p.x > 0) airway.push(p);
    for (let i = f.inner.length - 1; i >= 0; i--) airway.push(f.inner[i]);
    this.fill(c, airway, C.black);
    // mucosal sheen along the outer wall
    this.stroke(c, f.outer.filter((p) => p.y > g.y), "rgba(170,170,170,0.35)", 1.4);
    // ---- articulators
    // tongue with subtle intrinsic-fibre texture
    this.fill(c, f.tongue, C.tongue);
    c.save();
    this.path(c, f.tongue);
    c.clip();
    // genioglossus: fibres fan from the mental spine (behind the chin) up into the dorsum
    const origin = J(6.0, 5.45);
    const tc = f.tongueCenter;
    for (let i = 0; i <= 16; i++) {
      const ang = Math.PI * (0.18 + (0.9 * i) / 16);
      const end = { x: tc.x + Math.cos(ang) * f.tongueRadius * 1.25, y: tc.y + Math.sin(ang) * f.tongueRadius * 1.25 };
      c.beginPath();
      c.moveTo(this.X(origin), this.Y(origin));
      c.quadraticCurveTo(this.X(tc), this.Y({ x: tc.x, y: (tc.y + origin.y) / 2 }), this.X(end), this.Y(end));
      c.strokeStyle = "rgba(0,0,0,0.12)";
      c.lineWidth = 1.1 * this.dpr;
      c.stroke();
    }
    c.restore();
    this.stroke(c, f.tongue.slice(0, Math.floor(f.tongue.length * 0.78)), "rgba(200,200,200,0.28)", 1.2);
    // velum
    this.fill(c, f.velum, C.muscle);
    this.stroke(c, f.velum, "rgba(180,180,180,0.25)", 1, true);
    // lips (orbicularis) – fill between inner and outer surfaces
    this.fill(c, f.upperLip, "#7a7a7a");
    this.fill(c, f.lowerLip, "#7a7a7a");
    // teeth: no MRI signal
    this.fill(c, f.upperTeeth, C.tooth);
    this.fill(c, [...f.lowerTeeth, J(6.8, 6.0), J(6.4, 6.2)], C.tooth);
    // epiglottis cartilage
    this.stroke(c, f.epiglottis.slice(0, 2), "#9a9a9a", 3.2 * k);
    // vocal folds
    this.fill(c, [{ x: g.x - 0.62 * k, y: g.y + 0.05 }, { x: g.x - 0.1, y: g.y + 0.12 * k }, { x: g.x - 0.62 * k, y: g.y + 0.32 * k }], "#8a8a8a");
    this.fill(c, [{ x: g.x + 0.72 * k, y: g.y + 0.05 }, { x: g.x + 0.12, y: g.y + 0.12 * k }, { x: g.x + 0.72 * k, y: g.y + 0.32 * k }], "#8a8a8a");
    // soft edges: one blur pass over the finished layer. A filter set while drawing blurs every
    // fill separately (~60 full-canvas passes a frame), which held the app at a few fps.
    const s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, this.soft.width, this.soft.height);
    if (this.canFilter) s.filter = `blur(${(0.55 * this.dpr).toFixed(2)}px)`;
    s.drawImage(this.tissue, 0, 0);
    s.filter = "none";
    // film grain over tissue (multiplicative-ish), not blurred
    if (this.grain) {
      s.globalCompositeOperation = "overlay";
      s.globalAlpha = 0.22;
      s.fillStyle = this.grain;
      this.path(s, head);
      s.fill();
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
    }
  }

  private palatePoints(model: VoiceModel): Vec[] {
    const t = model.tract;
    const raw: [number, number][] = [[1.0, 9.6], [1.8, 9.92], [2.7, 10.18], [3.6, 10.3], [4.4, 10.25], [5.1, 10.05], [5.7, 9.72], [6.15, 9.36], [6.55, 9.15], [7.0, 9.6]];
    return raw.map(([x, y]) => t.P(x, y));
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

  private nodeValueAtS(values: Float32Array, nodeS: Float64Array, s: number): number {
    // nearest-node lookup (values are per section)
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

  private drawPressure(model: VoiceModel, f: HumanFrame, tele: TelemetryMessage): void {
    const ctx = this.ctx;
    const t = tele.t;
    const nodeS = model.nodeS(t.phLen, t.orLen);
    if (nodeS.length !== t.pressureRms.length) return;
    ctx.globalCompositeOperation = "screen";
    const g = f.grid;
    // epilarynx: glottis → first grid line
    const first = g[0];
    const quads: { pts: Vec[]; s: number }[] = [{ pts: [{ x: f.glottis.x - 0.45, y: f.glottis.y }, { x: f.glottis.x + 0.55, y: f.glottis.y }, first.inner, first.outer], s: first.s * 0.5 }];
    for (let i = 0; i < g.length - 1; i++) quads.push({ pts: [g[i].inner, g[i].outer, g[i + 1].outer, g[i + 1].inner], s: (g[i].s + g[i + 1].s) / 2 });
    for (const q of quads) {
      const lvl = pressureLevel(this.nodeValueAtS(t.pressureRms, nodeS, q.s));
      if (lvl <= 0.01) continue;
      const [r, gg, b] = hot(lvl);
      this.path(ctx, q.pts);
      const col = `rgba(${r | 0},${gg | 0},${b | 0},${0.35 + 0.6 * lvl})`;
      ctx.fillStyle = col;
      ctx.fill();
      // close antialiasing seams between neighbouring sections
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawParticles(model: VoiceModel, f: HumanFrame, tele: TelemetryMessage, dt: number): void {
    const ctx = this.ctx;
    const t = tele.t;
    const nodeS = model.nodeS(t.phLen, t.orLen);
    const areas = new Float32Array(t.phAreas.length + t.orAreas.length);
    areas.set(t.phAreas, 0);
    areas.set(t.orAreas, t.phAreas.length);
    const L = f.lipS;
    ctx.lineCap = "round";
    for (const p of this.particles) {
      const U = this.nodeValueAtS(t.flow, nodeS, p.s);
      const A = Math.max(0.05, this.nodeValueAtS(areas, nodeS, p.s));
      const u = U / A; // particle velocity cm/s
      const vis = Math.sign(u) * 2.2 * Math.log1p(Math.abs(u) / 30); // perceptual speed (cm/s on screen)
      p.s += vis * dt;
      p.life -= dt * 0.25;
      if (p.s > L || p.s < 0 || p.life <= 0 || Math.abs(u) < 3) {
        if (Math.abs(u) < 3 && p.life > 0) {
          // stalled air: keep position, fade
        } else {
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
      const speedA = Math.min(1, Math.abs(vis) / 6);
      if (Number.isFinite(p.px)) {
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(x, y);
        ctx.strokeStyle = `rgba(220, 240, 255, ${0.1 + 0.45 * speedA * Math.min(1, p.life)})`;
        ctx.lineWidth = 1.3 * this.dpr;
        ctx.stroke();
      }
      p.px = x;
      p.py = y;
    }
  }

  private drawTurbulence(model: VoiceModel, f: HumanFrame, tele: TelemetryMessage): void {
    const t = tele.t;
    if (!(t.noiseLevel > 1) || t.noiseNode < 0) return;
    const s = model.branchS(t.noiseNode, t.phLen, t.orLen);
    if (s < 0) return;
    const intensity = Math.min(1, Math.log10(t.noiseLevel) / 3.2);
    if (intensity <= 0.05) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "screen";
    let seed = (this.sparkSeed = (this.sparkSeed * 16807) % 2147483647);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const pos = this.gridPoint(f, s + 0.2 + rnd() * 1.2, rnd() * 2 - 1);
      if (!pos) continue;
      const r = (0.6 + rnd() * 1.6) * this.dpr;
      ctx.beginPath();
      ctx.arc(this.X(pos), this.Y(pos), r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(190, 230, 255, ${0.15 + 0.55 * intensity * rnd()})`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawCalipers(f: HumanFrame, tele: TelemetryMessage | null): void {
    const ctx = this.ctx;
    // narrowest constriction marker
    let mi = -1, ma = Infinity;
    for (let i = 2; i < f.grid.length - 1; i++) if (f.grid[i].area < ma) { ma = f.grid[i].area; mi = i; }
    if (mi >= 0 && ma < 1.2) {
      const g = f.grid[mi];
      ctx.beginPath();
      ctx.moveTo(this.X(g.inner), this.Y(g.inner));
      ctx.lineTo(this.X(g.outer), this.Y(g.outer));
      ctx.strokeStyle = C.caliper;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.stroke();
      for (const e of [g.inner, g.outer]) {
        ctx.beginPath();
        ctx.arc(this.X(e), this.Y(e), 2.2 * this.dpr, 0, Math.PI * 2);
        ctx.fillStyle = C.caliper;
        ctx.fill();
      }
      const label = ma <= 0.0005 ? "closed" : `${ma.toFixed(2)} cm²`;
      this.label(label, this.X(g.outer) + 8 * this.dpr, this.Y(g.outer) - 6 * this.dpr, C.caliper);
    }
    void tele;
  }

  private drawHandles(model: VoiceModel, f: HumanFrame, a: HumanArtic, hover: HandleId | null, drag: HandleId | null): void {
    const ctx = this.ctx;
    for (const h of this.handles(model, f, a)) {
      const x = this.X(h.pos), y = this.Y(h.pos);
      const active = h.id === drag || h.id === hover;
      const r = (active ? 8 : 6) * this.dpr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = active ? C.caliper : C.caliperDim;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r - 3 * this.dpr, y);
      ctx.lineTo(x - r + 3 * this.dpr, y);
      ctx.moveTo(x + r - 3 * this.dpr, y);
      ctx.lineTo(x + r + 3 * this.dpr, y);
      ctx.moveTo(x, y - r - 3 * this.dpr);
      ctx.lineTo(x, y - r + 3 * this.dpr);
      ctx.moveTo(x, y + r - 3 * this.dpr);
      ctx.lineTo(x, y + r + 3 * this.dpr);
      ctx.stroke();
      if (h.id === drag) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5 * this.dpr, 0, Math.PI * 2);
        ctx.fillStyle = C.caliper;
        ctx.fill();
      }
      if (active) this.label(h.label, x + r + 8 * this.dpr, y + 4 * this.dpr, C.caliper);
    }
  }

  private label(text: string, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = `${500} ${12 * this.dpr}px Archivo, system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 4 * this.dpr, y - 12 * this.dpr, w + 8 * this.dpr, 16 * this.dpr);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private drawOverlay(f: HumanFrame, a: HumanArtic, tele: TelemetryMessage | null, bodyLabel: string, formants: number[]): void {
    const ctx = this.ctx;
    const d = this.dpr;
    const W = this.canvas.width, H = this.canvas.height;
    const lineH = 17 * d;
    const pad = 14 * d;
    ctx.font = `${450} ${12.5 * d}px Archivo, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(232, 234, 235, 0.82)";
    ctx.textAlign = "left";
    const tl = [bodyLabel, "Midsagittal, live"];
    tl.forEach((s, i) => ctx.fillText(s, pad, pad + lineH * (i + 0.6)));
    ctx.textAlign = "right";
    const tr = tele ? [`f0 ${tele.t.f0.toFixed(1)} Hz`, `Lungs ${tele.t.pLung.toFixed(1)} cmH₂O`, `Voicing ${(tele.t.voicing * 100).toFixed(0)} %`] : ["Audio off"];
    tr.forEach((s, i) => ctx.fillText(s, W - pad, pad + lineH * (i + 0.6)));
    ctx.textAlign = "left";
    const vp = f.velumPort;
    const bl = [`Tract ${f.length.toFixed(1)} cm`, `Lip opening ${f.lipArea.toFixed(2)} cm²`, vp > 0.02 ? `Velum open ${vp.toFixed(2)} cm²` : "Velum closed"];
    bl.forEach((s, i) => ctx.fillText(s, pad, H - pad - lineH * (bl.length - 1 - i)));
    ctx.textAlign = "right";
    const br = formants.slice(0, 3).map((F, i) => `F${i + 1} ${Math.round(F)} Hz`);
    br.forEach((s, i) => ctx.fillText(s, W - pad, H - pad - lineH * (br.length - 1 - i)));
    ctx.textAlign = "left";
    void a;
  }
}
