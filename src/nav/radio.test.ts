import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Geodetic, Navaid } from '../core/types';
import { FT, NM } from '../core/units';
import { destinationPoint, greatCircleDistance } from '../geo/wgs84';
import { PUBLIC_DIR } from './__tests__/fsLoader';
import { decodeAirport, type AirportsFile } from './airportsData';
import { buildIlsGeometry, type IlsGeometry } from './ils';
import {
  alongTrackM, computeIlsRadio, computeNavRadio, computeVorRadio, crossTrackM, desiredTrackDeg, dmeSlantNm, emptyNavRadioState,
  glideslopeDeviation, inVhfRange, legGeometry, localizerDeviation, markerBeacon, radioHorizonNm, turnAnticipationM, turnRadiusM,
  vorDeviationDeg, vorRadialDeg,
} from './radio';

const D2R = Math.PI / 180;

/** A VOR with a 13° E station declination so that magnetic north is 013° true. */
const VOR: Navaid = { id: 'TST', type: 'VOR', name: 'Test', position: { lat: 37, lon: -122, alt: 0 }, frequencyKHz: 112_000, magneticVariationDeg: 13, rangeNm: 40 };
const MAGVAR = 13; // declination at the aircraft
const tuning = (obsDeg: number) => ({ activeKHz: 112_000, standbyKHz: 108_000, obsDeg });
/** aircraft on a given magnetic radial at `nm` from the VOR */
const onRadial = (radialMag: number, nm: number, altM = 1500): Geodetic => destinationPoint(VOR.position, radialMag + VOR.magneticVariationDeg, nm * NM, altM);

function ksfo28R(): IlsGeometry {
  const file = JSON.parse(readFileSync(join(PUBLIC_DIR, 'data', 'airports.json'), 'utf8')) as AirportsFile;
  const ksfo = decodeAirport(file.airports.find((a) => a.i === 'KSFO')!);
  const rw = ksfo.runways.find((r) => r.id === '10L/28R')!;
  return buildIlsGeometry('KSFO', rw, 1)!;
}

/** Point on the approach (`nm` before the GS reference point), at the glidepath height plus `extraM`. */
function onApproach(ils: IlsGeometry, nm: number, extraM = 0, lateralM = 0): Geodetic {
  const d = nm * NM;
  const p = destinationPoint(ils.gsReference, ils.courseDeg + 180, d);
  const q = lateralM ? destinationPoint(p, ils.courseDeg + 90, lateralM) : p;
  q.alt = ils.gsReference.alt + d * Math.tan(ils.glideslopeDeg * D2R) + extraM;
  return q;
}

describe('radio: VOR', () => {
  it('10 nm due magnetic north: radial 000, bearing-to 180, OBS 180 → TO centred, OBS 360 → FROM centred', () => {
    const ac = onRadial(0, 10);
    expect(vorRadialDeg(VOR, ac)).toBeCloseTo(0, 1);
    const s = computeVorRadio(ac, MAGVAR, VOR, tuning(180));
    expect(s.valid).toBe(true);
    expect(s.ident).toBe('TST');
    expect(Math.abs(s.radialDeg % 360)).toBeLessThan(0.1);
    expect(s.bearingDeg).toBeCloseTo(180, 1);
    expect(s.toFrom).toBe('to');
    expect(Math.abs(s.cdi)).toBeLessThan(0.01);
    expect(s.dmeNm).toBeCloseTo(Math.hypot(10, 1500 / NM), 2);
    expect(s.isLocalizer).toBe(false);
    expect(s.obsDeg).toBe(180);
    const f = computeVorRadio(ac, MAGVAR, VOR, tuning(360));
    expect(f.toFrom).toBe('from');
    expect(Math.abs(f.cdi)).toBeLessThan(0.01);
  });

  it('5° right of course → CDI −0.5 (fly left), both FROM and TO', () => {
    // Outbound on course 360 (FROM): right of course = east = radial 005
    const from = computeVorRadio(onRadial(5, 10), MAGVAR, VOR, tuning(360));
    expect(from.toFrom).toBe('from');
    expect(from.cdi).toBeCloseTo(-0.5, 2);
    // Inbound on course 180 from the north (TO): right of course = west = radial 355
    const to = computeVorRadio(onRadial(355, 10), MAGVAR, VOR, tuning(180));
    expect(to.toFrom).toBe('to');
    expect(to.cdi).toBeCloseTo(-0.5, 2);
    // and left of course → +0.5 (fly right)
    expect(computeVorRadio(onRadial(355, 10), MAGVAR, VOR, tuning(360)).cdi).toBeCloseTo(0.5, 2);
    expect(computeVorRadio(onRadial(5, 10), MAGVAR, VOR, tuning(180)).cdi).toBeCloseTo(0.5, 2);
  });

  it('full scale is ±10° and clamps beyond', () => {
    expect(computeVorRadio(onRadial(10, 10), MAGVAR, VOR, tuning(360)).cdi).toBeCloseTo(-1, 2);
    expect(computeVorRadio(onRadial(25, 10), MAGVAR, VOR, tuning(360)).cdi).toBe(-1);
    expect(computeVorRadio(onRadial(350, 10), MAGVAR, VOR, tuning(360)).cdi).toBeCloseTo(1, 2);
    expect(vorDeviationDeg(90, 0)).toEqual({ toFrom: 'from', deviationDeg: 90 });
    expect(vorDeviationDeg(91, 0).toFrom).toBe('to');
  });

  it('TO/FROM flips across the abeam line', () => {
    expect(computeVorRadio(onRadial(80, 10), MAGVAR, VOR, tuning(360)).toFrom).toBe('from');
    expect(computeVorRadio(onRadial(100, 10), MAGVAR, VOR, tuning(360)).toFrom).toBe('to');
  });

  it('cone of confusion within 1 nm overhead flags the CDI off but keeps DME', () => {
    const s = computeVorRadio(onRadial(0, 0.5, 1000), MAGVAR, VOR, tuning(360));
    expect(s.valid).toBe(true);
    expect(s.toFrom).toBe('off');
    expect(s.cdi).toBe(0);
    expect(s.dmeNm).toBeCloseTo(Math.hypot(0.5, 1000 / NM), 2);
  });

  it('range: line of sight and the published range both limit reception', () => {
    expect(radioHorizonNm(3000, 0)).toBeCloseTo(1.23 * (Math.sqrt(3000 / FT) + Math.sqrt(10 / FT)), 3);
    // on the ground 30 nm away: below the radio horizon
    expect(computeVorRadio(onRadial(0, 30, 0), MAGVAR, VOR, tuning(360)).valid).toBe(false);
    // at 3000 m, 30 nm: in range
    expect(computeVorRadio(onRadial(0, 30, 3000), MAGVAR, VOR, tuning(360)).valid).toBe(true);
    // at 3000 m, 50 nm: beyond the 40 nm published range
    const far = computeVorRadio(onRadial(0, 50, 3000), MAGVAR, VOR, tuning(360));
    expect(far.valid).toBe(false);
    expect(far.toFrom).toBe('off');
    expect(far.cdi).toBe(0);
    expect(inVhfRange(39 * NM, 3000, 0, 40)).toBe(true);
    expect(inVhfRange(41 * NM, 3000, 0, 40)).toBe(false);
  });

  it('DME-only and NDB stations give distance/bearing but no course deviation', () => {
    const dme: Navaid = { ...VOR, type: 'DME' };
    const s = computeVorRadio(onRadial(0, 10), MAGVAR, dme, tuning(180));
    expect(s.valid).toBe(true);
    expect(s.toFrom).toBe('off');
    expect(s.dmeNm).toBeGreaterThan(9.9);
    const ndb: Navaid = { ...VOR, type: 'NDB', rangeNm: 50 };
    expect(computeVorRadio(onRadial(0, 45, 0), MAGVAR, ndb, tuning(0)).valid).toBe(true);
    expect(computeVorRadio(onRadial(0, 55, 0), MAGVAR, ndb, tuning(0)).valid).toBe(false);
    expect(dmeSlantNm({ lat: 37, lon: -122, alt: 1852 }, VOR.position)).toBeCloseTo(1, 6);
  });

  it('computeNavRadio dispatches and the empty state is flagged', () => {
    const e = computeNavRadio(onRadial(0, 10), MAGVAR, undefined, tuning(90));
    expect(e.valid).toBe(false);
    expect(e.toFrom).toBe('off');
    expect(e.obsDeg).toBe(90);
    expect(e.ident).toBe('');
    const out = emptyNavRadioState();
    const v = computeNavRadio(onRadial(0, 10), MAGVAR, VOR, tuning(180), out);
    expect(v).toBe(out);
    expect(v.toFrom).toBe('to');
    const i = computeNavRadio(onApproach(ksfo28R(), 3), 13, ksfo28R(), tuning(298));
    expect(i.isLocalizer).toBe(true);
  });
});

describe('radio: ILS', () => {
  const ils = ksfo28R();

  it('on the centreline on the 3° path → both deviations ≈ 0', () => {
    const s = computeIlsRadio(onApproach(ils, 3), 13, ils, tuning(298));
    expect(s.valid).toBe(true);
    expect(s.gsValid).toBe(true);
    expect(s.isLocalizer).toBe(true);
    expect(s.backCourse).toBe(false);
    expect(Math.abs(s.cdi)).toBeLessThan(0.02);
    expect(Math.abs(s.gsDeviation)).toBeLessThan(0.02);
    expect(s.ident).toBe('ISFO');
    expect(s.toFrom).toBe('off');
    expect(s.dmeNm).toBeGreaterThan(3);
    expect(s.dmeNm).toBeLessThan(3.3);
    expect(s.radialDeg).toBeCloseTo(285, 6); // magnetic front course
  });

  it('100 ft high at 2 nm → glideslope deviation ≈ −0.67 (fly down)', () => {
    const s = computeIlsRadio(onApproach(ils, 2, 100 * FT), 13, ils, tuning(298));
    expect(s.gsValid).toBe(true);
    expect(s.gsDeviation).toBeLessThan(0);
    expect(s.gsDeviation).toBeCloseTo(-0.67, 1);
    expect(Math.abs(s.gsDeviation + 0.672)).toBeLessThan(0.02);
    const g = glideslopeDeviation(ils, onApproach(ils, 2, 100 * FT));
    expect(g.errorDeg).toBeCloseTo(-0.47, 2);
    // 100 ft low → +0.67 (fly up); far below → clamped +1
    expect(computeIlsRadio(onApproach(ils, 2, -100 * FT), 13, ils, tuning(298)).gsDeviation).toBeCloseTo(0.67, 1);
    expect(computeIlsRadio(onApproach(ils, 2, -400 * FT), 13, ils, tuning(298)).gsDeviation).toBe(1);
  });

  it('350 ft right of the centreline at the threshold → localizer −1 (fly left); left → +1', () => {
    const right = destinationPoint(ils.threshold, ils.courseDeg + 90, 350 * FT, 20);
    const s = computeIlsRadio(right, 13, ils, tuning(298));
    expect(s.valid).toBe(true);
    expect(s.cdi).toBeCloseTo(-1, 1);
    expect(Math.abs(s.cdi + 1)).toBeLessThan(0.02);
    const left = destinationPoint(ils.threshold, ils.courseDeg - 90, 350 * FT, 20);
    expect(computeIlsRadio(left, 13, ils, tuning(298)).cdi).toBeCloseTo(1, 1);
    // half that offset → half scale; way off → clamped
    expect(computeIlsRadio(destinationPoint(ils.threshold, ils.courseDeg + 90, 175 * FT, 20), 13, ils, tuning(298)).cdi).toBeCloseTo(-0.5, 1);
    expect(localizerDeviation(ils, destinationPoint(ils.threshold, ils.courseDeg + 90, 2000, 20)).cdi).toBe(-1);
    // the course width is angular: 350 ft right at 3 nm is only a fraction of full scale
    expect(Math.abs(computeIlsRadio(onApproach(ils, 3, 0, 350 * FT), 13, ils, tuning(298)).cdi)).toBeLessThan(0.5);
    expect(computeIlsRadio(onApproach(ils, 3, 0, 350 * FT), 13, ils, tuning(298)).cdi).toBeLessThan(0);
  });

  it('back course: reverse sensing, no glideslope', () => {
    // 3 nm beyond the localizer antenna, 100 m on the right-hand side of the front course
    const behind = destinationPoint(ils.locAntenna, ils.courseDeg, 3 * NM, 300);
    const rightSide = destinationPoint(behind, ils.courseDeg + 90, 100, 300);
    const s = computeIlsRadio(rightSide, 13, ils, tuning(298));
    expect(s.valid).toBe(true);
    expect(s.backCourse).toBe(true);
    expect(s.gsValid).toBe(false);
    expect(s.gsDeviation).toBe(0);
    expect(s.cdi).toBeLessThan(0); // geographic right of the front course → "fly left"
    const leftSide = destinationPoint(behind, ils.courseDeg - 90, 100, 300);
    expect(computeIlsRadio(leftSide, 13, ils, tuning(298)).cdi).toBeGreaterThan(0);
  });

  it('marker beacons', () => {
    const over = (p: Geodetic, alt = 150) => ({ lat: p.lat, lon: p.lon, alt });
    expect(markerBeacon(ils, over(ils.markers.outer))).toBe('outer');
    expect(markerBeacon(ils, over(ils.markers.middle))).toBe('middle');
    expect(markerBeacon(ils, over(ils.markers.inner))).toBe('inner');
    expect(markerBeacon(ils, over(destinationPoint(ils.markers.outer, ils.courseDeg + 180, 500)))).toBeNull();
    expect(markerBeacon(ils, over(destinationPoint(ils.markers.outer, ils.courseDeg + 90, 400)))).toBeNull();
    expect(markerBeacon(ils, over(destinationPoint(ils.markers.outer, ils.courseDeg + 90, 200)))).toBe('outer');
    const s = computeIlsRadio(onApproach(ils, (7200 + 300) / NM), 13, ils, tuning(298));
    expect(s.marker).toBe('outer');
    expect(computeIlsRadio(onApproach(ils, 3), 13, ils, tuning(298)).marker).toBeNull();
  });

  it('localizer range: 18 nm on course, 10 nm wide, flagged beyond; glideslope within 10 nm', () => {
    expect(computeIlsRadio(onApproach(ils, 15), 13, ils, tuning(298)).valid).toBe(true);
    expect(computeIlsRadio(onApproach(ils, 15), 13, ils, tuning(298)).gsValid).toBe(false);
    expect(computeIlsRadio(onApproach(ils, 9), 13, ils, tuning(298)).gsValid).toBe(true);
    const far = computeIlsRadio(onApproach(ils, 25), 13, ils, tuning(298));
    expect(far.valid).toBe(false);
    expect(far.cdi).toBe(0);
    // 15 nm out but 30° off the course: outside the ±10° / 18 nm lobe and the ±35° / 10 nm lobe
    const wide = destinationPoint(ils.locAntenna, ils.courseDeg + 180 + 30, 15 * NM, 1500);
    expect(computeIlsRadio(wide, 13, ils, tuning(298)).valid).toBe(false);
    const wideNear = destinationPoint(ils.locAntenna, ils.courseDeg + 180 + 30, 8 * NM, 1500);
    expect(computeIlsRadio(wideNear, 13, ils, tuning(298)).valid).toBe(true);
    expect(computeIlsRadio(wideNear, 13, ils, tuning(298)).cdi).toBe(1); // course far to the right → full scale
    // on the ground at the far end of the runway, still within line of sight
    expect(computeIlsRadio({ ...ils.locAntenna, alt: 4 }, 13, ils, tuning(298)).valid).toBe(true);
  });
});

describe('radio: GPS leg geometry', () => {
  const A: Geodetic = { lat: 0, lon: 0, alt: 0 };
  const B: Geodetic = { lat: 0, lon: 10, alt: 0 };

  it('cross-track is + right of course, along-track measures from the start', () => {
    const right: Geodetic = { lat: -0.1, lon: 5, alt: 0 }; // south of an eastbound leg = right
    expect(crossTrackM(A, B, right)).toBeCloseTo(0.1 * 111_195, -3);
    expect(crossTrackM(A, B, { lat: 0.1, lon: 5, alt: 0 })).toBeCloseTo(-0.1 * 111_195, -3);
    expect(alongTrackM(A, B, right)).toBeCloseTo(5 * 111_195, -3);
    expect(alongTrackM(A, B, { lat: 0, lon: -1, alt: 0 })).toBeCloseTo(-111_195, -3);
    expect(desiredTrackDeg(A, B, right)).toBeCloseTo(90, 1);
    const g = legGeometry(A, B, right);
    expect(g.legLengthM).toBeCloseTo(10 * 111_195, -3);
    expect(g.remainingM).toBeCloseTo(5 * 111_195, -3);
    expect(g.distanceToEndM).toBeCloseTo(greatCircleDistance(right, B), 6);
    expect(g.bearingToEndDeg).toBeGreaterThan(88);
    expect(g.bearingToEndDeg).toBeLessThan(90);
  });

  it('turn radius and anticipation follow r = V²/(g·tan φ)', () => {
    const r = turnRadiusM(56.6, 25);
    expect(r).toBeCloseTo((56.6 * 56.6) / (9.80665 * Math.tan(25 * D2R)), 6);
    expect(r).toBeGreaterThan(680);
    expect(r).toBeLessThan(700);
    expect(turnAnticipationM(56.6, 90)).toBeCloseTo(r, 6);
    expect(turnAnticipationM(56.6, 60)).toBeCloseTo(r * Math.tan(30 * D2R), 6);
    expect(turnAnticipationM(56.6, 150)).toBeCloseTo(r, 6); // capped at 90° (abeam logic)
    expect(turnAnticipationM(56.6, 0)).toBe(0);
    expect(turnAnticipationM(0, 90)).toBe(0);
  });
});
