import { describe, expect, it } from 'vitest';
import type { Geodetic } from '../core/types';
import { mulberry32 } from '../core/math';
import { NM } from '../core/units';
import { EARTH_RADIUS, greatCircleDistance } from '../geo/wgs84';
import { countingLoader } from './__tests__/fsLoader';
import { NavDb, shardCellsAround } from './NavDatabase';
import { M_PER_DEG, SpatialGrid } from './spatialGrid';

/** Brute-force reference: every item within `maxM`, nearest first, at most `maxCount`. */
function bruteNearest<T>(items: readonly T[], posOf: (t: T) => Geodetic, pos: Geodetic, maxCount: number, maxM: number): { item: T; d: number }[] {
  const all: { item: T; d: number }[] = [];
  for (const item of items) {
    const d = greatCircleDistance(pos, posOf(item));
    if (d <= maxM) all.push({ item, d });
  }
  all.sort((a, b) => a.d - b.d);
  return all.slice(0, maxCount);
}

/** Same distances in the same order, no duplicates, and every returned item really at that distance. */
function expectSameAsBrute<T>(got: { item: T; distanceM: number }[], want: { item: T; d: number }[], label: string): void {
  expect(got.length, `${label}: count`).toBe(want.length);
  expect(new Set(got.map((g) => g.item)).size, `${label}: duplicates`).toBe(got.length);
  for (let i = 0; i < want.length; i++) {
    expect(Math.abs(got[i].distanceM - want[i].d), `${label}: #${i} distance`).toBeLessThan(1e-6);
  }
}

describe('SpatialGrid', () => {
  it('uses the same metres-per-degree as the great-circle distance (safe early exit bound)', () => {
    expect(M_PER_DEG).toBeCloseTo((EARTH_RADIUS * Math.PI) / 180, 9);
  });

  it('never returns the same item twice when the longitude span wraps the globe', () => {
    const g = new SpatialGrid<number>();
    for (let i = 0; i < 360; i++) g.insert(i, 85, -180 + i + 0.5);
    for (const [pos, r] of [[{ lat: 88, lon: 0, alt: 0 }, 2_000_000], [{ lat: 0, lon: 0, alt: 0 }, 20_000_000], [{ lat: -89.5, lon: 120, alt: 0 }, 19_000_000]] as const) {
      const res = g.nearest(pos, 1000, r);
      expect(new Set(res.map((x) => x.item)).size).toBe(res.length);
      expectSameAsBrute(res, bruteNearest([...Array(360).keys()], (i) => ({ lat: 85, lon: -180 + i + 0.5, alt: 0 }), pos, 1000, r), `wrap ${pos.lat},${pos.lon}`);
    }
  });

  it('finds neighbours across cell boundaries, the antimeridian and the poles', () => {
    const pts: Geodetic[] = [
      { lat: 10, lon: 20, alt: 0 }, { lat: 9.999999, lon: 19.999999, alt: 0 }, // either side of a cell corner
      { lat: 0, lon: 179.99, alt: 0 }, { lat: 0, lon: -179.99, alt: 0 }, { lat: 0, lon: 180, alt: 0 }, // antimeridian
      { lat: 89.9, lon: 0, alt: 0 }, { lat: 89.9, lon: 180, alt: 0 }, { lat: 90, lon: 0, alt: 0 }, // across the north pole
      { lat: -90, lon: 0, alt: 0 }, { lat: -89.95, lon: 90, alt: 0 },
    ];
    const g = new SpatialGrid<number>();
    pts.forEach((p, i) => g.insert(i, p.lat, p.lon));
    const queries: [Geodetic, number][] = [
      [{ lat: 10, lon: 20, alt: 0 }, 1000], // exactly on a cell corner
      [{ lat: 0, lon: -180, alt: 0 }, 5000],
      [{ lat: 0, lon: 179.995, alt: 0 }, 2000],
      [{ lat: 89.95, lon: 90, alt: 0 }, 30_000], // the pole is between the points
      [{ lat: -90, lon: 45, alt: 0 }, 10_000],
    ];
    for (const [q, r] of queries) {
      expectSameAsBrute(g.nearest(q, 10, r), bruteNearest([...pts.keys()], (i) => pts[i], q, 10, r), `${q.lat},${q.lon}`);
    }
    // antimeridian neighbours are ~2.2 km apart, not 40 000 km
    const near = g.nearest({ lat: 0, lon: 179.99, alt: 0 }, 3, 5000).map((n) => n.item);
    expect(near).toEqual(expect.arrayContaining([2, 3, 4]));
    // the two points either side of the pole are 22 km apart (the pole itself is 11 km away)
    expect(g.nearest({ lat: 89.9, lon: 0, alt: 0 }, 3, 25_000).map((n) => n.item)).toEqual([5, 7, 6]);
  });

  it('matches a brute-force scan on random synthetic data (200 queries, radii up to 6000 nm)', () => {
    const rnd = mulberry32(42);
    const items: Geodetic[] = [];
    for (let i = 0; i < 3000; i++) {
      // cluster some points on integer cell edges and near the poles/antimeridian
      const k = rnd();
      const lat = k < 0.1 ? Math.round(rnd() * 160 - 80) : k < 0.15 ? 85 + rnd() * 5 : Math.asin(2 * rnd() - 1) * (180 / Math.PI);
      const lon = k < 0.1 ? Math.round(rnd() * 360 - 180) : k < 0.2 ? (rnd() < 0.5 ? 179 + rnd() : -180 + rnd()) : rnd() * 360 - 180;
      items.push({ lat, lon, alt: 0 });
    }
    const g = new SpatialGrid<number>();
    items.forEach((p, i) => g.insert(i, p.lat, p.lon));
    for (let q = 0; q < 200; q++) {
      const pos = { lat: rnd() * 180 - 90, lon: rnd() * 360 - 180, alt: 0 };
      const maxM = (q % 10 === 0 ? 6000 : rnd() * 800) * NM;
      // big radii ask for everything so a duplicated antipodal column cannot hide below the cut
      const maxCount = q % 10 === 0 ? 5000 : 1 + Math.floor(rnd() * 30);
      expectSameAsBrute(g.nearest(pos, maxCount, maxM), bruteNearest([...items.keys()], (i) => items[i], pos, maxCount, maxM), `q${q}`);
    }
  });

  it('an unbounded radius returns the global nearest', () => {
    const g = new SpatialGrid<string>();
    g.insert('far', -45, 170); g.insert('near', 10, 10); g.insert('mid', 50, -100);
    expect(g.nearest({ lat: 0, lon: 0, alt: 0 }, 2, Infinity).map((n) => n.item)).toEqual(['near', 'mid']);
    expect(g.nearest({ lat: 0, lon: 0, alt: 0 }, 0, Infinity)).toEqual([]);
  });

  it('forEachInBox visits each item in the box once, also across the antimeridian', () => {
    const g = new SpatialGrid<string>();
    g.insert('a', 10.5, 179.5); g.insert('b', 10.5, -179.5); g.insert('c', 12.5, 0);
    const seen: string[] = [];
    g.forEachInBox(10, 11, 179, 181, (it) => seen.push(it));
    expect(seen.sort()).toEqual(['a', 'b']);
    const all: string[] = [];
    g.forEachInBox(-90, 89, -180, 900, (it) => all.push(it));
    expect(all.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('NavDb nearest queries vs brute force (real data)', async () => {
  const db = new NavDb(countingLoader());
  // Load every small-airport shard so the airport set is the whole world.
  await db.load();
  await db.loadRegion({ lat: 0, lon: 0, alt: 0 }, 11_000);
  const rnd = mulberry32(2025);
  const positions: Geodetic[] = [];
  for (let i = 0; i < 50; i++) positions.push({ lat: Math.asin(2 * rnd() - 1) * (180 / Math.PI), lon: rnd() * 360 - 180, alt: 0 });
  // Deliberate edge cases: cell corners, the antimeridian (Fiji/Kamchatka), the high Arctic, KSFO.
  positions.push({ lat: 37, lon: -122, alt: 0 }, { lat: -17, lon: 180, alt: 0 }, { lat: -16.5, lon: -179.9, alt: 0 }, { lat: 78.25, lon: 15.5, alt: 0 }, { lat: 82.5, lon: -62.3, alt: 0 }, { lat: 37.6188, lon: -122.375, alt: 4 });

  it('loads every shard', () => {
    expect(db.airports.length).toBeGreaterThan(11_000);
  });

  it('nearestAirports equals a brute-force scan for 56 positions', () => {
    positions.forEach((pos, i) => {
      const maxNm = [25, 100, 250, 600, 2500][i % 5];
      const maxCount = [1, 5, 12, 25, 40][(i * 7) % 5];
      const got = db.nearestAirports(pos, maxCount, maxNm);
      const want = bruteNearest(db.airports, (a) => a.position, pos, maxCount, maxNm * NM);
      expectSameAsBrute(got.map((a) => ({ item: a, distanceM: greatCircleDistance(pos, a.position) })), want, `airports @${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`);
    });
  });

  it('nearestNavaids equals a brute-force scan for 56 positions', () => {
    positions.forEach((pos, i) => {
      const maxNm = [40, 130, 300, 800, 3000][i % 5];
      const maxCount = [1, 3, 10, 25, 50][(i * 3) % 5];
      const got = db.nearestNavaids(pos, maxCount, maxNm);
      const want = bruteNearest(db.navaids, (n) => n.position, pos, maxCount, maxNm * NM);
      expectSameAsBrute(got.map((n) => ({ item: n, distanceM: greatCircleDistance(pos, n.position) })), want, `navaids @${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`);
    });
  });

  it('1000 nearest queries take < 200 ms', () => {
    const qs: Geodetic[] = [];
    for (let i = 0; i < 1000; i++) qs.push({ lat: Math.asin(2 * rnd() - 1) * (180 / Math.PI), lon: rnd() * 360 - 180, alt: 0 });
    // warm-up (JIT), then time 500 airport + 500 navaid queries of the sizes the UI uses; the best of
    // up to three runs, so a machine busy with other work does not fail it (a linear scan is ~10× slower)
    for (let i = 0; i < 100; i++) db.nearestAirports(qs[i], 12, 40);
    let best = Infinity;
    for (let run = 0; run < 3 && best >= 200; run++) {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) {
        if (i % 2) db.nearestAirports(qs[i], 25, 100);
        else db.nearestNavaids(qs[i], 10, 130);
      }
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(200);
  });
});

describe('shardCellsAround', () => {
  /** Reference: every 10° cell that contains a point of the circle, by dense sampling. */
  function sampledCells(c: Geodetic, radiusM: number): Set<string> {
    const out = new Set<string>();
    const R = EARTH_RADIUS, D2R = Math.PI / 180;
    const φ1 = c.lat * D2R, λ1 = c.lon * D2R;
    for (let ri = 0; ri <= 40; ri++) {
      const δ = (radiusM / R) * (ri / 40);
      for (let bi = 0; bi < 720; bi++) {
        const θ = (bi / 720) * 2 * Math.PI;
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
        const lat = φ2 / D2R, lon = ((((λ2 / D2R + 180) % 360) + 360) % 360) - 180;
        out.add(`${Math.floor(Math.min(lat, 89.999) / 10)}_${Math.floor(lon / 10)}`);
      }
    }
    return out;
  }

  it('covers every cell touched by the circle, including high latitudes and the poles', () => {
    const cases: [Geodetic, number][] = [
      [{ lat: 85, lon: 0, alt: 0 }, 600_000], // crosses the north pole
      [{ lat: 60, lon: 10, alt: 0 }, 926_000], // large circle: widest longitude is poleward of the centre
      [{ lat: -75, lon: 170, alt: 0 }, 1_500_000], // antarctic + antimeridian
      [{ lat: 37.6, lon: -122.4, alt: 0 }, 370_000],
      [{ lat: 0, lon: 179.9, alt: 0 }, 50_000],
      [{ lat: 89.9, lon: 45, alt: 0 }, 20_000],
    ];
    for (const [c, r] of cases) {
      const got = new Set(shardCellsAround(c, r));
      for (const cell of sampledCells(c, r)) expect(got.has(cell), `${c.lat},${c.lon} r=${r}: ${cell}`).toBe(true);
    }
  });
});
