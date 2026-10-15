/** Damped spring integrated with fixed sub-steps (stable at any frame rate). */
export class Spring {
  velocity = 0;
  constructor(
    public value = 0,
    public target = 0,
    public stiffness = 170,
    public damping = 18,
  ) {}

  update(dt: number): number {
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 240);
      const a = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  kick(v: number): void {
    this.velocity += v;
  }
}

/** Animates a DOM element with a spring (entrance pop, pulses). */
export function springAnimate(
  apply: (v: number) => void,
  from: number,
  to: number,
  opts: { stiffness?: number; damping?: number; velocity?: number } = {},
): () => void {
  const s = new Spring(from, to, opts.stiffness ?? 220, opts.damping ?? 16);
  s.velocity = opts.velocity ?? 0;
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    s.update(dt);
    apply(s.value);
    if (Math.abs(s.value - s.target) < 0.0005 && Math.abs(s.velocity) < 0.0005) {
      apply(s.target);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

/** Pops an element in: scale + translate with a damped spring. */
export function popIn(el: HTMLElement, delay = 0, distance = 18): void {
  el.style.opacity = '0';
  el.style.transform = `translateY(${distance}px) scale(0.94)`;
  setTimeout(() => {
    el.style.opacity = '1';
    springAnimate(
      (v) => {
        el.style.transform = `translateY(${(1 - v) * distance}px) scale(${0.94 + 0.06 * v})`;
      },
      0,
      1,
      { stiffness: 260, damping: 17 },
    );
  }, delay);
}

/** Short elastic bump on an element (coverage milestones, timer ticks). */
export function pulse(el: HTMLElement, amount = 0.12): void {
  springAnimate(
    (v) => {
      el.style.transform = `scale(${1 + v})`;
    },
    0,
    0,
    { stiffness: 420, damping: 14, velocity: amount * 22 },
  );
}
