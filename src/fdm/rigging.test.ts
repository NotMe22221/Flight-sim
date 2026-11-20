import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { KT } from '../core/units';
import { DT, KSFO, airborne, kcas, makeEnv, makeFdm, run } from './testing';

const DEG = Math.PI / 180;

describe('lateral rigging', () => {
  it('flies hands-off in 105 KCAS cruise: wings stay level and heading holds for a minute', () => {
    const env = makeEnv();
    const f = makeFdm(1043);
    const u = airborne(f, env, 914, 105, 90);
    u.roll = 0; u.yaw = 0;
    let maxBank = 0;
    run(f, env, u, 60, () => { maxBank = Math.max(maxBank, Math.abs(f.state.euler[0])); });
    // un-rigged, engine torque rolled the aircraft left at about 1°/s
    expect(maxBank / DEG).toBeLessThan(5);
    const dHdg = Math.abs(((f.state.headingTrueRad / DEG - 90 + 540) % 360) - 180);
    expect(dHdg).toBeLessThan(10);
    expect(Math.abs(f.state.aero.beta / DEG)).toBeLessThan(1);
  });

  it('still needs right rudder in a full-power climb (rigging is for cruise only)', () => {
    const env = makeEnv();
    const f = makeFdm(1043);
    const u = airborne(f, env, 300, 74);
    u.throttle = 1; u.roll = 0; u.yaw = 0;
    run(f, env, u, 8);
    // nose yaws left with power: wind from the left is negative sideslip
    expect(f.state.aero.beta).toBeLessThan(0);
  });
});

describe('snapControls', () => {
  it('moves flaps straight to the commanded detent so an air spawn trims with them set', () => {
    const env = makeEnv();
    const f = makeFdm(1043);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 600 }, headingRad: 0, speedMs: 70 * KT, onGround: false, engineRunning: true, gammaRad: -3 * DEG }, env);
    const u = defaultControlInputs();
    u.flapsIndex = 2; u.magnetos = 3; u.mixture = 1; u.parkingBrake = false;
    f.snapControls(u);
    expect(f.state.surfaces.flapDeg).toBe(20);
    expect(f.trim(65 * KT, -3 * DEG, env)).toBe(true);
    const tr = f.trimResult!;
    u.throttle = tr.throttle; u.pitchTrim = tr.pitchTrim; u.pitch = tr.pitchStick;
    const alt0 = f.state.altitudeMslM;
    run(f, env, u, 6);
    // trimmed on a 3° descent at 65 KCAS: ~ -1.7 m/s, no balloon from flaps arriving late
    const vs = (f.state.altitudeMslM - alt0) / 6;
    expect(vs).toBeLessThan(-0.5);
    expect(vs).toBeGreaterThan(-3.5);
    expect(Math.abs(kcas(f) - 65)).toBeLessThan(4);
    expect(f.state.surfaces.flapDeg).toBe(20);
    void DT;
  });
});

describe('numerical instability', () => {
  it('a non-finite step crashes the aircraft at its last finite state (no NaN pose escapes)', () => {
    const env = makeEnv();
    const f = makeFdm(1043);
    const u = airborne(f, env, 914, 100, 90);
    run(f, env, u, 1);
    const before = [...f.state.posNED];
    const bad = { ...env, windNED: (_n: number, _e: number, _d: number, out: [number, number, number]) => { out[0] = NaN; out[1] = 0; out[2] = 0; return out; } };
    f.step(DT, u, bad as typeof env);
    expect(f.state.crashed).toBe(true);
    for (const v of [...f.state.posNED, ...f.state.euler, f.state.aero.ias, f.state.geo.lat, f.state.geo.alt]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(f.state.posNED[0] - before[0], f.state.posNED[1] - before[1])).toBeLessThan(5);
  });
});

import { atmosphere } from './atmosphere';

describe('altitude away from the frame origin (earth curvature)', () => {
  it('the air the aircraft flies in matches its true altitude 11 km from the frame origin', () => {
    const env = makeEnv();
    const f = makeFdm(1043);
    // 0.1° north of the frame origin (≈ 11 km): the tangent plane is ~9.7 m above the sphere there
    f.reset({ geo: { lat: KSFO.lat + 0.1, lon: KSFO.lon, alt: 914 }, headingRad: 0, speedMs: 50, onGround: false, engineRunning: true }, env);
    const st = f.state;
    const ref = atmosphere(st.geo.alt, 0, 101325);
    expect(st.geo.alt).toBeCloseTo(914, 0);
    // within the pressure change of 1 m (≈ 12 Pa near sea level)
    expect(Math.abs(st.atmosphere.pressurePa - ref.pressurePa)).toBeLessThan(12);
  });
});
