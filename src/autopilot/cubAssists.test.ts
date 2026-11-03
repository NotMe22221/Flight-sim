/**
 * The MSFS-style assists on the real Super Cub flight model (src/fdm/aircraft/cub.ts), tuned by
 * `assistsConfigFor`: assisted take-off on the tail wheel (the Cub ground-loops without rudder),
 * anti-stall with the speed floor (the Cub's elevator zooms it out of airspeed otherwise) and
 * auto-rudder against its large adverse yaw. The C172 keeps its own tuning (realFdm.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs, type Environment } from '../core/types';
import { clamp, wrapPi } from '../core/math';
import { DEG, FT, KT } from '../core/units';
import { Fdm } from '../fdm/fdm';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { KSFO, makeEnv } from '../fdm/testing';
import { FlightAssists, assistsConfigFor, isTailDragger, stallAlphaFromConfig } from './assists';

const DT = 1 / 120;

/** A Super Cub at gross weight less ~50 kg (pilot only, full fuel) as the simulator spawns it. */
function cub(): Fdm {
  const f = new Fdm(PA18_150, { seed: 1 });
  f.setFuelFraction(1);
  return f;
}

/** Trimmed in the air at `kcas`, returning the pilot inputs that hold the trim. */
function airborne(f: Fdm, env: Environment, kcas: number): ControlInputs {
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 3000 * FT }, headingRad: 0, speedMs: kcas * KT * 1.05, onGround: false, engineRunning: true, gammaRad: 0 }, env);
  if (!f.trim(kcas * KT, 0, env)) throw new Error('trim failed');
  const tr = f.trimResult!;
  const u = defaultControlInputs();
  u.parkingBrake = false; u.throttle = tr.throttle; u.pitchTrim = tr.pitchTrim; u.pitch = tr.pitchStick; u.magnetos = 3; u.mixture = 1;
  return u;
}

describe('assists tuning per aircraft', () => {
  it('the Cub is a tail-dragger and gets the anti-stall speed floor; the 172 keeps its tuning', () => {
    expect(isTailDragger(PA18_150)).toBe(true);
    expect(isTailDragger(C172S)).toBe(false);
    expect(assistsConfigFor(C172S)).toEqual({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
    const c = assistsConfigFor(PA18_150).antiStall!;
    expect(c.stallAlphaRad).toBeCloseTo(15.5 * DEG, 2);
    expect(c.speedFloorMs).toBeCloseTo(PA18_150.limits.Vs1Kt * KT, 6);
    expect(c.speedStartMs!).toBeGreaterThan(c.speedFloorMs!);
    expect(c.minIasMs!).toBeLessThan(PA18_150.limits.VsoKt * KT);
  });
});

describe('assists on the Super Cub flight model', () => {
  /**
   * Brakes set at full power, released at 3 s; the pilot raises the tail with forward stick above
   * 15 KIAS (≈ 2° nose-up) and rotates to 8° at 42 KIAS, feet off the pedals.
   */
  const takeoff = (assist: boolean, crosswindKt = 0) => {
    const env = makeEnv(crosswindKt ? { windNED: [0, -crosswindKt * KT, 0] } : {});
    const f = cub();
    const rwy = 280 * DEG;
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: rwy, speedMs: 0, onGround: true, engineRunning: true }, env);
    const pilot = defaultControlInputs();
    pilot.parkingBrake = true; pilot.throttle = 1; pilot.mixture = 1; pilot.magnetos = 3;
    const u = defaultControlInputs();
    const a = new FlightAssists(assistsConfigFor(PA18_150));
    const n0 = f.state.posNED[0], e0 = f.state.posNED[1];
    const r = { maxHdgErr: 0, maxOffset: 0, liftoffS: -1, crashed: false };
    for (let t = DT; t < 40; t += DT) {
      if (t > 3) pilot.parkingBrake = false;
      const s = f.state, ias = s.aero.ias / KT, theta = s.euler[1];
      const target = ias < 42 ? 2 * DEG : 8 * DEG;
      pilot.pitch = ias < 15 ? 0 : clamp((2.5 * (target - theta)) / (10 * DEG) - 0.4 * s.rates[1], -1, 1);
      Object.assign(u, pilot);
      u.lights = pilot.lights;
      if (assist) a.apply(u, s, DT, { autoRudder: true, assistedTakeoff: true });
      f.step(DT, u, env);
      if (f.state.crashed) { r.crashed = true; break; }
      if (!f.state.onGround) { if (r.liftoffS < 0) r.liftoffS = t; if (t - r.liftoffS > 2) break; continue; }
      r.maxHdgErr = Math.max(r.maxHdgErr, Math.abs(wrapPi(f.state.headingTrueRad - rwy)));
      const dN = f.state.posNED[0] - n0, dE = f.state.posNED[1] - e0;
      r.maxOffset = Math.max(r.maxOffset, Math.abs(-dN * Math.sin(rwy) + dE * Math.cos(rwy)));
    }
    return r;
  };

  it('assisted take-off holds the runway heading through tail-up and lift-off; without it the Cub ground-loops', () => {
    const off = takeoff(false);
    expect(off.maxHdgErr).toBeGreaterThan(45 * DEG);
    expect(off.liftoffS).toBeLessThan(0);
    for (const xw of [0, 10]) {
      const on = takeoff(true, xw);
      expect(on.crashed).toBe(false);
      expect(on.liftoffS).toBeGreaterThan(5);
      expect(on.liftoffS).toBeLessThan(16);
      expect(on.maxHdgErr).toBeLessThan(3.5 * DEG);
      // within 5 m of the centreline (the 10 kt crosswind case is mostly a tailwind here: a longer roll)
      expect(on.maxOffset).toBeLessThan(5);
    }
  });

  const pullUp = (assist: boolean, throttle: number, kcas: number) => {
    const env = makeEnv();
    const f = cub();
    const pilot = airborne(f, env, kcas);
    const a = new FlightAssists(assistsConfigFor(PA18_150));
    const u = defaultControlInputs();
    let stalled = false, maxAlpha = 0, minIas = Infinity;
    for (let t = 0; t < 25; t += DT) {
      pilot.pitch = 1;
      pilot.throttle = throttle;
      Object.assign(u, pilot);
      u.lights = pilot.lights;
      if (assist) a.apply(u, f.state, DT, { autoRudder: false, assistedTakeoff: false, antiStall: true });
      f.step(DT, u, env);
      stalled ||= f.state.aero.stalled;
      maxAlpha = Math.max(maxAlpha, f.state.aero.alpha);
      minIas = Math.min(minIas, f.state.aero.ias / KT);
    }
    return { stalled, maxAlpha, minIas, finalIas: f.state.aero.ias / KT };
  };

  it('anti-stall: full aft stick never stalls the Cub, power off or at full power', () => {
    expect(pullUp(false, 0, 65).stalled).toBe(true);
    for (const [thr, kcas] of [[0, 65], [1, 90]] as const) {
      const on = pullUp(true, thr, kcas);
      expect(on.stalled).toBe(false);
      expect(on.maxAlpha).toBeLessThan(stallAlphaFromConfig(PA18_150) - 1 * DEG);
      // the speed floor keeps it flying: it settles a few knots above the 1-g stall
      expect(on.minIas).toBeGreaterThan(PA18_150.limits.VsoKt - 2);
      expect(on.finalIas).toBeGreaterThan(PA18_150.limits.Vs1Kt);
    }
  });

  it('auto-rudder cuts the roll-in sideslip of the Cub\'s adverse yaw by more than half and centres the ball', () => {
    const rollIn = (assist: boolean) => {
      const env = makeEnv();
      const f = cub();
      const pilot = airborne(f, env, 80);
      const a = new FlightAssists(assistsConfigFor(PA18_150));
      const u = defaultControlInputs();
      let peak = 0;
      for (let t = 0; t < 15; t += DT) {
        pilot.roll = t > 2 && t < 4 ? 0.3 : 0;
        Object.assign(u, pilot);
        u.lights = pilot.lights;
        if (assist) a.apply(u, f.state, DT, { autoRudder: true, assistedTakeoff: false });
        f.step(DT, u, env);
        if (t > 2 && t < 10) peak = Math.max(peak, Math.abs(f.state.aero.beta));
      }
      return { peak, final: Math.abs(f.state.aero.beta) };
    };
    const off = rollIn(false), on = rollIn(true);
    expect(off.peak).toBeGreaterThan(3 * DEG);
    expect(on.peak).toBeLessThan(0.5 * off.peak);
    expect(on.final).toBeLessThan(0.2 * DEG);
  });
});
