import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { FPM, HP, KT, RPM_TO_RADS } from '../core/units';
import { DT, KSFO, SpeedHold, airborne, frameKSFO, kcas, levelWings, makeEnv, makeFdm, run } from './testing';
import { atmosphere } from './atmosphere';
import { PistonPropulsion } from './propulsion';
import { C172S } from './aircraft/c172';

const MTOW = 1156;

describe('engine and propeller', () => {
  const p = new PistonPropulsion(C172S.propulsion.engine as never, C172S.propulsion.propeller!);
  const sl = atmosphere(0);
  const air = (u: number) => ({ rho: sl.densityKgM3, pAmb: sl.pressurePa, tAmb: sl.temperatureK, u, v: 0, w: 0 });
  const full = { throttle: 1, mixture: 1, magnetos: 3 as const, starter: false, fuelAvailable: true };

  it('static thrust at ~2350 rpm is 2500–2900 N', () => {
    const o = p.evaluate(2350 * RPM_TO_RADS, 28.8 * 3386.39, air(0), full, [2, 0, 0.25], (globalThis as never as { o: never }).o ?? ({ F: new Float64Array(3), M: new Float64Array(3) } as never));
    expect(o.thrustN).toBeGreaterThan(2500);
    expect(o.thrustN).toBeLessThan(2900);
  });
  it('full-throttle sea-level power at 2700 rpm is 170–195 hp; static rpm 2200–2400; idle 550–750', () => {
    const eq = p.equilibrium(air(62), full, 2400 * RPM_TO_RADS, 90000);
    const o = p.evaluate(eq.omega, eq.map, air(62), full, [2, 0, 0.25], { F: new Float64Array(3), M: new Float64Array(3) } as never);
    const rpm = eq.omega / RPM_TO_RADS;
    const hpAt2700 = (o.brakePowerW / HP) * (2700 / rpm);
    expect(hpAt2700).toBeGreaterThan(170);
    expect(hpAt2700).toBeLessThan(195);
    const st = p.equilibrium(air(0), full, 2000 * RPM_TO_RADS, 90000).omega / RPM_TO_RADS;
    expect(st).toBeGreaterThan(2200);
    expect(st).toBeLessThan(2400);
    const idle = p.equilibrium(air(0), { ...full, throttle: 0 }, 900 * RPM_TO_RADS, 40000).omega / RPM_TO_RADS;
    expect(idle).toBeGreaterThan(550);
    expect(idle).toBeLessThan(750);
  });
});

describe('Fdm — trim and stability', () => {
  it('trims at 100 KCAS / 1000 m and holds altitude and speed hands-off for 60 s', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1000, 100);
    const tr = f.trimResult!;
    expect(tr.alphaRad * 57.3).toBeGreaterThan(0.5);
    expect(tr.alphaRad * 57.3).toBeLessThan(6);
    expect(tr.elevatorRad * 57.3).toBeGreaterThan(-8);
    expect(tr.elevatorRad * 57.3).toBeLessThan(5);
    expect(tr.throttle).toBeGreaterThan(0.35);
    expect(tr.throttle).toBeLessThan(0.9);
    const h0 = f.state.altitudeMslM, v0 = kcas(f);
    let hMax = 0, vMax = 0;
    run(f, env, u, 60, () => {
      levelWings(f, u);
      hMax = Math.max(hMax, Math.abs(f.state.altitudeMslM - h0));
      vMax = Math.max(vMax, Math.abs(kcas(f) - v0));
    });
    expect(hMax).toBeLessThan(40);
    expect(vMax).toBeLessThan(5);
    expect(f.state.crashed).toBe(false);
  });

  it('control signs: stick back → q>0, nz>1.1; roll right → p>0; right rudder → r>0, β<0', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u0 = airborne(f, env, 1500, 100);
    const snap = f.serialize();
    const pulse = (k: 'pitch' | 'roll' | 'yaw', v: number) => {
      f.deserialize(snap);
      const u = { ...u0, [k]: (u0[k] as number) + v };
      let peak = { q: 0, nz: 0, p: 0, r: 0, beta: 0 };
      run(f, env, u, 1, () => {
        const s = f.state;
        peak = { q: Math.max(peak.q, s.rates[1]), nz: Math.max(peak.nz, s.loadFactor[2]), p: Math.max(peak.p, s.rates[0]), r: Math.max(peak.r, s.rates[2]), beta: Math.min(peak.beta, s.aero.beta) };
      });
      return peak;
    };
    const pp = pulse('pitch', 0.5);
    expect(pp.q).toBeGreaterThan(0.05);
    expect(pp.nz).toBeGreaterThan(1.1);
    expect(pulse('roll', 0.5).p).toBeGreaterThan(0.2);
    const y = pulse('yaw', 0.5);
    expect(y.r).toBeGreaterThan(0.02);
    expect(y.beta).toBeLessThan(-0.01);
  });

  it('power and slow flight: left-turning tendencies (torque, P-factor, slipstream) at full power 60 KIAS', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1500, 62);
    u.throttle = 1;
    let pMin = 0, rMin = 0;
    run(f, env, u, 2, () => { pMin = Math.min(pMin, f.state.rates[0]); rMin = Math.min(rMin, f.state.rates[2]); });
    expect(pMin).toBeLessThan(0);
    expect(rMin).toBeLessThan(0);
  });
});

describe('Fdm — performance vs POH (docs/research/02 §10)', () => {
  /** Flight-test stall entry: power idle, hold altitude with the elevator until the wing stalls (≈1 g, ≈1 kt/s). */
  function stallKcas(flapsIndex: number): number {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1500, 75);
    u.throttle = 0;
    u.flapsIndex = flapsIndex;
    const h0 = f.state.altitudeMslM;
    let stick = u.pitch, stall = NaN;
    run(f, env, u, 120, () => {
      const s = f.state;
      levelWings(f, u);
      stick = Math.max(-1, Math.min(1, stick + (0.02 * (h0 - s.altitudeMslM) - 0.08 * s.verticalSpeedMs) * DT));
      u.pitch = Math.max(-1, Math.min(1, stick - 0.35 * s.rates[1]));
      if (Number.isNaN(stall) && (s.aero.alpha > 0.28 || s.aero.stalled)) stall = kcas(f);
    });
    return stall;
  }
  it('stall speed flaps up 48–58 KCAS (POH 53)', () => {
    const v = stallKcas(0);
    expect(v).toBeGreaterThan(48);
    expect(v).toBeLessThan(58);
  });
  it('stall speed flaps 30 42–53 KCAS (POH 48)', () => {
    const v = stallKcas(3);
    expect(v).toBeGreaterThan(42);
    expect(v).toBeLessThan(53);
  });

  it('climb at Vy full power, sea level: 550–950 fpm (POH 730)', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 100, 74);
    u.throttle = 1;
    const hold = new SpeedHold(f, 74, u.pitch);
    run(f, env, u, 10, () => { levelWings(f, u); hold.update(u, DT); });
    const h0 = f.state.altitudeMslM;
    run(f, env, u, 60, () => { levelWings(f, u); hold.update(u, DT); });
    const fpm = (f.state.altitudeMslM - h0) / 60 / FPM;
    expect(fpm).toBeGreaterThan(550);
    expect(fpm).toBeLessThan(950);
  });

  it('cruise at 8000 ft, full throttle, leaned: 112–135 KTAS and 2450–2750 rpm (POH 124 KTAS at 75 %)', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 2438, 95);
    u.throttle = 1;
    u.mixture = f.bestPowerMixture();
    // hold altitude with the elevator and let speed build
    run(f, env, u, 120, () => {
      levelWings(f, u);
      const s = f.state;
      const thetaCmd = 0.0 + 0.004 * (2438 - s.altitudeMslM) - 0.02 * s.verticalSpeedMs;
      u.pitch = Math.max(-1, Math.min(1, u.pitch + (1.5 * (thetaCmd - s.euler[1]) - 0.4 * s.rates[1]) * DT * 2));
    });
    const ktas = f.state.aero.tas / KT;
    expect(Math.abs(f.state.altitudeMslM - 2438)).toBeLessThan(60);
    expect(ktas).toBeGreaterThan(112);
    expect(ktas).toBeLessThan(135);
    expect(f.state.engine.rpm).toBeGreaterThan(2450);
    expect(f.state.engine.rpm).toBeLessThan(2750);
  });

  it('best glide at 68 KIAS, engine off: L/D 8–11 (POH ≈ 9)', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1500, 68, 0, -6 * Math.PI / 180);
    u.throttle = 0;
    u.mixture = 0;
    const hold = new SpeedHold(f, 66, u.pitch);
    run(f, env, u, 20, () => { levelWings(f, u); hold.update(u, DT); });
    const h0 = f.state.altitudeMslM, n0 = f.state.posNED[0], e0 = f.state.posNED[1];
    run(f, env, u, 60, () => { levelWings(f, u); hold.update(u, DT); });
    const dist = Math.hypot(f.state.posNED[0] - n0, f.state.posNED[1] - e0);
    const ld = dist / (h0 - f.state.altitudeMslM);
    expect(ld).toBeGreaterThan(8);
    expect(ld).toBeLessThan(11);
  });
});

describe('Fdm — ground handling', () => {
  it('parked with the brake set: no creep or jitter for 60 s, engine off and idling', () => {
    for (const running of [false, true]) {
      const env = makeEnv();
      const f = makeFdm(MTOW);
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 298 * Math.PI / 180, speedMs: 0, onGround: true, engineRunning: running }, env);
      const u = defaultControlInputs();
      u.parkingBrake = true;
      u.magnetos = running ? 3 : 0;
      u.mixture = running ? 1 : 0;
      const n0 = f.state.posNED[0], e0 = f.state.posNED[1], th0 = f.state.euler[1];
      run(f, env, u, 60);
      const s = f.state;
      expect(Math.hypot(...s.velBody)).toBeLessThan(0.01);
      expect(Math.hypot(s.posNED[0] - n0, s.posNED[1] - e0)).toBeLessThan(0.05);
      expect(Math.abs(s.euler[1] - th0)).toBeLessThan(3 / 57.3);
      expect(s.gear.every((g) => g.onGround)).toBe(true);
      expect(s.crashed).toBe(false);
      if (running) { expect(s.engine.running).toBe(true); expect(s.engine.rpm).toBeGreaterThan(500); }
    }
  });

  it('takeoff: lifts off within 700 m / 40 s, 50 ft within 1500 m, keeps heading', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const hdg = 298 * Math.PI / 180;
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: hdg, speedMs: 0, onGround: true, engineRunning: true }, env);
    const u = defaultControlInputs();
    u.parkingBrake = false; u.throttle = 1; u.flapsIndex = 1; u.magnetos = 3; u.mixture = 1;
    const p0 = [f.state.posNED[0], f.state.posNED[1]];
    let liftoffDist = NaN, liftoffT = NaN, fiftyDist = NaN, maxHdgErr = 0, t = 0;
    run(f, env, u, 60, () => {
      t += DT;
      const s = f.state;
      let e = hdg - s.headingTrueRad;
      while (e > Math.PI) e -= 2 * Math.PI;
      while (e < -Math.PI) e += 2 * Math.PI;
      maxHdgErr = Math.max(maxHdgErr, Math.abs(e));
      u.yaw = Math.max(-1, Math.min(1, 3 * e - 0.8 * s.rates[2]));
      const kias = s.aero.ias / KT;
      if (s.onGround) u.pitch = kias >= 55 ? 0.4 : 0;
      else { u.pitch = Math.max(-1, Math.min(1, 1.8 * (0.14 - s.euler[1]) - 0.5 * s.rates[1])); levelWings(f, u, hdg); u.yaw = Math.max(-1, Math.min(1, u.yaw + 3 * e)); }
      const d = Math.hypot(s.posNED[0] - p0[0], s.posNED[1] - p0[1]);
      if (Number.isNaN(liftoffDist) && !s.onGround && s.altitudeAglM > 0.3) { liftoffDist = d; liftoffT = t; }
      if (Number.isNaN(fiftyDist) && s.altitudeAglM > 15.24) fiftyDist = d;
    });
    expect(f.state.crashed).toBe(false);
    expect(liftoffDist).toBeLessThan(700);
    expect(liftoffT).toBeLessThan(40);
    expect(fiftyDist).toBeLessThan(1500);
    expect(maxHdgErr * 57.3).toBeLessThan(15);
  });
});

describe('Fdm — numerics', () => {
  it('robust: 120 s of seeded random inputs from extreme attitudes never produces NaN', () => {
    const env = makeEnv({ turbulence: { w20Kt: 30, intensity: 4, seed: 7 } });
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const [roll, pitch] of [[Math.PI, 0], [0, 1.4], [0, -1.4], [2, 0.5]]) {
      const f = makeFdm(MTOW, 3);
      const u = airborne(f, env, 3000, 95);
      const q = (f as unknown as { y: Float64Array }).y;
      // overwrite attitude
      const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      q[6] = cr * cp; q[7] = sr * cp; q[8] = cr * sp; q[9] = -sr * sp;
      run(f, env, u, 30, () => {
        u.pitch = rnd() * 2 - 1; u.roll = rnd() * 2 - 1; u.yaw = rnd() * 2 - 1; u.throttle = rnd(); u.flapsIndex = Math.floor(rnd() * 4);
      });
      const s = f.state;
      for (const v of [...s.posNED, ...s.velBody, ...s.rates, ...s.qNB, s.aero.alpha, s.engine.rpm]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(Math.hypot(...s.qNB) - 1)).toBeLessThan(1e-6);
    }
  });

  it('deterministic with turbulence: identical runs are bit-identical', () => {
    const env = makeEnv({ turbulence: { w20Kt: 30, intensity: 4, seed: 5 } });
    const go = () => { const f = makeFdm(MTOW, 42); const u = airborne(f, env, 600, 90); run(f, env, u, 30); return f.serialize(); };
    expect(go()).toBe(go());
  });

  it('serialize → deserialize → step matches the uninterrupted run', () => {
    const env = makeEnv({ turbulence: { w20Kt: 20, intensity: 3, seed: 9 } });
    const a = makeFdm(MTOW, 11);
    const u = airborne(a, env, 800, 95);
    run(a, env, u, 5);
    const snap = a.serialize();
    const b = makeFdm(MTOW, 11);
    b.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 800 }, headingRad: 0, speedMs: 50, onGround: false, engineRunning: true }, env);
    b.deserialize(snap);
    run(a, env, u, 5);
    run(b, env, u, 5);
    expect(b.serialize()).toBe(a.serialize());
  });

  it('rebase preserves airspeed, altitude and attitude', async () => {
    const { makeRebase } = await import('../world/rebase');
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1200, 100, 45);
    run(f, env, u, 2);
    const before = { tas: f.state.aero.tas, alt: f.state.altitudeMslM, pitch: f.state.euler[1], roll: f.state.euler[0], lat: f.state.geo.lat, lon: f.state.geo.lon };
    const pos = f.state.posNED;
    const far: [number, number, number] = [pos[0] + 20000, pos[1] + 5000, pos[2]];
    const t = makeRebase(frameKSFO, far);
    f.rebase(t.rotation, t.translationNED);
    const env2 = { ...env, frame: t.newFrame.info, groundHeight: (n: number, e: number) => env.groundHeight(n, e) };
    run(f, env2, u, 0.05);
    expect(Math.abs(f.state.aero.tas - before.tas)).toBeLessThan(0.5);
    expect(Math.abs(f.state.altitudeMslM - before.alt)).toBeLessThan(2);
    expect(Math.abs(f.state.geo.lat - before.lat)).toBeLessThan(1e-4);
    expect(Math.abs(f.state.geo.lon - before.lon)).toBeLessThan(1e-4);
    expect(Math.abs(f.state.euler[1] - before.pitch)).toBeLessThan(0.01);
  });

  it('performance: 12 000 steps in < 5 s', () => {
    const env = makeEnv({ turbulence: { w20Kt: 15, intensity: 3, seed: 1 } });
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1000, 100);
    const t0 = performance.now();
    run(f, env, u, 100);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
  });
});

void frameKSFO;
