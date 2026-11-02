import { describe, expect, it } from 'vitest';
import type { Geodetic } from '../core/types';
import { NM } from '../core/units';
import { greatCircleDistance } from '../geo/wgs84';
import { countingLoader } from './__tests__/fsLoader';
import { findRunwayEnd } from './airportsData';
import { NavDb, runwayInUse, shardCellsAround } from './NavDatabase';

const KSFO: Geodetic = { lat: 37.619806, lon: -122.374821, alt: 4 };

async function loadedDb(): Promise<{ db: NavDb; loader: ReturnType<typeof countingLoader> }> {
  const loader = countingLoader();
  const db = new NavDb(loader);
  await db.loadRegion(KSFO, 30);
  return { db, loader };
}

describe('NavDb', () => {
  it('is empty before loading', () => {
    const db = new NavDb(countingLoader());
    expect(db.ready).toBe(false);
    expect(db.getAirport('KSFO')).toBeUndefined();
    expect(db.nearestAirports(KSFO, 5, 30)).toEqual([]);
    expect(db.searchAirports('SFO')).toEqual([]);
    expect(db.findNavaidByFrequency(116_800, KSFO)).toBeUndefined();
  });

  it('getAirport finds KSFO after loading', async () => {
    const { db } = await loadedDb();
    expect(db.ready).toBe(true);
    const ksfo = db.getAirport('ksfo');
    expect(ksfo?.name).toContain('San Francisco');
    expect(ksfo?.runways).toHaveLength(4);
    expect(db.airports.length).toBeGreaterThan(5000);
    expect(db.navaids.length).toBeGreaterThan(10000);
  });

  it('nearestAirports around KSFO returns KSFO first and the Bay Area neighbours', async () => {
    const { db } = await loadedDb();
    const near = db.nearestAirports(KSFO, 5, 30);
    const ids = near.map((a) => a.icao);
    expect(ids[0]).toBe('KSFO');
    expect(ids).toContain('KOAK');
    expect(ids).toContain('KSQL');
    expect(ids).toContain('KHAF'); // small airport from the lazily loaded shard
    // sorted by distance, all within 30 nm
    let last = 0;
    for (const a of near) {
      const d = greatCircleDistance(KSFO, a.position);
      expect(d).toBeGreaterThanOrEqual(last);
      expect(d).toBeLessThanOrEqual(30 * NM);
      last = d;
    }
    expect(db.nearestAirports(KSFO, 50, 30).length).toBeGreaterThan(5);
    expect(db.nearestAirports(KSFO, 5, 0.5)).toHaveLength(1);
  });

  it('nearestNavaids finds the SFO VOR-DME on the field', async () => {
    const { db } = await loadedDb();
    const near = db.nearestNavaids(KSFO, 3, 20);
    expect(near[0].id).toBe('SFO');
    expect(near[0].type).toBe('VOR-DME');
    expect(near.map((n) => n.id)).toContain('OAK');
  });

  it('searchAirports ranks exact codes, prefixes and names', async () => {
    const { db } = await loadedDb();
    expect(db.searchAirports('innsbruck')[0].icao).toBe('LOWI');
    expect(db.searchAirports('SFO')[0].icao).toBe('KSFO');
    expect(db.searchAirports('ksfo')[0].icao).toBe('KSFO');
    const prefix = db.searchAirports('KS', 10);
    expect(prefix).toHaveLength(10);
    for (const a of prefix) expect(a.icao.startsWith('KS')).toBe(true);
    const muni = db.searchAirports('half moon');
    expect(muni[0].icao).toBe('KHAF');
    expect(db.searchAirports('')).toEqual([]);
    expect(db.searchAirports('zzzzzzzz')).toEqual([]);
  });

  it('findNavaidByFrequency(116800) near SF is the OAK VORTAC', async () => {
    const { db } = await loadedDb();
    const oak = db.findNavaidByFrequency(116_800, KSFO);
    expect(oak?.id).toBe('OAK');
    expect(oak?.type).toBe('VORTAC');
    // 115.80 is the SFO VOR-DME; from Innsbruck nothing on that frequency is in range
    expect(db.findNavaidByFrequency(115_800, KSFO)?.id).toBe('SFO');
    expect(db.findNavaidByFrequency(115_800, { lat: 47.26, lon: 11.34, alt: 600 })?.id).not.toBe('SFO');
    expect(db.findNavaidByFrequency(1, KSFO)).toBeUndefined();
  });

  it("findIlsByFrequency returns KSFO 28R for 28R's synthetic frequency", async () => {
    const { db } = await loadedDb();
    const ksfo = db.getAirport('KSFO')!;
    const end28R = findRunwayEnd(ksfo, '28R')!.end;
    const khz = end28R.ils!.frequencyKHz;
    const hit = db.findIlsByFrequency(khz, KSFO);
    expect(hit?.airport.icao).toBe('KSFO');
    expect(hit?.runway.ident).toBe('28R');
    expect(hit?.runway.headingDeg).toBe(298);
    expect(hit?.runway.ils?.frequencyMHz).toBeCloseTo(khz / 1000, 6);
    const entry = db.findIlsEntry(khz, KSFO)!;
    expect(entry.geometry.runway).toBe('28R');
    expect(db.ilsGeometry(ksfo, entry.runway, entry.endIndex)).toBe(entry.geometry);
    // far away, nothing is tuned
    expect(db.findIlsByFrequency(khz, { lat: 47.26, lon: 11.34, alt: 600 })?.airport.icao).not.toBe('KSFO');
  });

  it('runwayInUse picks the into-wind end and prefers the longest', async () => {
    const { db } = await loadedDb();
    const ksfo = db.getAirport('KSFO')!;
    expect(['28L', '28R']).toContain(db.runwayInUse(ksfo, 290)!.ident);
    expect(db.runwayInUse(ksfo, 290)!.ident).toBe('28R'); // 28R (3618 m) is longer than 28L (3469 m)
    expect(['10L', '10R']).toContain(runwayInUse(ksfo, 100)!.ident);
    expect(['1L', '1R']).toContain(runwayInUse(ksfo, 20)!.ident);
    expect(['19L', '19R']).toContain(runwayInUse(ksfo, 200)!.ident);
    expect(runwayInUse({ ...ksfo, runways: [] }, 0)).toBeUndefined();
  });

  it('loadRegion loads the right small shards once and never re-fetches', async () => {
    const { db, loader } = await loadedDb();
    expect(loader.calls).toContain('data/airports.json');
    expect(loader.calls).toContain('data/navaids.json');
    expect(loader.calls).toContain('data/index.json');
    expect(loader.calls).toContain('data/small/3_-13.json');
    expect(loader.calls).toHaveLength(4);
    expect(db.loadedShards).toEqual(['3_-13']);
    expect(db.getAirport('KHAF')?.type).toBe('small');
    expect(db.getAirport('KHWD')?.name).toContain('Hayward');
    // second call around the same place: no new loads
    await db.loadRegion(KSFO, 30);
    await db.load();
    expect(loader.calls).toHaveLength(4);
    expect(db.loaderCalls).toBe(4);
    // a bigger region crosses into the neighbouring cells
    await db.loadRegion(KSFO, 200);
    expect(loader.calls.length).toBeGreaterThan(4);
    expect(db.loadedShards).toContain('3_-13');
    const before = loader.calls.length;
    await db.loadRegion(KSFO, 200);
    expect(loader.calls.length).toBe(before);
  });

  it('shardCellsAround covers the circle', () => {
    expect(shardCellsAround(KSFO, 30 * NM)).toEqual(['3_-13']);
    const eq = shardCellsAround({ lat: 0, lon: 0, alt: 0 }, 200_000);
    expect(eq).toContain('0_0');
    expect(eq).toContain('-1_-1');
    expect(eq).toContain('0_-1');
    expect(eq).toContain('-1_0');
    const dateline = shardCellsAround({ lat: 60, lon: 179.5, alt: 0 }, 200_000);
    expect(dateline).toContain('6_17');
    expect(dateline).toContain('6_-18');
  });
});
