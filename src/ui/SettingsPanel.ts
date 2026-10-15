import GUI from 'lil-gui';
import { DEFAULTS, resetBalance, resetGun, saveSettings, settings, type Quality } from '../config';

export interface SettingsCallbacks {
  onAudio(): void;
  onQuality(q: Quality): void;
  onReduced(): void;
  calibrateGun(): void;
  detectGunAxes(): void;
  onClose(): void;
}

/** Live tuning panel for the round, the paint gun and effects (persisted in localStorage). */
export class SettingsPanel {
  private gui: GUI | null = null;
  constructor(private cb: SettingsCallbacks) {}

  get open(): boolean {
    return !!this.gui;
  }

  toggle(): void {
    if (this.gui) this.close();
    else this.show();
  }

  close(): void {
    this.gui?.destroy();
    this.gui = null;
    this.cb.onClose();
  }

  private show(): void {
    const gui = new GUI({ title: 'Réglages' });
    gui.domElement.classList.add('settings-gui');
    gui.domElement.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.gui = gui;
    const save = () => saveSettings();

    const fg = gui.addFolder('Partie');
    fg.add(settings, 'matchDuration', 10, 180, 5).name('Durée (s)').onChange(save);
    fg.add(settings, 'goal', 10, 100, 1).name('Objectif (%)').onChange(save);

    const fp = gui.addFolder('Pistolet à peinture');
    fp.add(settings.paint, 'radius', 0.08, 0.6, 0.01).name('Largeur du jet (m)').onChange(save);
    fp.add(settings.paint, 'rate', 1, 30, 0.5).name('Vitesse de dépôt (/s)').onChange(save);
    fp.add(settings.paint, 'center', 0, 2, 0.05).name('Intensité centre').onChange(save);
    fp.add(settings.paint, 'edge', 0, 2, 0.05).name('Intensité bords').onChange(save);
    fp.add(settings, 'paintIrregularity', 0, 0.6, 0.01).name('Contours irréguliers').onChange(save);

    const fgun = gui.addFolder('Gun (gyroscope)');
    const axes = ['x', 'y', 'z'];
    fgun.add(settings.gun, 'yawAxis', axes).name('Axe horizontal').onChange(save);
    fgun.add(settings.gun, 'invertYaw').name('Inverser horizontal').onChange(save);
    fgun.add(settings.gun, 'pitchAxis', axes).name('Axe vertical').onChange(save);
    fgun.add(settings.gun, 'invertPitch').name('Inverser vertical').onChange(save);
    fgun.add(settings.gun, 'sensitivity', 0.2, 4, 0.1).name('Sensibilité').onChange(save);
    fgun.add(settings.gun, 'maxYaw', 5, 90, 1).name('Angle max horizontal (°)').onChange(save);
    fgun.add(settings.gun, 'maxPitch', 5, 60, 1).name('Angle max vertical (°)').onChange(save);
    fgun.add(settings.gun, 'deadzone', 0, 0.2, 0.005).name('Zone morte (rad/s)').onChange(save);
    fgun.add(settings.gun, 'smoothing', 0, 0.9, 0.05).name('Lissage').onChange(save);
    fgun.add({ calibrate: () => this.cb.calibrateGun() }, 'calibrate').name('Recalibrer (C)');
    fgun.add({ detect: () => this.cb.detectGunAxes() }, 'detect').name('Détecter les axes (A)');
    fgun.add(
      {
        reset: () => {
          resetGun();
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        },
      },
      'reset',
    ).name('↺ Gun par défaut');
    fgun.close();

    const fx = gui.addFolder('Effets, son & qualité');
    fx.add(settings, 'reducedFx')
      .name('Effets réduits')
      .onChange(() => {
        save();
        this.cb.onReduced();
      });
    fx.add(settings, 'drips').name('Coulures').onChange(save);
    fx.add(settings, 'muted')
      .name('Muet')
      .onChange(() => {
        save();
        this.cb.onAudio();
      });
    fx.add(settings, 'volume', 0, 1, 0.05)
      .name('Volume')
      .onChange(() => {
        save();
        this.cb.onAudio();
      });
    fx.add(settings, 'quality', { Basse: 'low', Moyenne: 'medium', Haute: 'high' })
      .name('Qualité')
      .onChange((q: Quality) => {
        save();
        this.cb.onQuality(q);
      });

    gui.add(
      {
        reset: () => {
          resetBalance();
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        },
      },
      'reset',
    ).name(`↺ Par défaut (${DEFAULTS.matchDuration} s, objectif ${DEFAULTS.goal} %)`);
    gui.add({ close: () => this.close() }, 'close').name('Fermer');
  }

  refresh(): void {
    this.gui?.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}
