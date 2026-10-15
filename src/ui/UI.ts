import { settings } from '../config';
import type { OfficialResult } from '../game/Score';
import { popIn, pulse, Spring } from '../util/Spring';
import { ICON_GEAR, ICON_MOUSE, ICON_PAINT, ICON_PAUSE, ICON_SOUND_OFF, ICON_SOUND_ON } from './icons';

export type Screen = 'loading' | 'home' | 'countdown' | 'playing' | 'paused' | 'results';

export interface UIHandlers {
  start(): void;
  resume(): void;
  restart(): void;
  home(): void;
  pause(): void;
  toggleMute(): void;
  toggleReduced(): void;
  openSettings(): void;
  connectGun(): void;
}

const GUN_STEPS: Record<string, string> = {
  calibrating: "Calibration : garde le gun immobile, pointé vers le centre de l'écran",
  'detecting-yaw': 'Tourne le gun franchement vers la DROITE et reste là',
  'detecting-pitch': 'Maintenant, lève le canon vers le HAUT et reste là',
};

const GUN_WARNINGS: Record<string, string> = {
  moved: 'Ça a bougé, on recommence…',
  'too-few': "Pas assez de données reçues : vérifie le baud rate et le delay() de l'Arduino",
  'not-enough': 'Pas assez de mouvement, on recommence : tourne plus fort',
  'axes-found': "Axes trouvés ! Reviens pointer le centre de l'écran",
};

const GUN_HELP = 'Gâchette : peindre · C : recalibrer · R : recentrer · A : détecter les axes · D : debug';

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const pct = (tenths: number) => `${(tenths / 10).toFixed(1)} %`;

export class UI {
  root: HTMLElement;
  private screens: Record<string, HTMLElement> = {};
  private hud: HTMLElement;
  private reticleEl: HTMLElement;
  private gaugeSpring = new Spring(0, 0, 90, 16);
  private lastSecond = -1;

  constructor(h: UIHandlers) {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = this.template();
    for (const s of ['loading', 'home', 'pause', 'results', 'fatal']) {
      this.screens[s] = $(this.root, `#screen-${s}`);
    }
    this.hud = $(this.root, '#hud');
    this.reticleEl = $(this.root, '#reticle');

    const on = (sel: string, fn: () => void) =>
      this.root.querySelectorAll(sel).forEach((el) =>
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          (el as HTMLElement).blur();
          fn();
        }),
      );
    on('[data-act=start]', () => h.start());
    on('[data-act=resume]', () => h.resume());
    on('[data-act=restart]', () => h.restart());
    on('[data-act=home]', () => h.home());
    on('[data-act=pause]', () => h.pause());
    on('[data-act=mute]', () => h.toggleMute());
    on('[data-act=reduced]', () => h.toggleReduced());
    on('[data-act=settings]', () => h.openSettings());
    on('[data-act=connect]', () => h.connectGun());
    // Clicks on HUD buttons must not count as firing.
    this.root.querySelectorAll('button').forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
    this.refreshToggles();
  }

  private template(): string {
    return /* html */ `
<div class="reticle" id="reticle"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="17" class="ring"/><circle cx="32" cy="32" r="2.6" class="dot"/></svg></div>

<div id="hud" class="hidden">
  <div class="panel cover-panel">
    <div class="cover-head"><span class="kicker">PEINT</span><b class="gval" id="cover-val">0.0 %</b></div>
    <div class="gauge"><div class="gfill"></div><div class="ggoal"></div></div>
    <div class="tlabel" id="goal-label"></div>
  </div>
  <div class="panel timer-panel">
    <div class="timer" id="timer">01:00</div>
    <div class="tlabel">Temps restant</div>
  </div>
  <div class="hud-buttons">
    <button class="icon-btn" data-act="pause" title="Pause (Échap)">${ICON_PAUSE}</button>
    <button class="icon-btn mute-btn" data-act="mute" title="Couper le son"></button>
    <button class="icon-btn" data-act="settings" title="Réglages (G)">${ICON_GEAR}</button>
  </div>
</div>

<div id="countdown" class="hidden"><div class="cd-num"></div></div>

<section class="screen" id="screen-loading">
  <div class="card loading-card">
    <div class="brand-mini">PAINT IT TILL YOU MAKE IT</div>
    <div class="loading-label">Chargement</div>
    <div class="loading-bar"><div></div></div>
  </div>
</section>

<section class="screen hidden" id="screen-home">
  <div class="card home-card">
    <div class="kicker-line" id="home-kicker"></div>
    <h1 class="title"><span class="picto">${ICON_PAINT}</span>PAINT IT</h1>
    <p class="subtitle" id="home-pitch"></p>
    <div class="controls"><span class="key">${ICON_MOUSE}</span><span>Viser</span><span class="sep"></span><span class="key key-text">Clic gauche</span><span>maintenu : peindre</span></div>
    <div class="actions">
      <button class="btn primary big" data-act="start">Jouer</button>
      <button class="btn big gun-btn" id="connect" data-act="connect">Connecter le gun</button>
    </div>
    <p class="gun-status" id="gun-status"></p>
    <div class="footer-row">
      <button class="chip" data-act="mute"><span class="mute-ico"></span><span class="mute-txt"></span></button>
      <button class="chip" data-act="reduced"><span class="reduced-txt"></span></button>
      <button class="chip" data-act="settings">${ICON_GEAR}<span>Réglages</span></button>
      <span class="esc-hint"><span class="key key-text">Échap</span> pause</span>
    </div>
  </div>
</section>

<section class="screen hidden veil-light" id="screen-pause">
  <div class="card pause-card">
    <h2>Pause</h2>
    <p class="muted">Le temps est suspendu. À la reprise, relâchez puis cliquez à nouveau pour peindre.</p>
    <div class="stack">
      <button class="btn primary" data-act="resume">Reprendre</button>
      <button class="btn" data-act="restart">Recommencer</button>
      <button class="btn" data-act="home">Retour à l'accueil</button>
    </div>
    <div class="footer-row">
      <button class="chip" data-act="mute"><span class="mute-ico"></span><span class="mute-txt"></span></button>
      <button class="chip" data-act="reduced"><span class="reduced-txt"></span></button>
      <button class="chip" data-act="settings">${ICON_GEAR}<span>Réglages</span></button>
      <button class="chip gun-btn" data-act="connect">Connecter le gun</button>
    </div>
  </div>
</section>

<section class="screen hidden veil-none" id="screen-results">
  <div class="card results-card">
    <div class="kicker-line" id="res-kicker"></div>
    <h2 class="winner" id="res-title"></h2>
    <div class="stat-val" id="res-cover"></div>
    <div class="stat-lab" id="res-goal"></div>
    <div class="res-gauge"><div class="res-fill"></div><div class="ggoal"></div></div>
    <div class="stack row">
      <button class="btn primary" data-act="restart">Rejouer</button>
      <button class="btn ghost" data-act="home">Retour à l'accueil</button>
    </div>
  </div>
  <div id="confetti"></div>
</section>

<section class="screen hidden" id="screen-fatal">
  <div class="card">
    <h2>La 3D n'a pas pu démarrer</h2>
    <p class="muted" id="fatal-msg"></p>
    <p class="muted">Essayez un navigateur récent (Chrome, Edge, Firefox, Safari 17+), activez l'accélération matérielle, puis rechargez la page.</p>
  </div>
</section>

<div id="gun-calib" class="hidden">
  <div class="card calib-card">
    <div class="kicker">GUN</div>
    <p class="calib-msg"></p>
    <p class="calib-warn"></p>
    <div class="loading-bar"><div></div></div>
  </div>
</div>

<pre id="gun-debug" class="panel hidden"></pre>`;
  }

  // ---------------------------------------------------------------------------

  setLoading(p: number, label: string): void {
    $(this.screens.loading, '.loading-bar div').style.width = `${Math.round(p * 100)}%`;
    $(this.screens.loading, '.loading-label').textContent = label;
  }

  fatal(msg: string): void {
    for (const s of Object.values(this.screens)) s.classList.add('hidden');
    this.screens.fatal.classList.remove('hidden');
    $(this.root, '#fatal-msg').textContent = msg;
  }

  show(screen: Screen): void {
    const map: Record<Screen, string | null> = {
      loading: 'loading',
      home: 'home',
      countdown: null,
      playing: null,
      paused: 'pause',
      results: 'results',
    };
    const target = map[screen];
    for (const [k, el] of Object.entries(this.screens)) {
      if (k === 'fatal') continue;
      const visible = k === target;
      const was = !el.classList.contains('hidden');
      el.classList.toggle('hidden', !visible);
      if (visible && !was) {
        const card = el.querySelector('.card') as HTMLElement | null;
        if (card) popIn(card, 0, settings.reducedFx ? 0 : 24);
      }
    }
    if (screen === 'home') this.refreshRules();
    const inMatch = screen === 'countdown' || screen === 'playing' || screen === 'paused' || screen === 'results';
    const hudWasHidden = this.hud.classList.contains('hidden');
    this.hud.classList.toggle('hidden', !inMatch);
    if (inMatch && hudWasHidden) {
      this.hud.querySelectorAll<HTMLElement>('.panel').forEach((p, i) => popIn(p, 60 * i, settings.reducedFx ? 0 : -16));
    }
    document.body.classList.toggle('in-play', screen === 'playing' || screen === 'countdown');
    if (screen !== 'countdown' && screen !== 'playing') $(this.root, '#countdown').classList.add('hidden');
  }

  /** Home text and goal marker follow the current settings. */
  private refreshRules(): void {
    const goal = settings.goal;
    const secs = settings.matchDuration;
    $(this.root, '#home-kicker').textContent = `Solo · ${secs} secondes`;
    $(this.root, '#home-pitch').textContent = `Une pièce blanche, un pistolet à peinture. Recouvre au moins ${goal} % de la pièce avant la fin du temps.`;
    $(this.root, '#goal-label').textContent = `Objectif ${goal} %`;
    this.root.querySelectorAll<HTMLElement>('.ggoal').forEach((el) => (el.style.left = `${goal}%`));
  }

  countdown(n: number): void {
    const cd = $(this.root, '#countdown');
    cd.classList.remove('hidden');
    const num = $(cd, '.cd-num');
    num.textContent = n > 0 ? String(n) : 'GO !';
    num.classList.toggle('go', n <= 0);
    if (settings.reducedFx) return;
    num.animate(
      [
        { transform: 'scale(1.9)', opacity: 0 },
        { transform: 'scale(0.92)', opacity: 1, offset: 0.45 },
        { transform: 'scale(1.03)', offset: 0.7 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 520, easing: 'ease-out' },
    );
  }

  hideCountdown(): void {
    $(this.root, '#countdown').classList.add('hidden');
  }

  /** Per-frame HUD update. */
  update(dt: number, s: { timeLeft: number; cover: number; live: boolean }): void {
    const secs = Math.max(0, Math.ceil(s.timeLeft - 1e-6));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    const timer = $(this.root, '#timer');
    timer.textContent = `${mm}:${ss}`;
    const urgent = s.live && secs <= 5 && secs > 0;
    timer.classList.toggle('urgent', urgent);
    if (secs !== this.lastSecond) {
      if (urgent && this.lastSecond !== -1) pulse(timer, settings.reducedFx ? 0.04 : 0.16);
      this.lastSecond = secs;
    }

    this.gaugeSpring.target = s.cover / 10;
    this.gaugeSpring.update(dt);
    $(this.hud, '.gfill').style.width = `${Math.min(100, Math.max(0, this.gaugeSpring.value))}%`;
    const val = $(this.root, '#cover-val');
    val.textContent = pct(s.cover);
    val.classList.toggle('reached', s.cover >= settings.goal * 10);
  }

  pulseCover(): void {
    pulse($(this.root, '#cover-val'), settings.reducedFx ? 0.04 : 0.14);
  }

  resetHud(): void {
    this.gaugeSpring.snap(0);
    this.lastSecond = -1;
    this.refreshRules();
  }

  reticle(x: number, y: number, firing: boolean, visible: boolean): void {
    const r = this.reticleEl;
    r.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    r.classList.toggle('firing', firing);
    r.style.opacity = visible ? '1' : '0';
  }

  // ---------------------------------------------------------------------------
  // Gyro gun

  gunConnection(connected: boolean, message = ''): void {
    this.root.querySelectorAll<HTMLButtonElement>('.gun-btn').forEach((b) => {
      b.textContent = connected ? 'Gun connecté' : 'Connecter le gun';
      b.disabled = connected;
    });
    $(this.root, '#gun-status').textContent = message || (connected ? GUN_HELP : '');
  }

  gunState(state: string, info?: string | null): void {
    const step = GUN_STEPS[state];
    $(this.root, '#gun-calib').classList.toggle('hidden', !step);
    $(this.root, '#gun-calib .calib-msg').textContent = step ?? '';
    $(this.root, '#gun-calib .calib-warn').textContent = (info && GUN_WARNINGS[info]) || '';
  }

  gunProgress(p: number): void {
    $(this.root, '#gun-calib .loading-bar div').style.width = `${Math.round(p * 100)}%`;
  }

  gunDebug(text: string | null): void {
    const el = $(this.root, '#gun-debug');
    el.classList.toggle('hidden', text === null);
    if (text !== null) el.textContent = text;
  }

  results(res: OfficialResult, timeLeft: number): void {
    const title = $(this.root, '#res-title');
    const card = $(this.root, '.results-card');
    card.dataset.win = String(res.win);
    $(this.root, '#res-kicker').textContent =
      res.win && timeLeft > 0.05 ? `Objectif atteint avec ${timeLeft.toFixed(1)} s d'avance` : 'Temps écoulé';
    title.textContent = res.win ? 'PIÈCE REPEINTE !' : 'PAS ASSEZ DE PEINTURE';
    $(this.root, '#res-cover').textContent = pct(res.coverTenths);
    $(this.root, '#res-goal').textContent = `PEINT · OBJECTIF ${pct(res.goalTenths)}`;
    ($(this.root, '.res-fill') as HTMLElement).style.width = `${res.coverTenths / 10}%`;
    if (!settings.reducedFx) {
      title.animate(
        [
          { transform: 'scale(0.6) rotate(-3deg)', opacity: 0 },
          { transform: 'scale(1.12) rotate(1deg)', opacity: 1, offset: 0.55 },
          { transform: 'scale(0.97)', offset: 0.78 },
          { transform: 'scale(1)' },
        ],
        { duration: 700, easing: 'ease-out', delay: 120, fill: 'backwards' },
      );
      if (res.win) this.confetti();
    }
  }

  private confetti(): void {
    const box = $(this.root, '#confetti');
    box.innerHTML = '';
    const colors = ['#ff2d95', '#ff7bbd', '#ffffff', '#c3126b'];
    for (let i = 0; i < 70; i++) {
      const d = document.createElement('i');
      d.style.background = colors[i % colors.length];
      d.style.left = `${50 + (Math.random() - 0.5) * 30}%`;
      box.appendChild(d);
      const dx = (Math.random() - 0.5) * 900;
      const dy = -200 - Math.random() * 420;
      const rot = (Math.random() - 0.5) * 900;
      d.animate(
        [
          { transform: 'translate(0,0) rotate(0)', opacity: 1 },
          { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.4 },
          { transform: `translate(${dx}px, ${dy + 700}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        { duration: 1500 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' },
      );
    }
    setTimeout(() => (box.innerHTML = ''), 2600);
  }

  refreshToggles(): void {
    this.root.querySelectorAll<HTMLElement>('.mute-btn, .mute-ico').forEach((el) => {
      el.innerHTML = settings.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    });
    this.root.querySelectorAll<HTMLElement>('.mute-txt').forEach((el) => (el.textContent = settings.muted ? 'Son coupé' : 'Son activé'));
    this.root
      .querySelectorAll<HTMLElement>('.reduced-txt')
      .forEach((el) => (el.textContent = settings.reducedFx ? 'Effets réduits : oui' : 'Effets réduits : non'));
  }
}
