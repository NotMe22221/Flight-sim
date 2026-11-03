import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeAirport, decodeNavaid, decodeSurface, findRunwayEnd, reciprocalIdent, runwayEndHeadingMag, runwayEnds, runwayForEnd,
  type AirportsFile, type CompactAirport, type CompactNavaid, type NavaidsFile,
} from './airportsData';
import { ILS_CHANNELS_KHZ, buildIlsGeometry, ilsChannelIndex, landingThreshold } from './ils';
import { isIlsFrequency } from './frequencies';
import { PUBLIC_DIR } from './__tests__/fsLoader';
import type { Runway } from '../core/types';
import { greatCircleDistance } from '../geo/wgs84';

const airportsFile = JSON.parse(readFileSync(join(PUBLIC_DIR, 'data', 'airports.json'), 'utf8')) as AirportsFile;
const navaidsFile = JSON.parse(readFileSync(join(PUBLIC_DIR, 'data', 'navaids.json'), 'utf8')) as NavaidsFile;
const compact = (icao: string): CompactAirport => {
  const a = airportsFile.airports.find((x) => x.i === icao);
  if (!a) throw new Error(`${icao} missing from airports.json`);
  return a;
};

describe('airportsData', () => {
  it('KSFO decodes to 4 runways with 28R at the documented threshold', () => {
    const ksfo = decodeAirport(compact('KSFO'));
    expect(ksfo.icao).toBe('KSFO');
    expect(ksfo.iata).toBe('SFO');
    expect(ksfo.type).toBe('large');
    expect(ksfo.municipality).toBe('San Francisco');
    expect(ksfo.runways).toHaveLength(4);
    const hit = findRunwayEnd(ksfo, '28R');
    expect(hit).toBeDefined();
    const { runway, end } = hit!;
    expect(end.threshold.lat).toBeCloseTo(37.613538, 6);
    expect(end.threshold.lon).toBeCloseTo(-122.35716, 6);
    expect(end.threshold.alt).toBeCloseTo(4, 1);
    expect(end.headingDeg).toBe(298);
    expect(end.displacedThresholdM).toBe(91);
    expect(end.oppositeIdent).toBe('10L');
    expect(runway.lengthM).toBe(3618);
    expect(runway.widthM).toBe(61);
    expect(runway.surface).toBe('asphalt');
    expect(runway.lighted).toBe(true);
    expect(runway.id).toBe('10L/28R');
    // physical runway is oriented to the low-numbered end
    expect(runway.ident).toBe('10L');
    expect(runway.headingDeg).toBe(118);
    expect(runway.end).toEqual(end.threshold);
    expect(ksfo.frequencies?.find((f) => f.type === 'TWR')?.mhz).toBe(120.5);
  });

  it('runwayForEnd gives a Runway view oriented to the other end', () => {
    const ksfo = decodeAirport(compact('KSFO'));
    const rw = ksfo.runways.find((r) => r.id === '10L/28R')!;
    const v = runwayForEnd(rw, 1);
    expect(v.ident).toBe('28R');
    expect(v.headingDeg).toBe(298);
    expect(v.threshold.lat).toBeCloseTo(37.613538, 6);
    expect(v.end.lat).toBeCloseTo(37.628742, 6);
    expect(v.displacedThresholdM).toBe(91);
    expect(v.ils?.ident).toBe('ISFO');
    expect(runwayForEnd(rw, 0)).toBe(rw);
  });

  it('LOWI decodes with runway ends 08 and 26', () => {
    const lowi = decodeAirport(compact('LOWI'));
    expect(lowi.runways).toHaveLength(1);
    const [a, b] = runwayEnds(lowi.runways[0]);
    expect(a.ident).toBe('08');
    expect(b.ident).toBe('26');
    expect(a.headingDeg).toBe(81);
    expect(b.headingDeg).toBe(261);
    expect(lowi.elevationM).toBeCloseTo(581.3, 1);
    expect(lowi.country).toBe('AT');
  });

  it('a small-shard airport decodes (KHAF) without a synthetic ILS', () => {
    const file = JSON.parse(readFileSync(join(PUBLIC_DIR, 'data', 'small', '3_-13.json'), 'utf8')) as AirportsFile;
    const rec = file.airports.find((a) => a.i === 'KHAF');
    expect(rec).toBeDefined();
    const khaf = decodeAirport(rec!);
    expect(khaf.type).toBe('small');
    expect(khaf.name).toBe('Half Moon Bay Airport');
    expect(khaf.runways).toHaveLength(1);
    expect(khaf.runways[0].ends.map((e) => e.ident)).toEqual(['12', '30']);
    expect(khaf.runways[0].lengthM).toBe(1524);
    expect(khaf.runways[0].ends[0].ils).toBeUndefined();
    expect(khaf.runways[0].ils).toBeUndefined();
  });

  it('falls back to the airport elevation and geometric heading when the data is missing', () => {
    const a: CompactAirport = {
      i: 'TEST', n: 'Test', t: 'M', la: 25.3254, lo: -80.2748, e: 2.4, c: 'US',
      r: [{ id: '04/22', le: ['04', 25.3207, -80.279198, 0, 40, 0], he: ['22', 25.330099, -80.270401, null, null, 152], l: 1372, w: 21, s: 'ASP', lit: 1 }],
    };
    const ap = decodeAirport(a);
    const [le, he] = ap.runways[0].ends;
    expect(le.threshold.alt).toBeCloseTo(2.4, 6);
    expect(he.threshold.alt).toBeCloseTo(2.4, 6);
    expect(he.headingDeg).toBeGreaterThan(215);
    expect(he.headingDeg).toBeLessThan(225);
    expect(he.displacedThresholdM).toBe(152);
    expect(ap.runways[0].ils).toBeDefined(); // 1372 m ≥ 4 000 ft (1219 m) at a medium airport
    const short = decodeAirport({ ...a, r: [{ ...a.r![0], l: 1200 }] });
    expect(short.runways[0].ils).toBeUndefined(); // 1200 m < 4 000 ft
    expect(decodeAirport({ ...a, t: 'S' }).runways[0].ils).toBeUndefined(); // small airports get none
  });

  it('synthesises deterministic, in-band, per-airport-unique ILS frequencies', () => {
    const ksfo = decodeAirport(compact('KSFO'));
    const ends = ksfo.runways.flatMap((r) => r.ends);
    expect(ends).toHaveLength(8);
    const freqs = ends.map((e) => e.ils!.frequencyKHz);
    for (const e of ends) {
      expect(e.ils).toBeDefined();
      expect(e.ils!.synthetic).toBe(true);
      expect(isIlsFrequency(e.ils!.frequencyKHz)).toBe(true);
      expect(ILS_CHANNELS_KHZ).toContain(e.ils!.frequencyKHz);
      expect(e.ils!.frequencyMHz).toBeCloseTo(e.ils!.frequencyKHz / 1000, 6);
      expect(e.ils!.glideslopeDeg).toBe(3);
      expect(e.ils!.locCourseDeg).toBe(e.headingDeg);
      expect(e.ils!.ident).toBe('ISFO');
    }
    expect(new Set(freqs).size).toBe(8);
    // deterministic across decodes
    const again = decodeAirport(compact('KSFO')).runways.flatMap((r) => r.ends).map((e) => e.ils!.frequencyKHz);
    expect(again).toEqual(freqs);
    expect(ilsChannelIndex('KSFO', '28R')).toBe(ilsChannelIndex('KSFO', '28R'));
    expect(ilsChannelIndex('KSFO', '28R')).not.toBe(ilsChannelIndex('KSFO', '28L'));
    // the physical runway's contract-level `ils` is the low-numbered end's
    expect(ksfo.runways[0].ils).toBe(ksfo.runways[0].ends[0].ils);
  });

  it('builds ILS geometry: antenna beyond the far end, ±350 ft full scale at the threshold', () => {
    const ksfo = decodeAirport(compact('KSFO'));
    const rw = ksfo.runways.find((r) => r.id === '10L/28R')!;
    const g = buildIlsGeometry('KSFO', rw, 1)!;
    expect(g.runway).toBe('28R');
    expect(g.courseDeg).toBe(298);
    const thr = landingThreshold(rw.ends[1]);
    expect(greatCircleDistance(thr, rw.ends[1].threshold)).toBeCloseTo(91, 0);
    expect(g.threshold).toEqual(thr);
    const dLoc = greatCircleDistance(g.locAntenna, thr);
    // antenna ≈ (3618 − 91 + 300) m from the landing threshold
    expect(dLoc).toBeGreaterThan(3618 - 91 + 300 - 30);
    expect(dLoc).toBeLessThan(3618 - 91 + 300 + 30);
    expect(g.locFullScaleDeg).toBeCloseTo((Math.atan(106.7 / dLoc) * 180) / Math.PI, 6);
    expect(greatCircleDistance(g.gsReference, thr)).toBeCloseTo(300, 0);
    expect(greatCircleDistance(g.gsAntenna, g.gsReference)).toBeCloseTo(120, 0);
    expect(greatCircleDistance(g.markers.outer, thr)).toBeCloseTo(4 * 1852, 0); // OM 4 nm
    expect(greatCircleDistance(g.markers.middle, thr)).toBeCloseTo(1050, 0);
    expect(greatCircleDistance(g.markers.inner, thr)).toBeCloseTo(300, 0);
    expect(buildIlsGeometry('KSFO', { ...rw, ends: [{ ...rw.ends[0], ils: undefined }, rw.ends[1]] }, 0)).toBeUndefined();
  });

  it('runwayEndHeadingMag applies the WMM declination', () => {
    const ksfo = decodeAirport(compact('KSFO'));
    const end = findRunwayEnd(ksfo, '28R')!.end;
    const mag = runwayEndHeadingMag(end, Date.UTC(2026, 10, 2));
    expect(mag).toBeGreaterThan(284);
    expect(mag).toBeLessThan(286);
  });

  it('decodes navaids (OAK VORTAC) and maps NDB-DME to NDB with hasDme', () => {
    const oakRow = navaidsFile.navaids.find((n) => n[0] === 'OAK' && n[2] === 'VORTAC')!;
    const oak = decodeNavaid(oakRow);
    expect(oak.type).toBe('VORTAC');
    expect(oak.frequencyKHz).toBe(116_800);
    expect(oak.magneticVariationDeg).toBe(17);
    expect(oak.position.alt).toBe(3);
    expect(oak.hasDme).toBe(true);
    expect(oak.rangeNm).toBe(130);
    expect(oak.associatedAirport).toBe('KOAK');
    const ndbDme: CompactNavaid = ['AB', 'Test', 'NDB-DME', 350, 10, 10, null, null, ''];
    const n = decodeNavaid(ndbDme);
    expect(n.type).toBe('NDB');
    expect(n.hasDme).toBe(true);
    expect(n.position.alt).toBe(0);
    expect(n.magneticVariationDeg).toBe(0);
    expect(decodeNavaid(['X', 'Bad', 'VOR', -1, 0, 0, 0, 0, '']).frequencyKHz).toBe(0);
  });

  it('maps surface codes and reciprocal idents', () => {
    expect(decodeSurface('ASP')).toBe('asphalt');
    expect(decodeSurface('CON')).toBe('concrete');
    expect(decodeSurface('GRS')).toBe('grass');
    expect(decodeSurface('GRE')).toBe('gravel');
    expect(decodeSurface('GRVL')).toBe('gravel');
    expect(decodeSurface('WAT')).toBe('water');
    expect(decodeSurface('DIRT')).toBe('other');
    expect(decodeSurface('UNK')).toBe('other');
    expect(reciprocalIdent('28R')).toBe('10L');
    expect(reciprocalIdent('10L')).toBe('28R');
    expect(reciprocalIdent('08')).toBe('26');
    expect(reciprocalIdent('36')).toBe('18');
    expect(reciprocalIdent('18')).toBe('36');
    expect(reciprocalIdent('09C')).toBe('27C');
    expect(reciprocalIdent('N')).toBe('N');
  });

  it('runwayEnds derives both ends from a plain contract Runway', () => {
    const rw: Runway = {
      ident: '27', threshold: { lat: 47, lon: 11, alt: 500 }, end: { lat: 47, lon: 11.03, alt: 500 }, headingDeg: 270,
      lengthM: 2000, widthM: 45, surface: 'asphalt', lighted: true, displacedThresholdM: 0,
      ils: { frequencyMHz: 109.1, ident: 'ITST', glideslopeDeg: 3, locCourseDeg: 270 },
    };
    const [a, b] = runwayEnds(rw);
    expect(a.ident).toBe('27');
    expect(b.ident).toBe('09');
    expect(b.headingDeg).toBe(90);
    expect(b.threshold).toBe(rw.end);
    expect(a.ils?.frequencyKHz).toBe(109_100);
    expect(a.ils?.synthetic).toBe(false);
    expect(b.ils).toBeUndefined();
    expect(findRunwayEnd({ icao: 'T', name: '', position: a.threshold, elevationM: 0, type: 'small', country: '', runways: [rw] }, '9')?.end.ident).toBe('09');
  });
});
