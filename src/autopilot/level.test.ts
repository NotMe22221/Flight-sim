import { describe, expect, it } from 'vitest';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { alphaLimitedPitch, loadFactorPitchRate, wingsFirst } from './level';
import { Sim } from './testSim';

const rollDeg = (sim: Sim) => sim.ac.euler[0] / DEG;
const vsFpm = (sim: Sim) => sim.ac.verticalSpeedMs / FPM;

/** Start in an unusual attitude, press LVL, and record the recovery. */
const recover = (speedKt: number, rollDegInit: number, gammaDeg: number, seconds = 40) => {
  const sim = new Sim({ speedMs: speedKt * KT, altitudeM: 5000 * FT, headingRad: 0, rollRad: rollDegInit * DEG, gammaRad: gammaDeg * DEG });
  sim.frame();
  sim.ap.level();
  const r = { sim, wingsT: -1, maxNz: 0, maxAlpha: 0, warned: false, alwaysEngaged: true };
  sim.run(seconds, (s) => {
    if (r.wingsT < 0 && Math.abs(rollDeg(s)) < 5) r.wingsT = s.t;
    r.maxNz = Math.max(r.maxNz, s.ac.loadFactor[2]);
    r.maxAlpha = Math.max(r.maxAlpha, s.ac.aero.alpha);
    r.warned ||= s.ac.aero.stallWarning;
    r.alwaysEngaged &&= s.s.engaged;
  });
  return r;
};

describe('LVL helpers', () => {
  it('pull-up rate follows (n − 1)·g/V with a floor', () => {
    expect(loadFactorPitchRate(1.8, 50, 0)).toBeCloseTo((0.8 * 9.80665) / 50, 12);
    expect(loadFactorPitchRate(1.0, 50, 2 * DEG)).toBe(2 * DEG);
    expect(loadFactorPitchRate(2, 5, 0)).toBeCloseTo(9.80665 / 20, 12); // speed floor 20 m/s
  });
  it('α ceiling and wings-first rule', () => {
    expect(alphaLimitedPitch(15 * DEG, 12 * DEG, 10 * DEG)).toBeCloseTo(13 * DEG, 12);
    expect(wingsFirst(-35 * DEG, 30 * DEG)).toBe(true);
    expect(wingsFirst(20 * DEG, 30 * DEG)).toBe(false);
  });
});

describe('LVL mode (unusual-attitude recovery with the normal loops)', () => {
  it('recovers a nose-low 70° spiral: stays engaged past the 60° bank limit, wings first, ≤ 2 g, zero VS', () => {
    const r = recover(130, 70, -15);
    expect(r.alwaysEngaged).toBe(true);
    expect(r.wingsT).toBeGreaterThan(0);
    expect(r.wingsT).toBeLessThan(10);
    expect(r.maxNz).toBeLessThan(2.0);
    expect(Math.abs(rollDeg(r.sim))).toBeLessThan(1);
    expect(Math.abs(vsFpm(r.sim))).toBeLessThan(100);
    expect(r.sim.s.lvl).toBe(true);
    expect(r.sim.s.lateral).toBe('ROL');
    expect(r.sim.s.vertical).toBe('VS');
  });

  it('does not pull while steeply banked (wings first)', () => {
    const sim = new Sim({ speedMs: 130 * KT, altitudeM: 5000 * FT, headingRad: 0, rollRad: 70 * DEG, gammaRad: -15 * DEG });
    sim.frame();
    sim.ap.level();
    let maxCmdWhileBanked = -Infinity;
    sim.run(10, (s) => { if (Math.abs(s.ac.euler[0]) > 35 * DEG) maxCmdWhileBanked = Math.max(maxCmdWhileBanked, s.ap.pitchCommandRad - s.ac.euler[1]); });
    expect(maxCmdWhileBanked).toBeLessThan(0.5 * DEG);
  });

  it('recovers nose-high and slow without stalling: α stays under the LVL ceiling, no stall warning, no disconnect', () => {
    for (const [speed, roll, gamma] of [[75, 20, 20], [85, -60, 15]] as const) {
      const r = recover(speed, roll, gamma);
      expect(r.alwaysEngaged).toBe(true);
      expect(r.warned).toBe(false);
      expect(r.maxAlpha).toBeLessThan(r.sim.ap.config.limits.lvlAlphaMaxRad + 1 * DEG);
      expect(Math.abs(rollDeg(r.sim))).toBeLessThan(1);
      expect(Math.abs(vsFpm(r.sim))).toBeLessThan(100);
    }
  });

  it('levels off from an FLC climb with the AP already engaged', () => {
    const sim = new Sim({ speedMs: 80 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.throttle = 1;
    sim.ap.setAltitudeTarget(9000 * FT);
    sim.ap.engage(true);
    sim.ap.setIasTarget(80 * KT);
    sim.ap.setVertical('FLC');
    sim.run(30);
    expect(vsFpm(sim)).toBeGreaterThan(400);
    sim.ap.press('LVL');
    let maxVs = 0;
    sim.run(30, (s) => { if (s.t > 50) maxVs = Math.max(maxVs, Math.abs(vsFpm(s))); });
    expect(sim.s.engaged).toBe(true);
    expect(maxVs).toBeLessThan(150);
  });

  it('disarms everything, leaves the selected altitude, and ends on any mode selection', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.setAltitudeTarget(6000 * FT);
    sim.ap.engage(true);
    sim.ap.setVerticalSpeedTarget(500 * FPM);
    sim.ap.setVertical('VS');
    sim.frame();
    expect(sim.s.armedVertical).toBe('ALTS');
    sim.ap.level();
    sim.run(5);
    expect(sim.s.armedVertical).toBeNull();
    expect(sim.s.armedLateral).toBeNull();
    expect(sim.s.altitudeTargetM).toBeCloseTo(6000 * FT, 9);
    expect(sim.s.verticalSpeedTargetMs).toBe(0);
    sim.ap.setHeadingBug(90);
    sim.ap.setLateral('HDG');
    expect(sim.s.lvl).toBe(false);
    sim.frame();
    expect(sim.s.armedVertical).toBe('ALTS'); // plain VS again: altitude pre-select re-arms
  });

  it('bank / overspeed / stall disconnects are only suspended while LVL is active', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.level();
    sim.ac.euler[0] = 65 * DEG;
    sim.ac.warnings.overspeed = true;
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.engaged).toBe(true);
    sim.ap.setLateral('HDG');
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.engaged).toBe(false);
    expect(sim.s.disconnectReason).toBe('bank');
  });
});

describe('mode logic details', () => {
  it('a mode key with AP and FD off turns the flight director on', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.setLateral('HDG');
    expect(sim.s.flightDirector).toBe(true);
    expect(sim.s.lateral).toBe('HDG');
    expect(sim.s.vertical).toBe('PIT');
    sim.ap.engage(true);
    sim.ap.engage(false);
    expect(sim.s.lateral).toBe('HDG'); // AP disconnect keeps the FD modes
  });

  it('survives the FD flag being written directly (selects / clears default modes)', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.s.flightDirector = true;
    sim.frame();
    expect(sim.s.lateral).toBe('ROL');
    expect(sim.s.vertical).toBe('PIT');
    sim.s.flightDirector = false;
    sim.frame();
    expect(sim.s.lateral).toBe('OFF');
    expect(sim.s.vertical).toBe('OFF');
  });

  it('VS climbing away from a selected altitude just below does not snap into ALT', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.throttle = 1;
    sim.ap.setAltitudeTarget(2980 * FT);
    sim.ap.engage(true);
    sim.ap.setVerticalSpeedTarget(500 * FPM);
    sim.ap.setVertical('VS');
    sim.run(20);
    expect(sim.s.vertical).toBe('VS');
    expect(vsFpm(sim)).toBeGreaterThan(400);
  });

  it('GS reverts to PIT when the glideslope is lost for longer than the grace time, even with a good localizer', () => {
    const ils = { locNorthM: 2000, locEastM: 0, gsNorthM: 300, gsEastM: 0, gsElevationM: 0, courseRad: 0, glideRad: 3 * DEG };
    const dist = 5 * NM;
    const sim = new Sim({ speedMs: 90 * KT, altitudeM: dist * Math.tan(3 * DEG), headingRad: 0, northM: ils.gsNorthM - dist });
    sim.ils = ils;
    sim.frame();
    sim.ap.engage(true);
    sim.ap.setLateral('APR');
    sim.run(3);
    expect(sim.s.vertical).toBe('GS');
    // glideslope receiver fails; the localizer stays valid (freeze the receiver output)
    sim.ils = null;
    sim.nav1.gsValid = false;
    sim.run(1.5);
    expect(sim.s.vertical).toBe('GS'); // within the 2 s grace
    sim.run(1.0);
    expect(sim.s.vertical).toBe('PIT');
    expect(sim.s.lateral).toBe('APR');
  });
});
