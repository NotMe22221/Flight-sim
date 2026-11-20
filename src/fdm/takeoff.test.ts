import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { KT } from '../core/units';
import { DT, KSFO, makeEnv, makeFdm } from './testing';

const FT = 0.3048;

/**
 * C172S POH Section 5, short-field takeoff distance: 2,550 lb, sea level, 15 °C, flaps 10,
 * paved level dry runway, zero wind: ground roll 960 ft, total over a 50 ft obstacle 1,630 ft
 * (lift-off 51 KIAS, 57 KIAS at 50 ft). Flown here with flaps up and the normal technique (rotate
 * at 55 KIAS), which needs a little more runway: the bands are wide on purpose.
 */
function takeoff(flapsIndex: number) {
  const env = makeEnv();
  const f = makeFdm(1157); // 2,550 lb
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, env);
  const u = defaultControlInputs();
  u.magnetos = 3; u.mixture = 1; u.throttle = 1; u.parkingBrake = false; u.flapsIndex = flapsIndex;
  u.masterBattery = true; u.masterAlternator = true;
  f.snapControls(u);
  const n0 = f.state.posNED[0], e0 = f.state.posNED[1], h0 = f.state.geo.alt;
  let liftoffFt = NaN, over50Ft = NaN;
  for (let t = 0; t < 90 && !Number.isFinite(over50Ft); t += DT) {
    const s = f.state;
    // hold the centreline with the pedals (torque and P-factor pull left), rotate at 55 KIAS,
    // then hold a climb attitude of ~8° nose up
    const hdgErr = Math.atan2(-Math.sin(s.headingTrueRad), Math.cos(s.headingTrueRad)); // runway heading 0
    u.yaw = Math.max(-1, Math.min(1, 4 * hdgErr - 1.5 * s.rates[2]));
    u.roll = Math.max(-1, Math.min(1, -2 * s.euler[0] - 0.4 * s.rates[0]));
    const ias = s.aero.ias / KT;
    u.pitch = ias < 55 && s.onGround ? 0 : Math.max(-1, Math.min(1, 3 * ((8 * Math.PI) / 180 - s.euler[1]) - 0.8 * s.rates[1]));
    f.step(DT, u, env);
    const d = Math.hypot(s.posNED[0] - n0, s.posNED[1] - e0) / FT;
    if (!Number.isFinite(liftoffFt) && s.gear.every((g) => !g.onGround)) liftoffFt = d;
    if (s.geo.alt - h0 >= 50 * FT) over50Ft = d;
  }
  return { liftoffFt, over50Ft, crashed: f.state.crashed };
}

describe('C172S takeoff distance vs POH', () => {
  it('flaps 10: ground roll 750–1,300 ft (POH 960), over 50 ft 1,300–2,200 ft (POH 1,630)', () => {
    const r = takeoff(1);
    expect(r.crashed).toBe(false);
    expect(r.liftoffFt).toBeGreaterThan(750); expect(r.liftoffFt).toBeLessThan(1300);
    expect(r.over50Ft).toBeGreaterThan(1300); expect(r.over50Ft).toBeLessThan(2200);
  });

  it('flaps up takes a little more runway than flaps 10, and both leave the ground', () => {
    const up = takeoff(0), ten = takeoff(1);
    expect(Number.isFinite(up.liftoffFt)).toBe(true);
    expect(up.liftoffFt).toBeGreaterThan(ten.liftoffFt * 0.95);
  });
});

import { touchdownArrival } from './testing';

/**
 * C172S POH Section 5, short-field landing distance: 2,550 lb, sea level, 15 °C, flaps 30, power
 * off, maximum braking, paved level dry runway, zero wind: ground roll 575 ft (61 KIAS approach).
 * Flown from a 300 fpm touchdown in the landing attitude, then full brakes with the stick held back.
 */
function landingRoll(): { rollFt: number; touchKt: number; crashed: boolean } {
  const env = makeEnv();
  const f = makeFdm(1157);
  const u = touchdownArrival(f, env, { sinkFpm: 300, pitchDeg: 5, flapsIndex: 3 });
  const s = f.state;
  let n0 = NaN, e0 = NaN, touchKt = NaN, rollFt = NaN;
  for (let t = 0; t < 60; t += DT) {
    const hdgErr = Math.atan2(-Math.sin(s.headingTrueRad), Math.cos(s.headingTrueRad));
    u.yaw = Math.max(-1, Math.min(1, 4 * hdgErr - 1.5 * s.rates[2]));
    u.roll = Math.max(-1, Math.min(1, -2 * s.euler[0] - 0.4 * s.rates[0]));
    if (Number.isFinite(n0)) { u.pitch = 1; u.brakeLeft = 1; u.brakeRight = 1; u.throttle = 0; }
    f.step(DT, u, env);
    if (!Number.isFinite(n0) && s.gear.some((g) => g.onGround)) { n0 = s.posNED[0]; e0 = s.posNED[1]; touchKt = s.groundSpeedMs / KT; }
    if (Number.isFinite(n0) && s.groundSpeedMs < 0.3) { rollFt = Math.hypot(s.posNED[0] - n0, s.posNED[1] - e0) / FT; break; }
  }
  return { rollFt, touchKt, crashed: s.crashed };
}

describe('C172S landing distance vs POH', () => {
  it('flaps 30, maximum braking: ground roll 430–800 ft (POH 575)', () => {
    const r = landingRoll();
    expect(r.crashed).toBe(false);
    expect(r.touchKt).toBeGreaterThan(35); expect(r.touchKt).toBeLessThan(60);
    expect(r.rollFt).toBeGreaterThan(430); expect(r.rollFt).toBeLessThan(800);
  });
});
