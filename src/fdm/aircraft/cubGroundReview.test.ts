/**
 * Super Cub ground handling found in the real-app test flight (review): a tail wheel left swivelled
 * after a brake pivot must not act as a skid, and ordinary S-turns on the pedals (the way a Cub is
 * taxied to see past the nose) must not unlock the tail wheel.
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs, type Environment } from '../../core/types';
import { KT } from '../../core/units';
import { Fdm } from '../fdm';
import { DT, KSFO, makeEnv, run } from '../testing';
import { PA18_150 } from './cub';

const D2R = Math.PI / 180;
const SOLO = [77, 0, 0];
const GROSS = [112, 111, 22.7];
const clamp = (x: number, lo = -1, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
type GearInternals = { gear: { castering: Uint8Array; casterAngle: Float64Array } };
const swivel = (f: Fdm): GearInternals['gear'] => (f as unknown as GearInternals).gear;

function cubOnRunway(load: number[], env: Environment): { f: Fdm; u: ControlInputs } {
  const f = new Fdm(PA18_150, { seed: 1 });
  f.setFuelFraction(1);
  f.setLoad(load);
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, env);
  const u = defaultControlInputs();
  u.parkingBrake = false; u.magnetos = 3; u.mixture = 1; u.pitch = 1;
  return { f, u };
}

describe('Super Cub tail wheel after a pivot (review)', () => {
  it('a tail wheel left swivelled across the aircraft does not skid: taxi power rolls the Cub away and the wheel relocks', () => {
    for (const surface of ['paved', 'grass'] as const) for (const load of [SOLO, GROSS]) for (const angleDeg of [80, -80, 45]) {
      const env = makeEnv({ surface });
      const { f, u } = cubOnRunway(load, env);
      run(f, env, u, 3); // settle in the three-point attitude
      // stopped after a brake pivot: the wheel unlocked and swivelled across the aircraft
      const g = swivel(f);
      g.castering[2] = 1; g.casterAngle[2] = angleDeg * D2R;
      u.throttle = 0.3; // ≈ 1,300 rpm, an ordinary breakaway power on pavement
      let moving = NaN, relocked = NaN, t = 0;
      run(f, env, u, 15, () => {
        t += DT;
        if (Number.isNaN(moving) && f.state.groundSpeedMs > 1.5 * KT) moving = t;
        if (Number.isNaN(relocked) && !g.castering[2]) relocked = t;
        u.throttle = f.state.groundSpeedMs > 6 * KT ? 0.12 : 0.3;
        // the pilot straightens it with rudder and a touch of brake (no heading to hold, just stop the swing)
        const r = f.state.rates[2];
        u.yaw = clamp(-3 * r);
        u.brakeRight = clamp(-12 * r, 0, 1);
        u.brakeLeft = clamp(12 * r, 0, 1);
      });
      const what = `${surface}, load ${load[0] + load[1]} kg, wheel at ${angleDeg}°`;
      expect(moving, what).toBeLessThan(6);
      expect(relocked, what).toBeLessThan(12);
    }
  });

  it('S-turns on the pedals at a walking pace keep the tail wheel locked and the turns symmetric', () => {
    const env = makeEnv();
    for (const load of [SOLO, GROSS]) {
      const { f, u } = cubOnRunway(load, env);
      run(f, env, u, 2);
      let t = 0, unlockedS = 0, maxRate = 0, minRate = 0;
      run(f, env, u, 40, () => {
        t += DT;
        // ≈ 6 kt on the throttle, pedal reversals every 4 s (half, then full pedal), stick back
        const gs = f.state.groundSpeedMs / KT;
        u.throttle = clamp(0.12 + 0.05 * (6 - gs), 0, 0.45);
        const full = t > 20 ? 1 : 0.5;
        u.yaw = t < 4 ? 0 : (Math.floor(t / 4) % 2 === 0 ? full : -full);
        if (swivel(f).castering[2]) unlockedS += DT;
        if (t > 4) { maxRate = Math.max(maxRate, f.state.rates[2]); minRate = Math.min(minRate, f.state.rates[2]); }
      });
      expect(f.state.crashed).toBe(false);
      expect(unlockedS, `load ${load[0] + load[1]} kg: seconds unlocked`).toBe(0);
      // the turn rates either way agree (no ground loop building up in one direction)
      expect(maxRate / D2R).toBeGreaterThan(8);
      expect(-minRate / D2R).toBeGreaterThan(8);
      expect(Math.max(maxRate, -minRate) / D2R).toBeLessThan(45);
    }
  });
});
