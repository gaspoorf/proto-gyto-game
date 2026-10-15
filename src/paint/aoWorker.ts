/// <reference lib="webworker" />
import { BufferAttribute, BufferGeometry, DoubleSide, Ray } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Ambient-occlusion bake for a batch of surface samples (static scene).
 * Input samples: 6 floats each (position xyz, normal xyz). Output: AO in [0,1].
 */
export interface AOJob {
  positions: Float32Array;
  indices: Uint32Array;
  samples: Float32Array;
  rays: number;
  maxDist: number;
}

function hash2(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

self.onmessage = (e: MessageEvent<AOJob>) => {
  const { positions, indices, samples, rays: R, maxDist } = e.data;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  const bvh = new MeshBVH(g);
  const count = samples.length / 6;
  const out = new Float32Array(count);
  const ray = new Ray();
  let tAx = 0, tAy = 0, tAz = 0, tBx = 0, tBy = 0, tBz = 0;
  for (let s = 0; s < count; s++) {
    const o = s * 6;
    const nx = samples[o + 3];
    const ny = samples[o + 4];
    const nz = samples[o + 5];
    // tangent frame
    if (Math.abs(ny) < 0.9) {
      // t1 = up × n
      tAx = nz; tAy = 0; tAz = -nx;
    } else {
      tAx = 0; tAy = -nz; tAz = ny;
    }
    const l = Math.hypot(tAx, tAy, tAz) || 1;
    tAx /= l; tAy /= l; tAz /= l;
    tBx = ny * tAz - nz * tAy;
    tBy = nz * tAx - nx * tAz;
    tBz = nx * tAy - ny * tAx;
    ray.origin.set(samples[o] + nx * 0.006, samples[o + 1] + ny * 0.006, samples[o + 2] + nz * 0.006);
    const rot = hash2(s, 7) * Math.PI * 2;
    let occ = 0;
    for (let r = 0; r < R; r++) {
      const u1 = (r + hash2(s, r)) / R;
      const phi = rot + r * 2.39996;
      const sr = Math.sqrt(u1);
      const x = Math.cos(phi) * sr;
      const y = Math.sin(phi) * sr;
      const z = Math.sqrt(Math.max(0, 1 - u1));
      ray.direction.set(tAx * x + tBx * y + nx * z, tAy * x + tBy * y + ny * z, tAz * x + tBz * y + nz * z);
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, maxDist);
      if (hit) occ += 1 - Math.pow(hit.distance / maxDist, 0.7);
    }
    out[s] = Math.max(0, 1 - (occ / R) * 1.35);
    if ((s & 1023) === 1023) (self as unknown as Worker).postMessage({ progress: s / count });
  }
  (self as unknown as Worker).postMessage({ ao: out }, [out.buffer]);
};
