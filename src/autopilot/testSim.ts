/**
 * Closed-loop test harness: test plant + autopilot + nav signals, wired like the simulator's main
 * loop (nav update → `update` → `apply` → plant step). Test-only; not exported from the barrel.
 */
import { defaultControlInputs, type ControlInputs } from '../core/types';
import { GfcAutopilot, type GfcAutopilotOptions } from './Autopilot';
import {
  TestPlant, makeFlightPlan, makeNavRadioState, updateTestIls, updateTestPlan,
  type TestCourse, type TestIls, type TestPlantConfig, type TestPlantInit,
} from './testPlant';

export class Sim {
  readonly plant: TestPlant;
  readonly ap: GfcAutopilot;
  /** the pilot's controls (throttle preset to level flight at the initial speed) */
  readonly pilot: ControlInputs = defaultControlInputs();
  readonly nav1 = makeNavRadioState();
  readonly nav2 = makeNavRadioState();
  plan = makeFlightPlan();
  usePlan = false;
  course: TestCourse | null = null;
  ils: TestIls | null = null;
  /** elapsed time, s */
  t = 0;
  /** the controls the plant flew on the last frame */
  last: ControlInputs;
  /** optional hook between `apply` and the plant step (assists, scripted pilots) */
  beforeStep: ((sim: Sim, u: ControlInputs, dt: number) => void) | null = null;

  constructor(init: TestPlantInit, public readonly hz = 120, apOpts: GfcAutopilotOptions = {}, plantCfg: Partial<TestPlantConfig> = {}) {
    this.plant = new TestPlant(init, plantCfg);
    this.ap = new GfcAutopilot(apOpts);
    this.pilot.throttle = this.plant.levelThrottle();
    this.pilot.parkingBrake = false;
    this.last = this.pilot;
    this.updateNav();
  }

  get ac() { return this.plant.state; }
  get s() { return this.ap.state; }

  private updateNav(): void {
    if (this.course) updateTestPlan(this.ac, this.course, this.plan);
    if (this.ils) updateTestIls(this.ac, this.ils, this.nav1);
  }

  /** Advance one frame. */
  frame(): void {
    const dt = 1 / this.hz;
    this.updateNav();
    this.ap.update(dt, this.ac, { nav1: this.nav1, nav2: this.nav2, plan: this.usePlan ? this.plan : null });
    this.last = this.ap.apply(this.pilot);
    if (this.beforeStep) this.beforeStep(this, this.last, dt);
    this.plant.step(dt, this.last);
    this.t += dt;
  }

  /** Run for `seconds`, calling `probe` each frame; returns early when probe returns true. */
  run(seconds: number, probe?: (sim: Sim) => boolean | void): void {
    const n = Math.round(seconds * this.hz);
    for (let i = 0; i < n; i++) {
      this.frame();
      if (probe && probe(this) === true) return;
    }
  }
}
