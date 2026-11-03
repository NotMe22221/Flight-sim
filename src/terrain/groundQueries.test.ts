import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { lonLatToTile } from '../geo/mercator';
import { LocalFrame, destinationPoint } from '../geo/wgs84';
import { GroundQueries } from './groundQueries';
import { HeightField } from './heightfield';

const KSFO = { lat: 37.613538, lon: -122.35716 };

/** A z12 tile around KSFO filled from a height function of (lon, lat) at the pixel centres. */
function fieldFrom(fn: (lon: number, lat: number) => number, z = 12): HeightField {
  const hf = new HeightField(15);
  const t = lonLatToTile(KSFO.lon, KSFO.lat, z);
  const tx = Math.floor(t.x), ty = Math.floor(t.y), W = 256, n = 2 ** z;
  const h = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    const yy = ty + (j + 0.5) / W;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
    for (let i = 0; i < W; i++) h[j * W + i] = fn(((tx + (i + 0.5) / W) / n) * 360 - 180, lat);
  }
  hf.set(z, tx, ty, h, W);
  return hf;
}

describe('GroundQueries', () => {
  it('flat 10 m ground: up at the origin is 10 − alt0, and drops with curvature away from it', () => {
    const q = new GroundQueries(fieldFrom(() => 10));
    const frame = new LocalFrame(KSFO.lat, KSFO.lon, 4);
    expect(q.groundUp(frame, 0, 0)!).toBeCloseTo(6, 3);
    // 3 km west (KSFO is 1.15 km from the tile's east edge): the ellipsoid sags by ≈ d²/2R ≈ 0.71 m
    const up = q.groundUp(frame, 0, -3000)!;
    expect(up).not.toBeNull();
    expect(6 - up).toBeGreaterThan(0.6);
    expect(6 - up).toBeLessThan(0.8);
  });

  it('agrees with an exact geodetic → NED conversion of the ground point on a slope', () => {
    const slope = (lon: number, lat: number) => 50 + (lon - KSFO.lon) * 20000 + (lat - KSFO.lat) * 5000;
    const q = new GroundQueries(fieldFrom(slope));
    const frame = new LocalFrame(KSFO.lat, KSFO.lon, 0);
    const p = destinationPoint({ lat: KSFO.lat, lon: KSFO.lon, alt: 0 }, 240, 4000); // stays inside the z12 tile
    const ned = frame.geodeticToNED(p.lat, p.lon, 0);
    const up = q.groundUp(frame, ned[0], ned[1])!;
    expect(up).not.toBeNull();
    // the ground point found must lie (within cm) on the frame vertical through (n, e) at the DEM height
    const g = frame.nedToGeodetic(ned[0], ned[1], -up);
    expect(g.alt).toBeCloseTo(slope(g.lon, g.lat), 1);
  });

  it('returns null outside loaded data', () => {
    const q = new GroundQueries(new HeightField(15));
    const frame = new LocalFrame(KSFO.lat, KSFO.lon, 0);
    expect(q.groundUp(frame, 0, 0)).toBeNull();
    expect(q.groundNormal(frame, 0, 0, [0, 0, 0])).toBeNull();
  });

  it('normal: flat ground → [0,0,−1] at the origin; a slope rising to the east tilts it west', () => {
    const flat = new GroundQueries(fieldFrom(() => 10));
    const frame = new LocalFrame(KSFO.lat, KSFO.lon, 0);
    const n: Vec3 = [0, 0, 0];
    flat.groundNormal(frame, 0, 0, n);
    expect(n[0]).toBeCloseTo(0, 4); expect(n[1]).toBeCloseTo(0, 4); expect(n[2]).toBeCloseTo(-1, 6);
    // 0.1 m per metre to the east: 1° of longitude ≈ 88.2 km at 37.6° → 8820 m per degree
    const east = new GroundQueries(fieldFrom((lon) => 10 + (lon - KSFO.lon) * 8820));
    east.groundNormal(frame, 0, 0, n);
    expect(n[1]).toBeCloseTo(-0.1 / Math.hypot(1, 0.1), 2);
    expect(n[2]).toBeLessThan(-0.99);
  });
});
