// TEMPORARY exploration of the assists on the real Super Cub FDM (deleted before hand-off)
import { describe, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { clamp, wrapPi } from '../core/math';
import { DEG, FT, KT } from '../core/units';
import { Fdm } from '../fdm/fdm';
import { PA18_150 } from '../fdm/aircraft/cub';
import { KSFO, makeEnv } from '../fdm/testing';
import { FlightAssists, assistsConfigFor, stallAlphaFromConfig } from './assists';

const DT = 1 / 120;

function cub(): Fdm { const f = new Fdm(PA18_150, { seed: 1 }); f.setFuelFraction(1); return f; }

describe('probe', () => {
  it('take-off', () => {
    const variants: [string, object][] = [['default', {}], ['kp10kd4', { takeoff: { headingKp: 10, yawRateKd: 4 } }], ['kp12kd5', { takeoff: { headingKp: 12, yawRateKd: 5 } }], ['kp8kd5', { takeoff: { headingKp: 8, yawRateKd: 5 } }], ['kp8kd3auth1', { takeoff: { authority: 1 } }]];
    for (const [vn, vc] of variants) for (const assist of [true]) for (const xw of [0, 10]) {
      const env = makeEnv(xw ? { windNED: [0, -xw * KT, 0] } : {});
      const f = cub();
      const rwy = 280 * DEG;
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: rwy, speedMs: 0, onGround: true, engineRunning: true }, env);
      const pilot = defaultControlInputs();
      pilot.parkingBrake = true; pilot.throttle = 1; pilot.mixture = 1; pilot.magnetos = 3;
      const u = defaultControlInputs();
      const a = new FlightAssists(vc);
      const n0 = f.state.posNED[0], e0 = f.state.posNED[1];
      let maxHdg = 0, maxOff = 0, liftT = -1, crashed = false, minPitch = 99;
      for (let t = DT; t < 40; t += DT) {
        if (t > 3) pilot.parkingBrake = false;
        const s = f.state;
        const ias = s.aero.ias / KT, th = s.euler[1];
        const target = ias < 15 ? 11 * DEG : ias < 42 ? 2 * DEG : 8 * DEG;
        pilot.pitch = ias < 15 ? 0 : clamp(2.5 * (target - th) / (10 * DEG) - 0.4 * s.rates[1], -1, 1);
        Object.assign(u, pilot); u.lights = pilot.lights;
        if (assist) a.apply(u, s, DT, { autoRudder: true, assistedTakeoff: true });
        f.step(DT, u, env);
        if (f.state.crashed) { crashed = true; break; }
        if (!f.state.onGround) { if (liftT < 0) liftT = t; if (t - liftT > 2) break; continue; }
        maxHdg = Math.max(maxHdg, Math.abs(wrapPi(f.state.headingTrueRad - rwy)));
        const dN = f.state.posNED[0] - n0, dE = f.state.posNED[1] - e0;
        maxOff = Math.max(maxOff, Math.abs(-dN * Math.sin(rwy) + dE * Math.cos(rwy)));
        if (ias > 20) minPitch = Math.min(minPitch, th / DEG);
      }
      process.stderr.write("\n" + `${vn} assist=${assist} xw=${xw}: liftT=${liftT.toFixed(1)} maxHdg=${(maxHdg / DEG).toFixed(1)} maxOff=${maxOff.toFixed(1)} crashed=${crashed} minPitch=${minPitch.toFixed(1)}`);
    }
  });

  it('anti-stall + auto-rudder', () => {
    const env = makeEnv();
    process.stderr.write('\nstall alpha ' + (stallAlphaFromConfig(PA18_150) / DEG).toFixed(1));
    for (const assist of [false, true]) {
      const f = cub();
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 3000 * FT }, headingRad: 0, speedMs: 70 * KT, onGround: false, engineRunning: true, gammaRad: 0 }, env);
      f.trim(65 * KT, 0, env);
      const tr = f.trimResult!;
      const pilot = defaultControlInputs(); pilot.parkingBrake = false; pilot.throttle = tr.throttle; pilot.pitchTrim = tr.pitchTrim; pilot.magnetos = 3; pilot.mixture = 1;
      const a = new FlightAssists(assistsConfigFor(PA18_150));
      const u = defaultControlInputs();
      let stalled = false, maxA = 0;
      for (let t = 0; t < 25; t += DT) {
        pilot.pitch = 1; pilot.throttle = 0;
        Object.assign(u, pilot); u.lights = pilot.lights;
        if (assist) a.apply(u, f.state, DT, { autoRudder: false, assistedTakeoff: false, antiStall: true });
        f.step(DT, u, env);
        stalled ||= f.state.aero.stalled; maxA = Math.max(maxA, f.state.aero.alpha);
        if (assist && Math.round(t / DT) % 30 === 0 && t < 14) process.stderr.write(`\n t=${t.toFixed(2)} ias=${(f.state.aero.ias / KT).toFixed(1)} a=${(f.state.aero.alpha / DEG).toFixed(1)} adot=${(f.state.aero.alphaDot / DEG).toFixed(1)} u.pitch=${u.pitch.toFixed(2)} th=${(f.state.euler[1] / DEG).toFixed(1)} st=${f.state.aero.stalled} q=${(f.state.rates[1] / DEG).toFixed(1)} elev=${f.state.surfaces.elevatorDeg?.toFixed?.(1)}`);
      }
      process.stderr.write("\n" + `antistall assist=${assist}: stalled=${stalled} maxAlpha=${(maxA / DEG).toFixed(1)}`);
    }
    for (const assist of [false, true]) {
      const f = cub();
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 3000 * FT }, headingRad: 0, speedMs: 85 * KT, onGround: false, engineRunning: true, gammaRad: 0 }, env);
      f.trim(80 * KT, 0, env);
      const tr = f.trimResult!;
      const pilot = defaultControlInputs(); pilot.parkingBrake = false; pilot.throttle = tr.throttle; pilot.pitchTrim = tr.pitchTrim; pilot.pitch = tr.pitchStick; pilot.magnetos = 3; pilot.mixture = 1;
      const a = new FlightAssists();
      const u = defaultControlInputs();
      let peak = 0;
      for (let t = 0; t < 15; t += DT) {
        pilot.roll = t > 2 && t < 4 ? 0.3 : 0;
        Object.assign(u, pilot); u.lights = pilot.lights;
        if (assist) a.apply(u, f.state, DT, { autoRudder: true, assistedTakeoff: false });
        f.step(DT, u, env);
        if (t > 2 && t < 10) peak = Math.max(peak, Math.abs(f.state.aero.beta));
      }
      process.stderr.write("\n" + `autorudder assist=${assist}: peak=${(peak / DEG).toFixed(2)} final=${(Math.abs(f.state.aero.beta) / DEG).toFixed(2)} bank=${(f.state.euler[0] / DEG).toFixed(1)}`);
    }
  });
});
