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
import { type Vec, v, add, sub, scale, lerpV, polar, rotateAbout, Polyline, rayPolyline, rayCrossings, bezier3, bezier2, arc, catmullRom, tangentAngle, dist, norm } from "./geom.ts";
import { clamp, lerp, smoothstep } from "../util/math.ts";

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
  velum: -0.15,
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
  /** the gap the ray measured, before the contact models (cm) */
  ray: number;
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
/** points on the tongue body's arc */
const ARC_POINTS = 32;

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
  private readonly crossT: number[] = new Array(64);
  private readonly crossExit = new Uint8Array(64);
  /** signed closest approach (cm) of tongue tip / dorsum to the oral roof in the last frame */
  contactTip = 1;
  contactBody = 1;
  /** unit normals at the contacts, pointing from the roof into the airway (body coords) */
  contactTipN = { x: 0, y: -1 };
  contactBodyN = { x: 0, y: -1 };
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

  /** Inverse of P(): body coordinates → template coordinates (for direct manipulation). */
  unP(x: number, y: number): Vec {
    const k = this.k;
    const ph = this.body.pharynx;
    let xx = x / k;
    let yy = y / k;
    if (xx > 0.5) xx = 0.5 + (xx - 0.5) / 0.86;
    if (yy < 7) yy = 7 - (7 - yy) / ph;
    return { x: xx, y: yy };
  }

  get scale(): number {
    return this.k;
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
    // the velum's oral surface runs into the hard palate's: its root sat below the palate's edge,
    // folding the roof back on itself there, and rays crossed the fold as the velum turned
    const pal0 = this.palate[0];
    for (let i = 0; i < velOral.length; i++) {
      const u = i / 10 / 0.35;
      if (u < 1) velOral[i] = lerpV(velOral[i], pal0, (1 - u) * (1 - u));
    }
    const uvula = vel[vel.length - 1];

    // ---- outer contour: pharyngeal wall up to just below the uvula, then velum oral surface
    // (tip→PNS), palate, incisors, upper lip
    const outer = new Polyline();
    // The port window's lid runs from the posterior wall up to the uvula's tip. It must slope
    // up: a lid leaving the wall above the tip left rays just under the tip to hit the wall far
    // behind, so the back of the oral tract jumped as the velum moved.
    const uvY = velOral[velOral.length - 1].y - 0.3 * k;
    for (let i = 0; i < this.pharWall.length; i++) {
      const p = this.pharWall[i];
      if (p.y < uvY) {
        outer.push(p);
        continue;
      }
      // end exactly at that height: whole wall points popping in and out made the port
      // window, and every ray through it, jump as the velum moved
      if (i > 0) {
        const a = this.pharWall[i - 1];
        outer.push(lerpV(a, p, clamp((uvY - a.y) / Math.max(1e-9, p.y - a.y), 0, 1)));
      }
      break;
    }
    // bridge to the uvula tip (velopharyngeal port window)
    const roofStart = outer.length;
    for (let i = velOral.length - 1; i >= 0; i--) outer.push(velOral[i]);
    outer.append(this.palate, true);
    const roofEnd = outer.length - 1;
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
    // a fixed number of points: a count that changed with the angle re-spaced every vertex at once
    const arcPts = arc(B, r, thB, thF, ARC_POINTS);
    const pF = arcPts[arcPts.length - 1];
    const tanF = v(Math.sin(thF), -Math.cos(thF)); // direction of decreasing angle
    // blade: quadratic from the tangent point to the tip; curl lifts the tip and turns it back
    const bl = dist(pF, T);
    const curl = clamp(a.ttCurl, 0, 1);
    const ctrl = add(add(pF, scale(tanF, bl * 0.5)), v(0, (0.18 + 0.5 * curl) * k));
    // dorsum depression (clicks): hollow the tongue between the back (velar) contact at the top
    // of the body and the tip, leaving both contacts in place, so a sealed pocket expands
    const blade = bezier2(pF, ctrl, T, 7);
    if (a.dorsum > 0) {
      const x0 = B.x, x1 = T.x;
      const dip = (p: Vec): Vec => {
        const u = (p.x - x0) / Math.max(1e-6, x1 - x0);
        if (u <= 0 || u >= 1) return p;
        const w = Math.sin(Math.PI * Math.pow(u, 0.8));
        return add(p, v(0, -a.dorsum * 0.9 * k * w * w));
      };
      for (let i = 0; i < arcPts.length; i++) arcPts[i] = dip(arcPts[i]);
      for (let i = 1; i < blade.length - 1; i++) blade[i] = dip(blade[i]);
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
    // The wall leaves the epiglottis tip upward, for where the tongue's back (root, then the
    // dorsum arc) first rises above it: with the tongue low and the larynx high the whole root
    // can sit below the tip, and a wall coming back down from it made the tip a peak that a
    // horizontal ray measured past (to the root) or not (to the epiglottis) — a jump.
    const yRoot = epiTip.y + 0.05 * k;
    const back = [...root, ...arcPts.slice(1)];
    let start = back.findIndex((q) => q.y > yRoot);
    if (start < 0) start = back.length - 1;
    else if (start > 0) {
      // start exactly at that height, not at the next sample point (which jumped along the root)
      const a = back[start - 1], b = back[start];
      inner.push(lerpV(a, b, clamp((yRoot - a.y) / Math.max(1e-9, b.y - a.y), 0, 1)));
    }
    if (start < root.length) {
      for (let i = start; i < root.length; i++) inner.push(root[i]);
      inner.append(arcPts, true);
    } else inner.append(arcPts.slice(start - root.length + 1), true);
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
    // A fan ray's inner surface. The ray starts in the tongue: the gap begins where it leaves it
    // (or, if the tongue has moved off the origin, at the surface behind it: a fixed fallback
    // gap jumped as the surface crossed the origin). The gap is the air along the ray up to the
    // roof: tissue the ray passes through on the way (a curled tip with air beneath it) is taken
    // out by its thickness, so a layer that vanishes as the ray grazes it changes nothing ("the
    // last crossing before the roof" jumped deep into the mouth whenever a ray slipped past the
    // tip, as on the way into a rhotic).
    const crossT = this.crossT, crossExit = this.crossExit;
    const fanInner = (o: Vec, dir: Vec, tOut: number): number => {
      const n = rayCrossings(o.x, o.y, dir.x, dir.y, inner, 0, tOut + 1.5 * k, crossT, crossExit);
      // sort the crossings along the ray (there are only a few)
      for (let i = 1; i < n; i++) {
        const t = crossT[i], e = crossExit[i];
        let j = i - 1;
        while (j >= 0 && crossT[j] > t) {
          crossT[j + 1] = crossT[j];
          crossExit[j + 1] = crossExit[j];
          j--;
        }
        crossT[j + 1] = t;
        crossExit[j + 1] = e;
      }
      let tIn: number, i = 0;
      if (n > 0 && crossExit[0] === 1) {
        tIn = crossT[0];
        i = 1;
      } else {
        const back = 2.5 * k;
        const nBack = rayPolyline(o.x, o.y, -dir.x, -dir.y, inner, 0, back, tmp);
        let tb = back;
        for (let q = 0; q < nBack; q++) tb = Math.min(tb, tmp[q]);
        tIn = -tb;
      }
      let tissue = 0;
      for (; i < n && crossT[i] < tOut; i++) {
        if (crossExit[i] === 1) continue; // a surface without its entry: nothing to take out
        const b = i + 1 < n ? crossT[i + 1] : tOut + 1.5 * k;
        tissue += Math.min(b, tOut) - crossT[i];
        i++; // skip the layer's exit
      }
      return tIn + tissue;
    };
    // `fan`: a ray of the oral fan, whose origin the tongue can move off (the others start below
    // or in front of all tissue they measure)
    const measure = (o: Vec, dir: Vec, maxLen: number, fan = false): { inner: Vec; outer: Vec; d: number } | null => {
      // walk from o along dir: last inner crossing before the first outer crossing
      const nOut = rayPolyline(o.x, o.y, dir.x, dir.y, outer, 0, maxLen, tmp);
      if (nOut === 0) return null;
      let tOut = Infinity;
      for (let i = 0; i < nOut; i++) tOut = Math.min(tOut, tmp[i]);
      let tIn: number;
      if (fan) tIn = fanInner(o, dir, tOut);
      else {
        const nIn = rayPolyline(o.x, o.y, dir.x, dir.y, inner, 0, tOut + 1.5 * k, tmp);
        tIn = -Infinity;
        for (let i = 0; i < nIn; i++) if (tmp[i] > tIn && tmp[i] < tOut + 1.5 * k) tIn = tmp[i];
        if (tIn === -Infinity) tIn = Math.max(0, tOut - 3.5 * k);
      }
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
      if (m) grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, ray: m.d, region: 1 });
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
      const m = measure(c, dir, 8 * k, true);
      if (!m) continue;
      if (splitIndex < 0 && ang <= 150 * DEG) splitIndex = grid.length;
      // rays behind the velum still measure the (laterally wide) oropharynx
      grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, ray: m.d, region: splitIndex < 0 ? 1 : 2 });
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
      grid.push({ ...m, mid: lerpV(m.inner, m.outer, 0.5), area: 0, s: 0, ray: m.d, region: 3 });
    }

    // ---- soft-tissue contact model: near the oral roof, the gap at each roof point is its
    // distance to the tongue surface itself (dorsum arc, blade, tip and underside), negative
    // where the tongue is pressed into the roof. The raw ray crossings of the tissue polygon can
    // leave sealed pockets beside a contact, and a jet released into such a pocket water-hammers;
    // the surface distance has none, gives seals whose length grows with contact pressure, and
    // handles two contacts at once (a single contact point hopped between them, jumping areas).
    const roof = { xs: outer.xs.slice(roofStart, roofEnd + 1), ys: outer.ys.slice(roofStart, roofEnd + 1) };
    const cum = new Float64Array(roof.xs.length);
    for (let i = 1; i < roof.xs.length; i++) cum[i] = cum[i - 1] + Math.hypot(roof.xs[i] - roof.xs[i - 1], roof.ys[i] - roof.ys[i - 1]);
    const tipPts = [...blade.slice(2), ...under.slice(1, 3)];
    const tipC = closestApproach(roof, cum, tipPts);
    const bodyC = closestApproach(roof, cum, arcPts);
    this.contactTip = tipC.d;
    this.contactBody = bodyC.d;
    this.contactTipN = tipC.n;
    this.contactBodyN = bodyC.n;
    // No outer gate: each ray's own weight fades the contact in. A gate on the sampled
    // tongue-to-roof distance could open with the per-ray correction already part-way on.
    {
      // the whole tongue outline, closed: distance to its surface, signed by whether the roof
      // point is inside it (so the sign only changes where the distance is zero)
      const outl: Vec[] = [...root, ...arcPts.slice(1), ...blade.slice(1), ...under.slice(1), ...floor.slice(1), root[0]];
      const tongueOutline = { xs: outl.map((q) => q.x), ys: outl.map((q) => q.y) };
      const tongueGap = (x: number, y: number) => signedGap(tongueOutline, x, y);
      // Each roof ray takes the narrowest gap along its own stretch of roof: ±1 mm, so the rays
      // near a contact seal together and open together (a sharp burst), widening to ±2 mm while
      // the tongue is pressed in, because the tip's contact on the alveolar ridge is narrower
      // than the ~4 mm between rays there and could otherwise fall between two and never seal.
      const press = 1 - smoothstep(-0.06 * k, 0, Math.min(tipC.d, bodyC.d));
      const half = 0.1 * k * (1 + press);
      const roofLen = cum[cum.length - 1];
      for (const g of grid) {
        if (g.region === 0) continue;
        // only rays ending on the oral roof, fading out (not switching off) as they leave it
        const pr = projectOn(roof, cum, g.outer.x, g.outer.y);
        const onRoof = 1 - smoothstep(0.15 * k, 0.25 * k, pr.dist);
        if (onRoof <= 0) continue;
        let dc = tongueGap(g.outer.x, g.outer.y);
        // the gap changes no faster than the distance moved along the roof
        if (dc - half <= 0.6 * k)
          for (const f of [-1, -0.5, 0.5, 1]) {
            const q = pointAlong(roof, cum, clamp(pr.s + f * half, 0, roofLen));
            dc = Math.min(dc, tongueGap(q.x, q.y));
          }
        // the surface distance takes over as the tongue comes within ~6 mm of this roof point,
        // fully from 1.5 mm; it also caps the ray's gap from 4.5 mm in
        const w = (1 - smoothstep(0.15 * k, 0.6 * k, dc)) * onRoof;
        const cap = (1 - smoothstep(0.45 * k, 0.6 * k, dc)) * onRoof;
        if (w <= 0 && cap <= 0) continue;
        const dp = Math.max(0, dc);
        const dm = g.d + (Math.min(g.d, dp) - g.d) * cap;
        g.d = dm + (dp - dm) * w;
      }
    }

    // lip contact: between the lips the gap follows aperture + Δx²/2R back from the lip edge, so
    // compressed lips (aperture < 0) seal over a length that grows with compression
    {
      const edgeX = Math.min(ulEdge.x, llEdge.x);
      const Rl = 0.6 * k;
      const apEff = lab > 0.5 ? Infinity : ap; // labiodental uses its own geometry
      for (const g of grid) {
        if (g.region !== 3 || g.mid.x < this.palate[this.palate.length - 1].x) continue;
        const dxl = Math.max(0, edgeX - g.mid.x);
        g.d = Math.min(g.d, Math.max(0, apEff + (dxl * dxl) / (2 * Rl)));
      }
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
    const u = s / epiLen;
    const vent = 0.95 * (1 - 0.75 * clamp(a.ventricular, 0, 1));
    const top = lerp(1.9, 0.35, clamp(a.epilarynx, 0, 1));
    // laryngeal ventricle, ventricular folds, then the tube to its top
    const f = (x: number) => (x < 0.3 ? 1.3 : x < 0.5 ? vent : lerp(1.2, top, (x - 0.5) / 0.5));
    // the steps between them are short ramps: a section boundary sliding across a step made
    // that section's area jump
    const r = 0.03;
    let A = f(u);
    for (const u0 of [0.3, 0.5]) if (Math.abs(u - u0) < r) A = lerp(f(u0 - r), f(u0 + r), (u - (u0 - r)) / (2 * r));
    return A * this.k * this.k;
  }

  /**
   * Resample the tract into two uniform tubes (pharynx: glottis→velum, oral: velum→lips).
   * Uses the harmonic mean of area over each section (preserves constriction inertance and
   * exact closures).
   */
  resample(a: HumanArtic, f: HumanFrame, nPh: number, nOr: number, outPh: Float64Array, outOr: Float64Array, minPh?: Float64Array, minOr?: Float64Array): { phLen: number; orLen: number } {
    const epiLen = 2.4 * this.k * this.body.pharynx;
    const g = f.grid;
    // the epilarynx's last few millimetres flare into the pharynx (no step at its top)
    const flare = 0.1 * epiLen;
    const areaAt = (s: number): number => {
      if (s <= epiLen - flare) return this.epilarynxArea(a, s, epiLen);
      if (s <= epiLen) return lerp(this.epilarynxArea(a, s, epiLen), g[0].area, (s - (epiLen - flare)) / flare);
      if (s <= g[0].s) return g[0].area;
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
      let gi = 0;
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
        // actual grid samples inside the section (a point closure must seal the section)
        const a0 = s0 + d * i, a1 = s0 + d * (i + 1) + (i === n - 1 ? 1e-6 : 0);
        while (gi < g.length && g[gi].s < a0) gi++;
        for (let q = gi; q < g.length && g[q].s <= a1; q++) {
          if (g[q].area < mn) mn = g[q].area;
          if (g[q].area <= 1e-5) closed = true;
        }
        out[i] = closed ? 0 : sub / inv;
        if (mins) mins[i] = closed ? 0 : Math.min(mn, out[i]);
      }
    };
    const sp = f.pharynxLength;
    fill(0, sp, nPh, outPh, minPh);
    fill(sp, f.lipS, nOr, outOr, minOr);
    return { phLen: sp, orLen: f.lipS - sp };
  }
}

/** Project a point onto a polyline: arc position, distance, and the side (cross<0 = airway side). */
function projectOn(pl: { xs: number[]; ys: number[] }, cum: Float64Array, px: number, py: number): { s: number; dist: number; signed: number; x: number; y: number; seg: number } {
  let best = Infinity, bs = 0, bx = 0, by = 0, sign = 1, bseg = 0;
  for (let i = 0; i < pl.xs.length - 1; i++) {
    const ax = pl.xs[i], ay = pl.ys[i];
    const ex = pl.xs[i + 1] - ax, ey = pl.ys[i + 1] - ay;
    const L2 = ex * ex + ey * ey;
    if (L2 < 1e-12) continue;
    let t = ((px - ax) * ex + (py - ay) * ey) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + ex * t, qy = ay + ey * t;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) {
      best = d;
      bs = cum[i] + t * Math.sqrt(L2);
      bx = qx;
      by = qy;
      const cross = ex * (py - ay) - ey * (px - ax);
      sign = cross < 0 ? 1 : -1;
      bseg = i;
    }
  }
  return { s: bs, dist: best, signed: sign * best, x: bx, y: by, seg: bseg };
}

/** The point at arc length s along a polyline. */
function pointAlong(pl: { xs: number[]; ys: number[] }, cum: Float64Array, s: number): Vec {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const L = cum[i + 1] - cum[i];
  const u = L > 1e-9 ? clamp((s - cum[i]) / L, 0, 1) : 0;
  return { x: pl.xs[i] + (pl.xs[i + 1] - pl.xs[i]) * u, y: pl.ys[i] + (pl.ys[i + 1] - pl.ys[i]) * u };
}

/**
 * Distance from a point to a closed polygon's boundary (its last point repeats its first),
 * negative inside (even-odd rule), in one pass over the edges.
 */
function signedGap(pl: { xs: number[]; ys: number[] }, px: number, py: number): number {
  let best = Infinity, inside = false;
  const xs = pl.xs, ys = pl.ys;
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i], ay = ys[i], bx = xs[i + 1], by = ys[i + 1];
    const ex = bx - ax, ey = by - ay;
    const L2 = ex * ex + ey * ey;
    let t = L2 > 1e-12 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - ax - ex * t, dy = py - ay - ey * t;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
    if (ay > py !== by > py && px < ax + ((py - ay) * ex) / ey) inside = !inside;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}

/** Closest approach of a set of tissue points to the roof: signed gap δ (negative = pressed in) and the roof normal there. */
function closestApproach(pl: { xs: number[]; ys: number[] }, cum: Float64Array, pts: Vec[]): { d: number; n: { x: number; y: number } } {
  let d = Infinity, seg = 0;
  for (const p of pts) {
    const pr = projectOn(pl, cum, p.x, p.y);
    if (pr.signed < d) {
      d = pr.signed;
      seg = pr.seg;
    }
  }
  // inward normal of the roof segment (airway side is to the right of travel: (ey, −ex))
  const ex = pl.xs[seg + 1] - pl.xs[seg], ey = pl.ys[seg + 1] - pl.ys[seg];
  const L = Math.hypot(ex, ey) || 1;
  return { d, n: { x: ey / L, y: -ex / L } };
}

/** Clamp drawn tissue points that penetrate a wall onto its surface (drawing only). */
export function clampToWall(points: Vec[], wall: Vec[]): Vec[] {
  const pl = { xs: wall.map((p) => p.x), ys: wall.map((p) => p.y) };
  const cum = new Float64Array(wall.length);
  for (let i = 1; i < wall.length; i++) cum[i] = cum[i - 1] + Math.hypot(wall[i].x - wall[i - 1].x, wall[i].y - wall[i - 1].y);
  return points.map((p) => {
    const pr = projectOn(pl, cum, p.x, p.y);
    return pr.signed < 0 && pr.dist < 1.5 ? { x: pr.x, y: pr.y } : p;
  });
}
