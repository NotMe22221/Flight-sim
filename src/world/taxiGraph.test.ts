import { describe, expect, it } from 'vitest';
import { TaxiGraph, type TaxiLineInput } from './taxiGraph';

const LAT0 = 37.5, LON0 = -122.5;
const kx = 6378137 * (Math.PI / 180) * Math.cos((LAT0 * Math.PI) / 180), ky = 6378137 * (Math.PI / 180);
/** polyline from local [east, north] metres to [lon, lat, …] */
const ll = (...pts: [number, number][]): number[] => pts.flatMap(([e, n]) => [LON0 + e / kx, LAT0 + n / ky]);

/**
 * A runway along +east from (0,0) to (2000,0), 45 m wide. Parallel taxiway A at north 200 m from
 * east 0 to 2000 (split in two at east 1000 like a tile border, with 1 m of clipping error);
 * connectors B1 (east 100) and B2 (east 1900) from A down to 60 m north of the centre line; a stub C
 * from the apron (east 1000, north 500) that ends 3 m short of A (no shared node).
 */
const AIRPORT: TaxiLineInput[] = [
  { line: ll([0, 200], [1000, 200]), ref: 'A' },
  { line: ll([1000.8, 200.5], [2000, 200]), ref: 'A' },
  { line: ll([100, 200], [100, 60]), ref: 'B1' },
  { line: ll([1900, 200], [1900, 60]), ref: 'B2' },
  { line: ll([1000, 500], [1000, 203]), ref: 'C' },
];
const RWY = { threshold: { lat: LAT0, lon: LON0 }, end: { lat: LAT0, lon: LON0 + 2000 / kx }, widthM: 45 };

describe('TaxiGraph', () => {
  it('merges the tile-border split and joins a stub that stops short of another taxiway', () => {
    const g = new TaxiGraph(LAT0, LON0, AIRPORT);
    // A is continuous: a route from the far end of A to B1 exists and stays on A
    const hs = g.holdShort(RWY)!;
    const r = g.route(LAT0 + 200 / ky, LON0 + 1950 / kx, hs)!;
    expect(r).not.toBeNull();
    // the C stub reaches A: a route from the apron gets to the runway
    const fromApron = g.route(LAT0 + 490 / ky, LON0 + 1000 / kx, hs);
    expect(fromApron).not.toBeNull();
    expect(fromApron!.via).toEqual(['C', 'A', 'B1']);
  });

  it('holds short beside the runway near the threshold, never on it', () => {
    const g = new TaxiGraph(LAT0, LON0, AIRPORT);
    const hs = g.holdShort(RWY)!;
    expect(hs.e).toBeCloseTo(100, 0); // B1 (by the threshold), not B2 (by the far end)
    expect(hs.n).toBeCloseTo(60, 0);
    // the opposite runway direction picks the other connector
    const back = g.holdShort({ threshold: RWY.end, end: RWY.threshold, widthM: 45 })!;
    expect(back.e).toBeCloseTo(1900, 0);
  });

  it('routes the shortest way with the taxiway names in order', () => {
    const g = new TaxiGraph(LAT0, LON0, AIRPORT);
    const r = g.route(LAT0 + 490 / ky, LON0 + 1000 / kx, g.holdShort(RWY)!)!;
    // apron 290 m down C to A, 900 m west along A, 140 m down B1 (+ the 10 m join)
    expect(r.lengthM).toBeGreaterThan(1300); expect(r.lengthM).toBeLessThan(1360);
    expect(r.points[0][1]).toBeCloseTo(490, 0); // starts at the aircraft
    const last = r.geo[r.geo.length - 1];
    expect((last.lon - LON0) * kx).toBeCloseTo(100, 0);
    expect((last.lat - LAT0) * ky).toBeCloseTo(60, 0);
  });

  it('no route when the aircraft is far from every taxiway, no hold-short without a connector', () => {
    const g = new TaxiGraph(LAT0, LON0, AIRPORT);
    expect(g.route(LAT0 + 3000 / ky, LON0, g.holdShort(RWY)!)).toBeNull();
    // a stand 300 m out on an apron still gets a route (straight across the apron to the taxiway)
    expect(g.route(LAT0 + 500 / ky, LON0 + 1300 / kx, g.holdShort(RWY)!)).not.toBeNull();
    const onlyA = new TaxiGraph(LAT0, LON0, AIRPORT.slice(0, 2));
    expect(onlyA.holdShort(RWY)).toBeNull(); // A at 200 m is too far from the runway to hold short on
  });
});
