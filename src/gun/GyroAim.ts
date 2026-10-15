// Transforme les vitesses angulaires du gyroscope (rad/s) en angles de visée
import { Quaternion, Vector3 } from 'three';
import type { GunSettings } from '../config';

export type Axis = 'x' | 'y' | 'z';
export type AimState = 'idle' | 'calibrating' | 'detecting-yaw' | 'detecting-pitch' | 'ready';
export type AimInfo = 'moved' | 'too-few' | 'not-enough' | 'axes-found' | null | undefined;
type Vec3 = [number, number, number];

const AXES: Axis[] = ['x', 'y', 'z'];
const AXIS_VECTORS = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const DEG = Math.PI / 180;

// au-delà de cet écart-type (rad/s) pendant la calibration, on considère que le gun a bougé
const MAX_CALIBRATION_NOISE = 0.05;
// rotation minimale (rad) attendue pendant la détection d'un axe
const MIN_DETECTION_ROTATION = 0.3;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// vecteurs temporaires, réutilisés à chaque mesure
const omega = new Vector3();
const step = new Quaternion();
const right = new Vector3();
const down = new Vector3();
const forward = new Vector3();
const aimDirection = new Vector3();

export class GyroAim {
  state: AimState = 'idle';
  onStateChange: ((state: AimState, info: AimInfo) => void) | null = null;
  onAxesDetected: (() => void) | null = null;

  raw: Vec3 = [0, 0, 0];
  bias: Vec3 = [0, 0, 0];
  /** Orientation du gun par rapport à la position de calibration. */
  orientation = new Quaternion();
  /** rad, + = droite */
  yaw = 0;
  /** rad, + = haut */
  pitch = 0;

  private samples: Vec3[] = [];
  /** Rotation cumulée par axe pendant la détection. */
  private rotation: Vec3 = [0, 0, 0];
  /** Rotation cumulée par axe depuis le dernier recentrage. */
  total: Vec3 = [0, 0, 0];
  private lastTime: number | null = null;
  /** Fréquence de réception (Hz), pour le debug. */
  rate = 0;
  private stepStart = 0;
  private stepDuration = 2000;

  constructor(private settings: GunSettings) {}

  private setState(state: AimState, info?: AimInfo, duration = 2000): void {
    this.state = state;
    this.stepStart = performance.now();
    this.stepDuration = duration;
    this.onStateChange?.(state, info);
  }

  get progress(): number {
    if (this.state === 'ready' || this.state === 'idle') return 0;
    return clamp((performance.now() - this.stepStart) / this.stepDuration, 0, 1);
  }

  private get stepDone(): boolean {
    return performance.now() - this.stepStart >= this.stepDuration;
  }

  calibrate(info?: AimInfo): void {
    this.samples = [];
    this.setState('calibrating', info);
  }

  /** Demande de tourner le gun à droite, puis vers le haut, pour trouver quel axe fait quoi. */
  detectAxes(info?: AimInfo): void {
    this.rotation = [0, 0, 0];
    this.setState('detecting-yaw', info, 2500);
  }

  /** La direction actuelle du gun devient le centre de l'écran. */
  recenter(): void {
    this.orientation.identity();
    this.yaw = 0;
    this.pitch = 0;
    this.total = [0, 0, 0];
  }

  disconnect(): void {
    this.lastTime = null;
    this.setState('idle');
  }

  // sensorDt : temps (s) mesuré par l'Arduino depuis la mesure précédente, plus précis
  // que l'heure d'arrivée car le port série livre les lignes par paquets
  push(values: Vec3, sensorDt?: number, time = performance.now()): void {
    this.raw = values;

    const arrivalDt = this.lastTime === null ? 0 : (time - this.lastTime) / 1000;
    this.lastTime = time;
    // dt borné : évite un saut si les données ont été interrompues
    const dt = Math.min(sensorDt ?? arrivalDt, 0.25);
    if (dt > 0) this.rate += (1 / dt - this.rate) * 0.1;

    if (this.state === 'calibrating') return this.collect(values);
    if (this.state.startsWith('detecting')) return this.detect(values, dt);
    if (this.state !== 'ready') return;

    for (let i = 0; i < 3; i++) this.total[i] += (values[i] - this.bias[i]) * dt;

    // on fait tourner l'orientation 3D complète (les 3 axes ensemble) : contrairement à
    // une somme axe par axe, revenir à la position de départ redonne bien le centre
    omega.set(values[0] - this.bias[0], values[1] - this.bias[1], values[2] - this.bias[2]);
    const speed = omega.length();
    if (speed > this.settings.deadzone) {
      step.setFromAxisAngle(omega.divideScalar(speed), speed * dt);
      this.orientation.multiply(step).normalize();
    }

    this.updateAngles();
  }

  /** Direction du canon -> angles gauche/droite et haut/bas dans le repère de calibration. */
  private updateAngles(): void {
    const s = this.settings;

    // une rotation positive autour de "down" tourne vers la droite,
    // une rotation positive autour de "right" lève le canon
    right.copy(AXIS_VECTORS[AXES.indexOf(s.pitchAxis)]).multiplyScalar(s.invertPitch ? -1 : 1);
    down.copy(AXIS_VECTORS[AXES.indexOf(s.yawAxis)]).multiplyScalar(s.invertYaw ? -1 : 1);
    forward.crossVectors(right, down);
    if (forward.lengthSq() === 0) return; // même axe pour les deux : pas de direction de canon

    aimDirection.copy(forward).applyQuaternion(this.orientation);
    this.yaw = Math.atan2(aimDirection.dot(right), aimDirection.dot(forward)) * s.sensitivity;
    this.pitch = Math.asin(clamp(-aimDirection.dot(down), -1, 1)) * s.sensitivity;
  }

  private collect(values: Vec3): void {
    this.samples.push(values);
    if (!this.stepDone) return;

    const n = this.samples.length;
    if (n < 10) return this.calibrate('too-few'); // pas assez de données reçues

    const mean = [0, 1, 2].map((i) => this.samples.reduce((sum, v) => sum + v[i], 0) / n) as Vec3;
    const noise = [0, 1, 2].map((i) => Math.sqrt(this.samples.reduce((sum, v) => sum + (v[i] - mean[i]) ** 2, 0) / n));

    if (Math.max(...noise) > MAX_CALIBRATION_NOISE) return this.calibrate('moved');

    this.bias = mean;
    this.recenter();
    this.setState('ready');
  }

  private detect(values: Vec3, dt: number): void {
    for (let i = 0; i < 3; i++) this.rotation[i] += (values[i] - this.bias[i]) * dt;
    if (!this.stepDone) return;

    const isYaw = this.state === 'detecting-yaw';
    // l'axe vertical ne peut pas être le même que l'horizontal
    const candidates = [0, 1, 2].filter((i) => isYaw || AXES[i] !== this.settings.yawAxis);
    const axis = candidates.reduce((best, i) => (Math.abs(this.rotation[i]) > Math.abs(this.rotation[best]) ? i : best));

    if (Math.abs(this.rotation[axis]) < MIN_DETECTION_ROTATION) {
      this.rotation = [0, 0, 0];
      return this.setState(this.state, 'not-enough', 2500);
    }

    // à droite / vers le haut doit donner un angle positif
    const invert = this.rotation[axis] < 0;

    if (isYaw) {
      this.settings.yawAxis = AXES[axis];
      this.settings.invertYaw = invert;
      this.rotation = [0, 0, 0];
      this.setState('detecting-pitch', null, 2500);
    } else {
      this.settings.pitchAxis = AXES[axis];
      this.settings.invertPitch = invert;
      this.onAxesDetected?.();
      // on recalibre : le gun doit revenir pointer le centre
      this.calibrate('axes-found');
    }
  }

  /** Position normalisée du viseur, de -1 à 1 (+ = droite). */
  get x(): number {
    return clamp(this.yaw / (this.settings.maxYaw * DEG), -1, 1);
  }

  /** Position normalisée du viseur, de -1 à 1 (+ = haut). */
  get y(): number {
    return clamp(this.pitch / (this.settings.maxPitch * DEG), -1, 1);
  }
}
