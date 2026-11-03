import { describe, expect, it } from 'vitest';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { type DisconnectReason } from './Autopilot';
import { type TestIls } from './testPlant';
import { Sim } from './testSim';
import { deltaDeg } from '../core/math';

const hdgDeg = (sim: Sim) => sim.ac.headingMagRad / DEG;
const rollDeg = (sim: Sim) => sim.ac.euler[0] / DEG;
const altFt = (sim: Sim) => sim.ac.altitudeMslM / FT;
const vsFpm = (sim: Sim) => sim.ac.verticalSpeedMs / FPM;
const iasKt = (sim: Sim) => sim.ac.aero.ias / KT;

describe('GfcAutopilot lateral modes', () => {
  it('HDG 000 → 090 at 100 kt: captures within 60 s, overshoot < 3°, bank ≤ 25.5°', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.engage(true);
    sim.ap.setHeadingBug(90);
    sim.ap.setLateral('HDG');
    let maxBank = 0, maxOvershoot = 0, captureT = -1;
    sim.run(60, (s) => {
      maxBank = Math.max(maxBank, Math.abs(rollDeg(s)));
      const err = deltaDeg(hdgDeg(s), 90);
      maxOvershoot = Math.max(maxOvershoot, err);
      if (captureT < 0 && Math.abs(err) < 2) captureT = s.t;
      else if (captureT >= 0 && Math.abs(err) >= 2) captureT = -1;
    });
    expect(captureT).toBeGreaterThan(0);
    expect(captureT).toBeLessThan(60);
    expect(maxOvershoot).toBeLessThan(3);
    expect(maxBank).toBeLessThanOrEqual(25.5);
    expect(Math.abs(deltaDeg(hdgDeg(sim), 90))).toBeLessThan(1);
    expect(sim.s.fdRollRad).toBeCloseTo(sim.ap.rollCommandRad, 12);
  });

  it('HDG honours the bank limit at high speed and the standard-rate cap at low speed', () => {
    const fast = new Sim({ speedMs: 160 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    fast.ap.engage(true); fast.ap.setHeadingBug(180); fast.ap.setLateral('HDG');
    let maxBank = 0;
    fast.run(20, (s) => { maxBank = Math.max(maxBank, Math.abs(rollDeg(s))); });
    expect(maxBank).toBeLessThanOrEqual(25.5);
    expect(maxBank).toBeGreaterThan(20);
    const slow = new Sim({ speedMs: 70 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    slow.ap.engage(true); slow.ap.setHeadingBug(180); slow.ap.setLateral('HDG');
    let maxRate = 0;
    let prev = hdgDeg(slow);
    slow.run(20, (s) => { const h = hdgDeg(s); maxRate = Math.max(maxRate, Math.abs(deltaDeg(h, prev)) * s.hz); prev = h; });
    expect(maxRate).toBeLessThan(3.3);
  });

  it('ROL holds the bank at engage, wings level below 6°', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, rollRad: 3 * DEG });
    sim.run(0.1);
    sim.ap.engage(true);
    expect(sim.s.lateral).toBe('ROL');
    expect(sim.s.vertical).toBe('PIT');
    expect(sim.s.rollTargetRad).toBe(0);
    sim.run(10);
    expect(Math.abs(rollDeg(sim))).toBeLessThan(0.5);
    const banked = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, rollRad: 15 * DEG });
    banked.run(0.1);
    banked.ap.engage(true);
    expect(banked.s.rollTargetRad).toBeCloseTo(15 * DEG, 2);
    banked.run(10);
    expect(rollDeg(banked)).toBeCloseTo(15, 0);
  });

  it('NAV (GPS): from 2 nm right of course converges to < 0.1 nm with intercept ≤ 45°', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, eastM: 2 * NM });
    sim.course = { startNorthM: -5 * NM, startEastM: 0, endNorthM: 60 * NM, endEastM: 0 };
    sim.usePlan = true;
    sim.frame();
    sim.ap.engage(true);
    sim.ap.setLateral('NAV');
    expect(sim.s.lateral).toBe('NAV');
    let maxIntercept = 0, convergedT = -1;
    sim.run(300, (s) => {
      if (s.t > 15) maxIntercept = Math.max(maxIntercept, Math.abs(deltaDeg(s.ac.trackRad / DEG, 0)));
      if (convergedT < 0 && Math.abs(s.plan.crossTrackM) < 0.1 * NM) convergedT = s.t;
    });
    expect(convergedT).toBeGreaterThan(0);
    expect(maxIntercept).toBeLessThanOrEqual(45);
    expect(Math.abs(sim.plan.crossTrackM)).toBeLessThan(0.05 * NM);
    expect(Math.abs(deltaDeg(sim.ac.trackRad / DEG, 0))).toBeLessThan(2);
  });

  it('NAV arms while flying HDG beyond 1 dot and captures the course', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, eastM: 2 * NM });
    sim.course = { startNorthM: -5 * NM, startEastM: 0, endNorthM: 60 * NM, endEastM: 0 };
    sim.usePlan = true;
    sim.frame();
    sim.ap.engage(true);
    sim.ap.setHeadingBug(315);
    sim.ap.setLateral('HDG');
    sim.ap.setLateral('NAV');
    expect(sim.s.lateral).toBe('HDG');
    expect(sim.s.armedLateral).toBe('NAV');
    let captureT = -1;
    sim.run(240, (s) => { if (s.s.lateral === 'NAV') { captureT = s.t; return true; } });
    expect(captureT).toBeGreaterThan(0);
    expect(Math.abs(sim.plan.crossTrackM)).toBeLessThan(1.2 * NM);
    sim.run(120);
    expect(Math.abs(sim.plan.crossTrackM)).toBeLessThan(0.1 * NM);
  });
});

describe('GfcAutopilot vertical modes', () => {
  it('ALT: 3000 → 3500 ft captures within 120 s, VS ≤ 800 fpm, overshoot < 40 ft, SS error < 10 ft', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.throttle = 1;
    sim.ap.engage(true);
    sim.ap.setAltitudeTarget(3500 * FT);
    sim.ap.setVertical('ALT');
    let maxVs = 0, maxAlt = 0, captureT = -1;
    sim.run(120, (s) => {
      maxVs = Math.max(maxVs, vsFpm(s));
      maxAlt = Math.max(maxAlt, altFt(s));
      if (captureT < 0 && Math.abs(altFt(s) - 3500) < 20) captureT = s.t;
    });
    expect(captureT).toBeGreaterThan(0);
    expect(maxVs).toBeLessThanOrEqual(800);
    expect(maxAlt - 3500).toBeLessThan(40);
    expect(Math.abs(altFt(sim) - 3500)).toBeLessThan(10);
    expect(sim.s.fdPitchRad).toBeCloseTo(sim.ap.pitchCommandRad, 12);
  });

  it('VS holds +500 / −500 fpm within ±50 fpm', () => {
    for (const target of [500, -500]) {
      const sim = new Sim({ speedMs: 100 * KT, altitudeM: 5000 * FT, headingRad: 0 });
      sim.pilot.throttle = target > 0 ? 1 : 0.3;
      sim.ap.setAltitudeTarget((target > 0 ? 15000 : 1000) * FT);
      sim.ap.engage(true);
      sim.ap.setVerticalSpeedTarget(target * FPM);
      sim.ap.setVertical('VS');
      let maxErr = 0;
      sim.run(90, (s) => { if (s.t > 30) maxErr = Math.max(maxErr, Math.abs(vsFpm(s) - target)); });
      expect(sim.s.vertical).toBe('VS');
      expect(maxErr).toBeLessThan(50);
    }
  });

  it('FLC holds 90 kt within ±3 kt while climbing at full power', () => {
    const sim = new Sim({ speedMs: 90 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.setAltitudeTarget(12000 * FT);
    sim.ap.engage(true);
    sim.ap.setIasTarget(90 * KT);
    sim.ap.setVertical('FLC');
    sim.pilot.throttle = 1;
    let maxErr = 0, minVs = Infinity;
    sim.run(120, (s) => { if (s.t > 20) { maxErr = Math.max(maxErr, Math.abs(iasKt(s) - 90)); minVs = Math.min(minVs, vsFpm(s)); } });
    expect(sim.s.vertical).toBe('FLC');
    expect(maxErr).toBeLessThan(3);
    expect(minVs).toBeGreaterThan(300);
  });

  it('ALTS arms in VS and captures the pre-selected altitude smoothly', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.throttle = 1;
    sim.ap.setAltitudeTarget(4000 * FT);
    sim.ap.engage(true);
    sim.ap.setVerticalSpeedTarget(1000 * FPM);
    sim.ap.setVertical('VS');
    sim.frame();
    expect(sim.s.armedVertical).toBe('ALTS');
    let captureAlt = -1, maxAlt = 0, maxDecel = 0, prevVs = vsFpm(sim);
    sim.run(180, (s) => {
      if (captureAlt < 0 && s.s.vertical === 'ALTS') captureAlt = altFt(s);
      maxAlt = Math.max(maxAlt, altFt(s));
      const vs = vsFpm(s);
      maxDecel = Math.max(maxDecel, Math.abs(vs - prevVs) * s.hz);
      prevVs = vs;
    });
    expect(captureAlt).toBeGreaterThan(3700);
    expect(captureAlt).toBeLessThan(3900);
    expect(sim.s.vertical).toBe('ALT');
    expect(maxAlt - 4000).toBeLessThan(40);
    expect(Math.abs(altFt(sim) - 4000)).toBeLessThan(10);
    expect(maxDecel).toBeLessThan(400); // fpm per second (0.03 g ≈ 350 fpm/s) — no snatch at capture
  });
});

describe('GfcAutopilot approach', () => {
  const makeIls = (): TestIls => ({ locNorthM: 2000, locEastM: 0, gsNorthM: 300, gsEastM: 0, gsElevationM: 0, courseRad: 0, glideRad: 3 * DEG });

  it('APR/GS: from 1 dot below at 6 nm captures and tracks within 0.2 dots', () => {
    const ils = makeIls();
    // 6 nm DME = 6 nm from the glideslope antenna (north 300 m); the aircraft flies north toward it.
    // One dot = 0.35° (full scale ±0.7° = two dots), so one dot low is a 2.65° path angle.
    const dist = 6 * NM;
    const alt = dist * Math.tan(3 * DEG - 0.35 * DEG);
    const sim = new Sim({ speedMs: 90 * KT, altitudeM: alt, headingRad: 0, northM: ils.gsNorthM - dist });
    sim.ils = ils;
    sim.frame();
    expect(sim.nav1.gsDeviation).toBeCloseTo(0.5, 3); // exactly one dot (gsDeviation is full-scale ±1 = ±2 dots)
    sim.ap.setAltitudeTarget(alt);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setLateral('APR');
    expect(sim.s.lateral).toBe('APR');
    expect(sim.s.armedVertical).toBe('GS');
    let captureT = -1, maxDev = 0;
    sim.run(400, (s) => {
      if (captureT < 0 && s.s.vertical === 'GS') captureT = s.t;
      if (captureT > 0 && s.t > captureT + 40 && s.nav1.dmeNm > 1.0) maxDev = Math.max(maxDev, Math.abs(s.nav1.gsDeviation * 2));
      if (s.nav1.dmeNm < 1.0) return true;
    });
    expect(captureT).toBeGreaterThan(0);
    expect(maxDev).toBeLessThan(0.2);
    expect(Math.abs(sim.nav1.cdi)).toBeLessThan(0.1);
  });

  it('LOC: captures from a 30° intercept and tracks the localizer', () => {
    const ils = makeIls();
    const sim = new Sim({ speedMs: 90 * KT, altitudeM: 600, headingRad: 330 * DEG, northM: -8 * NM, eastM: 0.4 * NM });
    sim.ils = ils;
    sim.frame();
    sim.ap.setAltitudeTarget(600);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setHeadingBug(330);
    sim.ap.setLateral('HDG');
    sim.ap.setLateral('APR');
    expect(sim.s.armedLateral).toBe('APR');
    let captureT = -1, maxBank = 0, maxCdiAfter = 0;
    sim.run(240, (s) => {
      if (captureT < 0 && s.s.lateral === 'APR') captureT = s.t;
      maxBank = Math.max(maxBank, Math.abs(rollDeg(s)));
      if (captureT > 0 && s.t > captureT + 60) maxCdiAfter = Math.max(maxCdiAfter, Math.abs(s.nav1.cdi));
    });
    expect(captureT).toBeGreaterThan(0);
    expect(maxBank).toBeLessThanOrEqual(22.5);
    expect(maxCdiAfter).toBeLessThan(0.1);
  });
});

describe('GfcAutopilot protections and servos', () => {
  it('disconnects on pilot override after 0.5 s and reports the reason', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const reasons: DisconnectReason[] = [];
    sim.ap.onDisconnect((r) => reasons.push(r));
    sim.ap.engage(true);
    sim.run(2);
    sim.pilot.roll = 0.7;
    sim.run(0.4);
    expect(sim.s.engaged).toBe(true);
    sim.run(0.3);
    expect(sim.s.engaged).toBe(false);
    expect(reasons).toEqual(['override']);
    expect(sim.s.disconnectReason).toBe('override');
    expect(sim.s.lateral).toBe('OFF');
  });

  it('disconnects on stall warning', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const reasons: DisconnectReason[] = [];
    sim.ap.onDisconnect((r) => reasons.push(r));
    sim.ap.engage(true);
    sim.run(1);
    sim.ac.aero.stallWarning = true;
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.engaged).toBe(false);
    expect(reasons).toEqual(['stall']);
  });

  it('disconnects beyond 60° of bank and on overspeed', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.engage(true);
    sim.ac.euler[0] = 65 * DEG;
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.disconnectReason).toBe('bank');
    sim.ac.euler[0] = 0;
    sim.ap.engage(true);
    sim.ac.warnings.overspeed = true;
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.disconnectReason).toBe('overspeed');
  });

  it('needs avionics power: a bus failure drops AP, FD and YD, and nothing engages until power returns', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const elec = { busVolts: 28, avionicsPowered: true, mainPowered: true, batteryAmps: 0, alternatorAmps: 10, loadAmps: 10, batteryCharge: 1, lowVoltage: false };
    sim.ac.electrical = elec;
    const reasons: DisconnectReason[] = [];
    sim.ap.onDisconnect((r) => reasons.push(r));
    sim.ap.engage(true);
    sim.ap.setYawDamper(true);
    sim.ap.setHeadingBug(90);
    sim.ap.setLateral('HDG');
    sim.run(1);
    expect(sim.s.engaged).toBe(true);
    elec.avionicsPowered = false;
    sim.frame();
    expect(reasons).toEqual(['power']);
    expect(sim.s.engaged).toBe(false);
    expect(sim.s.flightDirector).toBe(false);
    expect(sim.s.yawDamper).toBe(false);
    expect(sim.s.lateral).toBe('OFF');
    expect(sim.ap.isPowered).toBe(false);
    sim.ap.engage(true);
    sim.ap.press('LVL');
    sim.ap.setLateral('HDG');
    sim.ap.press('FD');
    expect(sim.s.engaged).toBe(false);
    expect(sim.s.flightDirector).toBe(false);
    expect(sim.s.lateral).toBe('OFF');
    sim.frame();
    expect(sim.last.pitch).toBe(sim.pilot.pitch); // the pilot flies
    elec.avionicsPowered = true;
    sim.frame();
    sim.ap.engage(true);
    expect(sim.s.engaged).toBe(true);
  });

  it('engage is bumpless: elevator output continuity < 0.05', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.plant.setTrimSpeed(85 * KT); // trimmed for a slower speed → needs forward pressure
    sim.run(0.5);
    sim.pilot.pitch = -0.22;
    sim.run(2);
    const before = sim.last.pitch;
    sim.ap.engage(true);
    sim.frame();
    expect(sim.s.engaged).toBe(true);
    expect(Math.abs(sim.last.pitch - before)).toBeLessThan(0.05);
    let maxJump = 0, prev = sim.last.pitch;
    sim.pilot.pitch = 0;
    sim.run(3, (s) => { maxJump = Math.max(maxJump, Math.abs(s.last.pitch - prev)); prev = s.last.pitch; });
    expect(maxJump).toBeLessThan(0.05);
  });

  it('auto-trim relieves a steady elevator load so the servo returns toward centre', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.plant.setTrimSpeed(120 * KT); // out of trim: needs steady back pressure
    sim.ap.setAltitudeTarget(3000 * FT);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.run(8);
    const early = Math.abs(sim.s.outPitch);
    expect(early).toBeGreaterThan(0.05);
    sim.run(60);
    expect(Math.abs(sim.s.outPitch)).toBeLessThan(0.05);
    expect(Math.abs(sim.pilot.pitchTrim)).toBeGreaterThan(0.05);
    expect(Math.abs(altFt(sim) - 3000)).toBeLessThan(20);
  });

  it('FD bars follow the commanded attitude with the servos off', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.setFlightDirector(true);
    sim.ap.setHeadingBug(90);
    sim.ap.setLateral('HDG');
    sim.ap.setAltitudeTarget(3500 * FT);
    sim.ap.setVertical('ALT');
    sim.run(5);
    expect(sim.s.engaged).toBe(false);
    expect(sim.s.outRoll).toBe(0);
    expect(sim.s.fdRollRad).toBeGreaterThan(10 * DEG);
    expect(sim.s.fdRollRad).toBeCloseTo(sim.ap.rollCommandRad, 12);
    expect(sim.s.fdPitchRad).toBeCloseTo(sim.ap.pitchCommandRad, 12);
    expect(sim.s.fdPitchRad).toBeGreaterThan(sim.ac.euler[1]);
  });

  it('yaw damper output washes out to zero in a steady turn', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, rollRad: 20 * DEG });
    sim.ap.setYawDamper(true);
    sim.pilot.roll = 0;
    let peak = 0;
    sim.run(1, (s) => { peak = Math.max(peak, Math.abs(s.s.outYaw)); });
    sim.run(15);
    expect(Math.abs(sim.ac.rates[2])).toBeGreaterThan(0.05);
    expect(Math.abs(sim.s.outYaw)).toBeLessThan(0.005);
    expect(sim.last.yaw).toBeCloseTo(sim.s.outYaw, 12);
  });

  it('apply() does not allocate and leaves the pilot inputs untouched except trim', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.engage(true);
    sim.frame();
    const a = sim.ap.apply(sim.pilot);
    const b = sim.ap.apply(sim.pilot);
    expect(a).toBe(b);
    expect(a).not.toBe(sim.pilot);
    expect(sim.pilot.pitch).toBe(0);
    sim.ap.engage(false);
    expect(sim.ap.apply(sim.pilot)).toBe(sim.pilot);
  });
});

describe('GfcAutopilot frame-rate independence', () => {
  const hdgRun = (hz: number) => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 }, hz);
    sim.ap.engage(true); sim.ap.setHeadingBug(90); sim.ap.setLateral('HDG');
    const samples: number[] = [];
    let next = 5;
    sim.run(45, (s) => { if (s.t >= next - 1e-9) { samples.push(hdgDeg(s)); next += 5; } });
    return samples;
  };
  const altRun = (hz: number) => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 }, hz);
    sim.pilot.throttle = 1;
    sim.ap.engage(true); sim.ap.setAltitudeTarget(3500 * FT); sim.ap.setVertical('ALT');
    const samples: number[] = [];
    let next = 5;
    sim.run(90, (s) => { if (s.t >= next - 1e-9) { samples.push(altFt(s)); next += 5; } });
    return samples;
  };

  it('60 Hz results are within 5% of 120 Hz', () => {
    const h60 = hdgRun(60), h120 = hdgRun(120);
    expect(h60.length).toBe(h120.length);
    for (let i = 0; i < h60.length; i++) expect(Math.abs(deltaDeg(h60[i], h120[i]))).toBeLessThan(0.05 * 90);
    const a60 = altRun(60), a120 = altRun(120);
    for (let i = 0; i < a60.length; i++) expect(Math.abs(a60[i] - a120[i])).toBeLessThan(0.05 * 500);
  });
});
