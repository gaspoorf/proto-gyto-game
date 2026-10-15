import { DIRTY_RAMP_HI, DIRTY_RAMP_LO, settings } from '../config';
import type { PaintSystem, ScoreSink } from '../paint/PaintSystem';

/** How painted a texel counts, from its coverage. Same threshold the shader uses to show paint. */
export function painted(c: number): number {
  const x = (c - DIRTY_RAMP_LO) / (DIRTY_RAMP_HI - DIRTY_RAMP_LO);
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

export interface OfficialResult {
  /** Painted share in tenths of a percent (0..1000). */
  coverTenths: number;
  /** Goal in tenths of a percent. */
  goalTenths: number;
  win: boolean;
}

/**
 * Area-weighted painted share over reachable surfaces only.
 * Kept incrementally from coverage changes (no GPU readback), and fully
 * recomputed periodically and at the end to remove float drift.
 */
export class Score implements ScoreSink {
  private sum = 0;
  private totalWeight = 1;
  private frozen: OfficialResult | null = null;

  constructor(private ps: PaintSystem) {
    ps.score = this;
  }

  onCoverageChange(t: number, oldC: number, newC: number): void {
    const w = this.ps.weight[t];
    if (w === 0 || this.frozen) return;
    this.sum += w * (painted(newC) - painted(oldC));
  }

  recompute(): void {
    const { weight, cov, n } = this.ps;
    let tw = 0;
    let s = 0;
    for (let t = 0; t < n; t++) {
      const w = weight[t];
      if (w === 0) continue;
      tw += w;
      s += w * painted(cov[t]);
    }
    this.totalWeight = tw || 1;
    this.sum = s;
  }

  /** Live painted share in tenths of a percent. */
  liveTenths(): number {
    if (this.frozen) return this.frozen.coverTenths;
    return Math.min(1000, Math.max(0, Math.round((this.sum / this.totalWeight) * 1000)));
  }

  /** Called once at time-up (or when the goal is reached). */
  freeze(): OfficialResult {
    if (this.frozen) return this.frozen;
    this.recompute();
    const coverTenths = this.liveTenths();
    const goalTenths = Math.round(settings.goal * 10);
    this.frozen = { coverTenths, goalTenths, win: coverTenths >= goalTenths };
    return this.frozen;
  }

  get official(): OfficialResult | null {
    return this.frozen;
  }

  reset(): void {
    this.frozen = null;
    this.recompute();
  }
}
