/**
 * Branched airway acoustics: staggered-grid FDTD transmission-line network.
 *
 * Nodes carry pressure p (dyn/cm²) and a volume V = A·Δ; branches carry volume velocity
 * U (cm³/s) between two nodes. Leapfrog in time: branches update U(n+½) from p(n), then
 * nodes update p(n+1) from U(n+½).
 *
 * Branch momentum: the state is Φ = L·U (∝ particle velocity), so as a branch closes
 * (L → ∞) its volume flow goes to zero without remembering stale momentum. Update solves
 *   (L/T)·U' + R·U' + k·|U'|·U' = Δp + Φ/T      (exact quadratic, k = kinetic loss)
 * with Borda–Carnot expansion loss k = ρ/2·(1/A_up − 1/A_down)² chosen by flow direction.
 *
 * Node continuity (moving walls included):
 *   (V/ρc²)·dp/dt = ΣU_in − ΣU_out − U_wall − dV/dt
 * Yielding walls: per-node mass–spring–damper per unit area, times wall area (perimeter·Δ).
 * Radiation: Flanagan parallel R–L load at open ends; output is d/dt of radiated flow.
 */
import { RHO, RHO_C2, C_SOUND, MU, NU, RE_CRIT, type WallParams } from "../physics.ts";
import { Rng } from "../util/math.ts";

export interface TubeSpec {
  name: string;
  /** number of sections (pressure nodes) */
  n: number;
  /** total length (cm); may change at control rate */
  length: number;
  /** initial area(s) cm² */
  area: number | ArrayLike<number>;
  /** yielding wall parameters, or null for rigid */
  wall?: WallParams | null;
  /** cross-section perimeter relative to a circle of equal area (≥1) */
  perimeterFactor?: number;
  /** multiplier on viscous resistance */
  viscousFactor?: number;
  /** fraction of wall volume velocity radiated as sound (skin radiation) */
  wallRadiation?: number;
}

export class Tube {
  constructor(
    readonly index: number,
    readonly name: string,
    readonly n: number,
    readonly first: number,
    public length: number,
  ) {}
  node(i: number): number {
    return this.first + i;
  }
  get firstNode(): number {
    return this.first;
  }
  get lastNode(): number {
    return this.first + this.n - 1;
  }
  /** index of the internal branch between node i and i+1 (set at build time) */
  branchBase = -1;
  branch(i: number): number {
    return this.branchBase + i;
  }
}

const KIND_SERIES = 0; // inertance from adjacent half-sections
const KIND_PORT = 1; // own duct (area, length) in series with adjacent half-sections

export interface PortSpec {
  /** duct area (cm²) */
  area: number;
  /** duct length (cm) */
  length: number;
  /** kinetic loss coefficient for flow entering the duct (contraction) */
  kEntrance?: number;
  /** kinetic loss coefficient for flow leaving the duct (jet expansion) */
  kExit?: number;
  /** slit-viscous width factor: if >0, viscous R = 12μ·len·w²/A³ (glottis-like slit of length w) */
  slitWidth?: number;
  /** include the adjacent half-section inertances (default true) */
  includeHalfSections?: boolean;
  /** additional constant series resistance (CGS acoustic ohms) */
  extraResistance?: number;
}

export interface LinearElements {
  nNodes: number;
  nBranches: number;
  a: Int32Array;
  b: Int32Array;
  L: Float64Array;
  R: Float64Array;
  open: Uint8Array;
  C: Float64Array;
  wallArea: Float64Array;
  wallM: Float64Array;
  wallR: Float64Array;
  wallK: Float64Array;
  wallRad: Float64Array;
  fixed: Uint8Array;
  radNodes: Int32Array;
  radArea: Float64Array;
}

interface NoiseSource {
  src: number; // branch whose Reynolds number drives the source
  fwd: number; // branch to inject into when flow is positive (a→b)
  bwd: number; // branch to inject into when flow is negative
  gain: number;
  reFactor: number; // Re = |U|·reFactor
  // band-shaping filter state
  hp: number;
  lp1: number;
  lp2: number;
  lpCoef: number;
  hpCoef: number;
  level: number; // last amplitude (telemetry)
}

export class AirwayNetwork {
  readonly fs: number;
  readonly T: number;
  private readonly invT: number;

  readonly tubes: Tube[] = [];
  private tubeSpecs: TubeSpec[] = [];
  private finalized = false;

  // --- nodes ---
  nNodes = 0;
  p!: Float64Array;
  /** current node area (cm²) */
  area!: Float64Array;
  private areaTarget!: Float64Array;
  private areaStep!: Float64Array;
  /** current minimum (sub-section) area per node: drives kinetic losses and Reynolds numbers */
  amin!: Float64Array;
  private aminTarget!: Float64Array;
  private aminStep!: Float64Array;
  /** nodes with ≥3 connections get a compliance floor for leapfrog stability */
  private isJunction!: Uint8Array;
  private invLsum!: Float64Array;
  /** neighbour lists (CSR) for redistributing squeezed volume of nearly closed nodes */
  private nbrStart!: Int32Array;
  private nbrList!: Int32Array;
  private spill!: Float64Array;
  /** band-limited moving-wall volume source (2-pole low-pass state per node) */
  private volSrc1!: Float64Array;
  private volSrc2!: Float64Array;
  private volLpCoef = 0;
  /** cut-off of the moving-wall volume source (Hz): articulator-driven flow is sub-audio */
  volumeSourceHz = 60;
  /** below this node area (cm²) displaced volume is pushed into the neighbours */
  squeezeArea = 0.12;
  /** model switches (diagnostics / ablation) */
  enableVolumeSource = true;
  enableJunctionFloor = true;
  energySafe = true;
  /** diagnostics: use the larger kinetic coefficient for both flow directions */
  symmetricKinetic = false;
  /** current section length (cm) */
  dx!: Float64Array;
  private dxTarget!: Float64Array;
  private dxStep!: Float64Array;
  private vol!: Float64Array;
  private invA!: Float64Array;
  private flowSum!: Float64Array;
  /** external volume-velocity injection per node for the next step (cleared after use) */
  extFlow!: Float64Array;
  private fixed!: Uint8Array;
  private wallM!: Float64Array;
  private wallR!: Float64Array;
  private wallK!: Float64Array;
  private wallPerim!: Float64Array; // perimeter factor·2√π (multiply by √A·Δ for wall area)
  private wallRad!: Float64Array;
  private hasWall!: Uint8Array;
  wallY!: Float64Array;
  private wallV!: Float64Array;
  /** per-node wall volume velocity (telemetry) */
  wallU!: Float64Array;
  private nodeTube!: Int32Array;
  private viscF!: Float64Array;
  private radOf!: Int32Array;

  // --- branches ---
  nBranches = 0;
  private bA: number[] = [];
  private bB: number[] = [];
  private bKind: number[] = [];
  private portSpecs: (PortSpec | null)[] = [];
  private ba!: Int32Array;
  private bb!: Int32Array;
  private bk!: Uint8Array;
  U!: Float64Array;
  private mom!: Float64Array;
  private Lprev!: Float64Array;
  /** extra series pressure sources (noise, driven sources), cleared each sample */
  psrc!: Float64Array;
  /** port branch area (cm²), current */
  portArea!: Float64Array;
  private portAreaTarget!: Float64Array;
  private portAreaStep!: Float64Array;
  private portLen!: Float64Array;
  private portKin!: Float64Array;
  private portKex!: Float64Array;
  private portSlit!: Float64Array;
  private portHalf!: Uint8Array;
  private portExtraR!: Float64Array;
  /** branch "effective" area used for telemetry and Reynolds numbers */
  branchArea!: Float64Array;

  // --- radiation ---
  private radNodes: number[] = [];
  private radNodeArr!: Int32Array;
  private radUL!: Float64Array;
  private radLprev!: Float64Array;
  /** radiated volume velocity of each radiator (telemetry) */
  radU!: Float64Array;
  private radPrevTotal = 0;

  // --- sources/boundaries ---
  private noise: NoiseSource[] = [];
  private readonly rng = new Rng(12345);
  /** closure threshold (cm²): below this a branch passes no flow */
  closedArea = 2e-4;
  /** node area floor for volume/compliance (cm²) */
  minNodeArea = 0.02;
  /** global viscous loss scale */
  viscousScale = 1;
  /** reference angular frequency for frequency-independent viscous loss */
  viscousOmega = 2 * Math.PI * 700;
  /** scale on turbulence noise gain */
  noiseScale = 1;
  /** last output sample (radiated pressure derivative) */
  out = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.T = 1 / fs;
    this.invT = fs;
  }

  addTube(spec: TubeSpec): Tube {
    if (this.finalized) throw new Error("network finalized");
    const t = new Tube(this.tubes.length, spec.name, spec.n, this.nNodes, spec.length);
    this.tubes.push(t);
    this.tubeSpecs.push(spec);
    this.nNodes += spec.n;
    // internal branches
    t.branchBase = this.bA.length;
    for (let i = 0; i < spec.n - 1; i++) this.pushBranch(t.node(i), t.node(i + 1), KIND_SERIES, null);
    return t;
  }

  /** Connect two nodes with series half-section inertance (e.g. tube end to tube end). */
  connect(a: number, b: number): number {
    return this.pushBranch(a, b, KIND_SERIES, null);
  }

  /** Connect two nodes through a duct with its own (time-varying) area: glottis, velum port, valves, necks. */
  addPort(a: number, b: number, spec: PortSpec): number {
    return this.pushBranch(a, b, KIND_PORT, spec);
  }

  /** Add a lumped cavity node (Helmholtz resonator volume) — returns node index. */
  addCavity(name: string, volume: number, wall: WallParams | null = null): number {
    // cavity = 1-node tube with area·length = volume (use a cube-ish proportion)
    const len = Math.cbrt(volume);
    const t = this.addTube({ name, n: 1, length: len, area: volume / len, wall, perimeterFactor: 1.2 });
    return t.firstNode;
  }

  /** Prescribed-pressure boundary node (lungs, air sacs). Returns node index. */
  addPressureNode(name: string): number {
    const t = this.addTube({ name, n: 1, length: 1, area: 100, wall: null });
    this.pendingFixed.push(t.firstNode);
    return t.firstNode;
  }
  private pendingFixed: number[] = [];

  /** Attach a radiation load at an open end node. Returns radiator index. */
  addRadiation(node: number): number {
    this.radNodes.push(node);
    return this.radNodes.length - 1;
  }

  private pushBranch(a: number, b: number, kind: number, spec: PortSpec | null): number {
    this.bA.push(a);
    this.bB.push(b);
    this.bKind.push(kind);
    this.portSpecs.push(spec);
    return this.bA.length - 1;
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const N = this.nNodes;
    const B = (this.nBranches = this.bA.length);
    this.p = new Float64Array(N);
    this.area = new Float64Array(N);
    this.areaTarget = new Float64Array(N);
    this.areaStep = new Float64Array(N);
    this.amin = new Float64Array(N);
    this.aminTarget = new Float64Array(N);
    this.aminStep = new Float64Array(N);
    this.isJunction = new Uint8Array(N);
    this.invLsum = new Float64Array(N);
    this.dx = new Float64Array(N);
    this.dxTarget = new Float64Array(N);
    this.dxStep = new Float64Array(N);
    this.vol = new Float64Array(N);
    this.invA = new Float64Array(N);
    this.flowSum = new Float64Array(N);
    this.extFlow = new Float64Array(N);
    this.fixed = new Uint8Array(N);
    this.wallM = new Float64Array(N);
    this.wallR = new Float64Array(N);
    this.wallK = new Float64Array(N);
    this.wallPerim = new Float64Array(N);
    this.wallRad = new Float64Array(N);
    this.hasWall = new Uint8Array(N);
    this.wallY = new Float64Array(N);
    this.wallV = new Float64Array(N);
    this.wallU = new Float64Array(N);
    this.nodeTube = new Int32Array(N);
    this.viscF = new Float64Array(N);
    this.radOf = new Int32Array(N).fill(-1);
    for (const t of this.tubes) {
      const spec = this.tubeSpecs[t.index];
      const dx = spec.length / spec.n;
      for (let i = 0; i < t.n; i++) {
        const k = t.node(i);
        const a = typeof spec.area === "number" ? spec.area : spec.area[i];
        this.area[k] = this.areaTarget[k] = a;
        this.amin[k] = this.aminTarget[k] = a;
        this.dx[k] = this.dxTarget[k] = dx;
        this.nodeTube[k] = t.index;
        this.viscF[k] = spec.viscousFactor ?? 1;
        const w = spec.wall;
        if (w) {
          this.hasWall[k] = 1;
          this.wallM[k] = w.mass;
          this.wallR[k] = w.resistance;
          this.wallK[k] = w.stiffness;
        }
        this.wallPerim[k] = (spec.perimeterFactor ?? 1) * 2 * Math.sqrt(Math.PI);
        this.wallRad[k] = spec.wallRadiation ?? 0;
      }
    }
    for (const k of this.pendingFixed) this.fixed[k] = 1;
    this.ba = Int32Array.from(this.bA);
    this.bb = Int32Array.from(this.bB);
    this.bk = Uint8Array.from(this.bKind);
    this.U = new Float64Array(B);
    this.mom = new Float64Array(B);
    this.Lprev = new Float64Array(B);
    const degree = new Int32Array(N);
    for (let j = 0; j < B; j++) {
      degree[this.ba[j]]++;
      degree[this.bb[j]]++;
    }
    for (let k = 0; k < N; k++) this.isJunction[k] = degree[k] >= 3 ? 1 : 0;
    this.nbrStart = new Int32Array(N + 1);
    for (let k = 0; k < N; k++) this.nbrStart[k + 1] = this.nbrStart[k] + degree[k];
    this.nbrList = new Int32Array(this.nbrStart[N]);
    const fillN = this.nbrStart.slice(0, N);
    for (let j = 0; j < B; j++) {
      this.nbrList[fillN[this.ba[j]]++] = this.bb[j];
      this.nbrList[fillN[this.bb[j]]++] = this.ba[j];
    }
    this.spill = new Float64Array(N);
    this.volSrc1 = new Float64Array(N);
    this.volSrc2 = new Float64Array(N);
    this.volLpCoef = 1 - Math.exp((-2 * Math.PI * this.volumeSourceHz) / this.fs);
    this.psrc = new Float64Array(B);
    this.portArea = new Float64Array(B);
    this.portAreaTarget = new Float64Array(B);
    this.portAreaStep = new Float64Array(B);
    this.portLen = new Float64Array(B);
    this.portKin = new Float64Array(B);
    this.portKex = new Float64Array(B);
    this.portSlit = new Float64Array(B);
    this.portHalf = new Uint8Array(B);
    this.portExtraR = new Float64Array(B);
    this.branchArea = new Float64Array(B);
    for (let j = 0; j < B; j++) {
      const s = this.portSpecs[j];
      if (s) {
        this.portArea[j] = this.portAreaTarget[j] = s.area;
        this.portLen[j] = s.length;
        this.portKin[j] = s.kEntrance ?? 0.4;
        this.portKex[j] = s.kExit ?? 1.0;
        this.portSlit[j] = s.slitWidth ?? 0;
        this.portHalf[j] = s.includeHalfSections === false ? 0 : 1;
        this.portExtraR[j] = s.extraResistance ?? 0;
      }
    }
    this.radNodeArr = Int32Array.from(this.radNodes);
    this.radUL = new Float64Array(this.radNodes.length);
    this.radLprev = new Float64Array(this.radNodes.length);
    this.radU = new Float64Array(this.radNodes.length);
    for (let r = 0; r < this.radNodes.length; r++) this.radOf[this.radNodes[r]] = r;
    for (let k = 0; k < N; k++) {
      const a = Math.max(this.area[k], this.minNodeArea);
      this.vol[k] = a * this.dx[k];
      this.invA[k] = 1 / Math.max(this.area[k], 1e-6);
    }
    this.checkCfl();
  }

  /** Largest stable time step check (warn only). */
  checkCfl(): number {
    let minDx = Infinity;
    for (let k = 0; k < this.nNodes; k++) if (!this.fixed[k]) minDx = Math.min(minDx, this.dxTarget[k]);
    const cfl = (C_SOUND * this.T) / minDx;
    return cfl;
  }

  // ---------------------------------------------------------------- control-rate API

  /** Set target areas (and optionally total length) of a tube, reached at the end of the next block. */
  setTubeTargets(t: Tube, areas: ArrayLike<number>, length?: number, minAreas?: ArrayLike<number>): void {
    for (let i = 0; i < t.n; i++) {
      const a = Math.max(0, areas[i]);
      this.areaTarget[t.node(i)] = a;
      this.aminTarget[t.node(i)] = minAreas ? Math.max(0, Math.min(a, minAreas[i])) : a;
    }
    if (length !== undefined) {
      t.length = length;
      const d = length / t.n;
      for (let i = 0; i < t.n; i++) this.dxTarget[t.node(i)] = d;
    }
  }

  setNodeAreaTarget(node: number, area: number): void {
    this.areaTarget[node] = Math.max(0, area);
    this.aminTarget[node] = this.areaTarget[node];
  }

  setPortTarget(branch: number, area: number): void {
    this.portAreaTarget[branch] = Math.max(0, area);
  }

  /** Immediately set a port area (per-sample sources such as the glottis call this every sample). */
  setPortArea(branch: number, area: number): void {
    this.portArea[branch] = area < 0 ? 0 : area;
    this.portAreaTarget[branch] = this.portArea[branch];
    this.portAreaStep[branch] = 0;
  }

  setFixedPressure(node: number, p: number): void {
    this.p[node] = p;
  }

  /** Jump the geometry to the current targets immediately (initialisation; no dV/dt transient). */
  snapToTargets(): void {
    for (let k = 0; k < this.nNodes; k++) {
      this.area[k] = this.areaTarget[k];
      this.amin[k] = this.aminTarget[k];
      this.dx[k] = this.dxTarget[k];
      this.vol[k] = Math.max(this.area[k], this.minNodeArea) * this.dx[k];
      this.invA[k] = 1 / Math.max(this.area[k], 1e-6);
      this.areaStep[k] = this.aminStep[k] = this.dxStep[k] = 0;
    }
    for (let j = 0; j < this.nBranches; j++) {
      if (this.bk[j] === KIND_PORT) {
        this.portArea[j] = this.portAreaTarget[j];
        this.portAreaStep[j] = 0;
      }
    }
  }

  /** Prepare per-sample linear ramps toward the targets over `samples` internal samples. */
  beginBlock(samples: number): void {
    const inv = 1 / Math.max(1, samples);
    let maxP = 0;
    for (let k = 0; k < this.nNodes; k++) {
      this.areaStep[k] = (this.areaTarget[k] - this.area[k]) * inv;
      this.aminStep[k] = (this.aminTarget[k] - this.amin[k]) * inv;
      this.dxStep[k] = (this.dxTarget[k] - this.dx[k]) * inv;
      if (!this.fixed[k]) {
        const ap = Math.abs(this.p[k]);
        if (ap > maxP) maxP = ap;
      }
    }
    // flush decayed state to zero (avoids denormal slowdowns in silent tails)
    if (maxP < 1e-9) {
      let maxU = 0;
      for (let j = 0; j < this.nBranches; j++) maxU = Math.max(maxU, Math.abs(this.U[j]));
      if (maxU < 1e-9) this.flushState();
    }
    for (let j = 0; j < this.nBranches; j++) {
      if (this.bk[j] === KIND_PORT) this.portAreaStep[j] = (this.portAreaTarget[j] - this.portArea[j]) * inv;
    }
  }

  /** Replace the set of turbulence noise sources (called at control rate). */
  setNoiseSources(list: { src: number; fwd: number; bwd: number; gain: number; lowpassHz?: number; highpassHz?: number }[]): void {
    // reuse filter states for sources whose (src, fwd) pair persists, to avoid clicks
    const old = this.noise;
    const next: NoiseSource[] = [];
    for (const s of list) {
      const prev = old.find((o) => o.src === s.src && o.fwd === s.fwd);
      const lpHz = s.lowpassHz ?? 7000;
      const hpHz = s.highpassHz ?? 400;
      next.push({
        src: s.src,
        fwd: s.fwd,
        bwd: s.bwd,
        gain: s.gain,
        reFactor: 0,
        hp: prev?.hp ?? 0,
        lp1: prev?.lp1 ?? 0,
        lp2: prev?.lp2 ?? 0,
        lpCoef: 1 - Math.exp((-2 * Math.PI * lpHz) / this.fs),
        hpCoef: Math.exp((-2 * Math.PI * hpHz) / this.fs),
        level: 0,
      });
    }
    this.noise = next;
  }

  private flushState(): void {
    for (let k = 0; k < this.nNodes; k++) {
      if (!this.fixed[k]) this.p[k] = 0;
      this.wallV[k] = 0;
      if (Math.abs(this.wallY[k]) < 1e-12) this.wallY[k] = 0;
    }
    this.U.fill(0);
    this.mom.fill(0);
    this.radUL.fill(0);
  }

  get noiseSources(): readonly { src: number; level: number }[] {
    return this.noise;
  }

  // ---------------------------------------------------------------- per-sample step

  /** Advance one internal sample. Returns radiated pressure (arbitrary units ∝ dU_rad/dt). */
  step(): number {
    const N = this.nNodes;
    const B = this.nBranches;
    const T = this.T;
    const invT = this.invT;
    const p = this.p;
    const area = this.area;
    const amin = this.amin;
    const dx = this.dx;
    const invA = this.invA;
    const vol = this.vol;
    const flowSum = this.flowSum;
    const minA = this.minNodeArea;
    const isJ = this.isJunction;
    const invLsum = this.invLsum;

    // 1) geometry ramps and the moving-wall volume source. The raw −dV/dt of each node is first
    //    split between the node and its open neighbours (a nearly closed cell cannot hold the air
    //    its walls displace), THEN each node's total injection is low-passed: dV/dt is piecewise
    //    constant across control blocks and the split switches as cells close, and the output is a
    //    derivative of flow, so unfiltered steps would radiate as clicks. Linear filtering after
    //    the split keeps mass conserved.
    const sq = this.squeezeArea;
    const inj = this.spill; // reused as the per-node raw injection accumulator
    const volOn = this.enableVolumeSource;
    if (volOn) inj.fill(0);
    let anySpill = false;
    for (let k = 0; k < N; k++) {
      let a = area[k] + this.areaStep[k];
      if (a < 0) a = 0;
      area[k] = a;
      let am = amin[k] + this.aminStep[k];
      if (am < 0) am = 0;
      amin[k] = am > a ? a : am;
      const d = (dx[k] += this.dxStep[k]);
      invA[k] = 1 / (a > 1e-6 ? a : 1e-6);
      const v = (a > minA ? a : minA) * d;
      if (volOn) {
        const raw = -(v - vol[k]) * invT;
        const ae = amin[k] < a ? amin[k] : a; // a node sealed at its minimum cannot hold air either
        if (raw !== 0 && ae < sq) {
          const t = ae / sq;
          const keep = t * t * (3 - 2 * t);
          inj[k] += raw * keep;
          const sp = raw * (1 - keep);
          const s0 = this.nbrStart[k], s1 = this.nbrStart[k + 1];
          let nOpen = 0;
          for (let e = s0; e < s1; e++) {
            const m = this.nbrList[e];
            if (Math.min(area[m], amin[m]) >= sq || this.aminTarget[m] >= sq) nOpen++;
          }
          if (nOpen > 0) {
            const share = sp / nOpen;
            for (let e = s0; e < s1; e++) {
              const m = this.nbrList[e];
              if (Math.min(area[m], amin[m]) >= sq || this.aminTarget[m] >= sq) inj[m] += share;
            }
          } // else: fully sealed pocket, the squeezed air leaves laterally (absorbed)
          anySpill = true;
        } else inj[k] += raw;
      }
      vol[k] = v;
      invLsum[k] = 0;
      flowSum[k] = this.extFlow[k];
      this.extFlow[k] = 0;
    }
    void anySpill;
    if (volOn) {
      const c = this.volLpCoef;
      for (let k = 0; k < N; k++) {
        const s1 = (this.volSrc1[k] += c * (inj[k] - this.volSrc1[k]));
        flowSum[k] += this.volSrc2[k] += c * (s1 - this.volSrc2[k]);
      }
    }

    // 2) turbulence noise → series pressure sources
    const psrc = this.psrc;
    psrc.fill(0);
    if (this.noise.length) this.computeNoise();

    // 3) branches
    const ba = this.ba;
    const bb = this.bb;
    const bk = this.bk;
    const U = this.U;
    const mom = this.mom;
    const Lprev = this.Lprev;
    const visc = Math.sqrt((RHO * MU * this.viscousOmega) / 2) * this.viscousScale;
    const closed = this.closedArea;
    const halfRho = 0.5 * RHO;
    for (let j = 0; j < B; j++) {
      const a = ba[j];
      const b = bb[j];
      let L: number;
      let R: number;
      let kf: number;
      let kb: number;
      let aEff: number;
      if (bk[j] === KIND_SERIES) {
        const Aa = area[a];
        const Ab = area[b];
        const ma = amin[a];
        const mb = amin[b];
        aEff = ma < mb ? ma : mb;
        if ((Aa < Ab ? Aa : Ab) < closed || aEff < closed) {
          U[j] = 0;
          mom[j] = 0;
          this.branchArea[j] = aEff;
          continue;
        }
        const ia = invA[a];
        const ib = invA[b];
        L = halfRho * (dx[a] * ia + dx[b] * ib);
        // viscous: R = S·l/A² · sqrt(ρμω/2) with S = perimeter of each half-section
        R = 0.5 * visc * (this.wallPerim[a] * dx[a] * Math.sqrt(Aa) * ia * ia * this.viscF[a] + this.wallPerim[b] * dx[b] * Math.sqrt(Ab) * ib * ib * this.viscF[b]);
        // Borda–Carnot: the jet leaving the narrowest point of the upstream node expands into
        // the downstream node (sub-section minima make short constrictions lossy as they should be)
        const ef = 1 / ma - ib; // a→b
        const eb = 1 / mb - ia; // b→a
        kf = ef > 0 ? halfRho * ef * ef : 0;
        kb = eb > 0 ? halfRho * eb * eb : 0;
        // small contraction (vena contracta) loss entering a narrower node
        const cf = 1 / mb - ia;
        const cb = 1 / ma - ib;
        if (cf > 0) kf += 0.1 * halfRho * cf * cf;
        if (cb > 0) kb += 0.1 * halfRho * cb * cb;
      } else {
        let Ap = (this.portArea[j] += this.portAreaStep[j]);
        if (Ap < 0) Ap = this.portArea[j] = 0;
        aEff = Ap;
        if (Ap < closed) {
          U[j] = 0;
          mom[j] = 0;
          this.branchArea[j] = Ap;
          continue;
        }
        const ip = 1 / Ap;
        const len = this.portLen[j];
        L = RHO * len * ip;
        if (this.portHalf[j]) L += halfRho * (dx[a] * invA[a] + dx[b] * invA[b]);
        const w = this.portSlit[j];
        if (w > 0) R = (12 * MU * len * w * w) * ip * ip * ip;
        else R = visc * 2 * Math.sqrt(Math.PI) * len * Math.sqrt(Ap) * ip * ip;
        R += this.portExtraR[j];
        // kinetic: entrance (contraction) + exit (jet expansion into the downstream node)
        const exF = ip - invA[b]; // flow a→b exits into b
        const exB = ip - invA[a]; // flow b→a exits into a
        const kin = this.portKin[j] * halfRho * ip * ip;
        kf = kin + this.portKex[j] * halfRho * (exF > 0 ? exF * exF : 0);
        kb = kin + this.portKex[j] * halfRho * (exB > 0 ? exB * exB : 0);
      }
      this.branchArea[j] = aEff;
      // energy-safe momentum transfer when the inertance changes: closing (L↑) conserves
      // momentum (flow drops), opening (L↓) conserves flow — never injects kinetic energy
      if (this.symmetricKinetic) {
        const km = kf > kb ? kf : kb;
        kf = km;
        kb = km;
      }
      const Lp = Lprev[j];
      const m0 = this.energySafe && L < Lp ? L * U[j] : mom[j];
      const c = p[a] - p[b] + psrc[j] + m0 * invT;
      const bq = L * invT + R;
      let u: number;
      if (c >= 0) {
        u = kf > 0 ? (2 * c) / (bq + Math.sqrt(bq * bq + 4 * kf * c)) : c / bq;
      } else {
        u = kb > 0 ? (2 * c) / (bq + Math.sqrt(bq * bq - 4 * kb * c)) : c / bq;
      }
      U[j] = u;
      mom[j] = L * u;
      Lprev[j] = L;
      flowSum[a] -= u;
      flowSum[b] += u;
      if (isJ[a] | isJ[b]) {
        const il = 1 / L;
        invLsum[a] += il;
        invLsum[b] += il;
      }
    }

    // 4) walls (velocity at half step from p(n), displacement integrates)
    const wallU = this.wallU;
    let wallRadSum = 0;
    for (let k = 0; k < N; k++) {
      if (!this.hasWall[k]) continue;
      const m = this.wallM[k];
      const r = this.wallR[k];
      const v = ((m * invT - 0.5 * r) * this.wallV[k] + p[k] - this.wallK[k] * this.wallY[k]) / (m * invT + 0.5 * r);
      this.wallV[k] = v;
      this.wallY[k] += T * v;
      const a = area[k] > minA ? area[k] : minA;
      const uw = this.wallPerim[k] * Math.sqrt(a) * dx[k] * v;
      wallU[k] = uw;
      flowSum[k] -= uw;
      wallRadSum += uw * this.wallRad[k];
    }

    // 5) nodes (radiation loads handled semi-implicitly)
    const radUL = this.radUL;
    const T2 = T * T;
    let radTotal = wallRadSum;
    const cl = this.closedArea;
    for (let k = 0; k < N; k++) {
      if (this.fixed[k]) continue;
      // sealed if the cell itself, or its narrowest point, is closed (then all its series
      // branches are closed too, and compressing its remaining volume would trap pressure)
      if (area[k] < cl || amin[k] < cl) {
        const rr = this.radOf[k];
        if (rr >= 0) {
          // sealed aperture: its outer face is the atmosphere, so it relaxes to 0 (tracking the
          // pressurised cavity behind would discharge as a radiated spike on reopening)
          p[k] *= 0.98;
        } else {
          // sealed interior cell (tissue contact): no air of its own; follow open neighbours
          let sum = 0, cnt = 0;
          for (let e = this.nbrStart[k]; e < this.nbrStart[k + 1]; e++) {
            const m = this.nbrList[e];
            if (area[m] >= cl && amin[m] >= cl) {
              sum += p[m];
              cnt++;
            }
          }
          if (cnt > 0) p[k] += 0.02 * (sum / cnt - p[k]);
        }
        if (rr >= 0) {
          // sealed aperture: let the radiated flow die away smoothly (no derivative step)
          radUL[rr] *= 0.995;
          this.radU[rr] = radUL[rr];
          radTotal += radUL[rr];
        }
        continue;
      }
      let C = vol[k] / RHO_C2;
      // junction stability: local breathing mode ω² ≈ ΣL⁻¹/C must satisfy T²ω² ≤ 2.4
      if (isJ[k] && this.enableJunctionFloor) {
        const cMin = (T2 * invLsum[k]) / 2.4;
        if (C < cMin) C = cMin;
      }
      const r = this.radOf[k];
      if (r < 0) {
        p[k] += (T / C) * flowSum[k];
      } else {
        const a = area[k] > 1e-4 ? area[k] : 1e-4;
        const Lr = (8 * RHO) / (3 * Math.PI * Math.sqrt(Math.PI * a));
        const Rr = (128 * RHO * C_SOUND) / (9 * Math.PI * Math.PI * a);
        const pOld = p[k];
        // energy-safe: when the radiation inertance grows (aperture closing) conserve momentum
        const Lp = this.radLprev[r];
        let ulPrev = radUL[r];
        if (Lp > 0 && Lr > Lp) ulPrev *= Lp / Lr;
        this.radLprev[r] = Lr;
        // Crank–Nicolson coupling of the node and its parallel R–L load (A-stable, energy-
        // conserving for the reactive part): Lr ∝ A^-½ against C ∝ A makes the explicit form
        // unstable at small apertures. U_L lives at integer steps; the node sees its mean.
        const h = T / (2 * Lr);
        const g = 0.5 / Rr;
        const pNew = (pOld * (C * invT - 0.5 * h - g) + flowSum[k] - ulPrev) / (C * invT + 0.5 * h + g);
        p[k] = pNew;
        const ul = ulPrev + h * (pOld + pNew);
        radUL[r] = ul;
        const ur = 0.5 * (ulPrev + ul) + g * (pNew + pOld);
        this.radU[r] = ur;
        radTotal += ur;
      }
    }
    const out = (radTotal - this.radPrevTotal) * invT;
    this.radPrevTotal = radTotal;
    this.out = out;
    return out;
  }

  private computeNoise(): void {
    const U = this.U;
    const psrc = this.psrc;
    const rng = this.rng;
    // white noise power per Hz scales with fs: normalise to a 96 kHz reference
    const scale = this.noiseScale * Math.sqrt(96000 / this.fs);
    const sat = 12000 * 12000 - RE_CRIT * RE_CRIT;
    for (let i = 0; i < this.noise.length; i++) {
      const s = this.noise[i];
      const a = this.branchArea[s.src];
      const u = U[s.src];
      let amp = 0;
      if (a > this.closedArea) {
        // Re = v·d_h/ν with d_h = 2√(A/π) → Re = |U|·2/(ν·√(πA))
        const re = (Math.abs(u) * 2) / (NU * Math.sqrt(Math.PI * a));
        if (re > RE_CRIT) {
          const x = re * re - RE_CRIT * RE_CRIT;
          amp = (s.gain * scale * x) / (1 + x / sat); // bounded growth at very high Re
        }
      }
      // white → high-pass (1st order) → 2nd-order low-pass
      const w = rng.bipolar() * 1.732;
      s.hp += (1 - s.hpCoef) * (w - s.hp); // s.hp holds a low-passed copy
      const hpOut = w - s.hp;
      s.lp1 += s.lpCoef * (hpOut - s.lp1);
      s.lp2 += s.lpCoef * (s.lp1 - s.lp2);
      s.level = amp;
      if (amp === 0) continue;
      const v = amp * s.lp2;
      if (u >= 0) psrc[s.fwd] += v;
      else psrc[s.bwd] -= v;
    }
  }

  /** Total radiated volume velocity of radiator r. */
  radiatedFlow(r: number): number {
    return this.radU[r];
  }

  /**
   * Linearised element values at the *target* geometry (what the next block ramps to), for
   * frequency-domain analysis. Same formulas as step(); kinetic losses are omitted (they
   * vanish for small signals about zero mean flow).
   */
  linearElements(): LinearElements {
    const N = this.nNodes;
    const B = this.nBranches;
    const visc = Math.sqrt((RHO * MU * this.viscousOmega) / 2) * this.viscousScale;
    const A = this.areaTarget;
    const dx = this.dxTarget;
    const L = new Float64Array(B);
    const R = new Float64Array(B);
    const open = new Uint8Array(B);
    for (let j = 0; j < B; j++) {
      const a = this.ba[j];
      const b = this.bb[j];
      const ia = 1 / Math.max(A[a], 1e-6);
      const ib = 1 / Math.max(A[b], 1e-6);
      if (this.bk[j] === KIND_SERIES) {
        if (Math.min(A[a], A[b]) < this.closedArea) continue;
        open[j] = 1;
        L[j] = 0.5 * RHO * (dx[a] * ia + dx[b] * ib);
        R[j] = 0.5 * visc * (this.wallPerim[a] * dx[a] * Math.sqrt(A[a]) * ia * ia * this.viscF[a] + this.wallPerim[b] * dx[b] * Math.sqrt(A[b]) * ib * ib * this.viscF[b]);
      } else {
        const Ap = this.portAreaTarget[j];
        if (Ap < this.closedArea) continue;
        open[j] = 1;
        const ip = 1 / Ap;
        const len = this.portLen[j];
        L[j] = RHO * len * ip + (this.portHalf[j] ? 0.5 * RHO * (dx[a] * ia + dx[b] * ib) : 0);
        const w = this.portSlit[j];
        R[j] = (w > 0 ? 12 * MU * len * w * w * ip * ip * ip : visc * 2 * Math.sqrt(Math.PI) * len * Math.sqrt(Ap) * ip * ip) + this.portExtraR[j];
      }
    }
    const C = new Float64Array(N);
    const wallArea = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const a = Math.max(A[k], this.minNodeArea);
      C[k] = (a * dx[k]) / RHO_C2;
      wallArea[k] = this.hasWall[k] ? this.wallPerim[k] * Math.sqrt(a) * dx[k] : 0;
    }
    return {
      nNodes: N,
      nBranches: B,
      a: this.ba,
      b: this.bb,
      L,
      R,
      open,
      C,
      wallArea,
      wallM: this.wallM,
      wallR: this.wallR,
      wallK: this.wallK,
      wallRad: this.wallRad,
      fixed: this.fixed,
      radNodes: this.radNodeArr,
      radArea: Float64Array.from(this.radNodeArr, (k) => Math.max(A[k], 1e-4)),
    };
  }

  /** Tube index of a node. */
  tubeOfNode(node: number): number {
    return this.nodeTube[node];
  }

  /** Reset all acoustic state. */
  reset(): void {
    this.p.fill(0);
    this.U.fill(0);
    this.mom.fill(0);
    this.Lprev.fill(0);
    this.wallY.fill(0);
    this.wallV.fill(0);
    this.radUL.fill(0);
    this.radLprev.fill(0);
    this.radPrevTotal = 0;
  }
}
