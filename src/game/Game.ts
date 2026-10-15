import * as THREE from 'three';
import { QUALITY, SIM_DT, SIM_HZ, saveSettings, settings } from '../config';
import { World } from '../scene/World';
import { PaintSystem } from '../paint/PaintSystem';
import { Drips } from '../paint/Drips';
import { Score } from './Score';
import { Input } from './Input';
import { Tool } from '../fx/Tools';
import { PaintStream, Particles, tangentFrame, type JetState } from '../fx/Jets';
import { Audio } from '../fx/Audio';
import { UI, type Screen } from '../ui/UI';
import { SettingsPanel } from '../ui/SettingsPanel';

type State = Screen;

interface AimHit {
  si: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/**
 * Game flow: loading → home → countdown → playing ⇄ paused → results.
 * One player paints the room; the round ends when time runs out or the goal is reached.
 * Simulation (deposits, timer) runs at a fixed SIM_HZ, independent of frame rate.
 */
export class Game {
  state: State = 'loading';
  renderer!: THREE.WebGLRenderer;
  world!: World;
  ps = new PaintSystem();
  score = new Score(this.ps);
  drips = new Drips(this.ps);
  input: Input;
  ui: UI;
  audio = new Audio();
  settingsPanel: SettingsPanel;
  tool!: Tool;
  private paintStream!: PaintStream;
  private particles!: Particles;

  /** Simulation steps elapsed in the current round (time = steps / SIM_HZ). */
  steps = 0;
  totalSteps = settings.matchDuration * SIM_HZ;
  private acc = 0;
  private countdownT = 0;
  private lastCountdownShown = 99;
  private goHideT = 0;
  private pausedFrom: 'countdown' | 'playing' = 'playing';
  private builtDensity = 0;
  private pendingRebuild = false;
  private lastTickSecond = -1;
  private lastMilestone = 0;
  private resizeTimer = 0;
  private lastFrame = performance.now();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private meshes: THREE.Object3D[] = [];

  // Player stroke state
  private prevX = 0;
  private prevY = 0;
  private hasPrev = false;
  private wasFiring = false;
  private spawnAcc = 0;
  private aimPoint = new THREE.Vector3();
  private jet: JetState = {
    active: false,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    hit: false,
  };

  private camUp = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpT1 = new THREE.Vector3();
  private tmpT2 = new THREE.Vector3();
  /** Simulation is driven manually by tests when true (see window.__game). */
  manualClock = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ui = new UI({
      start: () => this.newMatch(),
      resume: () => this.resume(),
      restart: () => this.newMatch(),
      home: () => this.toHome(),
      pause: () => this.pause(),
      toggleMute: () => {
        settings.muted = !settings.muted;
        this.afterSettingsChange();
      },
      toggleReduced: () => {
        settings.reducedFx = !settings.reducedFx;
        this.afterSettingsChange();
      },
      openSettings: () => this.settingsPanel.toggle(),
      connectGun: () => void this.connectGun(),
    });
    this.input = new Input();
    this.input.onPause = () => this.onEscape();
    this.input.onSettings = () => this.settingsPanel.toggle();
    this.input.onBlur = () => {
      if (this.state === 'playing' || this.state === 'countdown') this.pause();
    };
    this.input.onGunConnection = (connected) => {
      this.ui.gunConnection(connected, connected ? '' : 'Gun déconnecté');
      this.settingsPanel.refresh();
    };
    this.input.onGunState = (state, info) => this.ui.gunState(state, info);
    this.input.onGunAxesDetected = () => this.settingsPanel.refresh();
    // The trigger can start a round from home, or resume from pause.
    this.input.onGunTrigger = () => {
      if (this.input.gun.state !== 'ready' || this.settingsPanel.open) return;
      if (this.state === 'home') this.newMatch();
      else if (this.state === 'paused') this.resume();
    };
    this.settingsPanel = new SettingsPanel({
      onAudio: () => this.audio.applyVolume(),
      onQuality: () => this.applyQuality(),
      onReduced: () => this.ui.refreshToggles(),
      calibrateGun: () => this.input.gunConnected && this.input.gun.calibrate(),
      detectGunAxes: () => this.input.gunConnected && this.input.gun.state === 'ready' && this.input.gun.detectAxes(),
      onClose: () => {
        if (this.state === 'home') this.ui.resetHud();
      },
    });
    // Any gesture unlocks audio.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  async init(): Promise<void> {
    this.ui.show('loading');
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      this.ui.fatal(`WebGL 2 indisponible (${(e as Error).message || e}).`);
      return;
    }
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.fatal('Le contexte WebGL a été perdu (GPU réinitialisé).');
    });

    this.world = new World(this.renderer);
    this.paintStream = new PaintStream(this.world.scene);
    this.particles = new Particles(this.world.scene);
    this.tool = new Tool(this.world.camera);
    this.raycaster.firstHitOnly = true;

    this.world.applyQuality(settings.quality);
    this.onResize(false);
    window.addEventListener('resize', () => this.onResize(true));
    await this.rebuildPaint();
    this.toHome();
    requestAnimationFrame(this.frame);
  }

  private async rebuildPaint(): Promise<void> {
    const q = QUALITY[settings.quality];
    const prev = this.state;
    this.ui.show('loading');
    this.ui.setLoading(0, 'Modelage de la pièce');
    await new Promise((r) => setTimeout(r, 16));
    const paintables = this.world.buildPaintables(q.texelDensity);
    this.meshes = paintables.map((p) => p.mesh);
    await this.ps.build(paintables, { aoStride: q.aoStride, aoRays: q.aoRays, density: q.texelDensity }, (p, label) =>
      this.ui.setLoading(p, label),
    );
    this.ps.computeReachability(this.renderer, this.world.camera, this.world.root);
    this.score.reset();
    void this.ps.bakeAO();
    this.builtDensity = q.texelDensity;
    this.pendingRebuild = false;
    this.ui.setLoading(1, 'Prêt');
    if (prev !== 'loading') this.ui.show(prev);
  }

  private applyQuality(): void {
    this.world.applyQuality(settings.quality);
    this.onResize(false);
    if (QUALITY[settings.quality].texelDensity !== this.builtDensity) this.pendingRebuild = true;
    if (this.pendingRebuild && (this.state === 'home' || this.state === 'results')) {
      this.settingsPanel.close();
      void this.rebuildPaint().then(() => this.toHome());
    }
  }

  private async connectGun(): Promise<void> {
    const error = await this.input.connectGun();
    if (error) this.ui.gunConnection(false, error);
  }

  private afterSettingsChange(): void {
    this.audio.applyVolume();
    this.ui.refreshToggles();
    this.settingsPanel.refresh();
    saveSettings();
  }

  // ---------------------------------------------------------------------------
  // Flow

  private setState(s: State): void {
    this.state = s;
    this.ui.show(s);
    this.input.capture = s === 'playing' || s === 'countdown';
  }

  toHome(): void {
    if (this.pendingRebuild) {
      void this.rebuildPaint().then(() => this.toHome());
      return;
    }
    this.resetMatch();
    this.setState('home');
  }

  /** Clears the room and all round state. */
  private resetMatch(): void {
    this.ps.reset();
    this.score.reset();
    this.drips.clear();
    this.particles.clear();
    this.steps = 0;
    this.totalSteps = Math.round(settings.matchDuration * SIM_HZ);
    this.acc = 0;
    this.cutJet();
    this.lastTickSecond = -1;
    this.lastMilestone = 0;
    this.ui.resetHud();
  }

  newMatch(): void {
    if (this.pendingRebuild) {
      void this.rebuildPaint().then(() => this.newMatch());
      return;
    }
    this.audio.click();
    this.settingsPanel.close();
    this.resetMatch();
    this.input.blockFire();
    this.countdownT = 3;
    this.lastCountdownShown = 99;
    this.setState('countdown');
  }

  private onEscape(): void {
    if (this.settingsPanel.open) {
      this.settingsPanel.close();
      return;
    }
    if (this.state === 'playing' || this.state === 'countdown') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.pausedFrom = this.state;
    this.cutJet();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.settingsPanel.close();
    // A fresh trigger press is required after a pause.
    this.input.blockFire();
    this.hasPrev = false;
    this.lastFrame = performance.now();
    this.setState(this.pausedFrom);
    if (this.pausedFrom === 'countdown') this.lastCountdownShown = 99;
  }

  private cutJet(): void {
    this.hasPrev = false;
    this.wasFiring = false;
    this.spawnAcc = 0;
    this.jet.active = false;
    this.audio.setJet(false);
  }

  private endMatch(): void {
    this.cutJet();
    this.input.blockFire();
    this.drips.clear();
    const res = this.score.freeze();
    const timeLeft = (this.totalSteps - this.steps) / SIM_HZ;
    this.setState('results');
    this.ui.results(res, timeLeft);
    this.ui.update(0, { timeLeft, cover: res.coverTenths, live: false });
    this.audio.end();
    this.audio.victory(res.win);
  }

  // ---------------------------------------------------------------------------
  // Simulation

  private raycastScreen(x: number, y: number): AimHit | null {
    this.ndc.set((x / this.input.width) * 2 - 1, -(y / this.input.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.world.camera);
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (!hit || !hit.face) return null;
    const si = this.ps.meshIndex.get(hit.object);
    if (si === undefined) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.dot(this.raycaster.ray.direction) > 0) n.negate();
    return { si, point: hit.point.clone(), normal: n, distance: hit.distance };
  }

  private projectedRadiusPx(dist: number, radius: number): number {
    const cam = this.world.camera;
    return (radius / Math.max(0.1, dist)) * (this.input.height / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
  }

  /** One fixed simulation step. */
  simStep(): void {
    this.ps.beginStep();
    if (this.input.firing) this.stamp();
    else this.hasPrev = false;
    if (settings.drips) this.drips.step(SIM_DT);
    this.ps.endStep();
    this.steps++;
    if (this.steps % SIM_HZ === 0) this.score.recompute();
  }

  private stamp(): void {
    const p = this.input.player;
    const params = settings.paint;
    const x0 = this.hasPrev ? this.prevX : p.x;
    const y0 = this.hasPrev ? this.prevY : p.y;
    const cur = this.raycastScreen(p.x, p.y);
    // Continuous strokes: sub-stamps between successive reticle positions.
    const spacing = Math.max(2, this.projectedRadiusPx(cur?.distance ?? 7, params.radius) * 0.3);
    const N = Math.min(40, Math.max(1, Math.ceil(Math.hypot(p.x - x0, p.y - y0) / spacing)));
    const share = Math.max(1 / N, 0.3);
    for (let k = 1; k <= N; k++) {
      const h = k === N ? cur : this.raycastScreen(x0 + ((p.x - x0) * k) / N, y0 + ((p.y - y0) * k) / N);
      if (!h) continue;
      this.ps.stamp(h.si, h.point, h.normal, {
        kind: 'paint',
        params,
        amount: params.rate * SIM_DT * share,
        irregularity: settings.paintIrregularity,
      });
    }
    if (cur) {
      // Secondary droplets around the splat (decorative channel only).
      if (Math.random() < 16 * SIM_DT) {
        tangentFrame(cur.normal, this.tmpT1, this.tmpT2);
        const count = 1 + (Math.random() < 0.4 ? 1 : 0);
        for (let c = 0; c < count; c++) {
          const a = Math.random() * Math.PI * 2;
          const d = params.radius * (1.0 + Math.random() * 0.8);
          this.tmpV
            .copy(cur.point)
            .addScaledVector(this.tmpT1, Math.cos(a) * d)
            .addScaledVector(this.tmpT2, Math.sin(a) * d);
          this.ps.decorBlob(cur.si, this.tmpV, cur.normal, 0.012 + Math.random() * 0.022);
        }
      }
      if (settings.drips && Math.random() < 3 * SIM_DT) this.drips.trySpawn(cur.si, cur.point, cur.normal, params.radius);
    }
    this.prevX = p.x;
    this.prevY = p.y;
    this.hasPrev = true;
  }

  // ---------------------------------------------------------------------------
  // Frame

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.tick(dt);
  };

  tick(dt: number): void {
    this.input.update(dt);
    this.ui.gunProgress(this.input.gun.progress);
    this.ui.gunDebug(this.input.showGunDebug ? this.input.gunDebugText() : null);
    if (this.state === 'countdown') this.updateCountdown(dt);
    if (this.state === 'playing' && !this.manualClock) {
      this.acc += dt;
      while (this.acc >= SIM_DT && this.steps < this.totalSteps) {
        this.simStep();
        this.acc -= SIM_DT;
      }
    }
    if (this.state === 'playing') {
      const goalReached = this.score.liveTenths() >= settings.goal * 10;
      if (this.steps >= this.totalSteps || goalReached) this.endMatch();
    }

    this.updateFx(dt);
    this.ps.updateVisuals(dt);
    this.updateHud(dt);
    if (this.resizeTimer > 0) {
      this.resizeTimer -= dt;
      if (this.resizeTimer <= 0) {
        this.ps.computeReachability(this.renderer, this.world.camera, this.world.root);
        if (!this.score.official) this.score.recompute();
      }
    }
    this.renderer.render(this.world.scene, this.world.camera);
  }

  private updateCountdown(dt: number): void {
    this.countdownT -= dt;
    const n = Math.ceil(this.countdownT);
    if (n !== this.lastCountdownShown && n > 0) {
      this.lastCountdownShown = n;
      this.ui.countdown(n);
      this.audio.countdown(n);
    }
    if (this.countdownT <= 0) {
      this.ui.countdown(0);
      this.audio.countdown(0);
      this.goHideT = 0.7;
      this.acc = 0;
      this.lastFrame = performance.now();
      this.setState('playing');
    }
  }

  private updateFx(dt: number): void {
    const cam = this.world.camera;
    this.camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const p = this.input.player;
    const firing = this.state === 'playing' && this.input.firing;
    const showTool = this.state !== 'home' && this.state !== 'loading';
    const pScale = QUALITY[settings.quality].particleScale * (settings.reducedFx ? 0.35 : 1);

    const aim = this.raycastScreen(p.x, p.y);
    if (aim) this.aimPoint.copy(aim.point);
    else this.raycaster.ray.at(12, this.aimPoint);
    this.tool.update(dt, this.aimPoint, firing, showTool);

    this.jet.active = firing;
    this.tool.nozzleWorld(this.jet.from);
    this.jet.to.copy(this.aimPoint);
    this.jet.hit = !!aim;
    if (aim) this.jet.normal.copy(aim.normal);
    if (firing && !this.wasFiring) {
      this.audio.jetStart();
      if (aim) this.particles.spawnPaint(aim.point, aim.normal, Math.round(22 * pScale), 1.3);
    }
    this.wasFiring = firing;
    if (firing && aim) {
      this.spawnAcc += dt * 120 * pScale;
      const n = Math.floor(this.spawnAcc);
      this.spawnAcc -= n;
      this.particles.spawnPaint(aim.point, aim.normal, n);
    }
    const visible = this.state === 'playing' || this.state === 'countdown' || this.state === 'paused';
    this.ui.reticle(p.x, p.y, firing, visible);

    this.paintStream.update(dt, this.jet, this.camUp);
    this.particles.update(dt);
    this.audio.setJet(firing);
  }

  private updateHud(dt: number): void {
    const inMatch = this.state === 'playing' || this.state === 'paused' || this.state === 'countdown';
    if (!inMatch) return;
    const timeLeft = (this.totalSteps - this.steps) / SIM_HZ;
    const cover = this.score.liveTenths();
    this.ui.update(dt, { timeLeft, cover, live: this.state === 'playing' });
    if (this.goHideT > 0) {
      this.goHideT -= dt;
      if (this.goHideT <= 0) this.ui.hideCountdown();
    }
    if (this.state !== 'playing') return;
    // Last five seconds: audible tick each second.
    const sec = Math.ceil(timeLeft - 1e-6);
    if (sec !== this.lastTickSecond) {
      if (sec <= 5 && sec > 0 && this.lastTickSecond !== -1) this.audio.tick(sec <= 3);
      this.lastTickSecond = sec;
    }
    // Small reward every 10 % painted.
    const milestone = Math.floor(cover / 100);
    if (milestone > this.lastMilestone) {
      this.lastMilestone = milestone;
      this.audio.milestone();
      this.ui.pulseCover();
    }
  }

  private onResize(recomputeLater: boolean): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.world.resize(w, h);
    this.input.resize(w, h);
    this.tool?.layout();
    if (recomputeLater) this.resizeTimer = 0.25;
  }
}
