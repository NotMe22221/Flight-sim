/**
 * Spot checks of numbers and formulas quoted in docs/research/05-cockpit-avionics-navigation.md §4
 * and its §11 validation checklist, plus sign/convention edge cases (TO/FROM ambiguity, radial vs
 * bearing, station vs local declination, DME availability, cone of confusion).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Geodetic, Navaid } from '../core/types';
import { deltaDeg } from '../core/math';
import { FT, KT, M_TO_FT, NM } from '../core/units';
import { decimalYear, magneticDeclinationAtYearDeg } from '../geo/magvar';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { PUBLIC_DIR } from './__tests__/fsLoader';
import { decodeAirport, findRunwayEnd, type AirportsFile, type CompactRunway } from './airportsData';
import { FlightPlanner, waypointFromAirport } from './flightPlan';
import { buildIlsGeometry, type IlsGeometry } from './ils';
import type { NavaidRecord, RunwayRecord } from './navTypes';
import { computeIlsRadio, computeVorRadio, localizerDeviation, vorConeRadiusM, vorDeviationDeg, vorRadialDeg } from './radio';
import { decodeRunway } from './airportsData';
import { synthesizeIls } from './ils';

const D2R = Math.PI / 180;
const file = JSON.parse(readFileSync(join(PUBLIC_DIR, 'data', 'airports.json'), 'utf8')) as AirportsFile;
const airport = (icao: string) => decodeAirport(file.airports.find((a) => a.i === icao)!);
function ilsFor(icao: string, ident: string): IlsGeometry {
  const ap = airport(icao);
  const hit = findRunwayEnd(ap, ident)!;
  return buildIlsGeometry(icao, hit.runway, hit.end.index)!;
}
const tune = (obsDeg: number) => ({ activeKHz: 115_800, standbyKHz: 108_000, obsDeg });

describe('spec §4.1 geodesy test vectors', () => {
  const KSFO = { lat: 37.6199, lon: -122.3748, alt: 0 };
  it.each([
    ['KOAK', { lat: 37.7201, lon: -122.2212, alt: 0 }, 9.459, 3, 50.5],
    ['KSEA', { lat: 47.4479, lon: -122.3103, alt: 0 }, 590.09, 2, 0.3],
    ['LOWI', { lat: 47.2602, lon: 11.344, alt: 0 }, 5139.2, 1, 29.5],
  ] as const)('KSFO → %s', (_id, to, nm, decimals, brg) => {
    // half a unit in the last quoted digit, plus 1.4 ppm because the spec's sphere is
    // R = 6 371 008.8 m and wgs84.ts uses 6 371 000 m
    expect(Math.abs(greatCircleDistance(KSFO, to) / NM - nm)).toBeLessThan(0.5 * 10 ** -decimals + 1.4e-6 * nm);
    expect(Math.abs(deltaDeg(initialBearingDeg(KSFO, to), brg))).toBeLessThan(0.06);
  });

  it('§11.6 GPS D→ KOAK from KSFO: DIS 9.46 nm, BRG 050° T, ≈ 037.7° M with the WMM declination', () => {
    const fp = new FlightPlanner();
    const koak = waypointFromAirport({ icao: 'KOAK', position: { lat: 37.7201, lon: -122.2212, alt: 2 } });
    fp.directTo(koak, KSFO);
    const s = fp.update(KSFO, 50)!;
    expect(s.distanceToActiveM / NM).toBeCloseTo(9.46, 2);
    expect(s.bearingToActiveDeg).toBeCloseTo(50.46, 1);
    const decl = magneticDeclinationAtYearDeg(KSFO.lat, KSFO.lon, 0, decimalYear(Date.UTC(2026, 10, 2)));
    expect(decl).toBeCloseTo(12.8, 1); // east positive
    expect(s.bearingToActiveDeg - decl).toBeCloseTo(37.7, 0); // magnetic = true − east declination
  });
});

describe('spec §4.3 VOR', () => {
  // SFO VOR with the 13.1° E variation of the worked example (the data carries the 17° slaved value).
  const SFO: Navaid = { id: 'SFO', type: 'VOR-DME', name: 'San Francisco', position: { lat: 37.6195, lon: -122.374, alt: 4 }, frequencyKHz: 115_800, magneticVariationDeg: 13.1, rangeNm: 40 };
  const AC: Geodetic = { lat: 37.74, lon: -122.22, alt: 1500 };

  it('worked example: true bearing 045.3°, radial ≈ 032°, 10.3 nm; CDI centres on OBS 032 FROM and 212 TO', () => {
    expect(initialBearingDeg(SFO.position, AC)).toBeCloseTo(45.3, 1);
    const radial = vorRadialDeg(SFO, AC);
    expect(radial).toBeCloseTo(32.2, 1);
    expect(greatCircleDistance(SFO.position, AC) / NM).toBeCloseTo(10.3, 1);
    const from = computeVorRadio(AC, 13.1, SFO, tune(32));
    expect(from.toFrom).toBe('from');
    expect(Math.abs(from.cdi)).toBeLessThan(0.03);
    const to = computeVorRadio(AC, 13.1, SFO, tune(212));
    expect(to.toFrom).toBe('to');
    expect(Math.abs(to.cdi)).toBeLessThan(0.03);
    // radial vs bearing: with equal declinations the magnetic bearing TO the station is the reciprocal radial
    expect(Math.abs(deltaDeg(to.bearingDeg, radial + 180))).toBeLessThan(0.2);
  });

  it('radials use the station declination; the bearing-to uses the local (aircraft) declination', () => {
    const slaved: Navaid = { ...SFO, magneticVariationDeg: 17 };
    const s = computeVorRadio(AC, 13.1, slaved, tune(28));
    expect(s.radialDeg).toBeCloseTo(45.3 - 17, 1);
    expect(s.bearingDeg).toBeCloseTo(wrapDeg(initialBearingDeg(AC, SFO.position) - 13.1), 6);
    expect(Math.abs(s.cdi)).toBeLessThan(0.05); // OBS 028 centres on the station-declination radial
  });

  it('TO/FROM flips exactly at 90° off the radial and the needle stays pinned to the same side', () => {
    expect(vorDeviationDeg(89.99, 0).toFrom).toBe('from');
    expect(vorDeviationDeg(90.01, 0).toFrom).toBe('to');
    expect(vorDeviationDeg(-89.99, 0).toFrom).toBe('from');
    expect(vorDeviationDeg(-90.01, 0).toFrom).toBe('to');
    // across the flip the deviation keeps its sign (full-scale fly right / fly left on both sides)
    expect(Math.sign(vorDeviationDeg(89.99, 0).deviationDeg)).toBe(Math.sign(vorDeviationDeg(90.01, 0).deviationDeg));
    expect(Math.sign(vorDeviationDeg(-89.99, 0).deviationDeg)).toBe(Math.sign(vorDeviationDeg(-90.01, 0).deviationDeg));
    // and it is geometrically right: on radial 300 with OBS 030 the course line (030/210) lies to the right
    expect(vorDeviationDeg(30, 300).deviationDeg).toBeGreaterThan(0);
    // reciprocal OBS gives the reciprocal sense: needle centred, flag swapped
    expect(vorDeviationDeg(180, 0)).toEqual({ toFrom: 'to', deviationDeg: 0 });
  });

  it('cone of confusion grows with height: max(300 m, h·tan 50°)', () => {
    expect(vorConeRadiusM(0)).toBe(300);
    expect(vorConeRadiusM(3048)).toBeCloseTo(3048 * Math.tan(50 * D2R), 6); // ≈ 3.6 km at 10 000 ft
    // 1.5 nm from the station at 10 000 ft above it: inside the cone → flag
    const high = destinationPoint(SFO.position, 45.3, 1.5 * NM, 4 + 3048);
    expect(computeVorRadio(high, 13.1, SFO, tune(32)).toFrom).toBe('off');
    // the same 1.5 nm at 1 000 ft above it: outside the cone → a usable FROM indication
    const low = destinationPoint(SFO.position, 45.3, 1.5 * NM, 4 + 1000 * FT);
    const s = computeVorRadio(low, 13.1, SFO, tune(32));
    expect(s.toFrom).toBe('from');
    expect(Math.abs(s.cdi)).toBeLessThan(0.05);
  });

  it('DME availability: VOR-DME/VORTAC/DME yes, plain VOR and NDB no, NDB-DME yes', () => {
    expect(computeVorRadio(AC, 13.1, SFO, tune(32)).dmeValid).toBe(true);
    expect(computeVorRadio(AC, 13.1, { ...SFO, type: 'VORTAC' }, tune(32)).dmeValid).toBe(true);
    expect(computeVorRadio(AC, 13.1, { ...SFO, type: 'DME' }, tune(32)).dmeValid).toBe(true);
    expect(computeVorRadio(AC, 13.1, { ...SFO, type: 'VOR' }, tune(32)).dmeValid).toBe(false);
    expect(computeVorRadio(AC, 13.1, { ...SFO, type: 'NDB', rangeNm: 50 }, tune(32)).dmeValid).toBe(false);
    const ndbDme: NavaidRecord = { ...SFO, type: 'NDB', rangeNm: 50, hasDme: true, associatedAirport: '' };
    expect(computeVorRadio(AC, 13.1, ndbDme, tune(32)).dmeValid).toBe(true);
    // out of range → no DME either
    expect(computeVorRadio(destinationPoint(SFO.position, 0, 60 * NM, 3000), 13.1, SFO, tune(0)).dmeValid).toBe(false);
  });
});

describe('spec §4.4 ILS geometry', () => {
  it('course widths: 2·atan(350 ft / (threshold→LOC antenna)), clamped to 3°–6°', () => {
    // KTRK 11 (7 001 ft, no displacement) → 5.01°; LOWI 26 (6 562 ft) → 5.30° (spec §4.4). The code
    // measures the threshold→far-end distance from the coordinates (KTRK's are 2 172 m apart, the
    // published length is 2 134 m), hence the 0.1° allowance.
    expect(Math.abs(2 * ilsFor('KTRK', '11').locFullScaleDeg - 5.01)).toBeLessThan(0.1);
    expect(Math.abs(2 * ilsFor('LOWI', '26').locFullScaleDeg - 5.3)).toBeLessThan(0.1);
    // KSFO 28R has a 91 m displaced threshold, so the antenna is 3 527 + 300 m away (spec: 3.12° from the full length)
    const sfo = ilsFor('KSFO', '28R');
    expect(2 * sfo.locFullScaleDeg).toBeCloseTo(2 * Math.atan(106.7 / (3618 - 91 + 300)) / D2R, 2);
    expect(2 * sfo.locFullScaleDeg).toBeGreaterThan(3.1);
    expect(2 * sfo.locFullScaleDeg).toBeLessThan(3.25);
    // a 5 000 ft runway would be 6.68° wide → clamped to 6.0°
    const short: CompactRunway = { id: '12/30', le: ['12', 37.5, -122.5, 20, 135, 0], he: ['30', 37.5 - 0.00969, -122.5 + 0.01221, 20, 315, 0], l: 1524, w: 45, s: 'ASP', lit: 1 };
    const rw: RunwayRecord = decodeRunway(short, 20);
    synthesizeIls('KXXX', [rw]);
    expect(2 * buildIlsGeometry('KXXX', rw, 0)!.locFullScaleDeg).toBeCloseTo(6, 6);
  });

  it('§11.5 full scale is angular: at 5 nm from the antenna it is D·tan(half-width) either side', () => {
    const ils = ilsFor('KSFO', '28R');
    const D = 5 * NM;
    const onCl = destinationPoint(ils.locAntenna, ils.courseDeg + 180, D, 500);
    const half = D * Math.tan(ils.locFullScaleDeg * D2R);
    expect(2 * half * M_TO_FT).toBeGreaterThan(1600); // ≈ 1 650–1 700 ft total (spec: ≈ 1 650 ft at 3.12°)
    expect(2 * half * M_TO_FT).toBeLessThan(1720);
    expect(localizerDeviation(ils, destinationPoint(onCl, ils.courseDeg + 90, half, 500)).cdi).toBeCloseTo(-1, 2);
    expect(localizerDeviation(ils, destinationPoint(onCl, ils.courseDeg - 90, half / 2, 500)).cdi).toBeCloseTo(0.5, 2);
  });

  it('§11.5 glideslope: ±0.7° full scale, 0.35° = half scale, TCH ≈ 52 ft, 3° at 90 kt ≈ 478 fpm', () => {
    const ils = ilsFor('KSFO', '28R');
    const at = (nm: number, angleDeg: number): Geodetic => {
      const p = destinationPoint(ils.gsReference, ils.courseDeg + 180, nm * NM);
      p.alt = ils.gsReference.alt + nm * NM * Math.tan(angleDeg * D2R);
      return p;
    };
    expect(computeIlsRadio(at(4, 3.7), 13, ils, tune(285)).gsDeviation).toBeCloseTo(-1, 3); // 0.7° high → full fly-down
    expect(computeIlsRadio(at(4, 2.3), 13, ils, tune(285)).gsDeviation).toBeCloseTo(1, 3); // 0.7° low → full fly-up
    expect(computeIlsRadio(at(4, 3.35), 13, ils, tune(285)).gsDeviation).toBeCloseTo(-0.5, 3);
    // threshold crossing height: the path is referenced 300 m (≈ 1 000 ft) beyond the threshold
    const tchM = greatCircleDistance(ils.threshold, ils.gsReference) * Math.tan(3 * D2R);
    expect(tchM * M_TO_FT).toBeCloseTo(51.6, 0);
    const overThr = { ...ils.threshold, alt: ils.threshold.alt + tchM };
    expect(Math.abs(computeIlsRadio(overThr, 13, ils, tune(285)).gsDeviation)).toBeLessThan(0.01);
    // descending along the beam at 90 kt ground speed for one minute loses ≈ 478 ft
    const a = at(5, 3), b = at(5 - (90 * KT * 60) / NM, 3);
    expect(((a.alt - b.alt) * M_TO_FT)).toBeCloseTo(477.7, 0);
  });
});

function wrapDeg(d: number): number { return ((d % 360) + 360) % 360; }
