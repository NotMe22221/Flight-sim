/**
 * AudioParam automation helpers. Rule for the whole module (docs/research/06 §A1.2): audible
 * parameters are never assigned through `.value` once a graph is built — every change goes
 * through `setValueAtTime` (construction / one-shot envelopes) or `setTargetAtTime`
 * (continuous control, a one-pole smoother running at audio rate, so frame jitter is inaudible).
 */

/** Fast smoothing time constant for gains that must feel immediate (warnings, gates), s. */
export const TAU_FAST = 0.02;
/** Default smoothing time constant for continuous controls (rpm, IAS), s. */
export const TAU = 0.05;
/** Slow smoothing for view changes and level rides, s (≈ 0.25 s to settle within 1 %… ×5). */
export const TAU_SLOW = 0.12;

/** Decibels → linear gain. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
/** Linear gain → decibels (−∞ for 0). */
export const gainToDb = (g: number): number => 20 * Math.log10(g);

/** Equal-power crossfade weight of the incoming signal for position x ∈ [0, 1]. */
export const xfadeIn = (x: number): number => Math.sin(Math.max(0, Math.min(1, x)) * Math.PI * 0.5);
/** Equal-power crossfade weight of the outgoing signal for position x ∈ [0, 1]. */
export const xfadeOut = (x: number): number => Math.cos(Math.max(0, Math.min(1, x)) * Math.PI * 0.5);

/** Glide `param` toward `value` with time constant `tau` starting at `now` (safe while audible). */
export function smoothTo(param: AudioParam, value: number, now: number, tau = TAU): void {
  if (Number.isFinite(value)) param.setTargetAtTime(value, now, tau);
}

/** Set `param` at time `now` through the automation timeline (construction / one-shot envelopes). */
export function setAt(param: AudioParam, value: number, now: number): void {
  if (Number.isFinite(value)) param.setValueAtTime(value, now);
}

/**
 * A continuously driven AudioParam that only schedules a new `setTargetAtTime` when the target
 * moves by more than an absolute + relative tolerance. Keeps automation timelines short and makes
 * per-frame updates allocation-free. `target` exposes the last scheduled target (used by tests
 * and by early-outs such as "is this layer silent?").
 */
export class SmoothParam {
  private last = Number.NaN;

  /**
   * @param param the AudioParam to drive
   * @param tau default smoothing time constant, s
   * @param absEps absolute change below which no automation is scheduled
   * @param relEps relative change (fraction of the new target) below which no automation is scheduled
   */
  constructor(
    readonly param: AudioParam,
    private readonly tau = TAU,
    private readonly absEps = 1e-4,
    private readonly relEps = 0.002,
  ) {}

  /** Last scheduled target (NaN before the first `init`/`set`). */
  get target(): number { return this.last; }

  /** Initialise immediately (construction time, before the param is audible). */
  init(value: number, now: number): void {
    this.param.setValueAtTime(value, now);
    this.last = value;
  }

  /**
   * Glide toward `value`. Returns true when automation was scheduled.
   * Non-finite values are ignored so a NaN from upstream can never reach the audio thread.
   */
  set(value: number, now: number, tau = this.tau): boolean {
    if (!Number.isFinite(value)) return false;
    const d = Math.abs(value - this.last);
    if (d <= this.absEps + this.relEps * Math.abs(value)) return false; // NaN `last` → false → schedule
    this.param.setTargetAtTime(value, now, tau);
    this.last = value;
    return true;
  }
}
