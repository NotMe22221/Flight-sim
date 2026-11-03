import { it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { wrapPi } from '../core/math';
import { DEG, FT, KT } from '../core/units';
import { C172S } from '../fdm';
import { KSFO, airborne, makeEnv, makeFdm } from '../fdm/testing';
import { GfcAutopilot } from './Autopilot';
import { FlightAssists, stallAlphaFromConfig } from './assists';
import { FDM_DT, ZohSim } from './reviewHarness';
import { makeNavRadioState } from './testPlant';

it('yaw damper sign on the real FDM', () => {
  for (const mode of ['off', 'on', 'flipped'] as const) {
    const env = makeEnv();
    const f = makeFdm(1043);
    const pilot = airborne(f, env, 3000 * FT, 100);
    const ap = new GfcAutopilot(mode === 'flipped' ? { config: { gains: { ydGain: -0.8 } } } : {});
    const nav = { nav1: makeNavRadioState(), nav2: makeNavRadioState(), plan: null };
    if (mode !== 'off') ap.setYawDamper(true);
    const u = defaultControlInputs();
    let rms = 0, n = 0, peakBeta = 0;
    for (let t = 0; t < 14; t += FDM_DT * 2) {
      Object.assign(u, pilot); u.lights = pilot.lights;
      u.yaw = t > 1 && t < 1.5 ? 0.4 : t >= 1.5 && t < 2 ? -0.4 : 0;
      ap.update(FDM_DT * 2, f.state, nav);
      const o = ap.apply(u);
      f.step(FDM_DT, o, env); f.step(FDM_DT, o, env);
      if (t > 2.5) { rms += f.state.rates[2] ** 2; n++; peakBeta = Math.max(peakBeta, Math.abs(f.state.aero.beta)); }
    }
    console.log(`YD ${mode}: yaw-rate RMS after doublet ${(Math.sqrt(rms / n) / DEG).toFixed(3)} deg/s, peak beta ${(peakBeta / DEG).toFixed(2)}`);
  }
});

it('assisted take-off and auto-rudder vs frame rate (real FDM)', () => {
  for (const sub of [1, 2, 4, 8]) {
    for (const xw of [0, 10]) {
      const env = makeEnv(xw ? { windNED: [0, -xw * KT, 0] } : {});
      const f = makeFdm(1043);
      const rwy = 280 * DEG;
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: rwy, speedMs: 0, onGround: true, engineRunning: true }, env);
      const pilot = defaultControlInputs();
      pilot.parkingBrake = true; pilot.throttle = 1; pilot.mixture = 1; pilot.magnetos = 3;
      const u = defaultControlInputs();
      const a = new FlightAssists();
      const n0 = f.state.posNED[0], e0 = f.state.posNED[1];
      let maxHdg = 0, maxOff = 0, lifted = false, maxYawCmdFlip = 0, prevYaw = 0;
      const dt = sub * FDM_DT;
      for (let t = dt; t < 40 && !lifted; t += dt) {
        if (t > 3) pilot.parkingBrake = false;
        pilot.pitch = f.state.aero.ias > 55 * KT ? 0.25 : 0;
        Object.assign(u, pilot); u.lights = pilot.lights;
        a.apply(u, f.state, dt, { autoRudder: true, assistedTakeoff: true });
        if (t > 3.5) maxYawCmdFlip = Math.max(maxYawCmdFlip, Math.abs(u.yaw - prevYaw));
        prevYaw = u.yaw;
        for (let i = 0; i < sub; i++) f.step(FDM_DT, u, env);
        const s = f.state;
        if (!s.onGround && s.altitudeAglM > 3) { lifted = true; break; }
        maxHdg = Math.max(maxHdg, Math.abs(wrapPi(s.headingTrueRad - rwy)));
        const dN = s.posNED[0] - n0, dE = s.posNED[1] - e0;
        maxOff = Math.max(maxOff, Math.abs(-dN * Math.sin(rwy) + dE * Math.cos(rwy)));
      }
      console.log(`takeoff sub=${sub} xw=${xw}: lifted ${lifted} maxHdgErr ${(maxHdg / DEG).toFixed(2)} maxOffset ${maxOff.toFixed(2)} m maxPedalStep ${maxYawCmdFlip.toFixed(3)}`);
    }
  }
  for (const sub of [1, 4, 8, 16]) {
    const env = makeEnv();
    const f = makeFdm(1043);
    const pilot = airborne(f, env, 3000 * FT, 100);
    const a = new FlightAssists();
    const u = defaultControlInputs();
    const dt = sub * FDM_DT;
    let peak = 0, late = 0;
    for (let t = 0; t < 20; t += dt) {
      pilot.roll = t > 2 && t < 4 ? 0.3 : 0;
      Object.assign(u, pilot); u.lights = pilot.lights;
      a.apply(u, f.state, dt, { autoRudder: true, assistedTakeoff: false });
      for (let i = 0; i < sub; i++) f.step(FDM_DT, u, env);
      if (t > 2 && t < 10) peak = Math.max(peak, Math.abs(f.state.aero.beta));
      if (t > 12) late = Math.max(late, Math.abs(f.state.aero.beta));
    }
    console.log(`autorudder sub=${sub}: peak beta ${(peak / DEG).toFixed(2)} late ${(late / DEG).toFixed(3)}`);
  }
  for (const sub of [1, 4, 8, 16]) {
    const env = makeEnv();
    const f = makeFdm(1043);
    const pilot = airborne(f, env, 3000 * FT, 80);
    const a = new FlightAssists({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
    const u = defaultControlInputs();
    const dt = sub * FDM_DT;
    let stalled = false, maxAlpha = 0;
    for (let t = 0; t < 25; t += dt) {
      pilot.pitch = 1; pilot.throttle = 0;
      Object.assign(u, pilot); u.lights = pilot.lights;
      a.apply(u, f.state, dt, { autoRudder: false, assistedTakeoff: false, antiStall: true });
      for (let i = 0; i < sub; i++) { f.step(FDM_DT, u, env); stalled ||= f.state.aero.stalled; maxAlpha = Math.max(maxAlpha, f.state.aero.alpha); }
    }
    console.log(`antistall sub=${sub}: stalled ${stalled} maxAlpha ${(maxAlpha / DEG).toFixed(2)}`);
  }
});

it('AP disconnects in turbulence at approach speed (real FDM)', () => {
  for (const intensity of [0.3, 0.6, 0.9]) {
    const env = makeEnv({ turbulence: { w20Kt: 15, intensity, seed: 7 } });
    const sim = new ZohSim(2000 * FT, 75, 0, 2, env);
    sim.ap.setAltitudeTarget(2000 * FT);
    sim.ap.engage(true); sim.ap.setVertical('ALT'); sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG)); sim.ap.setLateral('HDG');
    let warnFrames = 0, maxAlpha = 0;
    sim.run(120, (s) => { if (s.ac.aero.stallWarning) warnFrames++; maxAlpha = Math.max(maxAlpha, s.ac.aero.alpha); });
    console.log(`turb ${intensity}: engaged ${sim.s.engaged} reason ${sim.s.disconnectReason} at ${sim.s.disconnectT.toFixed(1)} s, warn frames ${warnFrames}, max alpha ${(maxAlpha / DEG).toFixed(1)}`);
  }
});
