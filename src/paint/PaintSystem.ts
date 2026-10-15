import * as THREE from 'three';
import type { Paintable } from '../scene/World';
import type { ToolParams } from '../config';

/**
 * Persistent, localized paint state.
 *
 * Every paintable mesh owns a mask texture (see clayMaterial). Each interior
 * texel of that mask is a "surface texel" with a world position, normal, area
 * and reachability flag, stored in flat typed arrays indexed by a global id.
 *
 *  - cov    : scored coverage, 0 = clean, 1 = fully painted
 *  - decor  : decorative paint (drips, flying droplets that landed). Never scored.
 *  - wet    : brief shine after cleaning.
 *
 * Both players write into per-step delta buffers (paint adds to dP, water to dC);
 * endStep() combines them in one pass, so the result never depends on the
 * order in which players are processed.
 */

export interface ScoreSink {
  onCoverageChange(t: number, oldC: number, newC: number): void;
}

export interface StampOptions {
  kind: 'paint' | 'clean';
  params: ToolParams;
  /** Amount at intensity 1 for this stamp (rate × dt × share). */
  amount: number;
  irregularity?: number;
}

const CELL = 0.15;
const keyOf = (ix: number, iy: number, iz: number) => (ix + 1024) * 4194304 + (iy + 1024) * 2048 + (iz + 1024);
const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class PaintSystem {
  surfaces: Paintable[] = [];
  meshIndex = new Map<THREE.Object3D, number>();
  textures: THREE.DataTexture[] = [];
  datas: Uint8Array[] = [];
  private texW: number[] = [];
  private surfStart: number[] = [];
  private surfDirty: boolean[] = [];
  private hashes: Map<number, Int32Array>[] = [];

  n = 0;
  pos = new Float32Array(0);
  nrm = new Float32Array(0);
  area = new Float32Array(0);
  /** area × reachable. Score weight. */
  weight = new Float32Array(0);
  surfOf = new Uint16Array(0);
  pix = new Int32Array(0);
  cov = new Float32Array(0);
  decor = new Float32Array(0);
  wet = new Float32Array(0);
  ao = new Float32Array(0);
  private gStart = new Int32Array(0);
  private gPix = new Int32Array(0);

  // Per-step accumulation
  private dP = new Float32Array(0);
  private dC = new Float32Array(0);
  private dD = new Float32Array(0);
  private mark = new Int32Array(0);
  private touched = new Int32Array(0);
  private touchedN = 0;
  private stepId = 1;

  private wetList = new Int32Array(0);
  private wetN = 0;
  private inWet = new Uint8Array(0);

  score: ScoreSink | null = null;
  /** World size of one mask texel (m). */
  texelSize = 1 / 64;
  readonly cameraPos = new THREE.Vector3();

  // ---------------------------------------------------------------------------
  // Build

  async build(
    paintables: Paintable[],
    opts: { aoStride: number; aoRays: number; density: number },
    onProgress: (p: number, label: string) => void,
  ): Promise<void> {
    this.texelSize = 1 / opts.density;
    const t0 = performance.now();
    for (const t of this.textures) t.dispose();
    this.surfaces = paintables;
    this.meshIndex.clear();
    this.textures = [];
    this.datas = [];
    this.texW = [];
    this.surfStart = [];
    this.surfDirty = [];
    this.hashes = [];

    let total = 0;
    for (const p of paintables) for (const c of p.shape.charts) total += c.w * c.h;
    this.n = total;
    const N = total;
    this.pos = new Float32Array(N * 3);
    this.nrm = new Float32Array(N * 3);
    this.area = new Float32Array(N);
    this.weight = new Float32Array(N);
    this.surfOf = new Uint16Array(N);
    this.pix = new Int32Array(N);
    this.cov = new Float32Array(N);
    this.decor = new Float32Array(N);
    this.wet = new Float32Array(N);
    this.ao = new Float32Array(N).fill(1);
    this.dP = new Float32Array(N);
    this.dC = new Float32Array(N);
    this.dD = new Float32Array(N);
    this.mark = new Int32Array(N);
    this.touched = new Int32Array(N);
    this.wetList = new Int32Array(N);
    this.inWet = new Uint8Array(N);
    this.wetN = 0;
    this.touchedN = 0;

    const gutterLists: number[][] = [];
    const p0 = new THREE.Vector3();
    const n0 = new THREE.Vector3();
    const du = new THREE.Vector3();
    const dv = new THREE.Vector3();

    let t = 0;
    for (let si = 0; si < paintables.length; si++) {
      const p = paintables[si];
      const mesh = p.mesh;
      this.meshIndex.set(mesh, si);
      mesh.updateMatrixWorld(true);
      const mw = mesh.matrixWorld;
      const { texW, texH } = p.shape;
      const data = new Uint8Array(texW * texH * 4);
      for (let k = 3; k < data.length; k += 4) data[k] = 255;
      const tex = new THREE.DataTexture(data, texW, texH, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      p.uniforms.uMask.value = tex;
      p.uniforms.uMaskTexel.value.set(1 / texW, 1 / texH);
      this.textures.push(tex);
      this.datas.push(data);
      this.texW.push(texW);
      this.surfStart.push(t);
      this.surfDirty.push(false);

      for (const c of p.shape.charts) {
        const base = t;
        for (let j = 0; j < c.h; j++) {
          for (let i = 0; i < c.w; i++) {
            const u = (i + 0.5) / c.w;
            const v = (j + 0.5) / c.h;
            c.evalLocal(u, v, p0, n0);
            p0.applyMatrix4(mw);
            n0.transformDirection(mw);
            this.pos[t * 3] = p0.x;
            this.pos[t * 3 + 1] = p0.y;
            this.pos[t * 3 + 2] = p0.z;
            this.nrm[t * 3] = n0.x;
            this.nrm[t * 3 + 1] = n0.y;
            this.nrm[t * 3 + 2] = n0.z;
            this.surfOf[t] = si;
            this.pix[t] = (c.y + j) * texW + (c.x + i);
            t++;
          }
        }
        // Texel area from the surface Jacobian (finite differences between neighbours).
        const P = this.pos;
        for (let j = 0; j < c.h; j++) {
          for (let i = 0; i < c.w; i++) {
            const k = base + j * c.w + i;
            const iL = c.wrapU ? (i - 1 + c.w) % c.w : Math.max(0, i - 1);
            const iR = c.wrapU ? (i + 1) % c.w : Math.min(c.w - 1, i + 1);
            const jD = Math.max(0, j - 1);
            const jU = Math.min(c.h - 1, j + 1);
            const a = base + j * c.w + iL;
            const b = base + j * c.w + iR;
            const d = base + jD * c.w + i;
            const e = base + jU * c.w + i;
            const su = c.wrapU ? 2 : iR - iL || 1;
            const sv = jU - jD || 1;
            du.set(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]).multiplyScalar(1 / su);
            dv.set(P[e * 3] - P[d * 3], P[e * 3 + 1] - P[d * 3 + 1], P[e * 3 + 2] - P[d * 3 + 2]).multiplyScalar(1 / sv);
            this.area[k] = du.cross(dv).length();
          }
        }
        // Gutter ring: each gutter pixel mirrors the closest interior texel (or wraps).
        for (let j = -1; j <= c.h; j++) {
          for (let i = -1; i <= c.w; i++) {
            if (i >= 0 && i < c.w && j >= 0 && j < c.h) continue;
            let si2 = i;
            if (c.wrapU) si2 = (i + c.w) % c.w;
            else si2 = Math.min(c.w - 1, Math.max(0, i));
            const sj = Math.min(c.h - 1, Math.max(0, j));
            const src = base + sj * c.w + si2;
            (gutterLists[src] ??= []).push((c.y + j) * texW + (c.x + i));
          }
        }
      }
      onProgress(0.25 * ((si + 1) / paintables.length), 'Modelage de la pièce');
      if (si % 6 === 5) await frame();
    }

    // CSR gutter table
    this.gStart = new Int32Array(N + 1);
    let gc = 0;
    for (let k = 0; k < N; k++) {
      this.gStart[k] = gc;
      gc += gutterLists[k]?.length ?? 0;
    }
    this.gStart[N] = gc;
    this.gPix = new Int32Array(gc);
    for (let k = 0; k < N; k++) {
      const l = gutterLists[k];
      if (l) this.gPix.set(l, this.gStart[k]);
    }

    // Spatial hash per surface, for stamping.
    for (let si = 0; si < paintables.length; si++) {
      const start = this.surfStart[si];
      const end = si + 1 < paintables.length ? this.surfStart[si + 1] : N;
      const tmp = new Map<number, number[]>();
      for (let k = start; k < end; k++) {
        const key = keyOf(
          Math.floor(this.pos[k * 3] / CELL),
          Math.floor(this.pos[k * 3 + 1] / CELL),
          Math.floor(this.pos[k * 3 + 2] / CELL),
        );
        let arr = tmp.get(key);
        if (!arr) tmp.set(key, (arr = []));
        arr.push(k);
      }
      const h = new Map<number, Int32Array>();
      for (const [k, v] of tmp) h.set(k, Int32Array.from(v));
      this.hashes.push(h);
    }
    for (let k = 0; k < N; k++) this.writeTexel(k);
    for (const tex of this.textures) tex.needsUpdate = true;
    this.aoOpts = opts;
    onProgress(0.97, 'Préparation du duel');
    console.info(`[paint] ${N} texels, ${paintables.length} surfaces — built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  private aoOpts = { aoStride: 3, aoRays: 12 };
  private aoWorkers: Worker[] = [];
  /** 0 → 1 while baked AO fades in (shader uniform). */
  aoMix = 0;
  private aoDone = false;

  /**
   * Baked ambient occlusion (static scene), stored in the mask alpha.
   * Runs in parallel Web Workers after the game is already interactive;
   * charts never visible from the camera are skipped.
   */
  async bakeAO(onProgress?: (f: number) => void): Promise<void> {
    for (const w of this.aoWorkers) w.terminate();
    this.aoWorkers = [];
    this.aoMix = 0;
    this.aoDone = false;
    const t0 = performance.now();
    const paintables = this.surfaces;
    // Merged world-space geometry for the BVH.
    let vCount = 0;
    let iCount = 0;
    for (const p of paintables) {
      vCount += p.mesh.geometry.getAttribute('position').count;
      iCount += p.mesh.geometry.getIndex()!.count;
    }
    const posArr = new Float32Array(vCount * 3);
    const idxArr = new Uint32Array(iCount);
    const v = new THREE.Vector3();
    let vo = 0;
    let io = 0;
    for (const p of paintables) {
      const pa = p.mesh.geometry.getAttribute('position');
      for (let k = 0; k < pa.count; k++) {
        v.fromBufferAttribute(pa, k).applyMatrix4(p.mesh.matrixWorld);
        posArr[(vo + k) * 3] = v.x;
        posArr[(vo + k) * 3 + 1] = v.y;
        posArr[(vo + k) * 3 + 2] = v.z;
      }
      const ia = p.mesh.geometry.getIndex()!.array;
      for (let k = 0; k < ia.length; k++) idxArr[io + k] = ia[k] + vo;
      vo += pa.count;
      io += ia.length;
    }

    // Coarse sample grid per chart (only charts with at least one reachable texel).
    const S = this.aoOpts.aoStride;
    interface ChartGrid { base: number; w: number; h: number; gw: number; gh: number; first: number }
    const grids: ChartGrid[] = [];
    const sampleList: number[] = [];
    let t = 0;
    for (const p of paintables) {
      for (const c of p.shape.charts) {
        let visible = false;
        for (let k = t; k < t + c.w * c.h; k++) if (this.weight[k] > 0) { visible = true; break; }
        if (visible) {
          const gw = Math.ceil((c.w - 1) / S) + 1;
          const gh = Math.ceil((c.h - 1) / S) + 1;
          grids.push({ base: t, w: c.w, h: c.h, gw, gh, first: sampleList.length });
          for (let gj = 0; gj < gh; gj++)
            for (let gi = 0; gi < gw; gi++) sampleList.push(t + Math.min(c.h - 1, gj * S) * c.w + Math.min(c.w - 1, gi * S));
        }
        t += c.w * c.h;
      }
    }
    const total = sampleList.length;
    const nWorkers = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    const per = Math.ceil(total / nWorkers);
    const progress = new Float32Array(nWorkers);
    const results = new Float32Array(total);
    const jobs: Promise<void>[] = [];
    for (let wi = 0; wi < nWorkers; wi++) {
      const from = wi * per;
      const to = Math.min(total, from + per);
      if (from >= to) continue;
      const samples = new Float32Array((to - from) * 6);
      for (let s = from; s < to; s++) {
        const k = sampleList[s];
        const o = (s - from) * 6;
        samples[o] = this.pos[k * 3];
        samples[o + 1] = this.pos[k * 3 + 1];
        samples[o + 2] = this.pos[k * 3 + 2];
        samples[o + 3] = this.nrm[k * 3];
        samples[o + 4] = this.nrm[k * 3 + 1];
        samples[o + 5] = this.nrm[k * 3 + 2];
      }
      const worker = new Worker(new URL('./aoWorker.ts', import.meta.url), { type: 'module' });
      this.aoWorkers.push(worker);
      jobs.push(
        new Promise<void>((resolve, reject) => {
          worker.onmessage = (e) => {
            if (e.data.progress !== undefined) {
              progress[wi] = e.data.progress;
              onProgress?.(progress.reduce((a, b) => a + b, 0) / nWorkers);
            } else {
              results.set(e.data.ao, from);
              worker.terminate();
              resolve();
            }
          };
          worker.onerror = (err) => reject(err);
          worker.postMessage(
            { positions: posArr.slice(), indices: idxArr.slice(), samples, rays: this.aoOpts.aoRays, maxDist: 0.6 },
          );
        }),
      );
    }
    try {
      await Promise.all(jobs);
    } catch (e) {
      console.warn('[paint] AO bake failed, continuing without it', e);
      return;
    }
    if (this.surfaces !== paintables) return; // rebuilt meanwhile

    for (const g of grids) {
      const blurred = blurGrid(results.subarray(g.first, g.first + g.gw * g.gh), g.gw, g.gh);
      for (let j = 0; j < g.h; j++) {
        const fy = Math.min(g.gh - 1, j / S);
        const y0 = Math.floor(fy);
        const y1 = Math.min(g.gh - 1, y0 + 1);
        const ty = fy - y0;
        for (let i = 0; i < g.w; i++) {
          const fx = Math.min(g.gw - 1, i / S);
          const x0 = Math.floor(fx);
          const x1 = Math.min(g.gw - 1, x0 + 1);
          const tx = fx - x0;
          const a = blurred[y0 * g.gw + x0] * (1 - tx) + blurred[y0 * g.gw + x1] * tx;
          const b = blurred[y1 * g.gw + x0] * (1 - tx) + blurred[y1 * g.gw + x1] * tx;
          this.ao[g.base + j * g.w + i] = a * (1 - ty) + b * ty;
        }
      }
    }
    for (let k = 0; k < this.n; k++) this.writeTexel(k);
    for (let si = 0; si < this.surfDirty.length; si++) this.surfDirty[si] = true;
    this.aoDone = true;
    console.info(`[paint] AO: ${total} samples on ${nWorkers} workers in ${(performance.now() - t0).toFixed(0)} ms`);
    onProgress?.(1);
  }

  /**
   * Marks texels visible from the fixed camera. Rendered once into an ID/depth
   * buffer (single readback at startup or resize), then every texel is projected
   * and compared. Hidden faces, undersides and off-screen areas get weight 0.
   */
  computeReachability(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, root: THREE.Object3D): void {
    const W = 1280;
    const H = Math.max(2, Math.round(W / camera.aspect));
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true });
    rt.texture.minFilter = THREE.NearestFilter;
    rt.texture.magFilter = THREE.NearestFilter;
    const saved: THREE.Material[] = [];
    const idMats: THREE.ShaderMaterial[] = [];
    this.surfaces.forEach((s, i) => {
      saved.push(s.mesh.material as THREE.Material);
      const m = new THREE.ShaderMaterial({
        uniforms: { uId: { value: (i + 1) / 255 } },
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform float uId; varying vec3 vW; void main(){ float d = clamp(length(vW - cameraPosition)/30.0, 0.0, 1.0)*65535.0; float hi = floor(d/256.0); float lo = floor(d - hi*256.0); gl_FragColor = vec4(uId, hi/255.0, lo/255.0, 1.0); }`,
      });
      idMats.push(m);
      s.mesh.material = m;
    });
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(root, camera);
    const buf = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadow;
    this.surfaces.forEach((s, i) => {
      s.mesh.material = saved[i];
      idMats[i].dispose();
    });
    rt.dispose();

    camera.updateMatrixWorld(true);
    const cam = camera.position;
    this.cameraPos.copy(cam);
    const v = new THREE.Vector3();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = vp.elements;
    for (let t = 0; t < this.n; t++) {
      const px = this.pos[t * 3];
      const py = this.pos[t * 3 + 1];
      const pz = this.pos[t * 3 + 2];
      const dx = cam.x - px;
      const dy = cam.y - py;
      const dz = cam.z - pz;
      const facing = dx * this.nrm[t * 3] + dy * this.nrm[t * 3 + 1] + dz * this.nrm[t * 3 + 2];
      let ok = false;
      if (facing > 0) {
        const w = e[3] * px + e[7] * py + e[11] * pz + e[15];
        v.set((e[0] * px + e[4] * py + e[8] * pz + e[12]) / w, (e[1] * px + e[5] * py + e[9] * pz + e[13]) / w, 0);
        if (w > 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
          const sx = Math.min(W - 1, Math.floor((v.x * 0.5 + 0.5) * W));
          const sy = Math.min(H - 1, Math.floor((v.y * 0.5 + 0.5) * H));
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const tol = 0.02 + dist * 0.004;
          const id = this.surfOf[t] + 1;
          for (let oy = -1; oy <= 1 && !ok; oy++) {
            for (let ox = -1; ox <= 1 && !ok; ox++) {
              const qx = sx + ox;
              const qy = sy + oy;
              if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
              const o = (qy * W + qx) * 4;
              if (buf[o] !== id) continue;
              const d = ((buf[o + 1] * 256 + buf[o + 2]) / 65535) * 30;
              if (Math.abs(d - dist) < tol) ok = true;
            }
          }
        }
      }
      this.weight[t] = ok ? this.area[t] : 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation step

  beginStep(): void {
    this.stepId++;
    this.touchedN = 0;
  }

  private touch(t: number): void {
    if (this.mark[t] !== this.stepId) {
      this.mark[t] = this.stepId;
      this.dP[t] = 0;
      this.dC[t] = 0;
      this.dD[t] = 0;
      this.touched[this.touchedN++] = t;
    }
  }

  /** Visits texels of a surface within `radius` of `c`. */
  forEachNear(si: number, c: THREE.Vector3, radius: number, cb: (t: number, d2: number) => void): void {
    const h = this.hashes[si];
    if (!h) return;
    const x0 = Math.floor((c.x - radius) / CELL);
    const x1 = Math.floor((c.x + radius) / CELL);
    const y0 = Math.floor((c.y - radius) / CELL);
    const y1 = Math.floor((c.y + radius) / CELL);
    const z0 = Math.floor((c.z - radius) / CELL);
    const z1 = Math.floor((c.z + radius) / CELL);
    const r2 = radius * radius;
    const P = this.pos;
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const arr = h.get(keyOf(ix, iy, iz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const t = arr[k];
            const dx = P[t * 3] - c.x;
            const dy = P[t * 3 + 1] - c.y;
            const dz = P[t * 3 + 2] - c.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) cb(t, d2);
          }
        }
  }

  private _t1 = new THREE.Vector3();
  private _t2 = new THREE.Vector3();

  /** Tool footprint on the first surface hit. Adds to the paint or clean delta of this step. */
  stamp(si: number, hit: THREE.Vector3, n: THREE.Vector3, o: StampOptions): void {
    const { radius: R, center, edge } = o.params;
    const t1 = this._t1;
    const t2 = this._t2;
    if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0);
    else t1.set(1, 0, 0);
    t1.cross(n).normalize();
    t2.crossVectors(n, t1);
    const irr = o.irregularity ?? 0;
    const ph1 = Math.random() * 6.283;
    const ph2 = Math.random() * 6.283;
    const ph3 = Math.random() * 6.283;
    const Rmax = R * (1 + irr);
    const P = this.pos;
    const Nn = this.nrm;
    const isPaint = o.kind === 'paint';
    const fadeStart = isPaint ? 0.78 : 0.88;
    this.forEachNear(si, hit, Rmax, (t, d2) => {
      const dx = P[t * 3] - hit.x;
      const dy = P[t * 3 + 1] - hit.y;
      const dz = P[t * 3 + 2] - hit.z;
      const ndot = Nn[t * 3] * n.x + Nn[t * 3 + 1] * n.y + Nn[t * 3 + 2] * n.z;
      if (ndot < 0.15) return; // don't wrap onto the far side of thin objects
      const dn = dx * n.x + dy * n.y + dz * n.z;
      if (Math.abs(dn) > R * 0.75) return;
      let Reff = R;
      if (irr > 0) {
        const a = Math.atan2(dx * t2.x + dy * t2.y + dz * t2.z, dx * t1.x + dy * t1.y + dz * t1.z);
        Reff = R * (1 + irr * (0.55 * Math.sin(3 * a + ph1) + 0.3 * Math.sin(5 * a + ph2) + 0.15 * Math.sin(9 * a + ph3)));
      }
      const d = Math.sqrt(d2);
      if (d >= Reff) return;
      const x = d / Reff;
      const f = (center + (edge - center) * x) * (1 - smooth01(fadeStart, 1, x));
      if (f <= 0) return;
      this.touch(t);
      if (isPaint) this.dP[t] += o.amount * f;
      else this.dC[t] += o.amount * f;
    });
  }

  /** Decorative paint blob (droplets, drips). Not scored. Returns texels touched. */
  decorBlob(si: number, c: THREE.Vector3, n: THREE.Vector3, radius: number, value = 1): number {
    let count = 0;
    radius = Math.max(radius, this.texelSize * 0.85);
    const P = this.pos;
    const Nn = this.nrm;
    this.forEachNear(si, c, radius, (t, d2) => {
      const ndot = Nn[t * 3] * n.x + Nn[t * 3 + 1] * n.y + Nn[t * 3 + 2] * n.z;
      if (ndot < 0.5) return;
      const dn = (P[t * 3] - c.x) * n.x + (P[t * 3 + 1] - c.y) * n.y + (P[t * 3 + 2] - c.z) * n.z;
      if (Math.abs(dn) > Math.max(0.02, radius)) return;
      const x = Math.sqrt(d2) / radius;
      this.touch(t);
      this.dD[t] = Math.max(this.dD[t], value * (1 - smooth01(0.6, 1, x)));
      count++;
    });
    return count;
  }

  /** Mean scored coverage around a point (used to decide where drips form). */
  coverageAround(si: number, c: THREE.Vector3, radius: number): number {
    let s = 0;
    let k = 0;
    this.forEachNear(si, c, radius, (t) => {
      s += this.cov[t];
      k++;
    });
    return k ? s / k : 0;
  }

  /** Combines paint and water deltas of this step in a single, order-independent pass. */
  endStep(): void {
    const sink = this.score;
    for (let k = 0; k < this.touchedN; k++) {
      const t = this.touched[k];
      const cOld = this.cov[t];
      const clean = this.dC[t];
      const cNew = Math.min(1, Math.max(0, cOld + this.dP[t] - clean));
      this.cov[t] = cNew;
      const dOld = this.decor[t];
      // Decorative paint: added as a max, removed by water faster than coverage.
      let dNew = Math.max(dOld, this.dD[t]);
      dNew = Math.max(0, dNew - clean * 1.6);
      this.decor[t] = dNew;
      if (clean > 0) {
        this.wet[t] = 1;
        if (!this.inWet[t]) {
          this.inWet[t] = 1;
          this.wetList[this.wetN++] = t;
        }
      }
      if (cNew !== cOld && sink) sink.onCoverageChange(t, cOld, cNew);
      this.writeTexel(t);
    }
  }

  private writeTexel(t: number): void {
    const si = this.surfOf[t];
    const data = this.datas[si];
    const r = Math.round(this.cov[t] * 255);
    const g = Math.round(this.decor[t] * 255);
    const b = Math.round(this.wet[t] * 255);
    const a = Math.round(this.ao[t] * 255);
    let o = this.pix[t] * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
    for (let k = this.gStart[t], e = this.gStart[t + 1]; k < e; k++) {
      o = this.gPix[k] * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
    this.surfDirty[si] = true;
  }

  /** Per-frame: decays the wet shine and uploads changed masks. */
  updateVisuals(dt: number): void {
    if (this.aoDone && this.aoMix < 1) {
      this.aoMix = Math.min(1, this.aoMix + dt / 0.9);
      const e = this.aoMix * this.aoMix * (3 - 2 * this.aoMix);
      for (const s of this.surfaces) s.uniforms.uAo.value = e;
    }
    if (this.wetN > 0) {
      const decay = dt / 0.75;
      let w = 0;
      for (let k = 0; k < this.wetN; k++) {
        const t = this.wetList[k];
        const v = this.wet[t] - decay;
        if (v <= 0) {
          this.wet[t] = 0;
          this.inWet[t] = 0;
        } else {
          this.wet[t] = v;
          this.wetList[w++] = t;
        }
        this.writeTexel(t);
      }
      this.wetN = w;
    }
    for (let si = 0; si < this.surfDirty.length; si++) {
      if (this.surfDirty[si]) {
        this.textures[si].needsUpdate = true;
        this.surfDirty[si] = false;
      }
    }
  }

  reset(): void {
    this.cov.fill(0);
    this.decor.fill(0);
    this.wet.fill(0);
    this.inWet.fill(0);
    this.wetN = 0;
    for (let t = 0; t < this.n; t++) this.writeTexel(t);
    for (const tex of this.textures) tex.needsUpdate = true;
    this.surfDirty.fill(false);
  }
}

function frame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}


function blurGrid(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(g.length);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let s = 0;
      let c = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          const y = j + dj;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const wt = di === 0 && dj === 0 ? 2 : 1;
          s += g[y * w + x] * wt;
          c += wt;
        }
      out[j * w + i] = s / c;
    }
  return out;
}
