/**
 * The autopilot fed by the real navigation receivers (src/nav `computeIlsRadio` / `computeVorRadio`)
 * instead of the test helpers, flying the real C172S model with the simulator's wiring (AP once
 * per 60 Hz frame, flight model sub-stepped at 120 Hz). This pins the CDI "fly right" and GS
 * "fly up" signs, the magnetic OBS course and the DME schedules against the producer the
 * simulator actually uses (magnetic variation at KSFO is 12.8° E, so true ≠ magnetic here).
 */
import { describe, expect, it } from 'vitest';
import type { Navaid } from '../core/types';
import { wrap360, wrapPi } from '../core/math';
import { DEG, FT, NM } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { computeIlsRadio, computeVorRadio, type IlsGeometry, type NavRadioStateEx } from '../nav';
import { ZohSim } from './reviewHarness';

const magvarDeg = (sim: ZohSim) => wrapPi(sim.ac.headingTrueRad - sim.ac.headingMagRad) / DEG;

/** An ILS whose extended centreline passes `offsetRightNm` to the LEFT of the aircraft (it sits right of course). */
const ilsAhead = (sim: ZohSim, courseTrueDeg: number, offsetRightNm: number, distNm: number): IlsGeometry => {
  const p0 = { lat: sim.ac.geo.lat, lon: sim.ac.geo.lon, alt: 4 };
  const onCl = destinationPoint(p0, courseTrueDeg - 90, offsetRightNm * NM, 4);
  const thr = destinationPoint(onCl, courseTrueDeg, distNm * NM, 4);
  const gsRef = destinationPoint(thr, courseTrueDeg, 300, 4);
  return {
    airport: 'TEST', runway: '28', ident: 'ITST', frequencyKHz: 110300, courseDeg: courseTrueDeg, threshold: thr,
    locAntenna: destinationPoint(thr, courseTrueDeg, 3000, 4), locFullScaleDeg: Math.atan(106.7 / 3000) / DEG,
    gsAntenna: gsRef, gsReference: gsRef, glideslopeDeg: 3, markers: { outer: thr, middle: thr, inner: thr }, synthetic: true,
  };
};

describe('autopilot with the real nav receivers on the C172S model', () => {
  it('APR: LOC from a 30° intercept 1 nm right of course, GS from below; tracks within 0.3 dot / 0.1 full scale', () => {
    const sim = new ZohSim(2000 * FT, 90, 250, 2);
    const ils = ilsAhead(sim, 280, 1, 8);
    const mv = magvarDeg(sim);
    // OBS on the magnetic front course (what an auto-course radio stack would set)
    const tuning = { activeKHz: 110300, standbyKHz: 110300, obsDeg: wrap360(280 - mv) };
    const rx = sim.nav1 as NavRadioStateEx;
    sim.pilotHook = (s) => { computeIlsRadio(s.ac.geo, mv, ils, tuning, rx); };
    computeIlsRadio(sim.ac.geo, mv, ils, tuning, rx);
    expect(rx.valid).toBe(true);
    expect(rx.cdi).toBeLessThan(-0.5); // right of course: fly left
    expect(rx.gsDeviation).toBeGreaterThan(0.5); // below the path: fly up
    sim.ap.setAltitudeTarget(2000 * FT);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG));
    sim.ap.setLateral('HDG');
    sim.ap.setLateral('APR');
    expect(sim.s.armedLateral).toBe('APR');
    let locT = -1, gsT = -1, maxGsDots = 0, maxCdi = 0, maxBank = 0;
    sim.run(300, (s) => {
      if (locT < 0 && s.s.lateral === 'APR') locT = s.t;
      if (gsT < 0 && s.s.vertical === 'GS') gsT = s.t;
      maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0]));
      if (gsT > 0 && s.t > gsT + 30 && rx.dmeNm > 1.2) {
        maxGsDots = Math.max(maxGsDots, Math.abs(rx.gsDeviation * 2));
        maxCdi = Math.max(maxCdi, Math.abs(rx.cdi));
      }
      if (rx.dmeNm < 1.0) return true;
    });
    expect(locT).toBeGreaterThan(0);
    expect(gsT).toBeGreaterThan(locT);
    expect(maxGsDots).toBeLessThan(0.3);
    expect(maxCdi).toBeLessThan(0.1);
    expect(maxBank).toBeLessThan(22.5 * DEG);
    expect(rx.dmeNm).toBeLessThan(1.0); // reached the 1 nm gate on the approach
    expect(sim.s.engaged).toBe(true);
  });

  it('NAV on a VOR: converges inbound (TO, 25 and 40 nm) and outbound (FROM) from 2 nm off course', () => {
    for (const [leg, distNm] of [['to', 25], ['to', 40], ['from', 8]] as const) {
      const sim = new ZohSim(3000 * FT, 100, 90, 2);
      const mv = magvarDeg(sim);
      const p0 = { lat: sim.ac.geo.lat, lon: sim.ac.geo.lon, alt: 4 };
      const onCourse = destinationPoint(p0, 0, 2 * NM, 4); // course line 2 nm north: the aircraft is right of an eastbound course
      const station: Navaid = {
        id: 'TST', type: 'VOR-DME', name: 'TEST', frequencyKHz: 113900, magneticVariationDeg: mv, rangeNm: 130,
        position: destinationPoint(onCourse, leg === 'to' ? 90 : 270, distNm * NM, 4),
      };
      const tuning = { activeKHz: 113900, standbyKHz: 113900, obsDeg: wrap360(90 - mv) };
      const rx = sim.nav1 as NavRadioStateEx;
      sim.pilotHook = (s) => { computeVorRadio(s.ac.geo, mv, station, tuning, rx); };
      computeVorRadio(sim.ac.geo, mv, station, tuning, rx);
      expect(rx.toFrom).toBe(leg);
      expect(rx.cdi).toBeLessThan(0); // right of course: fly left
      sim.ap.engage(true);
      sim.ap.setLateral('NAV'); // from ROL, before the first frame: captured on that frame (intercept law)
      sim.frame();
      expect(sim.s.lateral).toBe('NAV');
      let maxBank = 0, overshoot = 0;
      sim.run(240, (s) => { maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0])); overshoot = Math.max(overshoot, rx.cdi); });
      expect(Math.abs(rx.cdi)).toBeLessThan(0.1); // within 1° of the radial after 4 min
      expect(overshoot).toBeLessThan(0.1); // approached from the right: no swing through to the left side
      expect(Math.abs(wrapPi(sim.ac.trackRad - 90 * DEG))).toBeLessThan(5 * DEG);
      expect(maxBank).toBeLessThan(25.5 * DEG);
      expect(sim.s.lateral).toBe('NAV');
    }
  });
});
