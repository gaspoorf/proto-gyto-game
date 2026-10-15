import * as THREE from 'three';
import type { PaintSystem } from './PaintSystem';

interface Drip {
  si: number;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  n: THREE.Vector3;
  speed: number;
  left: number;
  width: number;
}

const GRAVITY = new THREE.Vector3(0, -1, 0);

/**
 * Paint runs on vertical surfaces. Written to the decorative channel only:
 * they look like paint and are washed away by water, but never count in the score.
 */
export class Drips {
  private drips: Drip[] = [];
  max = 28;

  constructor(private ps: PaintSystem) {}

  /** Try to start a drip under a fresh, saturated splat on a vertical surface. */
  trySpawn(si: number, hit: THREE.Vector3, n: THREE.Vector3, radius: number): void {
    if (this.drips.length >= this.max) return;
    if (Math.abs(n.y) > 0.45) return;
    const dir = GRAVITY.clone().addScaledVector(n, -GRAVITY.dot(n));
    if (dir.lengthSq() < 1e-4) return;
    dir.normalize();
    const side = new THREE.Vector3().crossVectors(n, dir);
    const start = hit
      .clone()
      .addScaledVector(dir, radius * (0.45 + Math.random() * 0.35))
      .addScaledVector(side, (Math.random() - 0.5) * radius * 1.1);
    if (this.ps.coverageAround(si, start, 0.02) < 0.7) return;
    this.drips.push({
      si,
      pos: start,
      dir,
      n: n.clone(),
      speed: 0.18 + Math.random() * 0.14,
      left: 0.12 + Math.random() * 0.4,
      width: 0.008 + Math.random() * 0.008,
    });
  }

  /** Advances drips by one simulation step (writes into the current step's decor delta). */
  step(dt: number): void {
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      const ds = d.speed * dt;
      d.pos.addScaledVector(d.dir, ds);
      d.left -= ds;
      d.speed = Math.max(0.035, d.speed * Math.exp(-1.4 * dt));
      const w = d.width * (0.75 + 0.25 * Math.min(1, d.left * 8));
      const hit = this.ps.decorBlob(d.si, d.pos, d.n, w, 1);
      if (hit === 0) {
        this.drips.splice(i, 1);
        continue;
      }
      if (d.left <= 0) {
        this.ps.decorBlob(d.si, d.pos, d.n, d.width * 1.7, 1); // drop bulb at the end
        this.drips.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.drips.length = 0;
  }
}
