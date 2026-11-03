import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StarField, blackbodyRGB, equatorialDir, equatorialToLocalMatrix, generateStarCatalog, gmstDeg } from './stars';

const R2D = 180 / Math.PI;
const azEl = (v: THREE.Vector3) => ({ el: Math.asin(v.y) * R2D, az: ((Math.atan2(v.x, -v.z) * R2D) + 360) % 360 });

describe('star field', () => {
  it('GMST: J2000.0 epoch ≈ 280.46°, advances ≈ 360.9856°/day', () => {
    const j2000 = Date.UTC(2000, 0, 1, 12);
    expect(gmstDeg(j2000)).toBeCloseTo(280.46, 1);
    expect(((gmstDeg(j2000 + 86_400_000) - gmstDeg(j2000)) + 360) % 360).toBeCloseTo(0.9856, 2);
  });

  it('Polaris sits near azimuth 0 at elevation ≈ latitude; equinox point on the meridian at LST 0', () => {
    const m = new THREE.Matrix4();
    for (const [lat, lon, t] of [[37.62, -122.37, Date.UTC(2025, 5, 21, 8)], [51.5, 0, Date.UTC(2025, 0, 1, 0)], [-33.9, 151.2, Date.UTC(2025, 8, 10, 14)]] as const) {
      equatorialToLocalMatrix(t, lat, lon, m);
      const polaris = equatorialDir(37.95, 89.26).applyMatrix4(m);
      const { el, az } = azEl(polaris);
      expect(Math.abs(el - lat)).toBeLessThan(1.2);
      if (lat > 0) expect(Math.min(az, 360 - az)).toBeLessThan(2.5);
      else expect(el).toBeLessThan(0); // below the horizon in the south
      // rotation preserves length
      expect(polaris.length()).toBeCloseTo(1, 9);
    }
    // find a time when LST ≈ 0 at lon 0 and check the vernal equinox point is due south at el = 90 − lat
    const lat = 40;
    let t = Date.UTC(2025, 8, 21, 0);
    for (let i = 0; i < 1440; i++) { if (gmstDeg(t) < 0.3) break; t += 60_000; }
    equatorialToLocalMatrix(t, lat, 0, m);
    const { el, az } = azEl(equatorialDir(0, 0).applyMatrix4(m));
    expect(el).toBeCloseTo(90 - lat, 0);
    expect(Math.abs(az - 180)).toBeLessThan(1);
    // stars move westward: 1 h later the equinox point has azimuth > 180 (toward the west) for a northern observer
    equatorialToLocalMatrix(t + 3_600_000, lat, 0, m);
    expect(azEl(equatorialDir(0, 0).applyMatrix4(m)).az).toBeGreaterThan(181);
  });

  it('catalogue is deterministic, unit-length, magnitudes in range with few bright stars', () => {
    const a = generateStarCatalog(3000, 7), b = generateStarCatalog(3000, 7), c = generateStarCatalog(3000, 8);
    expect(a.positions).toEqual(b.positions);
    expect(a.positions).not.toEqual(c.positions);
    let bright = 0;
    for (let i = 0; i < a.count; i++) {
      const l = Math.hypot(a.positions[i * 3], a.positions[i * 3 + 1], a.positions[i * 3 + 2]);
      expect(l).toBeCloseTo(1, 5);
      expect(a.magnitudes[i]).toBeGreaterThanOrEqual(-1.5); expect(a.magnitudes[i]).toBeLessThanOrEqual(6.5);
      if (a.magnitudes[i] < 2) bright++;
      for (let k = 0; k < 3; k++) { expect(a.colors[i * 3 + k]).toBeGreaterThanOrEqual(0); expect(a.colors[i * 3 + k]).toBeLessThanOrEqual(1); }
    }
    expect(bright).toBeGreaterThan(5); expect(bright).toBeLessThan(120);
    const hot = blackbodyRGB(15_000), cool = blackbodyRGB(3000);
    expect(hot.b).toBeGreaterThan(hot.r); expect(cool.r).toBeGreaterThan(cool.b);
  });

  it('StarField is constructible in Node, follows the camera and hides when invisible', () => {
    const sf = new StarField(500, 1);
    const cam = new THREE.Vector3(100, 200, 300);
    sf.update(Date.UTC(2025, 0, 1), 37.6, -122.4, cam, 0.8, 2);
    expect(sf.points.visible).toBe(true);
    expect(sf.points.position.equals(cam)).toBe(true);
    sf.update(Date.UTC(2025, 0, 1), 37.6, -122.4, cam, 0, 2);
    expect(sf.points.visible).toBe(false);
    sf.dispose();
  });
});
