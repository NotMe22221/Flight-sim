import { describe, expect, it } from 'vitest';
import { DEG, FT, KT } from '../core/units';
import { C172S_VSPEEDS } from './c172';
import { compassTargetDeg } from './compass';
import { Lag } from './filters';
import { ballWidths, turnRateStd } from './gyros';
import { InstrumentModel, indicatedAltitudeFt, isaPressurePa, kollsmanCorrectionFt, pressureAltitudeFt } from './readings';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

const hPa = (v: number): number => v * 100;

describe('altimetry', () => {
  it('standard setting at ISA pressure gives geometric (pressure) altitude', () => {
    expect(indicatedAltitudeFt(hPa(1013.25), hPa(1013.25))).toBeCloseTo(0, 6);
    const p3500 = isaPressurePa(3500);
    expect(pressureAltitudeFt(p3500)).toBeCloseTo(3500, 3);
    expect(indicatedAltitudeFt(p3500, hPa(1013.25))).toBeCloseTo(3500, 3);
  });
  it('QNH 1003 hPa with the Kollsman left at 1013.25 reads about +270..290 ft (≈ 82–88 m) at sea level', () => {
    const ft = indicatedAltitudeFt(hPa(1003), hPa(1013.25));
    expect(ft).toBeGreaterThan(260);
    expect(ft).toBeLessThan(300);
    expect(ft * FT).toBeGreaterThan(79);
    expect(ft * FT).toBeLessThan(92);
    // and setting the correct QNH removes the error; setting too low reads low
    expect(indicatedAltitudeFt(hPa(1003), hPa(1003))).toBeCloseTo(0, 6);
    expect(indicatedAltitudeFt(hPa(1013.25), hPa(1003))).toBeCloseTo(-ft, 6);
  });
  it('kollsman correction follows the 1 inHg ≈ 1 000 ft rule of thumb', () => {
    const d = kollsmanCorrectionFt(3386.39 * 29.92) - kollsmanCorrectionFt(3386.39 * 30.12);
    expect(Math.abs(d)).toBeGreaterThan(170);
    expect(Math.abs(d)).toBeLessThan(200);
  });
});

describe('first-order lag', () => {
  it('reaches 63.2 % of a step after one time constant', () => {
    const lag = new Lag(2.5, 0);
    for (let t = 0; t < 2.5 - 1e-9; t += 1 / 120) lag.step(1, 1 / 120);
    expect(lag.value).toBeCloseTo(1 - Math.exp(-1), 2);
  });
});

describe('turn coordinator', () => {
  it('3°/s yaw with wings steady is exactly standard rate', () => {
    expect(turnRateStd(0, 3 * DEG)).toBeCloseTo(1, 9);
    expect(turnRateStd(0, -3 * DEG)).toBeCloseTo(-1, 9);
  });
  it('roll rate contributes (20°/s roll = one standard-rate mark) and the output clamps', () => {
    expect(turnRateStd(20 * DEG, 0)).toBeCloseTo(1, 9);
    expect(turnRateStd(0, 30 * DEG)).toBe(2.5);
  });
  it('ball falls toward the low wing in a slip and is centred when coordinated', () => {
    expect(ballWidths(0, 1)).toBeCloseTo(0, 12);
    expect(ballWidths(0, 1.4)).toBeCloseTo(0, 12);
    // right slip: gravity pulls the ball right, specific force is to the left (ny < 0)
    expect(ballWidths(-Math.tan(4 * DEG), 1)).toBeCloseTo(1, 6);
    expect(ballWidths(Math.tan(8 * DEG), 1)).toBeCloseTo(-1.5, 6); // clamped
  });
});

describe('whiskey compass', () => {
  it('is exact wings-level and shows the northerly turning error when banked through north', () => {
    expect(compassTargetDeg(90, 0, 0, 61 * DEG)).toBeCloseTo(90, 6);
    const banked = compassTargetDeg(0, 15 * DEG, 0, 61 * DEG);
    const err = banked > 180 ? banked - 360 : banked;
    expect(err).toBeLessThan(-10); // card swings the wrong way (undershoots) rolling into a right turn from north
    expect(err).toBeGreaterThan(-35);
    // on an east heading the bank error is small
    const east = compassTargetDeg(90, 15 * DEG, 0, 61 * DEG);
    expect(Math.abs(east - 90)).toBeLessThan(5);
  });
});

describe('InstrumentModel dynamics', () => {
  const run = (model: InstrumentModel, snap: ReturnType<typeof makeSampleSnapshot>, seconds: number, dt = 1 / 60): void => {
    for (let t = 0; t < seconds - 1e-9; t += dt) { snap.time.simTimeS += dt; model.update(snap, dt); }
  };

  it('VSI lags a vertical-speed step with τ = 2.5 s (63 % at τ, > 95 % at 3τ)', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ vsFpm: 0 });
    model.update(snap, 1 / 60);
    snap.aircraft.verticalSpeedMs = 500 * FT / 60;
    run(model, snap, 2.5);
    expect(model.readings.vsiFpm / 500).toBeCloseTo(1 - Math.exp(-1), 1);
    expect(Math.abs(model.readings.vsiFpm - 316)).toBeLessThan(10);
    run(model, snap, 5);
    expect(model.readings.vsiFpm).toBeGreaterThan(475);
  });

  it('altimeter follows the Kollsman setting', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ altFt: 0 });
    snap.aircraft.atmosphere.pressurePa = hPa(1003);
    snap.aircraft.qnhSetPa = hPa(1003);
    model.reset(snap);
    run(model, snap, 1);
    expect(Math.abs(model.readings.altimeter.indicatedFt)).toBeLessThan(1);
    snap.aircraft.qnhSetPa = hPa(1013.25);
    run(model, snap, 2);
    expect(model.readings.altimeter.indicatedFt).toBeGreaterThan(260);
    expect(model.readings.altimeter.indicatedFt).toBeLessThan(300);
    expect(model.readings.altimeter.settingInHg).toBeCloseTo(29.92, 1);
    expect(model.readings.altimeter.settingHPa).toBeCloseTo(1013.25, 1);
  });

  it('ASI needle is damped but settles on the FDM indicated airspeed in knots', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ iasKt: 100 });
    model.reset(snap);
    snap.aircraft.aero.ias = 110 * KT;
    model.update(snap, 1 / 60);
    expect(model.readings.iasKt).toBeGreaterThan(100);
    expect(model.readings.iasKt).toBeLessThan(110);
    run(model, snap, 2);
    expect(model.readings.iasKt).toBeCloseTo(110, 1);
  });

  it('turn coordinator settles on the standard-rate mark for a 3°/s turn and the ball follows ny', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot();
    model.reset(snap);
    snap.aircraft.rates = [0, 0, 3 * DEG];
    run(model, snap, 8);
    expect(model.readings.turn.rateStd).toBeCloseTo(1, 2);
    snap.aircraft.loadFactor = [0, -Math.tan(4 * DEG), 1];
    run(model, snap, 3);
    expect(model.readings.turn.ballWidths).toBeCloseTo(1, 1);
  });

  it('heading indicator drifts at the configured rate only when gyroDrift is enabled', () => {
    const cfg = { dgRandomWalkDegPerSqrtMin: 0 };
    const drifting = new InstrumentModel({ ...new InstrumentModel().cfg, ...cfg });
    const snapA = makeSampleSnapshot({ headingMagDeg: 90 });
    drifting.reset(snapA);
    run(drifting, snapA, 60, 0.1);
    const errA = ((drifting.readings.heading.dgDeg - 90 + 540) % 360) - 180;
    expect(errA).toBeCloseTo(0.25, 2);

    const steady = new InstrumentModel({ ...new InstrumentModel().cfg, ...cfg });
    const snapB = makeSampleSnapshot({ headingMagDeg: 90 });
    snapB.assists.gyroDrift = false;
    steady.reset(snapB);
    run(steady, snapB, 60, 0.1);
    expect(steady.readings.heading.dgDeg).toBeCloseTo(90, 6);

    // random walk on by default: still bounded over a minute
    const rw = new InstrumentModel();
    const snapC = makeSampleSnapshot({ headingMagDeg: 90 });
    rw.reset(snapC);
    run(rw, snapC, 60, 0.1);
    const errC = ((rw.readings.heading.dgDeg - 90 + 540) % 360) - 180;
    expect(Math.abs(errC)).toBeLessThan(3);
    rw.alignHeadingIndicator();
    expect(Math.abs(((rw.readings.heading.compassDeg - rw.dg.headingDeg + 540) % 360) - 180)).toBeLessThan(1e-6);
  });

  it('gyros spin down when the engine stops and the attitude indicator develops erection error', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ engineRunning: false, rpm: 0 });
    snap.aircraft.engine.running = false;
    model.reset(snap);
    expect(model.readings.attitude.spin).toBe(0);
    run(model, snap, 2, 0.1);
    expect(model.readings.attitude.valid).toBe(false);
    // start the engine: 4 s to full spin
    snap.aircraft.engine.running = true; snap.aircraft.engine.rpm = 2300;
    run(model, snap, 5, 0.05);
    expect(model.readings.attitude.spin).toBeCloseTo(1, 2);
    expect(model.readings.attitude.valid).toBe(true);
    expect(model.readings.suctionInHg).toBeCloseTo(5, 1);
    // cut it again: at 180 s spin-down the error only appears after spin < 0.8 (36 s)
    snap.aircraft.engine.running = false; snap.aircraft.engine.rpm = 0;
    run(model, snap, 30, 0.1);
    expect(Math.abs(model.readings.attitude.rollDeg)).toBeLessThan(1);
    run(model, snap, 120, 0.1);
    expect(Math.abs(model.readings.attitude.rollDeg)).toBeGreaterThan(5);
  });

  it('engine gauges convert units and the low-fuel annunciator needs a 60 s hold', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot();
    model.reset(snap);
    run(model, snap, 3);
    const r = model.readings;
    expect(r.engine.rpm).toBeCloseTo(2350, 0);
    expect(r.engine.fuelFlowGph).toBeCloseTo((0.0073 * 3600) / 2.725, 1);
    expect(r.engine.oilPressPsi).toBeCloseTo(60, 0);
    expect(r.engine.oilTempF).toBeCloseTo((355 - 273.15) * 1.8 + 32, 0);
    expect(r.fuelGal[0]).toBeGreaterThan(17);
    expect(r.fuelGal[0]).toBeLessThan(21);
    expect(r.voltsV).toBeCloseTo(28, 0);
    expect(r.ampsA).toBeGreaterThan(0);
    expect(r.annunciators.lowFuelL).toBe(false);
    snap.aircraft.fuelKg = [8, 8];
    run(model, snap, 30, 0.1);
    expect(r.annunciators.lowFuelL).toBe(false);
    run(model, snap, 40, 0.1);
    expect(r.annunciators.lowFuelL).toBe(true);
    expect(r.annunciators.lowFuelR).toBe(true);
  });

  it('derives wind, heading bug error and trends', () => {
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ headingMagDeg: 285, magVarDeg: 13 });
    model.reset(snap);
    model.update(snap, 1 / 60);
    const r = model.readings;
    expect(r.heading.magVarDeg).toBeCloseTo(13, 6);
    expect(r.heading.bugDeg).toBe(300);
    expect(r.heading.bugErrorDeg).toBeCloseTo(15, 0);
    expect(r.wind.speedKt).toBeCloseTo(Math.hypot(5, 8), 6);
    expect(r.wind.fromTrueDeg).toBeCloseTo((Math.atan2(-8, 5) * 180) / Math.PI + 360, 6);
    expect(r.trends.altFtPer6s).toBe(0);
    expect(r.heading.trackMagDeg).toBeCloseTo(287, 6);
  });

  it('v-speed table matches the 172S POH', () => {
    expect(C172S_VSPEEDS).toMatchObject({ vso: 40, vs1: 48, vfe: 85, vno: 129, vne: 163 });
  });
});
