import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { COLORS, QUALITY, type Quality } from '../config';
import {
  ShapeBuilder,
  lathe,
  roundedBox,
  roundedCylinderProfile,
  roundedProfile,
  sphereProfile,
  type PaintableShape,
} from './shapes';
import { createClayMaterial, type ClayUniforms } from './clayMaterial';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Paintable {
  name: string;
  mesh: THREE.Mesh;
  shape: PaintableShape;
  uniforms: ClayUniforms;
}

interface PropDef {
  name: string;
  build: (b: ShapeBuilder) => void;
  pos: [number, number, number];
  rot?: [number, number, number];
  color?: number;
}

// Room interior: x ∈ [-RW, RW], z ∈ [-RD, RD], floor at y=0.
export const RW = 3.0;
export const RD = 2.2;
export const RH = 3.0;
const WALL_T = 0.2;

const C = (n: number) => n;

/** Furniture and room shell. All white clay, rounded volumes. */
function propDefs(): PropDef[] {
  const defs: PropDef[] = [];
  const add = (d: PropDef) => defs.push(d);
  const warm = 0xf6f3ef;
  const cool = 0xf1f1f0;

  // --- Shell: floor slab and three walls (outer faces skipped: never visible).
  add({
    name: 'floor',
    build: (b) => roundedBox(b, 2 * RW + 2 * WALL_T, 0.24, 2 * RD + WALL_T + 0.25, 0.05, ['-y']),
    pos: [0, -0.12, 0.125 - WALL_T / 2 + 0.0],
    color: 0xefece8,
  });
  add({
    name: 'wall-back',
    build: (b) => roundedBox(b, 2 * RW + 2 * WALL_T, RH, WALL_T, 0.05, ['-z', '-y']),
    pos: [0, RH / 2, -RD - WALL_T / 2],
    color: warm,
  });
  add({
    name: 'wall-left',
    build: (b) => roundedBox(b, WALL_T, RH, 2 * RD + 0.25, 0.05, ['-x', '-y', '-z']),
    pos: [-RW - WALL_T / 2, RH / 2, 0.125],
    color: warm,
  });
  add({
    name: 'wall-right',
    build: (b) => roundedBox(b, WALL_T, RH, 2 * RD + 0.25, 0.05, ['+x', '-y', '-z']),
    pos: [RW + WALL_T / 2, RH / 2, 0.125],
    color: warm,
  });

  // --- Rug
  add({ name: 'rug', build: (b) => roundedBox(b, 3.3, 0.035, 2.1, 0.017, ['-y']), pos: [0.15, 0.0175, -0.55], color: 0xf7f5f2 });

  // --- Sofa against the back wall
  const sz = -RD + 0.55;
  add({ name: 'sofa-base', build: (b) => roundedBox(b, 2.7, 0.4, 1.0, 0.1, ['-y', '-z']), pos: [0, 0.2, sz], color: cool });
  add({ name: 'sofa-arm-l', build: (b) => roundedBox(b, 0.24, 0.66, 1.0, 0.11, ['-y']), pos: [-1.23, 0.33, sz], color: cool });
  add({ name: 'sofa-arm-r', build: (b) => roundedBox(b, 0.24, 0.66, 1.0, 0.11, ['-y']), pos: [1.23, 0.33, sz], color: cool });
  add({ name: 'sofa-back', build: (b) => roundedBox(b, 2.22, 0.62, 0.26, 0.12, ['-y']), pos: [0, 0.68, sz - 0.36], rot: [-0.1, 0, 0], color: cool });
  add({ name: 'cushion-l', build: (b) => roundedBox(b, 1.08, 0.2, 0.74, 0.09, ['-y']), pos: [-0.55, 0.5, sz + 0.1], color: cool });
  add({ name: 'cushion-r', build: (b) => roundedBox(b, 1.08, 0.2, 0.74, 0.09, ['-y']), pos: [0.55, 0.5, sz + 0.1], color: cool });
  add({ name: 'pillow', build: (b) => roundedBox(b, 0.46, 0.42, 0.15, 0.07), pos: [-0.72, 0.82, sz - 0.12], rot: [-0.25, 0.25, 0.12], color: warm });

  // --- Coffee table
  const tx = 0.15;
  const tz = -0.45;
  add({ name: 'table-top', build: (b) => roundedBox(b, 1.4, 0.08, 0.72, 0.035), pos: [tx, 0.42, tz] });
  add({ name: 'table-leg-l', build: (b) => roundedBox(b, 0.09, 0.38, 0.6, 0.035, ['-y', '+y']), pos: [tx - 0.55, 0.19, tz] });
  add({ name: 'table-leg-r', build: (b) => roundedBox(b, 0.09, 0.38, 0.6, 0.035, ['-y', '+y']), pos: [tx + 0.55, 0.19, tz] });
  add({ name: 'cup', build: (b) => lathe(b, cupProfile(), 28), pos: [tx + 0.38, 0.46, tz + 0.12] });
  add({ name: 'vase', build: (b) => lathe(b, vaseProfile(), 32), pos: [tx - 0.32, 0.46, tz - 0.1] });
  add({ name: 'book-table', build: (b) => roundedBox(b, 0.34, 0.05, 0.24, 0.015, ['-y']), pos: [tx + 0.05, 0.485, tz + 0.05], rot: [0, 0.3, 0] });

  // --- Sideboard on the left wall
  const bx = -RW + 0.27;
  add({ name: 'sideboard', build: (b) => roundedBox(b, 0.5, 0.78, 1.9, 0.05, ['-y', '-x']), pos: [bx, 0.39, -0.35] });
  add({ name: 'sideboard-door-a', build: (b) => roundedBox(b, 0.03, 0.62, 0.86, 0.012, ['-x']), pos: [bx + 0.26, 0.4, -0.8] });
  add({ name: 'sideboard-door-b', build: (b) => roundedBox(b, 0.03, 0.62, 0.86, 0.012, ['-x']), pos: [bx + 0.26, 0.4, 0.1] });
  add({ name: 'table-lamp-base', build: (b) => lathe(b, sphereProfile(0.13, 16), 28), pos: [bx, 0.78, -0.95] });
  add({ name: 'table-lamp-shade', build: (b) => lathe(b, shadeProfile(0.2, 0.13, 0.22), 32), pos: [bx, 1.06, -0.95] });
  add({ name: 'books-a', build: (b) => roundedBox(b, 0.26, 0.24, 0.06, 0.012, ['-y']), pos: [bx - 0.02, 0.9, 0.1], rot: [0, Math.PI / 2, 0] });
  add({ name: 'books-b', build: (b) => roundedBox(b, 0.26, 0.2, 0.06, 0.012, ['-y']), pos: [bx - 0.02, 0.88, 0.17], rot: [0, Math.PI / 2, 0] });
  add({ name: 'bowl', build: (b) => lathe(b, bowlProfile(), 28), pos: [bx, 0.78, 0.45] });

  // --- Floor lamp (right of sofa)
  const lx = 1.85;
  const lz = -RD + 0.4;
  add({ name: 'lamp-foot', build: (b) => lathe(b, roundedCylinderProfile(0.2, 0.05, 0.022), 32), pos: [lx, 0, lz] });
  add({ name: 'lamp-pole', build: (b) => lathe(b, roundedCylinderProfile(0.025, 1.45, 0.012), 16), pos: [lx, 0.05, lz] });
  add({ name: 'lamp-shade', build: (b) => lathe(b, shadeProfile(0.3, 0.18, 0.32), 36), pos: [lx, 1.38, lz] });

  // --- Shelves on the right wall
  const sx = RW - 0.19;
  for (const [i, y] of [1.05, 1.5, 1.95].entries()) {
    add({ name: `shelf-${i}`, build: (b) => roundedBox(b, 0.38, 0.05, 1.5, 0.022, ['+x']), pos: [sx, y, -0.75] });
  }
  add({ name: 'shelf-ball', build: (b) => lathe(b, sphereProfile(0.11, 16), 28), pos: [sx - 0.02, 1.075, -1.2] });
  add({ name: 'shelf-vase', build: (b) => lathe(b, vaseProfile(0.8), 28), pos: [sx - 0.02, 1.525, -0.35] });
  add({ name: 'shelf-books', build: (b) => roundedBox(b, 0.22, 0.26, 0.38, 0.02, ['-y']), pos: [sx - 0.04, 1.105, -0.3] });
  add({ name: 'shelf-box', build: (b) => roundedBox(b, 0.28, 0.2, 0.3, 0.05, ['-y']), pos: [sx - 0.04, 1.625, -1.15] });
  add({ name: 'shelf-cone', build: (b) => lathe(b, coneProfile(), 24), pos: [sx - 0.04, 1.975, -0.75] });

  // --- Wall frames and round mirror on the back wall
  const wz = -RD;
  add({ name: 'frame-a', build: (b) => roundedBox(b, 0.95, 0.7, 0.05, 0.022, ['-z']), pos: [-0.55, 1.85, wz + 0.025] });
  add({ name: 'frame-b', build: (b) => roundedBox(b, 0.52, 0.7, 0.05, 0.022, ['-z']), pos: [0.38, 1.85, wz + 0.025] });
  add({ name: 'mirror', build: (b) => lathe(b, roundedCylinderProfile(0.36, 0.05, 0.02), 40), pos: [-RW, 1.8, 0.15], rot: [0, 0, -Math.PI / 2] });

  // --- Plant in the back-left corner
  const px = -RW + 0.65;
  const pz = -RD + 0.6;
  add({ name: 'pot', build: (b) => lathe(b, potProfile(), 32), pos: [px, 0, pz] });
  add({ name: 'leaf-a', build: (b) => lathe(b, sphereProfile(0.26, 16), 28), pos: [px, 0.52, pz] });
  add({ name: 'leaf-b', build: (b) => lathe(b, sphereProfile(0.19, 14), 24), pos: [px + 0.2, 0.82, pz + 0.04] });
  add({ name: 'leaf-c', build: (b) => lathe(b, sphereProfile(0.16, 14), 24), pos: [px - 0.12, 0.98, pz - 0.05] });

  // --- Pouf
  add({ name: 'pouf', build: (b) => lathe(b, roundedCylinderProfile(0.32, 0.36, 0.13), 36), pos: [-1.55, 0, 0.55] });
  add({ name: 'pouf-2', build: (b) => lathe(b, roundedCylinderProfile(0.24, 0.3, 0.11), 32), pos: [2.0, 0, 0.45] });
  return defs.map((d) => ({ ...d, color: d.color ?? C(COLORS.clay) }));
}

function cupProfile(): [number, number][] {
  return roundedProfile(
    [
      [0, 0],
      [0.042, 0],
      [0.05, 0.095],
      [0.042, 0.095],
      [0.036, 0.012],
      [0, 0.012],
    ],
    [0, 0.01, 0.004, 0.004, 0.01, 0],
    5,
  );
}

function vaseProfile(s = 1): [number, number][] {
  const p: [number, number][] = [
    [0, 0],
    [0.07, 0],
    [0.11, 0.09],
    [0.055, 0.24],
    [0.06, 0.3],
    [0.042, 0.3],
    [0.036, 0.25],
    [0, 0.25],
  ];
  return roundedProfile(
    p.map(([r, y]) => [r * s, y * s]),
    [0, 0.02, 0.07, 0.04, 0.006, 0.006, 0.01, 0],
    7,
  );
}

function bowlProfile(): [number, number][] {
  return roundedProfile(
    [
      [0, 0],
      [0.07, 0],
      [0.15, 0.09],
      [0.135, 0.09],
      [0.06, 0.02],
      [0, 0.02],
    ],
    [0, 0.04, 0.008, 0.008, 0.04, 0],
    6,
  );
}

function potProfile(): [number, number][] {
  return roundedProfile(
    [
      [0, 0],
      [0.18, 0],
      [0.24, 0.4],
      [0.21, 0.4],
      [0.19, 0.34],
      [0, 0.34],
    ],
    [0, 0.04, 0.015, 0.015, 0.02, 0],
    6,
  );
}

function shadeProfile(rBottom: number, rTop: number, h: number): [number, number][] {
  const t = 0.012;
  return roundedProfile(
    [
      [rBottom - t, 0.004],
      [rBottom, 0],
      [rTop, h],
      [rTop - t, h - 0.002],
      [rBottom - t * 1.6, 0.006],
    ],
    [0, 0.008, 0.008, 0.006, 0],
    4,
  );
}

function coneProfile(): [number, number][] {
  return roundedProfile(
    [
      [0, 0],
      [0.09, 0],
      [0.0, 0.26],
    ],
    [0, 0.02, 0],
    5,
  );
}

export class World {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  paintables: Paintable[] = [];
  root = new THREE.Group();
  sun: THREE.DirectionalLight;
  private pmrem: THREE.PMREMGenerator;
  readonly lookTarget = new THREE.Vector3(0.05, 0.85, -0.45);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.scene.background = new THREE.Color(COLORS.background);
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 60);
    this.camera.position.set(0.1, 2.75, 5.75);
    this.camera.lookAt(this.lookTarget);
    this.scene.add(this.camera);
    this.scene.add(this.root);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    const env = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.42;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xd9cfc6, 0.62);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff6ec, 2.35);
    this.sun.position.set(-3.0, 7.5, 6.0);
    this.sun.target.position.set(0, 0, -0.6);
    this.scene.add(this.sun, this.sun.target);
    const sc = this.sun.shadow.camera;
    sc.left = -5.2;
    sc.right = 5.2;
    sc.top = 5;
    sc.bottom = -5;
    sc.near = 1;
    sc.far = 20;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 5;
  }

  applyQuality(q: Quality): void {
    const p = QUALITY[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatioCap));
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize) {
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  /** (Re)creates paintable meshes with masks sized for the given texel density. */
  buildPaintables(density: number): Paintable[] {
    for (const p of this.paintables) {
      this.root.remove(p.mesh);
      p.mesh.geometry.disposeBoundsTree?.();
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.paintables = [];
    for (const def of propDefs()) {
      const b = new ShapeBuilder();
      def.build(b);
      const shape = b.finalize(density);
      const mat = createClayMaterial(def.color);
      const mesh = new THREE.Mesh(shape.geometry, mat);
      mesh.name = def.name;
      mesh.position.set(...def.pos);
      if (def.rot) mesh.rotation.set(...def.rot);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      shape.geometry.computeBoundsTree();
      this.root.add(mesh);
      this.paintables.push({ name: def.name, mesh, shape, uniforms: mat.userData.uniforms });
    }
    this.root.updateMatrixWorld(true);
    return this.paintables;
  }

  /** Keeps the whole room in frame whatever the aspect ratio. */
  resize(w: number, h: number): void {
    const aspect = w / h;
    this.camera.aspect = aspect;
    const baseV = 40;
    const refAspect = 16 / 9;
    if (aspect < refAspect) {
      const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseV) / 2) * refAspect);
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
    } else {
      this.camera.fov = baseV;
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }
}
