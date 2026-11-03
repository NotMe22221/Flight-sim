import { describe, expect, it } from 'vitest';
import type { Geodetic } from '../core/types';
import { NM } from '../core/units';
import { greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { countingLoader } from './__tests__/fsLoader';
import { FAF_DISTANCE_NM, approachWaypoints, ilsApproaches } from './approaches';
import { NavDb } from './NavDatabase';

const KSFO: Geodetic = { lat: 37.619806, lon: -122.374821, alt: 4 };

async function db(): Promise<NavDb> {
  const d = new NavDb(countingLoader());
  await d.loadRegion(KSFO, 30);
  return d;
}

describe('NavDb.searchIdents', () => {
  it('puts the exact ident first, then the nearest prefix matches, airports and navaids together', async () => {
    const d = await db();
    const oak = d.searchIdents('KOAK', KSFO, 5);
    expect(oak[0].ident).toBe('KOAK');
    expect(oak[0].kind).toBe('airport');
    expect(oak[0].exact).toBe(true);
    expect(oak[0].distanceM / NM).toBeCloseTo(9.5, 0);
    // "OAK" is both the Oakland VORTAC and Oakland's IATA code: both are exact
    const both = d.searchIdents('oak', KSFO, 6);
    const kinds = both.filter((m) => m.exact).map((m) => `${m.kind}:${m.ident}`);
    expect(kinds).toContain('vor:OAK');
    expect(kinds).toContain('airport:KOAK');
    const vor = both.find((m) => m.ident === 'OAK')!;
    expect(vor.frequencyKHz).toBe(116_800);
    // prefix matches are ordered by distance
    const k = d.searchIdents('KS', KSFO, 8);
    expect(k.length).toBe(8);
    // far-away NDBs named exactly "KS" do not hide the nearest prefix match
    expect(k[0].ident).toBe('KSFO');
    for (let i = 1; i < k.length; i++) expect(k[i].distanceM).toBeGreaterThanOrEqual(k[i - 1].distanceM);
    expect(d.searchIdents('', KSFO)).toEqual([]);
    expect(d.searchIdents('QQQQQ', KSFO)).toEqual([]);
  });

  it('finds NDBs with kind ndb', async () => {
    const d = await db();
    const ndb = d.navaids.find((n) => n.type === 'NDB' && n.frequencyKHz > 0)!;
    const m = d.searchIdents(ndb.id, ndb.position, 3);
    expect(m[0].ident).toBe(ndb.id);
    expect(m[0].kind).toBe('ndb');
  });
});

describe('ILS approaches', () => {
  it('lists one ILS per ILS-equipped runway end, sorted, with LOC frequency and course', async () => {
    const d = await db();
    const koak = d.getAirport('KOAK')!;
    const apps = ilsApproaches(koak);
    expect(apps.length).toBeGreaterThan(0);
    const names = apps.map((a) => a.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))).toEqual(names);
    for (const a of apps) {
      expect(a.frequencyKHz).toBeGreaterThanOrEqual(108_100);
      expect(a.frequencyKHz).toBeLessThanOrEqual(111_950);
      expect(a.airportIcao).toBe('KOAK');
      // the localizer serves the same end: tuning its frequency near KOAK finds this runway
      expect(d.findIlsByFrequency(a.frequencyKHz, a.threshold)?.runway.ident).toBe(a.runway);
    }
    expect(ilsApproaches({ ...koak, runways: [] })).toEqual([]);
  });

  it('builds FFxx on the extended centreline at 5 nm (glideslope height) and RWxx at the threshold', async () => {
    const d = await db();
    const a = ilsApproaches(d.getAirport('KSFO')!).find((x) => x.runway === '28R')!;
    expect(a).toBeDefined();
    const [faf, rw] = approachWaypoints(a);
    expect(faf.id).toBe('FF28R');
    expect(rw.id).toBe('RW28R');
    expect(greatCircleDistance(faf.position, a.threshold) / NM).toBeCloseTo(FAF_DISTANCE_NM, 3);
    // flying FAF → RW is the localizer course
    expect(initialBearingDeg(faf.position, rw.position)).toBeCloseTo(a.courseTrueDeg, 0);
    // 3° glideslope: ~1 590 ft above the threshold at 5 nm
    expect((faf.altConstraintM! - a.threshold.alt) / 0.3048).toBeCloseTo(1592, -1);
  });
});
