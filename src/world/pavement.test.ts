import { describe, expect, it } from 'vitest';
import type { Airport, Runway } from '../core/types';
import { planeHeightAt } from '../terrain/pavement';
import { PavementIndex, PavementRegistry, airportPavementPlane, type PavementArea, type PavementSource } from './pavement';

const rw = (ident: string, a: [number, number, number], b: [number, number, number]): Runway => ({
  ident, threshold: { lat: a[0], lon: a[1], alt: a[2] }, end: { lat: b[0], lon: b[1], alt: b[2] },
  headingDeg: 0, lengthM: 3000, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0,
});
/** KSFO as in public/data/airports.json */
const KSFO: Airport = {
  icao: 'KSFO', name: 'SFO', position: { lat: 37.619806, lon: -122.374821, alt: 4 }, elevationM: 4, type: 'large', country: 'US',
  runways: [
    rw('10L/28R', [37.628742, -122.39341, 1.5], [37.613538, -122.35716, 4]),
    rw('10R/28L', [37.626298, -122.393124, 1.8], [37.61172, -122.358367, 4]),
    rw('1L/19R', [37.607898, -122.38295, 3], [37.626476, -122.37063, 2.7]),
    rw('1R/19L', [37.606333, -122.381061, 3.7], [37.627346, -122.367124, 3]),
  ],
};
const ONE: Airport = { ...KSFO, icao: 'XONE', runways: [KSFO.runways[0]] };
const KX = 111_194.93 * Math.cos((KSFO.position.lat * Math.PI) / 180), KY = 111_194.93;
const ll = (e: number, n: number): [number, number] => [KSFO.position.lon + e / KX, KSFO.position.lat + n / KY];
const rect = (e0: number, n0: number, e1: number, n1: number): number[] => [...ll(e0, n0), ...ll(e1, n0), ...ll(e1, n1), ...ll(e0, n1)];
const apron = (key: string, e: number, n: number): PavementArea => ({ key, kind: 'apron', rings: [rect(e, n, e + 300, n + 200)], line: [], widthM: 0 });
const line = (key: string): PavementArea => ({ key, kind: 'taxiline', rings: [], line: [...ll(-500, -900), ...ll(-200, -900)], widthM: 18 });

class Source implements PavementSource {
  rev = 1;
  constructor(public areas: PavementArea[]) {}
  pavementRevision(): number { return this.rev; }
  pavementAreas(): readonly PavementArea[] { return this.areas; }
}

describe('airport pavement plane', () => {
  it('fits the KSFO runway thresholds within 0.35 m', () => {
    const p = airportPavementPlane(KSFO);
    for (const r of KSFO.runways) {
      for (const g of [r.threshold, r.end]) expect(Math.abs(planeHeightAt(p, g.lon, g.lat) - g.alt)).toBeLessThan(0.35);
    }
    expect(Math.abs(p.dhdE)).toBeLessThan(0.002);
  });

  it('contains a single runway exactly and is level across it; flat at the elevation without runways; clamps bad slopes', () => {
    const p = airportPavementPlane(ONE);
    const r = ONE.runways[0];
    expect(planeHeightAt(p, r.threshold.lon, r.threshold.lat)).toBeCloseTo(1.5, 3);
    expect(planeHeightAt(p, r.end.lon, r.end.lat)).toBeCloseTo(4, 3);
    // 500 m to the side of the runway midpoint (perpendicular): the midpoint height
    const mLat = (r.threshold.lat + r.end.lat) / 2, mLon = (r.threshold.lon + r.end.lon) / 2;
    const dE = (r.end.lon - r.threshold.lon) * KX, dN = (r.end.lat - r.threshold.lat) * KY, L = Math.hypot(dE, dN);
    expect(planeHeightAt(p, mLon + (-dN / L) * 500 / KX, mLat + (dE / L) * 500 / KY)).toBeCloseTo(2.75, 3);
    const none = airportPavementPlane({ ...KSFO, runways: [], elevationM: 123 });
    expect(none).toMatchObject({ h0: 123, dhdE: 0, dhdN: 0 });
    const steep = airportPavementPlane({ ...ONE, runways: [rw('x', [37.62, -122.39, 0], [37.62, -122.38, 400])] });
    expect(Math.abs(steep.dhdE)).toBeLessThanOrEqual(0.02 + 1e-12);
  });
});

describe('PavementRegistry', () => {
  it('deduplicates pieces repeated by neighbouring scenery tiles and keeps only areas near the current airports', () => {
    const src = new Source([
      apron('14/1/1/a0', -1300, -700), apron('14/1/2/a0', -1300, -700), // the same piece published by two tiles
      line('14/1/1/l0'), line('14/1/2/l3'),
      apron('14/9/9/a0', 20_000, 0), // 20 km away: no airport claims it
    ]);
    const reg = new PavementRegistry();
    const specs = reg.sync(src, [KSFO])!;
    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.key.startsWith('KSFO:'))).toBe(true);
    expect(specs.find((s) => s.line.length > 0)!.halfWidthM).toBe(9);
    // every spec of one airport shares its plane object (stable, fitted once)
    expect(specs[0].plane).toBe(specs[1].plane);
    expect(reg.sync(src, [KSFO])).toBeNull(); // nothing changed
    src.rev++;
    expect(reg.sync(src, [KSFO])).toBeNull(); // new revision, same content
  });

  it('keeps accepted areas when the scenery drops their tile, drops them with their airport, and is bounded', () => {
    const src = new Source([apron('t/a0', -1300, -700)]);
    const reg = new PavementRegistry({ maxAreas: 3 });
    expect(reg.sync(src, [KSFO])).toHaveLength(1);
    src.areas = []; src.rev++;
    expect(reg.sync(src, [KSFO])).toBeNull(); // evicted scenery tile: the terrain stays flattened
    expect(reg.size).toBe(1);
    expect(reg.sync(src, [])).toEqual([]); // the airport is no longer current
    src.areas = [0, 1, 2, 3, 4, 5].map((i) => apron(`t/a${i}`, -1600 + 100 * i, -900));
    src.rev++;
    expect(reg.sync(src, [KSFO])).toHaveLength(3);
    expect(reg.full).toBe(true);
    expect(reg.sync(null, [KSFO], true)).toBeNull();
  });

  it('a piece claimed by a nearer airport built later moves to it: never flattened twice with two planes', () => {
    const src = new Source([apron('t/a0', -1300, -700), line('t/l0')]);
    const reg = new PavementRegistry();
    expect(reg.sync(src, [KSFO])!.map((s) => s.key.split(':')[0])).toEqual(['KSFO', 'KSFO']);
    // a field at 30 m whose runway passes 100 m south of the apron (the line stays nearer KSFO)
    const [aLon, aLat] = ll(-1400, -800), [bLon, bLat] = ll(-900, -800);
    const NEAR: Airport = { ...KSFO, icao: 'XNEAR', position: { lat: aLat, lon: aLon, alt: 30 }, elevationM: 30, runways: [rw('09/27', [aLat, aLon, 30], [bLat, bLon, 30])] };
    const both = reg.sync(src, [KSFO, NEAR])!;
    expect(both).not.toBeNull();
    expect(both).toHaveLength(2);
    const apronSpec = both.find((s) => s.rings.length > 0)!;
    expect(apronSpec.key.startsWith('XNEAR:')).toBe(true);
    expect(apronSpec.plane.h0).toBeCloseTo(30, 6);
    expect(both.find((s) => s.line.length > 0)!.key.startsWith('KSFO:')).toBe(true);
    // the same result whichever airport was built first
    const fresh = new PavementRegistry().sync(src, [NEAR, KSFO])!;
    expect(fresh.map((s) => s.key).sort()).toEqual(both.map((s) => s.key).sort());
    // the field goes again: the apron returns to KSFO (still published)
    const back = reg.sync(src, [KSFO])!;
    expect(back.map((s) => s.key.split(':')[0])).toEqual(['KSFO', 'KSFO']);
  });

  it('PavementIndex: inside an apron (not its hole) and within half width of a taxiway line is pavement', () => {
    const holed: PavementArea = { key: 'h', kind: 'apron', rings: [rect(-1600, -1100, -1000, -300), rect(-1400, -800, -1250, -650)], line: [], widthM: 0 };
    const specs = new PavementRegistry().sync(new Source([holed, line('l')]), [KSFO])!;
    const idx = new PavementIndex(specs);
    const on = (e: number, n: number) => { const [lon, lat] = ll(e, n); return idx.contains(lat, lon); };
    expect(on(-1100, -400)).toBe(true);
    expect(on(-1325, -725)).toBe(false); // the grass island
    expect(on(-950, -400)).toBe(false);
    expect(on(-350, -892)).toBe(true); // 8 m beside the 18 m wide line
    expect(on(-350, -880)).toBe(false);
    expect(new PavementIndex([]).empty).toBe(true);
  });
});
