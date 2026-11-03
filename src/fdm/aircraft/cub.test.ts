/**
 * Piper PA-18-150 Super Cub (PA18_150) against published figures.
 *
 * Sources (facts): PA-18-150 owner's handbook — stall 47 / 43 mph (41 / 37 kt) flaps up / down
 * at 1,750 lb, rate of climb 960 fpm, top speed 130 mph (113 kt), 75 % cruise 115 mph (100 kt),
 * take-off run 200 ft and landing roll 350 ft with flaps; FAA TCDS 1A2 — 1,750 lb, C.G. +7 … +20 in
 * aft of the wing leading edge at 1,750 lb, seats +9 / +36 in, baggage +50 in (50 lb); Lycoming
 * O-320-A — 150 hp at 2,700 rpm. Tolerances are stated in each test; the pilots are the shared
 * models in ../testing.ts plus ground-handling pilots here.
 */
import { describe, expect, it } from 'vitest';
import { Table2D } from '../../core/math';
import { defaultControlInputs, type ControlInputs, type Environment } from '../../core/types';
import { FPM, HP, KT, LB, RPM_TO_RADS } from '../../core/units';
import { atmosphere } from '../atmosphere';
import { Fdm } from '../fdm';
import { PistonPropulsion } from '../propulsion';
import { AltitudeHold, DT, KSFO, SpeedHold, airborne, kcas, levelWings, makeEnv, run, touchdownArrival } from '../testing';
import { C172S } from './c172';
import { CUB_GEOMETRY, PA18_150, cubArm } from './cub';

const D2R = Math.PI / 180;
const GROSS_KG = 1750 * LB;
/** front, rear, baggage (kg): two large occupants and 50 lb of bags with full fuel = 1,750 lb */
const GROSS = [112, 111, 22.7];
const SOLO = [77, 0, 0];

function cub(stations: number[] = GROSS, seed = 1): Fdm {
  const f = new Fdm(PA18_150, { seed });
  f.setFuelFraction(1);
  f.setLoad(stations);
  return f;
}
const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (x: number, lo = -1, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
const kias = (f: Fdm): number => f.state.aero.ias / KT;
const pilotArm = (f: Fdm): number => (CUB_GEOMETRY.wingLeadingEdgeX - f.state.cgM[0]) / 0.0254;

/** Ground spawn on runway heading north, engine running, brakes off. */
function onRunway(f: Fdm, env: Environment, engineRunning = true): ControlInputs {
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning }, env);
  const u = defaultControlInputs();
  u.parkingBrake = false; u.magnetos = engineRunning ? 3 : 0; u.mixture = engineRunning ? 1 : 0;
  return u;
}

/** Total pitching-moment slope about the CG (per rad of α, power and controls fixed) at the current state. */
function cmAlphaAtCg(f: Fdm): number {
  const I = f as unknown as { y: Float64Array; deriv(s: Float64Array, o: Float64Array): void; mp: { Iyy: number }; atm: { densityKgM3: number } };
  const y = I.y, V = Math.hypot(y[3], y[5]), a0 = Math.atan2(y[5], y[3]);
  const cm = (da: number): number => {
    const s = Float64Array.from(y), k = new Float64Array(s.length);
    s[3] = V * Math.cos(a0 + da); s[5] = V * Math.sin(a0 + da);
    I.deriv(s, k);
    return (k[11] * I.mp.Iyy) / (0.5 * I.atm.densityKgM3 * V * V * PA18_150.geometry.S * PA18_150.geometry.cbar);
  };
  return (cm(0.01) - cm(-0.01)) / 0.02;
}

describe('PA-18-150 config: shared airframe numbers, mass and balance', () => {
  it('geometry matches the shared numbers (wing, propeller, gear, eye point)', () => {
    const g = PA18_150.geometry;
    expect(PA18_150.id).toBe('pa18-150');
    expect(PA18_150.panel).toBe('cub-steam');
    expect(PA18_150.airframe).toBe('cub');
    expect(g.S).toBeCloseTo(16.58, 2);
    expect(g.b).toBeCloseTo(10.73, 2);
    expect(g.b * g.b / g.S).toBeCloseTo(6.94, 1); // aspect ratio ≈ 7
    expect(g.eyePoint).toEqual([0.05, 0, -0.6]);
    const prop = PA18_150.propulsion.propeller!;
    expect(prop.position).toEqual([1.8, 0, -0.05]);
    expect(prop.diameterM).toBeCloseTo(1.88, 2);
    expect(prop.sense).toBe(C172S.propulsion.propeller!.sense);
    const [l, r, tail] = PA18_150.gear;
    expect(l.pos).toEqual([0.5, -0.92, 1.12]);
    expect(r.pos).toEqual([0.5, 0.92, 1.12]);
    expect(tail.pos).toEqual([-4.4, 0, 0.15]);
    expect([l.tyreRadius, tail.tyreRadius]).toEqual([0.28, 0.08]);
    expect(tail.casters && tail.maxSteerDeg).toBe(25);
    // the gear geometry alone sets an ≈ 11° three-point attitude
    expect(Math.atan2(l.pos[2] - tail.pos[2], l.pos[0] - tail.pos[0]) / D2R).toBeCloseTo(11.2, 1);
    // tables are well formed
    const cl = PA18_150.aero.CL.table;
    for (let i = 1; i < cl.rows.length; i++) expect(cl.rows[i]).toBeGreaterThan(cl.rows[i - 1]);
    const t = new Table2D(cl.rows, cl.cols, cl.data);
    expect(t.at(0.25, 1)).toBeLessThan(t.at(0.25, 0));
  });

  it('empty 440–460 kg, MTOW 1,750 lb, and the test loadings sit inside the TCDS C.G. envelope (+7 … +20 in)', () => {
    expect(PA18_150.mass.emptyMassKg).toBeGreaterThanOrEqual(440);
    expect(PA18_150.mass.emptyMassKg).toBeLessThanOrEqual(460);
    expect(PA18_150.mass.maxTakeoffKg).toBeCloseTo(793.8, 1);
    expect(PA18_150.mass.stations.map((s) => s.name)).toEqual(['Front seat', 'Rear seat', 'Baggage']);
    expect(PA18_150.mass.tanks.map((t) => t.capacityKg / 2.725)).toEqual([expect.closeTo(18, 1), expect.closeTo(18, 1)]);
    expect(cubArm(36)).toBeCloseTo(-0.494, 3);
    const env = makeEnv();
    for (const load of [GROSS, SOLO]) {
      const f = cub(load);
      onRunway(f, env, false);
      const arm = pilotArm(f);
      expect(arm).toBeGreaterThan(7);
      expect(arm).toBeLessThan(20.5);
    }
    const g = cub(GROSS);
    onRunway(g, env, false);
    expect(g.state.totalMassKg).toBeCloseTo(GROSS_KG, 0);
  });
});

describe('PA-18-150 engine and propeller (O-320-A, 74 in climb propeller)', () => {
  const p = new PistonPropulsion(PA18_150.propulsion.engine as never, PA18_150.propulsion.propeller!);
  const sl = atmosphere(0);
  const air = (u: number) => ({ rho: sl.densityKgM3, pAmb: sl.pressurePa, tAmb: sl.temperatureK, u, v: 0, w: 0 });
  const full = { throttle: 1, mixture: 1, magnetos: 3 as const, starter: false, fuelAvailable: true };
  it('150 hp ± 5 at 2,700 rpm; static 2,250–2,450 rpm with ≈ 600 lbf; idle 550–750 rpm', () => {
    const o = { F: new Float64Array(3), M: new Float64Array(3) } as never;
    const eq = p.equilibrium(air(58), full, 2600 * RPM_TO_RADS, 90000);
    const r = p.evaluate(eq.omega, eq.map, air(58), full, [0, 0, 0], o) as { brakePowerW: number };
    const rpm = eq.omega / RPM_TO_RADS;
    expect((r.brakePowerW / HP) * (2700 / rpm)).toBeGreaterThan(145);
    expect((r.brakePowerW / HP) * (2700 / rpm)).toBeLessThan(155);
    const st = p.equilibrium(air(0), full, 2000 * RPM_TO_RADS, 90000);
    expect(st.omega / RPM_TO_RADS).toBeGreaterThan(2250);
    expect(st.omega / RPM_TO_RADS).toBeLessThan(2450);
    const ts = p.evaluate(st.omega, st.map, air(0), full, [0, 0, 0], o) as { thrustN: number };
    expect(ts.thrustN / 4.448).toBeGreaterThan(540);
    expect(ts.thrustN / 4.448).toBeLessThan(680);
    const idle = p.equilibrium(air(0), { ...full, throttle: 0 }, 900 * RPM_TO_RADS, 40000).omega / RPM_TO_RADS;
    expect(idle).toBeGreaterThan(550);
    expect(idle).toBeLessThan(750);
  });
});

describe('PA-18-150 static stability and trim', () => {
  it('trims at 50, 70 and 90 KIAS (gross and solo) with Cm_α < 0 about the CG, and holds 70 KIAS hands-off for 60 s', () => {
    const env = makeEnv();
    for (const load of [GROSS, SOLO]) {
      const f = cub(load);
      let prevDe = -Infinity;
      for (const v of [50, 70, 90]) {
        airborne(f, env, 600, v);
        const tr = f.trimResult!;
        expect(tr.ok, `trim ${v} KIAS`).toBe(true);
        expect(tr.residual).toBeLessThan(1e-3);
        expect(cmAlphaAtCg(f), `Cm_alpha at ${v} KIAS`).toBeLessThan(-0.2);
        // stick-fixed stability: more trim elevator (TE down) as speed rises, all within trim authority
        expect(tr.elevatorRad).toBeGreaterThan(prevDe);
        prevDe = tr.elevatorRad;
        expect(Math.abs(tr.pitchStick)).toBeLessThan(1e-6);
      }
      const u = airborne(f, env, 600, 70);
      const h0 = f.state.altitudeMslM;
      let dh = 0, dv = 0;
      run(f, env, u, 60, () => {
        levelWings(f, u, undefined, 3);
        dh = Math.max(dh, Math.abs(f.state.altitudeMslM - h0));
        dv = Math.max(dv, Math.abs(kcas(f) - 70));
      });
      expect(dh).toBeLessThan(40);
      expect(dv).toBeLessThan(5);
    }
  });
});

describe('PA-18-150 performance vs the owner\'s handbook (1,750 lb, ISA sea level)', () => {
  /** Power-off stall entry at ≈ 1 kt/s holding altitude; returns the entry IAS and the 1-g stall IAS from CLmax. */
  function stall(flapsIndex: number): { entry: number; oneG: number; warnMargin: number } {
    const env = makeEnv();
    const f = cub(GROSS);
    const u = airborne(f, env, 1500, 60);
    u.throttle = 0; u.flapsIndex = flapsIndex;
    const hold = new AltitudeHold(f, 1500, u.pitch);
    let entry = NaN, warn = NaN, clMax = 0;
    run(f, env, u, 90, () => {
      levelWings(f, u, undefined, 3);
      hold.update(u, DT);
      clMax = Math.max(clMax, f.state.aero.coefficients.CL);
      if (Number.isNaN(warn) && f.state.aero.stallWarning) warn = kias(f);
      if (Number.isNaN(entry) && f.state.aero.stalled) entry = kias(f);
    });
    const oneG = Math.sqrt((f.state.totalMassKg * 9.80665) / (0.5 * 1.225 * PA18_150.geometry.S * clMax)) / KT;
    return { entry, oneG, warnMargin: warn - entry };
  }
  it('stalls at 41 KIAS flaps up and 37 KIAS full flaps, ± 2.5 kt (1 g, power off); the entry and warning are sensible', () => {
    const up = stall(0), dn = stall(2);
    expect(up.oneG).toBeGreaterThan(38.5);
    expect(up.oneG).toBeLessThan(43.5);
    expect(dn.oneG).toBeGreaterThan(34.5);
    expect(dn.oneG).toBeLessThan(39.5);
    for (const s of [up, dn]) {
      expect(s.entry).toBeGreaterThan(s.oneG - 4);
      expect(s.entry).toBeLessThan(s.oneG + 1);
      expect(s.warnMargin).toBeGreaterThan(2);
      expect(s.warnMargin).toBeLessThan(9);
    }
  });

  it('climbs at 960 fpm ± 12 % at Vy (61 KIAS), full throttle, sea level', () => {
    const env = makeEnv();
    const f = cub(GROSS);
    const u = airborne(f, env, 100, PA18_150.limits.VyKt);
    u.throttle = 1;
    const hold = new SpeedHold(f, PA18_150.limits.VyKt, u.pitch);
    run(f, env, u, 10, () => { levelWings(f, u, undefined, 3); hold.update(u, DT); });
    const h0 = f.state.altitudeMslM;
    run(f, env, u, 30, () => { levelWings(f, u, undefined, 3); hold.update(u, DT); });
    const fpm = (f.state.altitudeMslM - h0) / 30 / FPM;
    expect(fpm).toBeGreaterThan(845);
    expect(fpm).toBeLessThan(1075);
  });

  it('top speed 113 KTAS ± 6 % at sea level (full throttle, ≤ 2,750 rpm); 75 % cruise 100 KTAS ± 6 %', () => {
    const env = makeEnv();
    const top = cub(GROSS);
    const u = airborne(top, env, 30, 95);
    u.throttle = 1;
    const hold = new AltitudeHold(top, 30, u.pitch);
    run(top, env, u, 120, () => { levelWings(top, u, undefined, 3); hold.update(u, DT); });
    const vTop = top.state.aero.tas / KT;
    expect(vTop).toBeGreaterThan(106);
    expect(vTop).toBeLessThan(120);
    expect(top.state.engine.rpm).toBeLessThan(2750);
    expect(Math.abs(top.state.altitudeMslM - 30)).toBeLessThan(5);

    const cr = cub(GROSS);
    const v = airborne(cr, env, 30, 95);
    const ch = new AltitudeHold(cr, 30, v.pitch);
    let thr = v.throttle;
    run(cr, env, v, 150, () => {
      levelWings(cr, v, undefined, 3); ch.update(v, DT);
      thr = clamp(thr + (0.75 - cr.state.engine.pctPower) * 0.1 * DT, 0, 1); v.throttle = thr;
    });
    expect(cr.state.engine.pctPower).toBeCloseTo(0.75, 1);
    expect(cr.state.aero.tas / KT).toBeGreaterThan(94);
    expect(cr.state.aero.tas / KT).toBeLessThan(106);
  });
});

// ───────────────────────────── ground handling ─────────────────────────────

/** Rudder pilot for the ground: hold the runway heading (north) with pedal, plus a right-rudder bias at power. */
function rudderOnRunway(f: Fdm, u: ControlInputs, bias = 0): void {
  const s = f.state;
  u.yaw = clamp(bias + 4 * wrap(-s.headingTrueRad) - 1.0 * s.rates[2]);
  u.roll = clamp(-1.5 * s.euler[0]);
}
const mainsOnGround = (f: Fdm): boolean => f.state.gear[0].onGround || f.state.gear[1].onGround;
const castering = (f: Fdm): number => (f as unknown as { gear: { castering: Uint8Array } }).gear.castering[2];

describe('PA-18-150 tail-dragger ground handling', () => {
  it('sits in the three-point attitude (11 ± 1.5°) after a ground spawn, without creep or jitter, engine off and idling', () => {
    for (const running of [false, true]) for (const load of [GROSS, SOLO]) {
      const env = makeEnv();
      const f = cub(load);
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 1.2, speedMs: 0, onGround: true, engineRunning: running }, env);
      const s = f.state;
      expect(s.euler[1] / D2R).toBeGreaterThan(9.5);
      expect(s.euler[1] / D2R).toBeLessThan(12.5);
      expect(s.gear.every((g) => g.onGround)).toBe(true);
      // the tail wheel carries ≈ 10–15 % of the weight
      const tailShare = s.gear[2].normalForceN / (s.totalMassKg * 9.80665);
      expect(tailShare).toBeGreaterThan(0.08);
      expect(tailShare).toBeLessThan(0.18);
      const u = defaultControlInputs();
      u.parkingBrake = true; u.magnetos = running ? 3 : 0; u.mixture = running ? 1 : 0;
      const n0 = s.posNED[0], e0 = s.posNED[1], th0 = s.euler[1], hdg0 = s.headingTrueRad;
      let vMax = 0, qMax = 0;
      run(f, env, u, 60, () => { vMax = Math.max(vMax, Math.hypot(...f.state.velBody)); qMax = Math.max(qMax, Math.abs(f.state.rates[1])); });
      expect(vMax).toBeLessThan(0.01);
      expect(qMax).toBeLessThan(0.002);
      expect(Math.hypot(s.posNED[0] - n0, s.posNED[1] - e0)).toBeLessThan(0.02);
      expect(Math.abs(s.euler[1] - th0)).toBeLessThan(0.1 * D2R);
      expect(Math.abs(wrap(s.headingTrueRad - hdg0))).toBeLessThan(0.1 * D2R);
      expect(s.crashed).toBe(false);
      if (running) expect(s.engine.rpm).toBeGreaterThan(500);
    }
  });

  it('lifts its tail under forward stick by 25–35 KIAS on a full-power take-off roll (1,750 lb)', () => {
    const env = makeEnv();
    for (const stick of [-0.4, -0.6]) {
      const f = cub(GROSS);
      const u = onRunway(f, env);
      u.throttle = 1; u.flapsIndex = 1;
      let tailUp = NaN;
      run(f, env, u, 12, () => {
        rudderOnRunway(f, u, 0.15);
        u.pitch = kias(f) > 5 ? stick : 0;
        if (Number.isNaN(tailUp) && mainsOnGround(f) && !f.state.gear[2].onGround) tailUp = kias(f);
      });
      expect(tailUp, `stick ${stick}`).toBeGreaterThan(25);
      expect(tailUp, `stick ${stick}`).toBeLessThan(35);
    }
  });

  /** Short-field take-off: full flaps, full throttle, stick a little aft (three-point attitude), fly off when ready. */
  function takeoff(load: number[]): { rollFt: number; maxHdgDeg: number; crashed: boolean } {
    const env = makeEnv();
    const f = cub(load);
    const u = onRunway(f, env);
    u.throttle = 1; u.flapsIndex = 2;
    f.snapControls(u);
    const p0 = [f.state.posNED[0], f.state.posNED[1]];
    let roll = NaN, lastD = 0, air = 0, maxE = 0;
    run(f, env, u, 20, () => {
      const s = f.state;
      const d = Math.hypot(s.posNED[0] - p0[0], s.posNED[1] - p0[1]);
      if (mainsOnGround(f)) {
        rudderOnRunway(f, u, 0.15);
        u.pitch = 0.3;
        maxE = Math.max(maxE, Math.abs(wrap(s.headingTrueRad)));
        air = 0; lastD = d;
      } else {
        // initial climb: hold the attitude, wings level, and keep the right rudder in
        air += DT;
        if (air > 1 && Number.isNaN(roll)) roll = lastD;
        u.pitch = clamp(1.5 * (0.14 - s.euler[1]) - 0.4 * s.rates[1]);
        rudderOnRunway(f, u, 0.15);
        u.roll = clamp(-1.5 * s.euler[0] - 0.3 * s.rates[0]);
      }
    });
    return { rollFt: roll / 0.3048, maxHdgDeg: maxE / D2R, crashed: f.state.crashed };
  }
  it('take-off run with flaps: ≈ 200 ft (handbook) — 150–330 ft at 1,750 lb, 110–260 ft solo — on runway heading', () => {
    const g = takeoff(GROSS), s = takeoff(SOLO);
    for (const r of [g, s]) { expect(r.crashed).toBe(false); expect(r.maxHdgDeg).toBeLessThan(5); }
    expect(g.rollFt).toBeGreaterThan(150);
    expect(g.rollFt).toBeLessThan(330);
    expect(s.rollFt).toBeGreaterThan(110);
    expect(s.rollFt).toBeLessThan(260);
  });

  it('landing roll ≈ 350 ft ± 25 % from a three-point touchdown with full flaps and heel brakes; it does not nose over', () => {
    const env = makeEnv();
    const f = cub(GROSS);
    const u = touchdownArrival(f, env, { sinkFpm: 150, pitchDeg: 10.5, flapsIndex: 2 });
    const stick0 = u.pitch;
    let tTouch = NaN, t = 0, p0 = [0, 0], dist = 0, minPitch = 99;
    run(f, env, u, 25, () => {
      t += DT;
      const s = f.state;
      if (Number.isNaN(tTouch) && s.onGround) { tTouch = t; p0 = [s.posNED[0], s.posNED[1]]; }
      if (Number.isNaN(tTouch)) return;
      u.pitch = Math.min(1, stick0 + (t - tTouch));
      if (t - tTouch > 1) u.brakeLeft = u.brakeRight = 1;
      rudderOnRunway(f, u);
      dist = Math.hypot(s.posNED[0] - p0[0], s.posNED[1] - p0[1]);
      minPitch = Math.min(minPitch, s.euler[1] / D2R);
    });
    expect(f.state.crashed).toBe(false);
    expect(f.state.groundSpeedMs).toBeLessThan(0.1);
    expect(minPitch).toBeGreaterThan(7); // the tail stays down under full braking
    expect(dist / 0.3048).toBeGreaterThan(262);
    expect(dist / 0.3048).toBeLessThan(438);
  });

  it('taxi turns on the tail wheel (right pedal turns right, wheel steered left), pivots on a brake with the wheel unlocked, relocks when straight', () => {
    const env = makeEnv();
    for (const side of [1, -1]) {
      const f = cub(SOLO);
      const u = onRunway(f, env);
      let t = 0;
      run(f, env, u, 25, () => {
        t += DT;
        const s = f.state;
        u.throttle = clamp(0.25 + 0.1 * (3 - s.groundSpeedMs), 0, 1); // taxi at ≈ 10 kt
        if (t < 12) rudderOnRunway(f, u); else u.yaw = side;
      });
      const s = f.state;
      const radius = s.groundSpeedMs / Math.abs(s.rates[2]);
      expect(Math.sign(s.rates[2])).toBe(side);
      expect(Math.sign(s.gear[2].steerRad)).toBe(-side); // a wheel behind the CG steers the other way
      expect(radius).toBeGreaterThan(8);
      expect(radius).toBeLessThan(20);
      expect(castering(f)).toBe(0);
      // slow to a walk, then pivot: inside brake, full pedal and a little power until 80° round, then both brakes to stop the swing
      run(f, env, u, 3, () => { u.yaw = 0; u.throttle = 0; u.brakeLeft = u.brakeRight = f.state.groundSpeedMs > 0.5 ? 0.6 : 0; });
      const h0 = f.state.headingTrueRad;
      let phase = 0, unlocked = false, rMax = 0, rMin = Infinity, tp = 0;
      run(f, env, u, 8, () => {
        const st = f.state;
        tp += DT;
        if (phase === 0 && Math.abs(wrap(st.headingTrueRad - h0)) > 80 * D2R) phase = 1;
        if (phase === 1 && Math.abs(st.rates[2]) < 3 * D2R) phase = 2;
        u.yaw = phase === 0 ? side : 0; u.throttle = phase === 0 ? 0.3 : 0;
        u.brakeRight = phase > 0 || side > 0 ? 1 : 0; u.brakeLeft = phase > 0 || side < 0 ? 1 : 0;
        unlocked = unlocked || castering(f) === 1;
        if (phase === 0 && tp > 0.5) { rMax = Math.max(rMax, Math.abs(st.rates[2])); rMin = Math.min(rMin, st.groundSpeedMs / Math.max(Math.abs(st.rates[2]), 1e-3)); }
      });
      expect(unlocked).toBe(true);
      expect(phase).toBe(2);
      expect(rMax).toBeGreaterThan(15 * D2R);
      expect(rMin).toBeLessThan(7); // pivots near the braked wheel (half track 0.92 m), not on the 8–20 m steering radius
      // roll forward, checking any swing with the opposite brake and rudder, until the wheel locks; then steer straight
      const hdg = f.state.headingTrueRad;
      let relocked = NaN, t2 = 0;
      run(f, env, u, 10, () => {
        const st = f.state, r = st.rates[2];
        t2 += DT;
        u.throttle = clamp(0.25 + 0.1 * (3 - st.groundSpeedMs), 0, 1);
        if (Number.isNaN(relocked) && castering(f) === 0) relocked = t2;
        if (Number.isNaN(relocked)) {
          u.yaw = clamp(-3 * r);
          u.brakeRight = r < -0.03 ? clamp(-4 * r, 0, 1) : 0;
          u.brakeLeft = r > 0.03 ? clamp(4 * r, 0, 1) : 0;
        } else {
          u.brakeLeft = u.brakeRight = 0;
          u.yaw = clamp(3 * wrap(hdg - st.headingTrueRad) - 1.0 * r);
        }
      });
      expect(relocked).toBeLessThan(6);
      expect(castering(f)).toBe(0);
      expect(Math.abs(f.state.rates[2])).toBeLessThan(2 * D2R);
      expect(f.state.crashed).toBe(false);
    }
  });

  /**
   * Wheel landing (half flaps, 100 fpm, tail flying with a touch of forward stick, idle), then a 15 kt
   * gust from the right half a second after touchdown (1 s ramp, 3 s hold, 1 s ramp). Both pilots hold
   * the wings level into the wind with aileron; only one works the rudder.
   */
  function gustOnRollout(load: number[], withRudder: boolean): { maxHdgDeg: number; crashed: boolean } {
    const gust = { e: 0 };
    const base = makeEnv();
    const env: Environment = { ...base, windNED: (_n, _e, _d, out) => { out[0] = 0; out[1] = gust.e; out[2] = 0; return out; } };
    const f = cub(load);
    const u = touchdownArrival(f, env, { sinkFpm: 100, pitchDeg: 3, flapsIndex: 1 });
    const stick0 = u.pitch;
    let t = 0, tTouch = NaN, maxE = 0;
    run(f, env, u, 12, () => {
      t += DT;
      const s = f.state;
      if (Number.isNaN(tTouch) && s.onGround) tTouch = t;
      if (Number.isNaN(tTouch)) return;
      const tg = t - tTouch - 0.5;
      const g = tg < 0 ? 0 : tg < 1 ? tg : tg < 4 ? 1 : tg < 5 ? 5 - tg : 0;
      gust.e = -15 * KT * g;
      u.pitch = stick0 - 0.1;
      u.roll = clamp(0.75 * g - 2 * s.euler[0] - 0.5 * s.rates[0]);
      if (withRudder) u.yaw = clamp(4 * wrap(-s.headingTrueRad) - 1.0 * s.rates[2]);
      maxE = Math.max(maxE, Math.abs(wrap(s.headingTrueRad)));
    });
    return { maxHdgDeg: maxE / D2R, crashed: f.state.crashed };
  }
  it('ground-loops in a crosswind gust when the pilot neglects the rudder; normal rudder (and aileron into the wind) keeps it straight', () => {
    for (const load of [GROSS, SOLO]) {
      const free = gustOnRollout(load, false);
      expect(free.maxHdgDeg).toBeGreaterThan(45);
      const flown = gustOnRollout(load, true);
      expect(flown.crashed).toBe(false);
      expect(flown.maxHdgDeg).toBeLessThan(10);
    }
  });

  it('swerves left on a full-power take-off roll with the feet off the rudder (torque, P-factor, slipstream, gyroscopic precession)', () => {
    const env = makeEnv();
    for (const load of [GROSS, SOLO]) {
      const f = cub(load);
      const u = onRunway(f, env);
      u.throttle = 1; u.flapsIndex = 1;
      let worst = 0;
      run(f, env, u, 8, () => { if (mainsOnGround(f)) worst = Math.min(worst, wrap(f.state.headingTrueRad)); });
      expect(worst / D2R).toBeLessThan(-15);
    }
  });

  it('a normal 300 fpm landing (three-point, tail-low or wheel landing; 1,750 lb and solo) breaks nothing; a wheel landing bounces a little', () => {
    const env = makeEnv();
    for (const load of [GROSS, SOLO]) for (const [pitchDeg, kind] of [[10.5, '3-point'], [8, 'tail-low'], [3, 'wheel']] as const) {
      const f = cub(load);
      const W = f.state.totalMassKg * 9.80665;
      const u = touchdownArrival(f, env, { sinkFpm: 300, pitchDeg, flapsIndex: 2 });
      const stick0 = u.pitch;
      let tTouch = NaN, t = 0, nz = 0, wheel = 0, bounce = 0;
      run(f, env, u, 6, () => {
        t += DT;
        const s = f.state;
        if (Number.isNaN(tTouch) && s.onGround) tTouch = t;
        if (Number.isNaN(tTouch)) return;
        // after touchdown ease the stick back (a wheel landing holds it a touch forward instead)
        u.pitch = kind === 'wheel' ? stick0 - 0.05 : Math.min(1, stick0 + Math.max(0, t - tTouch - 0.5) * 0.4);
        nz = Math.max(nz, s.loadFactor[2]);
        wheel = Math.max(wheel, s.gear[0].normalForceN / W, s.gear[1].normalForceN / W);
        if (!s.onGround) bounce = Math.max(bounce, s.altitudeAglM);
      });
      const tag = `${kind} ${load === GROSS ? 'gross' : 'solo'}`;
      expect(f.state.crashed, tag).toBe(false);
      expect(nz, tag).toBeLessThan(3);
      expect(wheel, tag).toBeLessThan(1.5);
      expect(bounce, tag).toBeLessThan(1);
      if (kind === 'wheel' && load === GROSS) expect(bounce, tag).toBeGreaterThan(0.1);
    }
  });
});

describe('PA-18-150 systems and state', () => {
  it('14 V electrical system: ≈ 12.3 V on the battery with LOW VOLTS lit, starts the O-320, then 14.2 V regulated; the C172 keeps its 28 V system', () => {
    const env = makeEnv();
    const f = cub(SOLO);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: false }, env);
    const u = defaultControlInputs();
    Object.assign(u, { masterBattery: true, masterAlternator: true, avionicsMaster: true, magnetos: 3, mixture: 1, throttle: 0.1, parkingBrake: true });
    run(f, env, u, 1);
    const e = f.state.electrical!;
    expect(e.nominalVolts).toBe(14);
    expect(e.lowVoltsThresholdV).toBe(12.5);
    expect(e.busVolts).toBeGreaterThan(11.8);
    expect(e.busVolts).toBeLessThan(12.6);
    expect(e.lowVoltage).toBe(true);
    expect(e.batteryAmps).toBeLessThan(0);
    let t = 0;
    run(f, env, u, 10, () => { t += DT; u.starter = t < 4 && !f.state.engine.running; u.throttle = f.state.engine.running ? 0.2 : 0.1; });
    expect(f.state.engine.running).toBe(true);
    expect(f.state.engine.rpm).toBeGreaterThan(1000);
    expect(e.busVolts).toBeCloseTo(14.2, 1);
    expect(e.lowVoltage).toBe(false);
    expect(e.alternatorAmps).toBeGreaterThan(0);
    // a flat battery does not crank it
    const g = cub(SOLO);
    g.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: false }, env);
    g.electrical.setCharge(0.03);
    t = 0;
    run(g, env, u, 8, () => { t += DT; u.starter = t < 4; });
    expect(g.state.engine.running).toBe(false);
    const c = new Fdm(C172S);
    expect(c.state.electrical!.nominalVolts).toBe(28);
    expect(c.state.electrical!.lowVoltsThresholdV).toBe(24.5);
  });

  it('indicates CAS (no published ASI calibration) and gives no stall warning in normal flight', () => {
    const env = makeEnv();
    const f = cub(GROSS);
    airborne(f, env, 600, 70);
    expect(f.state.aero.ias).toBeCloseTo(f.state.aero.cas, 6);
    expect(f.state.aero.stallWarning).toBe(false);
  });

  it('save / restore is bit-exact while the tail wheel castors (swivel state is serialised)', () => {
    const env = makeEnv();
    const a = cub(SOLO, 3);
    const u = onRunway(a, env);
    u.throttle = 0.35; u.yaw = 1;
    // taxi into a right pivot on the right brake until the tail wheel has broken out
    for (let i = 0; i < 1200 && castering(a) === 0; i++) { u.brakeRight = i > 360 ? 1 : 0; a.step(DT, u, env); }
    run(a, env, u, 0.5);
    expect(castering(a)).toBe(1);
    const snap = a.serialize();
    const b = cub(SOLO, 3);
    onRunway(b, env);
    b.deserialize(snap);
    expect(castering(b)).toBe(1);
    run(a, env, u, 3);
    run(b, env, u, 3);
    expect(b.serialize()).toBe(a.serialize());
    expect(b.state.gear[2].steerRad).toBe(a.state.gear[2].steerRad);
  });
});
