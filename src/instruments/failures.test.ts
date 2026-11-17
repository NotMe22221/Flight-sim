import { describe, expect, it } from 'vitest';
import { InstrumentModel } from './readings';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

/** Fly the snapshot to a new altitude (static pressure from ISA) at constant airspeed. */
function climbTo(s: ReturnType<typeof makeSampleSnapshot>, altFt: number): void {
  const m = altFt * 0.3048;
  s.aircraft.altitudeMslM = m; s.aircraft.geo.alt = m;
  s.aircraft.atmosphere.pressurePa = 101325 * Math.pow(1 - 2.25577e-5 * m, 5.25588);
}
const settle = (im: InstrumentModel, s: ReturnType<typeof makeSampleSnapshot>, sec = 20) => { let r = im.update(s, 1 / 30); for (let t = 0; t < sec; t += 1 / 30) r = im.update(s, 1 / 30); return r; };

describe('instrument failures', () => {
  it('blocked pitot: the airspeed indicator climbs with altitude like an altimeter', () => {
    const s = makeSampleSnapshot();
    climbTo(s, 3000);
    const im = new InstrumentModel();
    const healthy = settle(im, s).iasKt;
    s.failures = { pitot: true };
    settle(im, s);
    climbTo(s, 5000);
    const after = settle(im, s).iasKt;
    expect(after).toBeGreaterThan(healthy + 15); // reads high climbing
    s.failures = {};
    climbTo(s, 5000);
    expect(Math.abs(settle(im, s).iasKt - healthy)).toBeLessThan(3); // recovers when cleared
  });

  it('blocked static: the altimeter freezes, the VSI reads zero, the airspeed reads low when climbing', () => {
    const s = makeSampleSnapshot();
    climbTo(s, 3000);
    s.aircraft.verticalSpeedMs = 3.5;
    const im = new InstrumentModel();
    const r0 = settle(im, s);
    const alt0 = r0.altimeter.indicatedFt, ias0 = r0.iasKt;
    expect(r0.vsiFpm).toBeGreaterThan(500);
    s.failures = { static: true };
    settle(im, s, 2);
    climbTo(s, 4500);
    const r1 = settle(im, s);
    expect(Math.abs(r1.altimeter.indicatedFt - alt0)).toBeLessThan(30);
    expect(Math.abs(r1.vsiFpm)).toBeLessThan(20);
    expect(r1.iasKt).toBeLessThan(ias0 - 3);
  });

  it('vacuum pump: suction drops to zero and the VACUUM annunciator lights', () => {
    const s = makeSampleSnapshot();
    const im = new InstrumentModel();
    expect(settle(im, s, 2).suctionInHg).toBeGreaterThan(3);
    s.failures = { vacuum: true };
    const r = settle(im, s, 2);
    expect(r.suctionInHg).toBe(0);
    expect(r.annunciators.vacuum).toBe(true);
  });
});
