/**
 * Dynamic resolution: trades pixels for frame rate on GPUs that cannot hold the target, the way
 * console games and MSFS's "dynamic settings" do. Fed the wall-clock frame interval, it returns a
 * render-scale multiplier (min…1) applied on top of the user's render scale.
 *
 * - Frame interval is smoothed (EMA over ~0.5 s).
 * - Slower than `downMs` (default 1000/40) for `downHoldS` → step down 10 %.
 * - Faster than `upMs` (default 1000/55: with a 60 Hz vsync the interval never drops below 16.7 ms, so
 *   "up" means "at vsync") for `upHoldS` → step up 5 %.
 * - After a step down from a scale, stepping back up to it is blocked for `ceilingHoldS` (no
 *   oscillation between a scale that is too slow and one that is fast enough).
 * - Gaps over 1 s (tab switch, a loading hitch) are ignored; slower frames count as 250 ms.
 */
export interface DynamicResolutionOptions {
  min?: number;
  downMs?: number;
  upMs?: number;
  downHoldS?: number;
  upHoldS?: number;
  ceilingHoldS?: number;
}

export class DynamicResolution {
  scale = 1;
  enabled = true;
  private avgMs = 16.7;
  private slowS = 0;
  private fastS = 0;
  private ceiling = Infinity;
  private ceilingS = 0;
  private readonly o: Required<DynamicResolutionOptions>;

  constructor(opts: DynamicResolutionOptions = {}) {
    this.o = { min: 0.5, downMs: 1000 / 40, upMs: 1000 / 55, downHoldS: 1, upHoldS: 4, ceilingHoldS: 30, ...opts };
  }

  /** Smoothed frame interval, ms. */
  get frameMs(): number { return this.avgMs; }

  /** Restart the measurement (a new flight, a settings change): keeps the current scale. */
  reset(): void { this.slowS = 0; this.fastS = 0; this.avgMs = 16.7; }

  /** Feed one frame interval (s). Returns true when `scale` changed. */
  update(dtS: number): boolean {
    if (!this.enabled) { const changed = this.scale !== 1; this.scale = 1; this.ceiling = Infinity; return changed; }
    if (!(dtS > 0) || dtS > 1) return false;
    dtS = Math.min(dtS, 0.25);
    const ms = dtS * 1000;
    this.avgMs += (ms - this.avgMs) * Math.min(1, dtS / 0.5);
    if (this.ceilingS > 0) { this.ceilingS -= dtS; if (this.ceilingS <= 0) this.ceiling = Infinity; }
    if (this.avgMs > this.o.downMs) { this.slowS += dtS; this.fastS = 0; }
    else if (this.avgMs < this.o.upMs) { this.fastS += dtS; this.slowS = 0; }
    else { this.slowS = 0; this.fastS = 0; }
    if (this.slowS >= this.o.downHoldS && this.scale > this.o.min) {
      this.ceiling = this.scale; this.ceilingS = this.o.ceilingHoldS;
      this.scale = Math.max(this.o.min, round2(this.scale * 0.9));
      this.slowS = 0;
      return true;
    }
    if (this.fastS >= this.o.upHoldS && this.scale < 1) {
      const next = Math.min(1, round2(this.scale * 1.05 + 0.005));
      this.fastS = 0;
      if (next >= this.ceiling) return false;
      this.scale = next;
      return true;
    }
    return false;
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;
