/**
 * Test-only harness for the adversarial review: the autopilot and assists wired to the real C172S
 * flight model exactly as src/app/Simulator.ts wires them — `update`/`apply`/assists once per
 * display frame with the frame's simulated dt, then the flight model sub-stepped at its fixed
 * 120 Hz with those controls held (zero-order hold). Not exported from the barrel.
 */
import { defaultControlInputs, type ControlInputs, type Environment } from '../core/types';
import { C172S, type Fdm } from '../fdm';
import { airborne, makeEnv, makeFdm } from '../fdm/testing';
import { GfcAutopilot } from './Autopilot';
import { FlightAssists, stallAlphaFromConfig, type AssistFlags } from './assists';
import { makeFlightPlan, makeNavRadioState, updateTestIls, updateTestPlan, type TestCourse, type TestIls } from './testPlant';
import { wrapPi } from '../core/math';
import { DEG } from '../core/units';

export const FDM_DT = 1 / 120;

export class ZohSim {
  readonly env: Environment;
  readonly fdm: Fdm;
  readonly ap = new GfcAutopilot();
  readonly assists = new FlightAssists({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
  flags: AssistFlags | null = null;
  pilot: ControlInputs;
  readonly eff: ControlInputs = defaultControlInputs();
  readonly nav1 = makeNavRadioState();
  readonly nav2 = makeNavRadioState();
  readonly plan = makeFlightPlan();
  course: TestCourse | null = null;
  ils: TestIls | null = null;
  /** FDM sub-steps per autopilot frame (1 = AP at 120 Hz, 2 = 60 Hz, 4 = 30 Hz, 16 = 7.5 Hz) */
  readonly sub: number;
  t = 0;

  constructor(altM: number, kcas: number, hdgDeg = 0, sub = 2, env: Environment = makeEnv()) {
    this.env = env;
    this.sub = sub;
    this.fdm = makeFdm(1043);
    this.pilot = airborne(this.fdm, env, altM, kcas, hdgDeg);
  }

  get ac() { return this.fdm.state; }
  get s() { return this.ap.state; }

  frame(): void {
    const dt = this.sub * FDM_DT;
    if (this.course) updateTestPlan(this.ac, this.course, this.plan);
    if (this.ils) {
      updateTestIls(this.ac, this.ils, this.nav1);
      const magvarDeg = wrapPi(this.ac.headingTrueRad - this.ac.headingMagRad) / DEG;
      this.nav1.obsDeg = (((this.nav1.obsDeg - magvarDeg) % 360) + 360) % 360;
    }
    Object.assign(this.eff, this.pilot);
    this.eff.lights = this.pilot.lights;
    this.ap.update(dt, this.ac, { nav1: this.nav1, nav2: this.nav2, plan: this.course ? this.plan : null });
    const o = this.ap.apply(this.eff);
    if (o !== this.eff) Object.assign(this.eff, o);
    if (this.s.engaged) this.pilot.pitchTrim = this.s.trimCommand;
    if (this.flags) this.assists.apply(this.eff, this.ac, dt, this.flags);
    for (let i = 0; i < this.sub; i++) this.fdm.step(FDM_DT, this.eff, this.env);
    this.t += dt;
  }

  run(seconds: number, probe?: (s: ZohSim) => boolean | void): void {
    const n = Math.round(seconds / (this.sub * FDM_DT));
    for (let i = 0; i < n; i++) {
      this.frame();
      if (probe && probe(this) === true) return;
    }
  }
}
