/**
 * Human midsagittal articulatory model.
 *
 * Head frame (cm): x forward, y up, glottis at (0,0) for a neutral larynx (adult male template,
 * scaled for other bodies). Fixed outer wall: posterior pharyngeal wall, velum (moves), hard
 * palate, alveolar ridge, upper incisors, upper lip. Moving inner wall: epiglottis, tongue root,
 * tongue body (circle), blade, tip, sublingual floor, lower incisors, lower lip — the lower parts
 * are carried by the jaw (rotation about the condyle).
 *
 * Area function: a semipolar grid (horizontal lines in the pharynx, radial lines in the
 * oral cavity, vertical lines at the teeth/lips) is intersected with both walls; the
 * midsagittal distance d gives area A = α·d^β per region (lips: elliptical slit d·w·π/4).
 * The epilarynx is a short parametric tube above the glottis.
 */
import { type Vec, v, add, sub, scale, lerpV, polar, rotateAbout, Polyline, rayPolyline, bezier3, bezier2, arc, catmullRom, tangentAngle, dist, norm } from "./geom.ts";
import { clamp, lerp } from "../util/math.ts";

export interface HumanArtic {
  /** jaw opening at the incisors (cm) */
  jaw: number;
  /** tongue body centre (cm, head frame) */
  tbX: number;
  tbY: number;
  /** tongue tip (cm, head frame) */
  ttX: number;
  ttY: number;
  /** retroflex curl 0..1 */
  ttCurl: number;
  /** tongue root advance (+) / retraction (−), cm */
  root: number;
  /** lip aperture (cm); negative = compressed */
  lipAp: number;
  /** lip protrusion (cm) */
  lipProt: number;
  /** lip spreading 0 (rounded) .. 1 (spread) */
  lipWidth: number;
  /** lower lip to upper teeth 0..1 */
  labiodental: number;
  /** velopharyngeal port area (cm²) */
  velum: number;
  /** larynx height offset (cm, + raised) */
  larynx: number;
  /** epilaryngeal narrowing 0..1 (twang) */
  epilarynx: number;
  /** ventricular-fold narrowing 0..1 */
  ventricular: number;
  /** lateral channel opening 0..1 (for /l/) */
  lateral: number;
  /** tongue dorsum depression between closures 0..1 (clicks) */
  dorsum: number;
}

export interface HumanBody {
  name: string;
  /** overall size scale (1 = adult male) */
  scale: number;
  /** extra pharynx length scale (female/child have proportionally shorter pharynx) */
  pharynx: number;
  /** tongue body radius (cm, before scale) */
  tongueRadius: number;
  /** max lip width (cm, before scale) */
  lipWidth: number;
}

export const BODY_MALE: HumanBody = { name: "Adult male", scale: 1, pharynx: 1, tongueRadius: 2.25, lipWidth: 4.6 };
export const BODY_FEMALE: HumanBody = { name: "Adult female", scale: 0.9, pharynx: 0.88, tongueRadius: 2.2, lipWidth: 4.4 };
export const BODY_CHILD: HumanBody = { name: "Child", scale: 0.74, pharynx: 0.8, tongueRadius: 2.15, lipWidth: 4.0 };

/** Neutral (schwa-like) articulation for the male template, unscaled coordinates. */
export const NEUTRAL: HumanArtic = {
  jaw: 0.6,
  tbX: 2.9,
  tbY: 6.85,
  ttX: 6.45,
  ttY: 7.3,
  ttCurl: 0,
  root: 0,
  lipAp: 0.7,
  lipProt: 0.2,
  lipWidth: 0.5,
  labiodental: 0,
  velum: 0,
  larynx: 0,
  epilarynx: 0,
  ventricular: 0,
  lateral: 0,
  dorsum: 0,
};

/**
 * Resting tongue-tip position (template coordinates) for a given jaw and tongue body:
 * behind the lower incisors, carried by the jaw and dragged by the tongue body.
 */
export function restTip(jaw: number, tbX: number, tbY: number): { x: number; y: number } {
  const cx = -2.5, cy = 10.5;
  const px = 6.45, py = 7.35;
  const ang = -jaw / 9.84;
  const dx = px - cx, dy = py - cy;
  const x = cx + dx * Math.cos(ang) - dy * Math.sin(ang);
  const y = cy + dx * Math.sin(ang) + dy * Math.cos(ang);
  return { x: x + 0.3 * (tbX - NEUTRAL.tbX), y: y + 0.35 * (tbY - NEUTRAL.tbY) };
}

export interface GridSample {
  inner: Vec;
  outer: Vec;
  mid: Vec;
  /** midsagittal distance (cm), 0 when closed */
  d: number;
  /** area (cm²) */
  area: number;
  /** distance from the glottis along the centreline (cm) */
  s: number;
  region: 0 | 1 | 2 | 3; // 0 epilarynx, 1 pharynx, 2 oral (radial), 3 front (teeth/lips)
}

export interface HumanFrame {
  /** outer wall (posterior pharynx → velum → palate → incisors → upper lip) */
  outer: Vec[];
  /** inner wall (epiglottis → tongue → floor → lower incisors → lower lip) */
  inner: Vec[];
  /** tongue outline for drawing (closed) */
  tongue: Vec[];
  velum: Vec[];
  upperLip: Vec[];
  lowerLip: Vec[];
  upperTeeth: Vec[];
  lowerTeeth: Vec[];
  jawBone: Vec[];
  epiglottis: Vec[];
  nasalCavity: Vec[];
  /** glottis position */
  glottis: Vec;
  grid: GridSample[];
  /** total length glottis → lips (cm) */
  length: number;
  /** length glottis → velopharyngeal junction (cm) */
  pharynxLength: number;
  /** s position of the upper incisor edge (cm from glottis) */
  teethS: number;
  /** s of the lip opening (end) */
  lipS: number;
  velumPort: number;
  lipArea: number;
  tongueCenter: Vec;
  tongueRadius: number;
  tip: Vec;
  /** grid index where the oral tube begins */
  splitIndex: number;
}

const DEG = Math.PI / 180;

export class HumanVocalTract {
  readonly body: HumanBody;
  private readonly k: number; // scale
  // fixed landmarks (scaled)
  private readonly pharWall: Vec[];
  private readonly palate: Vec[];
  private readonly pns: Vec;
  private readonly condyle: Vec;
  private readonly polarC: Vec;
  private readonly polarC2: Vec;
  private readonly tmpT: number[] = new Array(64);
  /** area-law coefficients per region [α, β] */
  areaLaw = {
    pharynx: [2.0, 1.4] as [number, number],
    oral: [2.6, 1.4] as [number, number],
    front: [2.0, 1.4] as [number, number],
  };

  constructor(body: HumanBody = BODY_MALE) {
    this.body = body;
    this.k = body.scale;
    const P = (x: number, y: number) => this.P(x, y);
    // posterior pharyngeal wall, bottom → top (curving forward into nasopharynx roof)
    this.pharWall = catmullRom([P(-1.0, -1.5), P(-1.1, 1.5), P(-1.2, 3.6), P(-1.3, 5.6), P(-1.38, 7.5), P(-1.33, 8.9), P(-1.05, 10.1), P(-0.45, 10.9), P(0.4, 11.3)], 4);
    this.pns = P(1.0, 9.75);
    this.palate = catmullRom([P(1.0, 9.6), P(1.8, 9.92), P(2.7, 10.18), P(3.6, 10.3), P(4.4, 10.25), P(5.1, 10.05), P(5.7, 9.72), P(6.15, 9.36), P(6.5, 9.05), P(6.78, 8.7), P(6.98, 8.3), P(7.12, 7.95)], 3);
    this.condyle = P(-2.5, 10.5);
    this.polarC = P(2.6, 6.95);
    this.polarC2 = P(5.0, 6.85);
  }

  /**
   * Template point → body coordinates. The oral region (x > 0.5) is compressed by 0.86 so the
   * template's landmarks give a ≈17.5 cm neutral tract; the pharynx (y < 7) is shortened by the
   * body's pharynx factor; everything is scaled by the body size.
   */
  P(x: number, y: number): Vec {
    const k = this.k;
    const ph = this.body.pharynx;
    const xx = x > 0.5 ? 0.5 + (x - 0.5) * 0.86 : x;
    const yy = y < 7 ? 7 - (7 - y) * ph : y;
    return { x: xx * k, y: yy * k };
  }

  compute(a: HumanArtic): HumanFrame {
    const k = this.k;
    const P = (x: number, y: number) => this.P(x, y);
    const lar = a.larynx * k;
    const glottis = add(P(0, 0), v(0, lar));

    // ---- jaw (rotation about the condyle)
    const jawRef = P(6.95, 7.75);
    const jawR = dist(this.condyle, jawRef);
    const phi = -clamp(a.jaw, -0.2, 3.0) * k / jawR;
    const J = (x: number, y: number) => rotateAbout(P(x, y), this.condyle, phi);

    // ---- velum flap from PNS; angle from port area
    const vOpen = clamp(a.velum / 1.2, 0, 1);
    const vAng = (194 + 46 * vOpen) * DEG;
    const vLen = 2.8 * k;
    const vel: Vec[] = [];
    const velOral: Vec[] = [];
    const velNasal: Vec[] = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const sag = Math.sin(s * Math.PI) * k * (0.3 * vOpen - 0.12);
      const c = add(polar(this.pns, vLen * s, vAng), { x: 0, y: -sag });
      const nrm = { x: -Math.sin(vAng), y: Math.cos(vAng) }; // oral-side normal (forward-down)
      const th = (0.48 - 0.2 * s) * k;
      velOral.push(add(c, scale(nrm, th)));
      velNasal.push(sub(c, scale(nrm, th)));
      vel.push(c);
    }
    const uvula = vel[vel.length - 1];

    // ---- outer contour: pharyngeal wall up to uvula height, then velum oral surface (tip→PNS), palate, incisors, upper lip
    const outer = new Polyline();
    const uvY = uvula.y;
    for (const p of this.pharWall) {
      if (p.y < uvY) outer.push(p);
    }
    // bridge to the uvula tip (velopharyngeal port window)
    for (let i = velOral.length - 1; i >= 0; i--) outer.push(velOral[i]);
    outer.append(this.palate, true);
    // upper lip
    const prot = clamp(a.lipProt, -0.2, 1.6) * k;
    const spreadW = clamp(a.lipWidth, 0, 1);
    const yMid = (7.85 - 0.3 * a.jaw) * k;
    const lab = clamp(a.labiodental, 0, 1);
    const ap = a.lipAp * k;
    const lipFrontX = P(8.15 + 0.12 * (1 - spreadW), 0).x + prot * 0.95;
    let ulEdge = v(lipFrontX - 0.15 * k, yMid + ap * 0.35 + lab * 0.35 * k);
    let llEdge = v(lipFrontX - 0.25 * k, yMid - ap * 0.65);
    if (lab > 0) {
      // lower lip tucks under the upper incisor edge for /f v/
      const incisor = this.palate[this.palate.length - 1];
      const target = v(incisor.x + 0.05 * k, incisor.y - Math.max(a.lipAp * k, -0.1));
      llEdge = lerpV(llEdge, target, lab);
      ulEdge = lerpV(ulEdge, v(incisor.x + 0.55 * k, incisor.y + 0.45 * k), lab * 0.7);
    }
    const ulBase = P(7.32, 8.35);
    const upperLipIn = bezier3(ulBase, add(ulBase, v(0.3 * k + prot * 0.4, 0.05 * k)), add(ulEdge, v(-0.35 * k, 0.12 * k)), ulEdge, 7);
    outer.append(upperLipIn);

    // ---- tongue
    const r = this.body.tongueRadius * k;
    const B = this.P(a.tbX, a.tbY);
    const B0 = P(NEUTRAL.tbX, NEUTRAL.tbY);
    const vallecula = add(P(0.75, 3.3), v(0.45 * (B.x - B0.x) + a.root * k, 0.3 * (B.y - B0.y) + 0.55 * lar));
    const epiBase = add(P(0.3, 2.4), v(0, lar));
    const epiTip = add(P(0.0, 4.5), v(0.35 * (vallecula.x - 0.75 * k), lar * 0.8 + 0.15 * (B.y - B0.y)));
    const thB = 200 * DEG;
    const pB = polar(B, r, thB);
    const tanB = v(Math.sin(thB), -Math.cos(thB));
    const hR = dist(vallecula, pB) / 3;
    const root = bezier3(vallecula, add(vallecula, v(0.08 * k, hR)), sub(pB, scale(tanB, hR)), pB, 9);
    let T = this.P(a.ttX, a.ttY);
    // keep tip outside the body circle
    const dT = dist(T, B);
    if (dT < r * 1.05) T = add(B, scale(norm(sub(T, B)), r * 1.05));
    let thF = tangentAngle(B, r, T, true);
    if (thF === null) thF = Math.atan2(T.y - B.y, T.x - B.x);
    // arc runs from thB (200°) decreasing to thF
    while (thF > thB) thF -= 2 * Math.PI;
    while (thF < thB - 2 * Math.PI) thF += 2 * Math.PI;
    const arcPts = arc(B, r, thB, thF, Math.max(6, Math.round(((thB - thF) / DEG) / 6)));
    const pF = arcPts[arcPts.length - 1];
    const tanF = v(Math.sin(thF), -Math.cos(thF)); // direction of decreasing angle
    // blade: quadratic from the tangent point to the tip; curl lifts the tip and turns it back
    const bl = dist(pF, T);
    const curl = clamp(a.ttCurl, 0, 1);
    const ctrl = add(add(pF, scale(tanF, bl * 0.5)), v(0, (0.18 + 0.5 * curl) * k));
    // dorsum depression (clicks): pull the middle of the blade/body down
    const blade = bezier2(pF, ctrl, T, 7);
    if (a.dorsum > 0) {
      for (let i = 0; i < arcPts.length; i++) {
        const t = i / (arcPts.length - 1);
        const w = Math.sin(Math.min(1, t * 1.3) * Math.PI);
        arcPts[i] = add(arcPts[i], v(0, -a.dorsum * 0.9 * k * w * w));
      }
    }
    // underside back to the frenulum / floor of mouth (jaw-carried)
    const fren = J(5.7, 6.15);
    const under = bezier2(T, add(T, v(-0.3 * k - curl * 0.4 * k, -0.6 * k)), fren, 6);
    const floor = [fren, J(6.2, 6.25), J(6.45, 6.55)];
    // lower incisors (jaw)
    const liTip = J(6.95, 7.75);
    const lowerTeethPts = [J(6.45, 6.55), J(6.72, 7.15), liTip, J(7.12, 7.45)];
    // lower lip: from labial base of lower incisor to the edge
    const llBase = J(7.12, 7.45);
    const lowerLipIn = bezier3(llBase, add(llBase, v(0.25 * k + prot * 0.3, -0.05 * k)), add(llEdge, v(-0.3 * k, -0.12 * k)), llEdge, 7);

    // acoustic inner wall: epiglottis (laryngeal surface) then the tongue root *above* the
    // epiglottis tip — the vallecula pocket is omitted so the wall is single-valued along the
    // pharyngeal rays (a pocket makes ray crossings flip discontinuously)
    const inner = new Polyline();
    inner.push(epiBase).push(epiTip);
    let rootStart = root.findIndex((q) => q.y > epiTip.y + 0.05 * k);
    if (rootStart < 0) rootStart = root.length - 1;
    for (let i = rootStart; i < root.length; i++) inner.push(root[i]);
    inner.append(arcPts, true);
    inner.append(blade, true);
    inner.append(under, true);
    inner.append(floor, true);
    inner.append(lowerTeethPts, true);
    inner.append(lowerLipIn);

    // ---- grid
    const grid: GridSample[] = [];
    const tmp = this.tmpT;
    const yEpiTop = glottis.y + 2.4 * k * this.body.pharynx;
    const yPharTop = this.polarC.y;
    const nPh = 12;
    const measure = (o: Vec, dir: Vec, maxLen: number): { inner: Vec; outer: Vec; d: number } | null => {
      // walk from o along dir: last inner crossing before the first outer crossing
      const nOut = rayPolyline(o.x, o.y, dir.x, dir.y, outer, 0, maxLen, tmp);
      if (nOut === 0) return null;
      let tOut = Infinity;
      for (let i = 0; i < nOut; i++) tOut = Math.min(tOut, tmp[i]);
      const nIn = rayPolyline(o.x, o.y, dir.x, dir.y, inner, 0, tOut + 1.5 * k, tmp);
      let tIn = -Infinity;
      for (let i = 0; i < nIn; i++) if (tmp[i] > tIn && tmp[i] < tOut + 1.5 * k) tIn = tmp[i];
      if (tIn === -Infinity) tIn = Math.max(0, tOut - 3.5 * k);
      // if the tongue crosses the wall, the outermost inner crossing lies beyond tOut → closed
      const d = Math.max(0, tOut - tIn);
      const pIn = add(o, scale(dir, Math.min(tIn, tOut)));
      const pOut = add(o, scale(dir, tOut));
      return { inner: pIn, outer: pOut, d };
    };
    // pharyngeal horizontals (origin in front, looking back)
    for (let i = 0; i < nPh; i++) {
      const y = lerp(yEpiTop + 0.12 * k, yPharTop, i / nPh);
      const m = measure(v(4.6 * k, y), v(-1, 0), 9 * k);
      if (m) grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, region: 1 });
    }
    // oral family: rays from a centre that glides from C1 (mid-oral) to C2 (behind the incisors)
    // while the angle sweeps back → up → forward; consecutive rays never cross inside the airway.
    const nRad = 30;
    let splitIndex = -1;
    for (let i = 0; i <= nRad; i++) {
      const t = i / nRad;
      const ang = lerp(180, 36, t) * DEG;
      const w = t < 0.45 ? 0 : (t - 0.45) / 0.55;
      const c = lerpV(this.polarC, this.polarC2, w * w * (3 - 2 * w));
      const dir = v(Math.cos(ang), Math.sin(ang));
      const m = measure(c, dir, 8 * k);
      if (!m) continue;
      if (splitIndex < 0 && ang <= 150 * DEG) splitIndex = grid.length;
      // rays behind the velum still measure the (laterally wide) oropharynx
      grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, region: splitIndex < 0 ? 1 : 2 });
    }
    // front verticals (upper incisor edge → lip opening), looking up
    const incisorTip = this.palate[this.palate.length - 1];
    const xStart = incisorTip.x + 0.03 * k;
    const xEnd = Math.max(xStart + 0.3 * k, Math.min(ulEdge.x, llEdge.x) - 0.04 * k);
    const nFr = 6;
    const lipW = (1.1 + (this.body.lipWidth - 1.1) * spreadW) * k;
    const teethIdx = grid.length;
    for (let i = 0; i < nFr; i++) {
      const x = lerp(xStart, xEnd, i / (nFr - 1));
      const m = measure(v(x, 4.0 * k), v(0, 1), 8 * k);
      if (!m) continue;
      grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, region: 3 });
    }

    // ---- areas
    const [aP, bP] = this.areaLaw.pharynx;
    const [aO, bO] = this.areaLaw.oral;
    const [aF, bF] = this.areaLaw.front;
    const teethX = this.palate[this.palate.length - 1].x;
    for (const g of grid) {
      if (g.region === 1) g.area = aP * Math.pow(g.d, bP);
      else if (g.region === 2) g.area = aO * Math.pow(g.d, bO);
      else {
        // behind the incisors: dental arch; in front: elliptical lip slit of width lipW
        const u = clamp((g.mid.x - teethX) / (0.45 * k), 0, 1);
        const dental = aF * Math.pow(g.d, bF);
        const lip = (Math.PI / 4) * g.d * lipW;
        g.area = lerp(dental, lip, u);
      }
    }
    // suppress isolated spikes (rays grazing the port window / tooth corners): clamp each open
    // sample to 1.35× the larger of its neighbours
    for (let i = 1; i < grid.length - 1; i++) {
      const lim = 1.35 * Math.max(grid[i - 1].area, grid[i + 1].area);
      if (grid[i].area > lim) grid[i].area = lim;
    }
    // lateral channel (for /l/): keeps a side passage open around a midline tip closure
    if (a.lateral > 0) {
      for (const g of grid) {
        if (g.region >= 2 && dist(g.mid, T) < 1.4 * k) g.area = Math.max(g.area, a.lateral * 0.35 * k * k);
      }
    }

    // ---- centreline s
    const epiLen = 2.4 * k * this.body.pharynx;
    let s = epiLen;
    for (let i = 0; i < grid.length; i++) {
      if (i > 0) s += dist(grid[i].mid, grid[i - 1].mid);
      grid[i].s = s;
    }
    // teeth position along s (first front line sits at the upper incisor edge)
    const teethS = teethIdx < grid.length ? grid[teethIdx].s : grid[grid.length - 1].s;
    const lipS = grid[grid.length - 1].s;
    const pharynxLength = splitIndex > 0 ? grid[splitIndex].s : grid[nPh].s;

    // ---- drawing parts
    const tongue = [...root, ...arcPts.slice(1), ...blade.slice(1), ...under.slice(1), ...floor.slice(1)];
    const upperLipOut = bezier3(ulEdge, add(ulEdge, v(0.25 * k, 0.35 * k)), P(8.3 + 0.0, 9.6), P(7.9, 10.4), 6);
    const lowerLipOut = bezier3(llEdge, add(llEdge, v(0.3 * k, -0.4 * k)), J(8.1, 6.3), J(7.6, 5.6), 6);
    const jawBone = [J(7.25, 6.75), J(7.4, 5.4), J(6.4, 4.6), J(3.5, 4.4), J(1.2, 5.2), J(-0.6, 7.4), J(-1.9, 9.6)];
    const nasal = catmullRom([this.pns, P(2.5, 10.8), P(5.0, 11.2), P(7.3, 10.6), P(8.0, 10.1)], 4);
    return {
      outer: outer.toArray(),
      inner: inner.toArray(),
      tongue,
      velum: [...velNasal, ...velOral.slice().reverse()],
      upperLip: [...upperLipIn, ...upperLipOut.slice(1)],
      lowerLip: [...lowerLipIn, ...lowerLipOut.slice(1)],
      upperTeeth: [P(6.15, 9.36), P(6.78, 8.7), P(7.12, 7.95), P(7.38, 8.7), P(7.4, 9.3)],
      lowerTeeth: lowerTeethPts,
      jawBone,
      epiglottis: [epiBase, epiTip, vallecula],
      nasalCavity: nasal,
      glottis,
      grid,
      length: lipS,
      pharynxLength,
      teethS,
      lipS,
      velumPort: Math.max(0, a.velum) * k * k,
      lipArea: grid[grid.length - 1].area,
      tongueCenter: B,
      tongueRadius: r,
      tip: T,
      splitIndex,
    };
  }

  /** Epilarynx area profile at s ∈ [0, epiLen]. */
  epilarynxArea(a: HumanArtic, s: number, epiLen: number): number {
    const k2 = this.k * this.k;
    const u = s / epiLen;
    const vent = 1 - 0.75 * clamp(a.ventricular, 0, 1);
    if (u < 0.3) return 1.3 * k2; // laryngeal ventricle
    if (u < 0.5) return 0.95 * k2 * vent; // ventricular folds
    const top = lerp(1.9, 0.35, clamp(a.epilarynx, 0, 1)) * k2;
    return lerp(1.2 * k2, top, (u - 0.5) / 0.5);
  }

  /**
   * Resample the tract into two uniform tubes (pharynx: glottis→velum, oral: velum→lips).
   * Uses the harmonic mean of area over each section (preserves constriction inertance and
   * exact closures).
   */
  resample(a: HumanArtic, f: HumanFrame, nPh: number, nOr: number, outPh: Float64Array, outOr: Float64Array, minPh?: Float64Array, minOr?: Float64Array): { phLen: number; orLen: number } {
    const epiLen = 2.4 * this.k * this.body.pharynx;
    const g = f.grid;
    const areaAt = (s: number): number => {
      if (s <= epiLen) return this.epilarynxArea(a, s, epiLen);
      if (s <= g[0].s) return lerp(this.epilarynxArea(a, epiLen, epiLen), g[0].area, (s - epiLen) / Math.max(1e-6, g[0].s - epiLen));
      // binary search
      let lo = 0, hi = g.length - 1;
      if (s >= g[hi].s) return g[hi].area;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (g[m].s <= s) lo = m;
        else hi = m;
      }
      const t = (s - g[lo].s) / Math.max(1e-9, g[hi].s - g[lo].s);
      return lerp(g[lo].area, g[hi].area, t);
    };
    const fill = (s0: number, s1: number, n: number, out: Float64Array, mins?: Float64Array) => {
      const d = (s1 - s0) / n;
      const sub = 8;
      for (let i = 0; i < n; i++) {
        let inv = 0;
        let closed = false;
        let mn = Infinity;
        for (let j = 0; j < sub; j++) {
          const A = areaAt(s0 + d * (i + (j + 0.5) / sub));
          if (A < mn) mn = A;
          if (A <= 1e-5) {
            closed = true;
            break;
          }
          inv += 1 / A;
        }
        out[i] = closed ? 0 : sub / inv;
        if (mins) mins[i] = closed ? 0 : mn;
      }
    };
    const sp = f.pharynxLength;
    fill(0, sp, nPh, outPh, minPh);
    fill(sp, f.lipS, nOr, outOr, minOr);
    return { phLen: sp, orLen: f.lipS - sp };
  }
}
