import { settings } from '../config';

/** Fully synthesized sound (WebAudio): no assets to load. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private paintGain!: GainNode;
  private paintLfoDepth!: GainNode;
  private noise!: AudioBuffer;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.applyVolume();

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Paint: band-passed noise with a rhythmic amplitude pulse ("pfft-pfft").
    const pn = this.noiseSrc();
    const pbp = ctx.createBiquadFilter();
    pbp.type = 'bandpass';
    pbp.frequency.value = 1500;
    pbp.Q.value = 0.7;
    const plow = ctx.createBiquadFilter();
    plow.type = 'lowshelf';
    plow.frequency.value = 300;
    plow.gain.value = 6;
    const pulseAmp = ctx.createGain();
    pulseAmp.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 9;
    this.paintLfoDepth = ctx.createGain();
    this.paintLfoDepth.gain.value = 0.4;
    lfo.connect(this.paintLfoDepth).connect(pulseAmp.gain);
    lfo.start();
    this.paintGain = ctx.createGain();
    this.paintGain.gain.value = 0;
    pn.connect(pbp).connect(plow).connect(pulseAmp).connect(this.paintGain).connect(this.master);

  }

  private noiseSrc(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  applyVolume(): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(settings.muted ? 0 : settings.volume * 0.7, this.ctx.currentTime, 0.03);
  }

  /** Continuous jet loop. */
  setJet(on: boolean): void {
    if (!this.ctx) return;
    this.paintGain.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, on ? 0.015 : 0.05);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo?: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, freq: number, vol: number, q = 1): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  jetStart(): void {
    this.burst(0.12, 700, 0.5, 0.8);
    this.tone(160, 0.1, 'sine', 0.25, 0, 90);
  }

  countdown(n: number): void {
    if (n > 0) this.tone(620, 0.16, 'sine', 0.35);
    else {
      this.tone(880, 0.25, 'triangle', 0.35);
      this.tone(1320, 0.35, 'triangle', 0.25, 0.06);
    }
  }

  tick(urgent: boolean): void {
    this.tone(urgent ? 1180 : 980, 0.07, 'square', urgent ? 0.14 : 0.09);
  }

  /** Coverage milestone (every 10 %). */
  milestone(): void {
    this.tone(520, 0.09, 'triangle', 0.2);
    this.tone(780, 0.12, 'triangle', 0.2, 0.07);
  }

  end(): void {
    this.tone(220, 0.5, 'sawtooth', 0.15, 0, 140);
    this.burst(0.4, 400, 0.35, 0.5);
  }

  victory(win: boolean): void {
    const notes = win ? [523, 659, 784, 1047] : [523, 466, 392];
    notes.forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.28, 0.25 + i * 0.11));
    if (win) this.tone(1568, 0.6, 'sine', 0.12, 0.25 + notes.length * 0.11);
  }

  click(): void {
    this.tone(700, 0.05, 'sine', 0.15);
  }
}
