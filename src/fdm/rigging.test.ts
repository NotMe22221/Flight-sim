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
