import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { COLORS, settings } from '../config';
import { Spring } from '../util/Spring';

const clay = (color: number, roughness = 0.75, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

function rbox(w: number, h: number, d: number, r: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
}

function cylZ(r: number, len: number, mat: THREE.Material, seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.rotation.x = Math.PI / 2;
  return m;
}

function buildPaintGun(): { model: THREE.Group; nozzle: THREE.Object3D } {
  const g = new THREE.Group();
  const white = clay(0xf5f3f0, 0.6);
  const accent = clay(COLORS.paint, 0.35);
  const dark = clay(0x3a3a42, 0.4, 0.4);
  const paintGloss = new THREE.MeshStandardMaterial({ color: COLORS.paint, roughness: 0.18, metalness: 0 });

  const body = rbox(0.05, 0.062, 0.15, 0.02, white);
  body.position.set(0, 0.03, -0.045);
  const handle = rbox(0.036, 0.115, 0.046, 0.016, accent);
  handle.position.set(0, -0.045, 0.012);
  handle.rotation.x = 0.28;
  const trigger = rbox(0.012, 0.045, 0.012, 0.005, dark);
  trigger.position.set(0, -0.012, -0.03);
  trigger.rotation.x = 0.2;
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.06, 24), paintGloss);
  cup.position.set(0, 0.092, -0.06);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.012, 24), white);
  lid.position.set(0, 0.126, -0.06);
  const neck = cylZ(0.014, 0.04, dark);
  neck.position.set(0, 0.03, -0.135);
  const tip = cylZ(0.017, 0.012, accent);
  tip.position.set(0, 0.03, -0.158);
  g.add(body, handle, trigger, cup, lid, neck, tip);
  const nozzle = new THREE.Object3D();
  nozzle.position.set(0, 0.03, -0.168);
  g.add(nozzle);
  return { model: g, nozzle };
}

/** First-person paint gun held at the bottom centre of the screen, aiming at its jet impact with spring inertia. */
export class Tool {
  readonly group = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly nozzle: THREE.Object3D;
  private yaw = new Spring(0, 0, 150, 17);
  private pitch = new Spring(0, 0, 150, 17);
  private recoil = new Spring(0, 0, 260, 14);
  private recoilPitch = new Spring(0, 0, 240, 13);
  private rest = new THREE.Vector3();
  private wasFiring = false;
  private tmp = new THREE.Vector3();
  private time = 0;

  constructor(private camera: THREE.PerspectiveCamera) {
    const built = buildPaintGun();
    this.nozzle = built.nozzle;
    built.model.scale.setScalar(0.46);
    this.pivot.add(built.model);
    this.group.add(this.pivot);
    this.group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    camera.add(this.group);
  }

  layout(): void {
    const d = 0.62;
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.rest.set(0, -halfH * 0.8, -d);
  }

  /** target: world-space point the jet is going to. */
  update(dt: number, target: THREE.Vector3, firing: boolean, visible: boolean): void {
    this.group.visible = visible;
    this.time += dt;
    // Aim in camera space
    this.tmp.copy(target);
    this.camera.worldToLocal(this.tmp);
    this.tmp.sub(this.rest);
    const yaw = Math.atan2(-this.tmp.x, -this.tmp.z);
    const pitch = Math.atan2(this.tmp.y, Math.hypot(this.tmp.x, this.tmp.z));
    this.yaw.target = yaw;
    this.pitch.target = pitch;
    const reduced = settings.reducedFx;
    if (firing && !this.wasFiring) {
      // Elastic recoil when the jet starts.
      this.recoil.kick(reduced ? 0.25 : 0.55);
      this.recoilPitch.kick(reduced ? 0.8 : 2.2);
    }
    this.wasFiring = firing;
    this.yaw.update(dt);
    this.pitch.update(dt);
    this.recoil.update(dt);
    this.recoilPitch.update(dt);

    const jitterZ = firing && !reduced ? Math.max(0, Math.sin(this.time * Math.PI * 2 * 11)) * 0.0035 : 0;
    const bob = reduced ? 0 : Math.sin(this.time * 1.7) * 0.0025;
    this.group.position.set(this.rest.x, this.rest.y + bob, this.rest.z + this.recoil.value * 0.035 + jitterZ);
    this.pivot.rotation.set(this.pitch.value + this.recoilPitch.value * 0.05, this.yaw.value, 0, 'YXZ');
  }

  nozzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.nozzle.updateWorldMatrix(true, false);
    return this.nozzle.getWorldPosition(out);
  }
}
