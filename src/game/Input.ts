import { saveSettings, settings } from '../config';
import { GyroAim, type AimInfo, type AimState } from '../gun/GyroAim';
import { openSerial, serialSupported } from '../gun/serial';

/** Must match Serial.begin() on the Arduino. */
const BAUD_RATE = 115200;

/** Single player: mouse (or gyro gun) aims, left button / trigger (held) paints. */
export interface PlayerInput {
  x: number;
  y: number;
  held: boolean;
  /** Firing is ignored until the trigger is released once (after pause/end). */
  blocked: boolean;
}

export class Input {
  player: PlayerInput;
  /** True while a match screen owns the input (prevents page scroll, etc.). */
  capture = true;
  onPause: (() => void) | null = null;
  onBlur: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  width = window.innerWidth;
  height = window.innerHeight;

  /** Gyro gun: when connected, it replaces the mouse for aiming and firing. */
  gun = new GyroAim(settings.gun);
  gunConnected = false;
  showGunDebug = false;
  onGunState: ((state: AimState, info: AimInfo) => void) | null = null;
  onGunConnection: ((connected: boolean) => void) | null = null;
  /** Called on each trigger press (edge), whatever the game state. */
  onGunTrigger: (() => void) | null = null;
  onGunAxesDetected: (() => void) | null = null;
  private triggerDown = false;

  constructor() {
    this.player = { x: this.width * 0.5, y: this.height * 0.5, held: false, blocked: false };
    const p = this.player;

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || this.gunConnected) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!(e.buttons & 1) && p.held) this.release();
    });
    // On window: overlays sit above the canvas. UI buttons stop propagation.
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch' || this.gunConnected) return;
      p.x = e.clientX;
      p.y = e.clientY;
      p.held = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0 && !this.gunConnected) this.release();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        if (!e.repeat) this.onPause?.();
        return;
      }
      if (e.repeat || (e.target as HTMLElement | null)?.closest?.('.settings-gui')) return;
      if (e.code === 'KeyC' && this.gunConnected) this.gun.calibrate();
      else if (e.code === 'KeyA' && this.gunConnected && this.gun.state === 'ready') this.gun.detectAxes();
      else if (e.code === 'KeyR') this.gun.recenter();
      else if (e.code === 'KeyD') this.showGunDebug = !this.showGunDebug;
      else if (e.code === 'KeyG') this.onSettings?.();
    });
    // Losing focus cuts the jet.
    window.addEventListener('blur', () => this.loseFocus());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.loseFocus();
    });
    // No page scroll / zoom gestures while playing.
    window.addEventListener('wheel', (e) => this.capture && e.preventDefault(), { passive: false });

    this.gun.onStateChange = (state, info) => this.onGunState?.(state, info);
    this.gun.onAxesDetected = () => {
      saveSettings();
      this.onGunAxesDetected?.();
    };
  }

  private release(): void {
    this.player.held = false;
    this.player.blocked = false;
  }

  private loseFocus(): void {
    this.release();
    this.onBlur?.();
  }

  /** Require a fresh press before firing again. */
  blockFire(): void {
    this.player.blocked = this.player.held;
  }

  get firing(): boolean {
    if (this.gunConnected && this.gun.state !== 'ready') return false;
    return this.player.held && !this.player.blocked;
  }

  // ---------------------------------------------------------------------------
  // Gyro gun

  /** Opens the serial port picker. Returns an error message, or null. */
  async connectGun(): Promise<string | null> {
    if (this.gunConnected) return null;
    if (!serialSupported()) return 'Web Serial non supporté : utilise Chrome ou Edge';
    try {
      await openSerial({ baudRate: BAUD_RATE, onLine: this.handleLine, onClose: this.handleClose });
    } catch (err) {
      if ((err as Error).name === 'NotFoundError') return null; // fenêtre annulée
      console.error(err);
      return `Connexion impossible : ${(err as Error).message || err}`;
    }
    this.gunConnected = true;
    this.release();
    this.onGunConnection?.(true);
    this.gun.calibrate();
    return null;
  }

  // ligne attendue : "gyro.x, gyro.y, gyro.z, gachette, dt"
  // (rad/s, 1 si gâchette appuyée, microsecondes depuis la mesure précédente)
  private handleLine = (line: string): void => {
    const values = line.split(',').map(Number);
    if (values.length < 3 || values.some(Number.isNaN)) return;
    const sensorDt = values.length >= 5 ? values[4] / 1e6 : undefined;
    this.gun.push([values[0], values[1], values[2]], sensorDt);

    // The paint jet follows the trigger: press = held, release = stop.
    const pressed = values[3] === 1;
    if (pressed && !this.triggerDown) {
      this.player.held = true;
      this.onGunTrigger?.();
    } else if (!pressed && this.triggerDown) {
      this.release();
    }
    this.triggerDown = pressed;
  };

  private handleClose = (): void => {
    this.gunConnected = false;
    this.triggerDown = false;
    this.release();
    this.gun.disconnect();
    this.onGunConnection?.(false);
  };

  /** Per-frame: moves the reticle toward the gun's aim, with smoothing. */
  update(dt: number): void {
    if (!this.gunConnected || this.gun.state !== 'ready') return;
    const tx = (this.gun.x * 0.5 + 0.5) * this.width;
    const ty = (-this.gun.y * 0.5 + 0.5) * this.height;
    const k = 1 - Math.pow(settings.gun.smoothing, dt * 60);
    this.player.x += (tx - this.player.x) * k;
    this.player.y += (ty - this.player.y) * k;
  }

  /** Debug readout (key D). */
  gunDebugText(): string {
    const DEG = 180 / Math.PI;
    const g = this.gun;
    const s = settings.gun;
    const fmt = (v: number) => v.toFixed(3).padStart(7);
    return [
      `état      ${g.state}${this.gunConnected ? '' : ' (souris)'}`,
      `            x       y       z`,
      `brut      ${g.raw.map(fmt).join(' ')}`,
      `biais     ${g.bias.map(fmt).join(' ')}`,
      `rotation° ${g.total.map((v) => fmt(v * DEG)).join(' ')}`,
      `axes      yaw=${s.invertYaw ? '-' : '+'}${s.yawAxis}  pitch=${s.invertPitch ? '-' : '+'}${s.pitchAxis}`,
      `yaw/pitch ${fmt(g.yaw * DEG)}° ${fmt(g.pitch * DEG)}°`,
      `réception ${g.rate.toFixed(0)} Hz`,
    ].join('\n');
  }

  resize(w: number, h: number): void {
    this.player.x = (this.player.x / this.width) * w;
    this.player.y = (this.player.y / this.height) * h;
    this.width = w;
    this.height = h;
  }

  /** Test hook: lets automated checks drive the player. */
  debugSet(x: number, y: number, held: boolean): void {
    this.player.x = x;
    this.player.y = y;
    this.player.held = held;
    if (!held) this.player.blocked = false;
  }
}
