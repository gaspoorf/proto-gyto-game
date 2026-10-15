import * as THREE from 'three';
import { COLORS } from '../config';

/** Visual jets and particles. Purely decorative: never touch the score. */

export interface JetState {
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  normal: THREE.Vector3;
  hit: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _ctrl = new THREE.Vector3();

function bezier(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const m = 1 - t;
  return out.set(
    m * m * a.x + 2 * m * t * c.x + t * t * b.x,
    m * m * a.y + 2 * m * t * c.y + t * t * b.y,
    m * m * a.z + 2 * m * t * c.z + t * t * b.z,
  );
}
function bezierTangent(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const m = 1 - t;
  return out
    .set(
      2 * m * (c.x - a.x) + 2 * t * (b.x - c.x),
      2 * m * (c.y - a.y) + 2 * t * (b.y - c.y),
      2 * m * (c.z - a.z) + 2 * t * (b.z - c.z),
    )
    .normalize();
}

/** Pulsed paint stream: glossy blobs flowing along an arc that lands exactly on the impact point. */
export class PaintStream {
  readonly mesh: THREE.InstancedMesh;
  private K = 70;
  private time = 0;
  constructor(scene: THREE.Object3D) {
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.paint, roughness: 0.22, metalness: 0, emissive: 0x4a0020 });
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), mat, this.K);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }
  update(dt: number, s: JetState, camUp: THREE.Vector3): void {
    this.time += dt;
    if (!s.active) {
      this.mesh.count = 0;
      return;
    }
    const dist = s.from.distanceTo(s.to);
    _ctrl.addVectors(s.from, s.to).multiplyScalar(0.5).addScaledVector(camUp, dist * 0.07);
    for (let k = 0; k < this.K; k++) {
      const t = (k / this.K + this.time * 2.6) % 1;
      bezier(_p, s.from, _ctrl, s.to, t);
      bezierTangent(_t, s.from, _ctrl, s.to, t);
      // Pulses travel down the stream.
      const pulse = 0.55 + 0.45 * Math.max(0, Math.sin(this.time * Math.PI * 2 * 9 - t * 14));
      const r = (0.004 + 0.024 * t) * pulse;
      _q.setFromUnitVectors(_z, _t);
      _s.set(r, r, r * (3.2 + 1.5 * t));
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(k, _m);
    }
    this.mesh.count = this.K;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Pooled paint droplets (instanced spheres). */
export class Particles {
  private dropMesh: THREE.InstancedMesh;
  private dropPos: Float32Array;
  private dropVel: Float32Array;
  private dropLife: Float32Array;
  private dropMax: Float32Array;
  private dropSize: Float32Array;
  private dropHead = 0;
  readonly DROPS = 240;

  constructor(scene: THREE.Object3D) {
    const dm = new THREE.MeshStandardMaterial({ color: COLORS.paint, roughness: 0.2, emissive: 0x3a0018 });
    this.dropMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), dm, this.DROPS);
    this.dropMesh.frustumCulled = false;
    this.dropPos = new Float32Array(this.DROPS * 3);
    this.dropVel = new Float32Array(this.DROPS * 3);
    this.dropLife = new Float32Array(this.DROPS);
    this.dropMax = new Float32Array(this.DROPS).fill(1);
    this.dropSize = new Float32Array(this.DROPS);
    for (let i = 0; i < this.DROPS; i++) this.dropMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    scene.add(this.dropMesh);
  }

  spawnPaint(p: THREE.Vector3, n: THREE.Vector3, count: number, speed = 1): void {
    for (let k = 0; k < count; k++) {
      const i = this.dropHead;
      this.dropHead = (this.dropHead + 1) % this.DROPS;
      // Radial splash: mostly along the surface, kicked off the normal.
      const a = Math.random() * Math.PI * 2;
      tangentFrame(n, _t, _s);
      const radial = (0.5 + Math.random() * 1.3) * speed;
      const up = (0.4 + Math.random() * 1.0) * speed;
      const vx = (_t.x * Math.cos(a) + _s.x * Math.sin(a)) * radial + n.x * up;
      const vy = (_t.y * Math.cos(a) + _s.y * Math.sin(a)) * radial + n.y * up;
      const vz = (_t.z * Math.cos(a) + _s.z * Math.sin(a)) * radial + n.z * up;
      this.dropPos.set([p.x + n.x * 0.02, p.y + n.y * 0.02, p.z + n.z * 0.02], i * 3);
      this.dropVel.set([vx, vy, vz], i * 3);
      this.dropMax[i] = this.dropLife[i] = 0.18 + Math.random() * 0.3;
      this.dropSize[i] = 0.004 + Math.random() * 0.007;
    }
  }

  update(dt: number): void {
    const g = -9.8;
    for (let i = 0; i < this.DROPS; i++) {
      if (this.dropLife[i] <= 0) continue;
      this.dropLife[i] -= dt;
      const o = i * 3;
      this.dropVel[o + 1] += g * dt;
      this.dropPos[o] += this.dropVel[o] * dt;
      this.dropPos[o + 1] += this.dropVel[o + 1] * dt;
      this.dropPos[o + 2] += this.dropVel[o + 2] * dt;
      const life = Math.max(0, this.dropLife[i] / this.dropMax[i]);
      const r = this.dropSize[i] * Math.min(1, life * 2.5);
      _p.set(this.dropPos[o], this.dropPos[o + 1], this.dropPos[o + 2]);
      _t.set(this.dropVel[o], this.dropVel[o + 1], this.dropVel[o + 2]);
      const sp = _t.length();
      _q.setFromUnitVectors(_z, sp > 1e-4 ? _t.multiplyScalar(1 / sp) : _z);
      _s.set(r, r, r * (1 + Math.min(2, sp * 0.4)));
      this.dropMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    this.dropMesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.dropLife.fill(0);
    for (let i = 0; i < this.DROPS; i++) this.dropMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    this.dropMesh.instanceMatrix.needsUpdate = true;
  }
}

export function tangentFrame(n: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0);
  else t1.set(1, 0, 0);
  t1.cross(n).normalize();
  t2.crossVectors(n, t1);
}
