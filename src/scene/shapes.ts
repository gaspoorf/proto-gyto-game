import * as THREE from 'three';

/**
 * Paintable surfaces are built from rectangular parametric "charts".
 * Each chart maps (u,v) ∈ [0,1]² to a point/normal on the surface, and gets a
 * rectangle of texels in the mesh's paint mask. The same function generates the
 * render geometry and the per-texel world data used by painting, AO and score,
 * so mask texels and pixels on screen always agree.
 */
export interface Chart {
  /** World length of the parametric domain along u and v (metres). */
  lenU: number;
  lenV: number;
  /** u wraps around (lathe surfaces): gutters copy the opposite edge. */
  wrapU: boolean;
  evalLocal(u: number, v: number, pos: THREE.Vector3, nrm: THREE.Vector3): void;
  // Filled when packed into the mask atlas.
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface PaintableShape {
  geometry: THREE.BufferGeometry;
  charts: Chart[];
  texW: number;
  texH: number;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Accumulates chart grids, then packs charts and emits a BufferGeometry with a `maskUv` attribute. */
export class ShapeBuilder {
  charts: Chart[] = [];
  private pos: number[] = [];
  private nrm: number[] = [];
  private chartId: number[] = [];
  private cuv: number[] = [];
  private idx: number[] = [];

  addChart(chart: Omit<Chart, 'w' | 'h' | 'x' | 'y'>, us: number[], vs: number[]): void {
    const c: Chart = { ...chart, w: 0, h: 0, x: 0, y: 0 } as Chart;
    const ci = this.charts.length;
    this.charts.push(c);
    const base = this.pos.length / 3;
    for (let j = 0; j < vs.length; j++) {
      for (let i = 0; i < us.length; i++) {
        c.evalLocal(us[i], vs[j], _p, _n);
        this.pos.push(_p.x, _p.y, _p.z);
        this.nrm.push(_n.x, _n.y, _n.z);
        this.chartId.push(ci);
        this.cuv.push(us[i], vs[j]);
      }
    }
    const nu = us.length;
    // Winding: test a cell near the middle against the analytic normal.
    const mi = Math.max(0, Math.floor((us.length - 1) / 2));
    const mj = Math.max(0, Math.floor((vs.length - 1) / 2));
    const i0 = base + mj * nu + mi;
    const get = (k: number, out: THREE.Vector3) => out.set(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2]);
    get(i0, _a);
    get(i0 + 1, _b);
    get(i0 + nu, _c);
    _b.sub(_a);
    _c.sub(_a);
    const geomN = _b.cross(_c);
    const anN = _n.set(this.nrm[i0 * 3], this.nrm[i0 * 3 + 1], this.nrm[i0 * 3 + 2]);
    const flip = geomN.dot(anN) < 0;
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < us.length - 1; i++) {
        const a = base + j * nu + i;
        const b = a + 1;
        const c2 = a + nu;
        const d = c2 + 1;
        if (flip) this.idx.push(a, c2, b, b, c2, d);
        else this.idx.push(a, b, c2, b, d, c2);
      }
    }
  }

  finalize(density: number): PaintableShape {
    // Size charts from their world extent so texel density is uniform.
    for (const c of this.charts) {
      c.w = Math.max(2, Math.ceil(c.lenU * density));
      c.h = Math.max(2, Math.ceil(c.lenV * density));
    }
    // Shelf packing with a 1-texel gutter around each chart.
    const order = this.charts.map((_, i) => i).sort((a, b) => this.charts[b].h - this.charts[a].h);
    let area = 0;
    let maxW = 0;
    for (const c of this.charts) {
      area += (c.w + 2) * (c.h + 2);
      maxW = Math.max(maxW, c.w + 2);
    }
    const rowMax = Math.max(maxW, Math.ceil(Math.sqrt(area) * 1.15));
    let x = 0;
    let y = 0;
    let rowH = 0;
    let texW = 0;
    for (const i of order) {
      const c = this.charts[i];
      if (x + c.w + 2 > rowMax) {
        y += rowH;
        x = 0;
        rowH = 0;
      }
      c.x = x + 1;
      c.y = y + 1;
      x += c.w + 2;
      rowH = Math.max(rowH, c.h + 2);
      texW = Math.max(texW, x);
    }
    const texH = y + rowH;

    const n = this.pos.length / 3;
    const uv = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const c = this.charts[this.chartId[k]];
      uv[k * 2] = (c.x + this.cuv[k * 2] * c.w) / texW;
      uv[k * 2 + 1] = (c.y + this.cuv[k * 2 + 1] * c.h) / texH;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('maskUv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return { geometry: g, charts: this.charts, texW, texH };
  }
}

// ---------------------------------------------------------------------------
// Rounded box: six face charts split along the 45° bevel seams.

type FaceKey = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

function strip(h: number, inner: number, segs: number): number[] {
  // Normalised [0,1] coordinates along a face axis: rounded strip, flat middle, rounded strip.
  const out: number[] = [];
  const to01 = (x: number) => (x + h) / (2 * h);
  for (let k = 0; k <= segs; k++) out.push(to01(-h + (h - inner) * (k / segs)));
  if (inner > 1e-5) for (let k = 0; k <= segs; k++) out.push(to01(inner + (h - inner) * (k / segs)));
  else out.pop();
  return out.filter((v, i, arr) => i === 0 || v - arr[i - 1] > 1e-6);
}

export function roundedBox(
  b: ShapeBuilder,
  w: number,
  h: number,
  d: number,
  r: number,
  skip: FaceKey[] = [],
): ShapeBuilder {
  const half = [w / 2, h / 2, d / 2];
  r = Math.min(r, ...half.map((x) => x * 0.999));
  const inner = half.map((x) => x - r);
  const faces: [FaceKey, number, number][] = [
    ['+x', 0, 1],
    ['-x', 0, -1],
    ['+y', 1, 1],
    ['-y', 1, -1],
    ['+z', 2, 1],
    ['-z', 2, -1],
  ];
  for (const [key, axis, sign] of faces) {
    if (skip.includes(key)) continue;
    const ua = (axis + 1) % 3;
    const va = (axis + 2) % 3;
    const flat = [0, 0, 0];
    const evalLocal = (u: number, v: number, pos: THREE.Vector3, nrm: THREE.Vector3) => {
      flat[axis] = sign * half[axis];
      flat[ua] = -half[ua] + 2 * half[ua] * u;
      flat[va] = -half[va] + 2 * half[va] * v;
      const ix = Math.max(-inner[0], Math.min(inner[0], flat[0]));
      const iy = Math.max(-inner[1], Math.min(inner[1], flat[1]));
      const iz = Math.max(-inner[2], Math.min(inner[2], flat[2]));
      nrm.set(flat[0] - ix, flat[1] - iy, flat[2] - iz).normalize();
      pos.set(ix + nrm.x * r, iy + nrm.y * r, iz + nrm.z * r);
    };
    const segs = r > 0.02 ? 5 : 3;
    b.addChart(
      { lenU: 2 * half[ua], lenV: 2 * half[va], wrapU: false, evalLocal },
      strip(half[ua], inner[ua], segs),
      strip(half[va], inner[va], segs),
    );
  }
  return b;
}

// ---------------------------------------------------------------------------
// Lathe: a 2D profile (r, y) revolved around Y. One wrapping chart.

export type Profile = [number, number][];

export function lathe(b: ShapeBuilder, profile: Profile, radialSegs = 40): ShapeBuilder {
  const n = profile.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
  }
  const L = cum[n - 1];
  // Vertex normals of the profile: average of adjacent segment normals.
  const pn: [number, number][] = [];
  const segN = (i: number): [number, number] => {
    const dx = profile[i + 1][0] - profile[i][0];
    const dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  };
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? segN(i - 1) : segN(0);
    const c = i < n - 1 ? segN(i) : segN(n - 2);
    let nx = a[0] + c[0];
    let ny = a[1] + c[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    pn.push([nx, ny]);
  }
  let rmax = 0;
  for (const p of profile) rmax = Math.max(rmax, p[0]);

  const evalLocal = (u: number, v: number, pos: THREE.Vector3, nrm: THREE.Vector3) => {
    const s = Math.min(L, Math.max(0, v * L));
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / seg;
    const r = profile[lo][0] + (profile[hi][0] - profile[lo][0]) * t;
    const y = profile[lo][1] + (profile[hi][1] - profile[lo][1]) * t;
    let nr = pn[lo][0] + (pn[hi][0] - pn[lo][0]) * t;
    let ny = pn[lo][1] + (pn[hi][1] - pn[lo][1]) * t;
    const l = Math.hypot(nr, ny) || 1;
    nr /= l;
    ny /= l;
    const th = u * Math.PI * 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    pos.set(r * c, y, -r * sn);
    nrm.set(nr * c, ny, -nr * sn);
  };
  const us: number[] = [];
  for (let k = 0; k <= radialSegs; k++) us.push(k / radialSegs);
  const vs = Array.from(cum, (c) => c / L);
  b.addChart({ lenU: Math.PI * 2 * rmax, lenV: L, wrapU: true, evalLocal }, us, vs);
  return b;
}

/** Polyline through corner points, each corner rounded with a quadratic Bézier of the given radius. */
export function roundedProfile(pts: Profile, radii: number[], segs = 6): Profile {
  const out: Profile = [];
  for (let i = 0; i < pts.length; i++) {
    const r = radii[i] ?? 0;
    if (i === 0 || i === pts.length - 1 || r <= 0) {
      out.push([pts[i][0], pts[i][1]]);
      continue;
    }
    const p = pts[i];
    const a = pts[i - 1];
    const c = pts[i + 1];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const lc = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const rr = Math.min(r, la * 0.5, lc * 0.5);
    const A: [number, number] = [p[0] + ((a[0] - p[0]) / la) * rr, p[1] + ((a[1] - p[1]) / la) * rr];
    const B: [number, number] = [p[0] + ((c[0] - p[0]) / lc) * rr, p[1] + ((c[1] - p[1]) / lc) * rr];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const m = 1 - t;
      out.push([m * m * A[0] + 2 * m * t * p[0] + t * t * B[0], m * m * A[1] + 2 * m * t * p[1] + t * t * B[1]]);
    }
  }
  return out;
}

export function roundedCylinderProfile(R: number, H: number, r: number, rTop = r): Profile {
  return roundedProfile(
    [
      [0, 0],
      [R, 0],
      [R, H],
      [0, H],
    ],
    [0, r, rTop, 0],
    7,
  );
}

export function sphereProfile(R: number, segs = 18): Profile {
  const out: Profile = [];
  for (let k = 0; k <= segs; k++) {
    const a = -Math.PI / 2 + (Math.PI * k) / segs;
    out.push([Math.max(0, Math.cos(a) * R), R + Math.sin(a) * R]);
  }
  out[0][0] = 0;
  out[segs][0] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Flat plane (single chart).

export function plane(b: ShapeBuilder, w: number, h: number): ShapeBuilder {
  b.addChart(
    {
      lenU: w,
      lenV: h,
      wrapU: false,
      evalLocal: (u, v, pos, nrm) => {
        pos.set(-w / 2 + u * w, -h / 2 + v * h, 0);
        nrm.set(0, 0, 1);
      },
    },
    [0, 1],
    [0, 1],
  );
  return b;
}
