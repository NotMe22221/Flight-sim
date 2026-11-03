import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../core/math';
import { lonLatToTile } from '../geo/mercator';
import { LocalFrame, destinationPoint } from '../geo/wgs84';
import { Quadtree, computeTileAabb, type SelectedNode } from './quadtree';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const frame = new LocalFrame(KSFO.lat, KSFO.lon, 0);
/** Bay Area heights are known: everything between −10 and 100 m (as a loaded heightfield would report). */
const flatRange = (_z: number, _x: number, _y: number, out: Float64Array): number => { out[0] = -10; out[1] = 100; return 12; };
const keys = (sel: readonly SelectedNode[]): string[] => sel.map((s) => `${s.key}${s.parentPatch ? 'P' : ''}`).sort();

describe('Quadtree CDLOD selection', () => {
  it('camera at KSFO, 1000 m: z15 under the camera, disc fully covered exactly once, sane node count', () => {
    const qt = new Quadtree(frame, { range0: 3500 }, flatRange);
    expect(qt.levels).toBe(9);
    expect(qt.ranges[8]).toBe(3500 * 256);
    const sel = qt.select([0, 1000, 0], null);
    const under = sel.filter((s) => { const t = lonLatToTile(KSFO.lon, KSFO.lat, s.z); return Math.floor(t.x) === s.x && Math.floor(t.y) === s.y; });
    expect(under.length).toBe(1);
    expect(under[0].z).toBe(15);
    expect(under[0].parentPatch).toBe(false);
    expect(sel.length).toBeGreaterThanOrEqual(100);
    expect(sel.length).toBeLessThanOrEqual(400);
    // every selected zoom is within [7, 15]
    for (const s of sel) { expect(s.z).toBeGreaterThanOrEqual(7); expect(s.z).toBeLessThanOrEqual(15); expect(s.level).toBe(15 - s.z); }
    // 500 random points within 100 km are each covered by exactly one entry (node or parent patch)
    const rnd = mulberry32(1234);
    for (let k = 0; k < 500; k++) {
      const d = Math.sqrt(rnd()) * 100_000, brg = rnd() * 360;
      const p = destinationPoint({ lat: KSFO.lat, lon: KSFO.lon, alt: 0 }, brg, d, 0);
      let count = 0;
      for (const s of sel) { const t = lonLatToTile(p.lon, p.lat, s.z); if (Math.floor(t.x) === s.x && Math.floor(t.y) === s.y) count++; }
      expect(count).toBe(1);
    }
    // the z15 ring is compact: all z15 nodes lie within range0 of the camera (z15 *patches* are z14 geometry beyond it)
    for (const s of sel) if (s.z === 15 && !s.parentPatch) expect(s.distance).toBeLessThanOrEqual(3500 + 1);
    for (const s of sel) if (s.z === 15 && s.parentPatch) expect(s.distance).toBeGreaterThan(3500 - 1);
    expect(sel.length).toBeGreaterThan(250); // ≈ 290 per the §3.2 budget table
    // parent patches exist (children outside their range along ring boundaries)
    expect(sel.some((s) => s.parentPatch)).toBe(true);
  });

  it('at 10 000 m the finest level under the camera is ≤ z13', () => {
    const qt = new Quadtree(frame, { range0: 3500 }, flatRange);
    const sel = qt.select([0, 10_000, 0], null);
    const under = sel.filter((s) => { const t = lonLatToTile(KSFO.lon, KSFO.lat, s.z); return Math.floor(t.x) === s.x && Math.floor(t.y) === s.y; });
    expect(under.length).toBe(1);
    expect(under[0].z).toBeLessThanOrEqual(13);
    expect(sel.every((s) => s.z <= 13)).toBe(true);
    expect(sel.length).toBeGreaterThan(50);
  });

  it('frustum culling drops nodes but never leaves a parent patch for culled areas', () => {
    const qt = new Quadtree(frame, { range0: 3500 }, flatRange);
    const all = qt.select([0, 1000, 0], null).length;
    // "frustum" = everything with x ≥ 0 (east half-space)
    const east = { intersectsBox: (min: ArrayLike<number>, max: ArrayLike<number>) => max[0] >= 0 && min[0] <= Infinity };
    const sel = qt.select([0, 1000, 0], east);
    expect(sel.length).toBeLessThan(all);
    expect(sel.length).toBeGreaterThan(all * 0.3);
    const west = destinationPoint({ lat: KSFO.lat, lon: KSFO.lon, alt: 0 }, 270, 30_000, 0);
    expect(sel.some((s) => { const t = lonLatToTile(west.lon, west.lat, s.z); return Math.floor(t.x) === s.x && Math.floor(t.y) === s.y; })).toBe(false);
  });

  it('horizon culling removes far tiles hidden by curvature at low altitude but not at FL350', () => {
    const low = new Quadtree(frame, { range0: 3500, horizonCull: true }, flatRange).select([0, 100, 0], null);
    const lowNoCull = new Quadtree(frame, { range0: 3500, horizonCull: false }, flatRange).select([0, 100, 0], null);
    expect(low.length).toBeLessThan(lowNoCull.length);
    // horizon at 100 m ≈ 36 km (+ 36 km for 100 m tile tops + 2 km margin) measured to the box edge; the
    // reported distance is to the centre, so a 248 km z7 tile can still report up to ≈ 74 + 175 km
    expect(Math.max(...low.map((s) => s.distance))).toBeLessThan(260_000);
    expect(Math.max(...lowNoCull.map((s) => s.distance))).toBeGreaterThan(500_000);
    const high = new Quadtree(frame, { range0: 3500, horizonCull: true }, flatRange).select([0, 10_700, 0], null);
    expect(Math.max(...high.map((s) => s.distance))).toBeGreaterThan(300_000);
  });

  it('hysteresis: once settled, moving the camera back and forth by 1 % of a range does not change the selection', () => {
    // 1. Without hysteresis, find a camera position whose selection changes when moved by 1 % of range0.
    const step = 0.01 * 3500;
    const stateless = new Quadtree(frame, { range0: 3500, hysteresis: 0 }, flatRange);
    let xa = 0, found = false;
    let prev = keys(stateless.select([xa, 1000, 0], null));
    for (let i = 1; i < 400 && !found; i++) {
      const cur = keys(stateless.select([i * step, 1000, 0], null));
      if (cur.join() !== prev.join()) { xa = (i - 1) * step; found = true; }
      prev = cur;
    }
    expect(found).toBe(true);
    const P = [xa, 1000, 0], Q = [xa + step, 1000, 0];
    // stateless (hysteresis 0) flaps between the two positions
    expect(keys(stateless.select(P, null)).join()).not.toBe(keys(stateless.select(Q, null)).join());
    // 2. With hysteresis the selection settles after one transition and then stays put under ±1 % jitter.
    const qt = new Quadtree(frame, { range0: 3500, hysteresis: 0.15 }, flatRange);
    qt.select(P, null);
    const s1 = keys(qt.select(Q, null));
    const s2 = keys(qt.select(P, null));
    const s3 = keys(qt.select(Q, null));
    const s4 = keys(qt.select(P, null));
    expect(s2).toEqual(s1);
    expect(s3).toEqual(s1);
    expect(s4).toEqual(s1);
  });

  it('a fresh selection at KSFO is unchanged by a 1 % range0 move east', () => {
    const qt = new Quadtree(frame, { range0: 3500 }, flatRange);
    const a = keys(qt.select([0, 1000, 0], null));
    const b = keys(qt.select([35, 1000, 0], null));
    expect(b).toEqual(a);
  });

  it('setFrame rebases AABBs: selection in the new frame covers the same tiles', () => {
    const qt = new Quadtree(frame, { range0: 3500 }, flatRange);
    const a = keys(qt.select([0, 1000, 0], null));
    const f2 = new LocalFrame(KSFO.lat + 0.1, KSFO.lon, 0);
    qt.setFrame(f2);
    const cam = f2.geodeticToThree(KSFO.lat, KSFO.lon, 1000);
    const b = keys(qt.select(cam, null));
    expect(b).toEqual(a);
  });

  it('computeTileAabb contains the tile corners and centre with padding', () => {
    const min = new Float64Array(3), max = new Float64Array(3);
    computeTileAabb(frame, 15, 5246, 12684, -10, 100, min, max);
    expect(max[0] - min[0]).toBeGreaterThan(900);
    expect(max[0] - min[0]).toBeLessThan(1100);
    expect(max[1] - min[1]).toBeGreaterThan(110);
    const c = frame.geodeticToThree(37.61, -122.36, 50);
    for (let a = 0; a < 3; a++) { expect(c[a]).toBeGreaterThan(min[a]); expect(c[a]).toBeLessThan(max[a]); }
  });
});
