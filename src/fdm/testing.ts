/** Shared helpers for flight-model tests: spawning, simple pilot controllers, unit shorthands. */
import { defaultControlInputs, type ControlInputs, type Environment } from '../core/types';
import { FPM as FPM_MS, KT } from '../core/units';
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

/**
 * Wings-level / heading-hold with ailerons and a yaw damper on the rudder. `yawGain` (pedal per
 * radian of sideslip) defaults to the C172's; a lighter aircraft with a bigger rudder needs less.
 */
export function levelWings(f: Fdm, u: ControlInputs, headingRad?: number, yawGain = 10): void {
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
  u.yaw = Math.max(-1, Math.min(1, yawGain * s.aero.beta));
}

const clamp1 = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Cascaded altitude hold for light aircraft: altitude error → vertical-speed command → pitch-
 * attitude command (integrating the vertical-speed error) → stick (PI on attitude with pitch-rate
 * damping, on top of the trim stick). Gentler than the C172 tests' integrating stick loop, which
 * pilot-induces an oscillation in a lighter aircraft with a more powerful elevator.
 */
export class AltitudeHold {
  private stick: number;
  private theta: number;
  constructor(private readonly f: Fdm, private readonly targetM: number, baseStick: number) {
    this.stick = baseStick;
    this.theta = f.state.euler[1];
  }
  update(u: ControlInputs, dt: number): void {
    const s = this.f.state;
    const vsErr = clamp1(0.12 * (this.targetM - s.altitudeMslM), -2.5, 2.5) - s.verticalSpeedMs;
    this.theta = clamp1(this.theta + 0.024 * vsErr * dt, -0.35, 0.45);
    const e = clamp1(this.theta + 0.012 * vsErr, -0.35, 0.45) - s.euler[1];
    this.stick = clamp1(this.stick + 0.6 * e * dt, -1, 1);
    u.pitch = clamp1(this.stick + 1.2 * e - 0.25 * s.rates[1], -1, 1);
  }
}

/** White-box view of the flight-model internals the arrival set-up needs. */
interface FdmInternals {
  y: Float64Array;
  k1: Float64Array;
  specF: Float64Array;
  hyst: number;
  env: Environment;
  gearOut: { wheelsOnGround: number };
  deriv(s: Float64Array, out: Float64Array): void;
  sampleEnvironment(): void;
}

/**
 * A steady, power-idle arrival 2 cm above the runway (heading north) in a given pitch attitude and
 * sink rate: the airspeed is solved so that lift supports the weight (1 g, ground effect included)
 * and the stick so that the pitching moment balances. Returns the inputs holding that state.
 */
export function touchdownArrival(f: Fdm, env: Environment, o: { sinkFpm: number; pitchDeg: number; flapsIndex: number; rollDeg?: number }): ControlInputs {
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev + 30 }, headingRad: 0, speedMs: 25, onGround: false, engineRunning: true }, env);
  const I = f as unknown as FdmInternals;
  const u = defaultControlInputs();
  u.parkingBrake = false; u.magnetos = 3; u.mixture = 1; u.throttle = 0; u.flapsIndex = o.flapsIndex;
  f.snapControls(u);
  const y = I.y;
  const th = (o.pitchDeg * Math.PI) / 180, ph = ((o.rollDeg ?? 0) * Math.PI) / 180;
  // attitude (roll then pitch, heading 0)
  y[6] = Math.cos(ph / 2) * Math.cos(th / 2); y[7] = Math.sin(ph / 2) * Math.cos(th / 2);
  y[8] = Math.cos(ph / 2) * Math.sin(th / 2); y[9] = -Math.sin(ph / 2) * Math.sin(th / 2);
  y[10] = y[11] = y[12] = 0;
  const vd = o.sinkFpm * FPM_MS, c = Math.cos(th), s = Math.sin(th);
  const place = (V: number): void => {
    y[3] = V * c - vd * s; y[4] = 0; y[5] = V * s + vd * c;
    y[2] = -I.env.groundHeight(y[0], y[1]) - 3;
    I.sampleEnvironment(); I.deriv(y, I.k1);
    for (let k = 0; k < 4000 && I.gearOut.wheelsOnGround === 0; k++) { y[2] += 0.001; I.deriv(y, I.k1); }
    y[2] -= 0.02;
  };
  const balanceStick = (): void => {
    const qdot = (p: number): number => { u.pitch = p; f.snapControls(u); I.deriv(y, I.k1); return I.k1[11]; };
    let lo = -1, hi = 1;
    if (qdot(lo) > 0) u.pitch = lo;
    else if (qdot(hi) < 0) u.pitch = hi;
    else { for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (qdot(m) > 0) hi = m; else lo = m; } u.pitch = (lo + hi) / 2; }
    f.snapControls(u); I.deriv(y, I.k1);
  };
  let lo = 8, hi = 45;
  for (let k = 0; k < 40; k++) {
    const V = (lo + hi) / 2;
    place(V); balanceStick();
    // upward non-gravitational specific force (pitch-only attitude) against g
    if (I.specF[0] * s - I.specF[2] * c > 9.80665) hi = V; else lo = V;
  }
  place((lo + hi) / 2); balanceStick();
  I.hyst = 0;
  return u;
}
