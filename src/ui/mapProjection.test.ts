import { describe, expect, it } from 'vitest';
import {
  MAX_LAT, MAX_PX_PER_DEG, MIN_PX_PER_DEG, clampLat, clampView, createView, fitBounds, graticuleStep, lonDelta,
  metersPerPixel, pan, project, scaleBarMeters, unproject, visibleBounds, wrapLon, zoomAt,
} from './mapProjection';

const view = createView(-122.37, 37.62, 200, 1024, 600);

describe('wrap / clamp', () => {
  it('wraps longitude into [-180, 180)', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(180)).toBe(-180);
    expect(wrapLon(540)).toBe(-180);
    expect(lonDelta(179, -179)).toBe(-2);
    expect(lonDelta(-179, 179)).toBe(2);
  });
  it('clamps latitude at ±85°', () => {
    expect(clampLat(89)).toBe(MAX_LAT);
    expect(clampLat(-100)).toBe(-MAX_LAT);
    expect(clampLat(12)).toBe(12);
  });
});

describe('project / unproject', () => {
  it('centre maps to the canvas centre', () => {
    const p = project(view, view.centerLon, view.centerLat);
    expect(p.x).toBeCloseTo(512, 9);
    expect(p.y).toBeCloseTo(300, 9);
  });
  it('round trips lon/lat → px → lon/lat', () => {
    for (const [lon, lat] of [[-122.5, 37.5], [-121.9, 38.1], [-123, 36.9], [-122.37, 37.62]]) {
      const p = project(view, lon, lat);
      const g = unproject(view, p.x, p.y);
      expect(g.lon).toBeCloseTo(lon, 9);
      expect(g.lat).toBeCloseTo(lat, 9);
    }
  });
  it('round trips px → lon/lat → px', () => {
    for (const [x, y] of [[0, 0], [1024, 600], [100, 500], [512, 300]]) {
      const g = unproject(view, x, y);
      const p = project(view, g.lon, g.lat);
      expect(p.x).toBeCloseTo(x, 7);
      expect(p.y).toBeCloseTo(y, 7);
    }
  });
  it('north is up and east is right', () => {
    const n = project(view, view.centerLon, view.centerLat + 1);
    const e = project(view, view.centerLon + 1, view.centerLat);
    expect(n.y).toBeLessThan(300);
    expect(n.x).toBeCloseTo(512, 9);
    expect(e.x).toBeCloseTo(512 + 200, 9);
    expect(e.y).toBeCloseTo(300, 9);
  });
  it('is conformal: a kilometre north and a kilometre east are the same length on screen (KSFO, 60°N)', () => {
    for (const lat of [37.62, 60, -45]) {
      const v = createView(10, lat, 20_000, 1000, 800);
      const dLat = 1000 / 111_320, dLon = 1000 / (111_320 * Math.cos(lat * Math.PI / 180));
      const c = project(v, 10, lat), n = project(v, 10, lat + dLat), e = project(v, 10 + dLon, lat);
      expect((c.y - n.y) / (e.x - c.x)).toBeCloseTo(1, 3);
    }
  });
  it('keeps runways that cross at 90° crossing at 90° on the map', () => {
    const lat = 37.62, v = createView(-122.37, lat, 3000, 1000, 800);
    const k = 1 / (111_320 * Math.cos(lat * Math.PI / 180));
    const at = (bearing: number, m: number) => project(v, -122.37 + Math.sin(bearing * Math.PI / 180) * m * k, lat + Math.cos(bearing * Math.PI / 180) * m / 111_320);
    const c = project(v, -122.37, lat), a = at(298, 3000), b = at(28, 2600);
    const ang = Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x);
    expect(Math.abs(Math.cos(ang))).toBeLessThan(0.01);
  });
  it('handles the antimeridian', () => {
    const v = createView(179.5, 0, 100, 800, 600);
    const p = project(v, -179.5, 0); // 1° east of centre across the dateline
    expect(p.x).toBeCloseTo(400 + 100, 9);
  });
});

describe('zoomAt', () => {
  it('keeps the lon/lat under the cursor fixed', () => {
    const cursor = { x: 700, y: 120 };
    const before = unproject(view, cursor.x, cursor.y);
    for (const f of [2, 0.5, 1.25, 0.8]) {
      const z = zoomAt(view, cursor.x, cursor.y, f);
      const after = unproject(z, cursor.x, cursor.y);
      expect(after.lon).toBeCloseTo(before.lon, 9);
      expect(after.lat).toBeCloseTo(before.lat, 9);
      expect(z.pxPerDeg).toBeCloseTo(view.pxPerDeg * f, 9);
    }
  });
  it('clamps the scale', () => {
    expect(zoomAt(view, 0, 0, 1e9).pxPerDeg).toBe(MAX_PX_PER_DEG);
    expect(zoomAt(view, 0, 0, 1e-9).pxPerDeg).toBe(MIN_PX_PER_DEG);
  });
});

describe('pan / clampView', () => {
  it('dragging right moves the centre west', () => {
    const p = pan(view, 200, 0);
    expect(p.centerLon).toBeCloseTo(view.centerLon - 1, 9);
    const q = pan(view, 0, -100); // drag up: the content follows the pointer, the centre moves south
    expect(q.centerLat).toBeLessThan(view.centerLat);
    expect(project(q, view.centerLon, view.centerLat).y).toBeCloseTo(300 - 100, 6);
  });
  it('never lets the visible range exceed ±85° latitude', () => {
    const v = clampView({ centerLon: 0, centerLat: 89, pxPerDeg: 10, width: 800, height: 600 });
    const b = visibleBounds(v);
    expect(b.maxLat).toBeLessThanOrEqual(MAX_LAT + 1e-9);
    expect(project(v, 0, MAX_LAT).y).toBeCloseTo(0, 6); // the top edge sits exactly on 85°N
    const s = clampView({ centerLon: 0, centerLat: -89, pxPerDeg: 10, width: 800, height: 600 });
    expect(visibleBounds(s).minLat).toBeGreaterThanOrEqual(-MAX_LAT - 1e-9);
  });
  it('centres on the equator when the whole range fits', () => {
    const v = clampView({ centerLon: 0, centerLat: 40, pxPerDeg: 1, width: 800, height: 600 });
    expect(v.centerLat).toBe(0);
  });
  it('wraps the centre longitude', () => {
    expect(pan(createView(179.9, 0, 100, 800, 600), -50, 0).centerLon).toBeCloseTo(-179.6, 9);
  });
});

describe('helpers', () => {
  it('fitBounds shows the whole box', () => {
    const v = fitBounds({ minLon: -123, maxLon: -121, minLat: 37, maxLat: 38 }, 1000, 600, 0);
    const b = visibleBounds(v);
    expect(b.minLon).toBeLessThanOrEqual(-123 + 1e-9);
    expect(b.maxLon).toBeGreaterThanOrEqual(-121 - 1e-9);
    expect(b.minLat).toBeLessThanOrEqual(37 + 1e-9);
    expect(b.maxLat).toBeGreaterThanOrEqual(38 - 1e-9);
  });
  it('graticule step grows as you zoom out', () => {
    expect(graticuleStep(1)).toBe(90);
    expect(graticuleStep(10)).toBe(10);
    expect(graticuleStep(200)).toBe(0.5);
    expect(graticuleStep(10000)).toBe(0.01);
  });
  it('metres per pixel and scale bar', () => {
    const mpp = metersPerPixel(view, 0);
    expect(mpp).toBeCloseTo(111320 / 200, 6);
    const sb = scaleBarMeters(view, 0, 120);
    expect(sb.px).toBeLessThanOrEqual(120);
    expect(sb.meters).toBeGreaterThan(0);
  });
});
