/** Shared helpers for flight-model tests: spawning, simple pilot controllers, unit shorthands. */
import { defaultControlInputs, type ControlInputs, type Environment } from '../core/types';
import { KT } from '../core/units';
import { LocalFrame } from '../geo/wgs84';
import { C172S } from './aircraft/c172';
import { Fdm } from './fdm';
import { flatEnvironment, type FlatEnvOptions } from './testEnv';

export const DT = 1 / 120;
export const KSFO = { lat: 37.613538, lon: -122.35716, elev: 4 };
export const frameKSFO = new LocalFrame(KSFO.lat, KSFO.lon, KSFO.elev);
export const kcas = (f: Fdm) => f.state.aero.cas / KT;

export function makeEnv(o: FlatEnvOptions = {}): Environment {
  return flatEnvironment(frameKSFO.info, { groundAltM: KSFO.elev, ...o });
}

/** New C172S loaded to `massKg` total (fuel full, pilot + passengers fill the rest). */
export function makeFdm(massKg?: number, seed = 1): Fdm {
  const f = new Fdm(C172S, { seed });
  f.setFuelFraction(1);
  if (massKg) {
    const extra = massKg - f.state.totalMassKg - 0; // computed below after setLoad
    void extra;
    const base = C172S.mass.emptyMassKg + C172S.mass.tanks.reduce((s, t) => s + t.capacityKg, 0);
    let rest = Math.max(0, massKg - base);
    const st = C172S.mass.stations.map((s) => { const m = Math.min(rest, s.maxKg); rest -= m; return m; });
    f.setLoad(st);
  }
  return f;
}

/** Airborne at altitude (m MSL), trimmed at `kcasTarget`; returns the inputs that hold the trim. */
export function airborne(f: Fdm, env: Environment, altM: number, kcasTarget: number, headingDeg = 0, gammaRad = 0): ControlInputs {
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: altM }, headingRad: (headingDeg * Math.PI) / 180, speedMs: kcasTarget * KT * 1.05, onGround: false, engineRunning: true, gammaRad }, env);
  const ok = f.trim(kcasTarget * KT, gammaRad, env);
  const tr = f.trimResult!;
  if (!ok) throw new Error(`trim failed: ${JSON.stringify(tr)}`);
  const u = defaultControlInputs();
  u.parkingBrake = false;
  u.throttle = tr.throttle;
  u.pitchTrim = tr.pitchTrim;
  u.pitch = tr.pitchStick;
  u.magnetos = 3;
  u.mixture = 1;
  return u;
}

export function run(f: Fdm, env: Environment, u: ControlInputs, seconds: number, each?: (t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { each?.(i * DT); f.step(DT, u, env); }
}

/**
 * Airspeed-hold pilot using the elevator: a PID on airspeed sets a pitch-attitude command,
 * and a PD on pitch attitude moves the stick (on top of the trim stick).
 */
export class SpeedHold {
  private readonly theta0: number;
  private integ = 0;
  private prevErr = NaN;
  private errRate = 0;
  constructor(private f: Fdm, private targetKcas: number, private baseStick: number) { this.theta0 = f.state.euler[1]; }
  update(u: ControlInputs, dt: number, target = this.targetKcas): void {
    const s = this.f.state;
    const err = kcas(this.f) - target;
    if (!Number.isNaN(this.prevErr)) this.errRate += ((err - this.prevErr) / dt - this.errRate) * (1 - Math.exp(-dt / 0.5));
    this.prevErr = err;
    this.integ = Math.max(-200, Math.min(200, this.integ + err * dt));
    const thetaCmd = Math.max(-0.35, Math.min(0.4, this.theta0 + 0.01 * err + 0.0012 * this.integ + 0.04 * this.errRate));
    u.pitch = Math.max(-1, Math.min(1, this.baseStick + 1.0 * (thetaCmd - s.euler[1]) - 0.35 * s.rates[1]));
  }
}

/** Wings-level / heading-hold with ailerons and a yaw damper on the rudder. */
export function levelWings(f: Fdm, u: ControlInputs, headingRad?: number): void {
  const s = f.state;
  let bankCmd = 0;
  if (headingRad !== undefined) {
    let e = headingRad - s.headingTrueRad;
    while (e > Math.PI) e -= 2 * Math.PI;
    while (e < -Math.PI) e += 2 * Math.PI;
    bankCmd = Math.max(-0.35, Math.min(0.35, 1.5 * e));
  }
  u.roll = Math.max(-1, Math.min(1, 2.0 * (bankCmd - s.euler[0]) - 0.4 * s.rates[0]));
  // sideslip to the right (β > 0) needs right rudder (yaw > 0)
  u.yaw = Math.max(-1, Math.min(1, 10 * s.aero.beta));
}
