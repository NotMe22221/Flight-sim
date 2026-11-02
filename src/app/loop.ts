/**
 * Fixed-timestep accumulator (Gaffer-on-Games pattern). Physics runs at a fixed DT; the
 * caller renders with the returned interpolation factor between the previous and current
 * physics states so motion is smooth at any display refresh rate.
 */
export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
/** Largest wall-clock delta we will integrate in one frame (prevents the spiral of death). */
export const MAX_FRAME_DT = 0.25;
/** Hard cap on physics sub-steps per frame even at high time scale. */
export const MAX_STEPS_PER_FRAME = 60;

export interface StepResult {
  /** number of fixed steps executed this frame */
  steps: number;
  /** interpolation factor 0..1 between previous and current physics state */
  alpha: number;
  /** sim seconds advanced this frame */
  simDt: number;
}

export class FixedStepLoop {
  private accumulator = 0;
  constructor(public readonly dt: number = PHYSICS_DT) {}

  /**
   * Advance by a real-time delta (seconds) scaled by `timeScale`. `step` is called once per
   * fixed step with (dt). `beforeStep` runs just before each step (used to save the previous state).
   */
  advance(realDt: number, timeScale: number, beforeStep: () => void, step: (dt: number) => void): StepResult {
    const frameDt = Math.min(Math.max(realDt, 0), MAX_FRAME_DT) * Math.max(timeScale, 0);
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= this.dt && steps < MAX_STEPS_PER_FRAME) {
      beforeStep();
      step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0; // drop the remainder rather than stall
    return { steps, alpha: timeScale > 0 ? this.accumulator / this.dt : 1, simDt: steps * this.dt };
  }

  reset(): void { this.accumulator = 0; }
}
