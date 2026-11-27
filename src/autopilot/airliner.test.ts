import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs } from '../core/types';
import { DEG, FPM, FT, KT } from '../core/units';
import { A320 } from '../fdm/aircraft/a320';
import { Fdm } from '../fdm/fdm';
import { KSFO, makeEnv } from '../fdm/testing';
import { GfcAutopilot } from './Autopilot';
import { AutoThrust } from './autothrust';
import { AIRLINER_AUTOPILOT } from './airliner';
import { FlyByWire } from './fbw';
import { makeFlightPlan, makeNavRadioState } from './testPlant';

const DT = 1 / 120;
const env = makeEnv();

class Airliner {
  readonly fdm = new Fdm(A320, { seed: 4 });
  readonly ap = new GfcAutopilot({ config: AIRLINER_AUTOPILOT });
  readonly at = new AutoThrust();
  readonly fbw = new FlyByWire({ vmoKt: 350, alphaProtRad: 0.2, alphaFloorRad: 0.23 });
  readonly pilot: ControlInputs;
  readonly eff = defaultControlInputs();
  readonly nav = { nav1: makeNavRadioState(), nav2: makeNavRadioState(), plan: null as ReturnType<typeof makeFlightPlan> | null };
  constructor(altFt: number, kcas: number) {
    const f = this.fdm;
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: altFt * FT }, headingRad: 0, speedMs: kcas * KT * 1.2, onGround: false, engineRunning: true }, env);
    f.setGearDown(false);
    const u0 = defaultControlInputs(); u0.gearDown = false;
    f.snapControls(u0);
    if (!f.trim(kcas * KT, 0, env)) throw new Error('trim');
    const tr = f.trimResult!;
    this.pilot = { ...u0, parkingBrake: false, throttle: tr.throttle, pitchTrim: tr.pitchTrim, pitch: 0, magnetos: 3, mixture: 1 };
    this.fbw.reset(tr.pitchStick, true);
  }
  get ac() { return this.fdm.state; }
  run(seconds: number, each?: () => void): void {
    for (let t = 0; t < seconds; t += DT) {
      Object.assign(this.eff, this.pilot);
      this.eff.lights = this.pilot.lights;
      this.ap.update(DT, this.ac, this.nav);
      if (!this.ap.state.engaged) this.fbw.apply(this.eff, this.ac, DT);
      const o = this.ap.apply(this.eff);
      if (o !== this.eff) Object.assign(this.eff, o);
      if (this.ap.state.engaged) { this.pilot.pitchTrim = this.ap.state.trimCommand; this.fbw.coordinate(this.eff, this.ac); }
      const thr = this.at.update(DT, this.ac, this.ap.state, this.fbw.alphaFloor, this.eff.gearDown);
      if (thr !== null) this.eff.throttle = thr;
      this.fdm.step(DT, this.eff, env);
      each?.();
    }
  }
}

describe('airliner autopilot + autothrust (A320)', () => {
  it('ALT + HDG: holds 10,000 ft through a 90° turn; climbs 3,000 ft at 1,800 fpm and levels off; A/THR holds 250 kt', () => {
    const a = new Airliner(10_000, 250);
    const ap = a.ap;
    ap.setHeadingBug(Math.round(a.ac.headingMagRad / DEG));
    ap.setAltitudeTarget(a.ac.altitudeMslM);
    ap.setIasTarget(250 * KT);
    ap.engage(true); ap.setLateral('HDG'); ap.setVertical('ALT');
    a.at.engage(true, a.pilot.throttle);
    a.run(10);
    const alt0 = a.ac.altitudeMslM;
    ap.setHeadingBug(Math.round(a.ac.headingMagRad / DEG) + 90);
    let worstAlt = 0, maxBank = 0;
    a.run(80, () => { worstAlt = Math.max(worstAlt, Math.abs(a.ac.altitudeMslM - alt0)); maxBank = Math.max(maxBank, Math.abs(a.ac.euler[0])); });
    expect(worstAlt / FT).toBeLessThan(150);
    expect(maxBank / DEG).toBeLessThan(28);
    const hdgErr = Math.abs(((ap.state.headingBugDeg - a.ac.headingMagRad / DEG) % 360 + 540) % 360 - 180);
    expect(hdgErr).toBeLessThan(5);
    // climb
    ap.setAltitudeTarget(alt0 + 3000 * FT);
    ap.setVertical('VS');
    ap.setVerticalSpeedTarget(1800 * FPM);
    let maxVs = 0;
    a.run(150, () => { maxVs = Math.max(maxVs, a.ac.verticalSpeedMs); });
    expect(maxVs / FPM).toBeGreaterThan(1400);
    expect(Math.abs(a.ac.altitudeMslM - (alt0 + 3000 * FT)) / FT).toBeLessThan(150);
    expect(Math.abs(a.ac.aero.ias / KT - 250)).toBeLessThan(15);
  });
});
