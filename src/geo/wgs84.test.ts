import { describe, expect, it } from 'vitest';
import { LocalFrame, destinationPoint, ecefToGeodetic, geodeticToEcef, greatCircleDistance, horizonDistance, initialBearingDeg, nedToThree, threeToNED } from './wgs84';

describe('wgs84', () => {
  it('round-trips geodetic ↔ ECEF', () => {
    for (const [lat, lon, h] of [[37.613538, -122.35716, 4], [47.2588, 11.3309, 581], [-33.9, 151.2, 10], [89.9, 10, 0], [0, 0, 0]]) {
      const p = geodeticToEcef(lat, lon, h);
      const g = ecefToGeodetic(p[0], p[1], p[2]);
      expect(g.lat).toBeCloseTo(lat, 8);
      expect(g.lon).toBeCloseTo(lon, 8);
      expect(g.alt).toBeCloseTo(h, 5);
    }
  });

  it('ECEF of equator/prime meridian is on the x axis at the semi-major axis', () => {
    const p = geodeticToEcef(0, 0, 0);
    expect(p[0]).toBeCloseTo(6378137, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });

  it('local frame round trip is sub-micron within 500 km', () => {
    const f = new LocalFrame(37.613538, -122.35716, 4);
    const g = f.nedToGeodetic(300000, -200000, -5000);
    const ned = f.geodeticToNED(g.lat, g.lon, g.alt);
    expect(ned[0]).toBeCloseTo(300000, 4);
    expect(ned[1]).toBeCloseTo(-200000, 4);
    expect(ned[2]).toBeCloseTo(-5000, 4);
  });

  it('a point 100 km east at h=0 drops ≈785 m below the tangent plane (curvature)', () => {
    const f = new LocalFrame(37.6, -122.3, 0);
    const dest = destinationPoint({ lat: 37.6, lon: -122.3, alt: 0 }, 90, 100000, 0);
    const t = f.geodeticToThree(dest.lat, dest.lon, 0);
    expect(t[1]).toBeLessThan(-780);
    expect(t[1]).toBeGreaterThan(-790);
    expect(t[0]).toBeGreaterThan(99000); // mostly east
  });

  it('north/east/up directions are right', () => {
    const f = new LocalFrame(37.6, -122.3, 0);
    const n = f.geodeticToNED(37.61, -122.3, 0);
    expect(n[0]).toBeGreaterThan(1000); // north ≈ 1.11 km
    expect(Math.abs(n[1])).toBeLessThan(1);
    const e = f.geodeticToNED(37.6, -122.29, 0);
    expect(e[1]).toBeGreaterThan(800); // east ≈ 0.88 km at this latitude
    expect(Math.abs(e[0])).toBeLessThan(1);
    const u = f.geodeticToNED(37.6, -122.3, 100);
    expect(u[2]).toBeCloseTo(-100, 6);
  });

  it('NED ↔ Three.js axis permutation', () => {
    expect(nedToThree([1, 0, 0])).toEqual([0, -0, -1]);
    expect(nedToThree([0, 1, 0])).toEqual([1, -0, -0]);
    expect(nedToThree([0, 0, 1])).toEqual([0, -1, -0]);
    const v: [number, number, number] = [3, -4, 5];
    expect(threeToNED(nedToThree(v))).toEqual(v);
  });

  it('frame rebase rotation is tiny for a 20 km move and orthonormal', () => {
    const a = new LocalFrame(37.6, -122.3, 0);
    const dest = destinationPoint({ lat: 37.6, lon: -122.3, alt: 0 }, 45, 20000, 0);
    const b = new LocalFrame(dest.lat, dest.lon, 0);
    const R = a.rotationNEDTo(b);
    // trace = 1 + 2cosθ; θ is the tilt d/R ≈ 0.18° combined with meridian convergence Δλ·sin(lat) ≈ 0.10°
    const trace = R[0] + R[4] + R[8];
    const theta = Math.acos((trace - 1) / 2);
    expect(theta).toBeGreaterThan(20000 / 6371000);
    expect(theta).toBeLessThan(1.3 * 20000 / 6371000);
    // orthonormal rows
    expect(R[0] * R[0] + R[1] * R[1] + R[2] * R[2]).toBeCloseTo(1, 12);
    expect(R[0] * R[3] + R[1] * R[4] + R[2] * R[5]).toBeCloseTo(0, 12);
    // A unit "down" in A becomes almost "down" in B
    const d = [R[2], R[5], R[8]];
    expect(d[2]).toBeCloseTo(1, 5);
  });

  it('great-circle distance and bearing KSFO → LOWI', () => {
    const ksfo = { lat: 37.6188, lon: -122.375, alt: 0 };
    const lowi = { lat: 47.2602, lon: 11.344, alt: 0 };
    const d = greatCircleDistance(ksfo, lowi);
    expect(d / 1852).toBeGreaterThan(5100); // ≈ 5 170 nm
    expect(d / 1852).toBeLessThan(5250);
    const brg = initialBearingDeg(ksfo, lowi);
    expect(brg).toBeGreaterThan(25);
    expect(brg).toBeLessThan(40);
  });

  it('horizon at 1000 m is ≈112.9 km', () => {
    expect(horizonDistance(1000) / 1000).toBeCloseTo(112.9, 0);
  });
});
