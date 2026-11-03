import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../geo/wgs84';
import { lonLatToTile, tileWidthMeters } from '../geo/mercator';
import { TileProjector, expandTileUrl, hash01, hash2, parseTileKey, sceneryTileKey, tileCenter, tileSeed, tilesAround } from './tileMath';
import { TilePlacement } from './grounding';

describe('tilesAround', () => {
  const lat = 37.6188, lon = -122.375;
  it('returns every z14 tile within the radius, nearest first, the containing tile at distance 0', () => {
    const t = tilesAround(lat, lon, 5000, 14);
    const here = lonLatToTile(lon, lat, 14);
    expect(t[0]).toMatchObject({ x: Math.floor(here.x), y: Math.floor(here.y), distM: 0 });
    for (let i = 1; i < t.length; i++) expect(t[i].distM).toBeGreaterThanOrEqual(t[i - 1].distM);
    expect(t.every((d) => d.distM <= 5000)).toBe(true);
    const w = tileWidthMeters(lat, 14);
    // area check: roughly π r² / w² tiles (± the boundary ring)
    const expected = (Math.PI * 5000 ** 2) / (w * w);
    expect(t.length).toBeGreaterThan(expected * 0.8);
    expect(t.length).toBeLessThan(expected * 1.8);
    expect(new Set(t.map((d) => d.key)).size).toBe(t.length);
  });

  it('reuses the output objects and keeps keys consistent', () => {
    const out = tilesAround(lat, lon, 3000, 14);
    const before = new Set(out);
    const again = tilesAround(lat + 0.0001, lon, 3000, 14, out);
    expect(again).toBe(out);
    expect(again.length).toBe(before.size);
    for (const d of again) expect(before.has(d)).toBe(true); // no new objects
    for (const d of again) expect(d.key).toBe(sceneryTileKey(d.z, d.x, d.y));
    const moved = tilesAround(lat + 0.2, lon, 3000, 14, out);
    for (const d of moved) expect(d.key).toBe(sceneryTileKey(d.z, d.x, d.y));
  });

  it('parses keys and expands URL templates (incl. TMS {-y})', () => {
    expect(parseTileKey('14/2621/6341')).toEqual({ z: 14, x: 2621, y: 6341 });
    expect(parseTileKey('nope')).toBeNull();
    expect(expandTileUrl('https://t/{z}/{x}/{y}.pbf', 14, 1, 2)).toBe('https://t/14/1/2.pbf');
    expect(expandTileUrl('https://t/{z}/{x}/{-y}.pbf', 2, 1, 0)).toBe('https://t/2/1/3.pbf');
  });
});

describe('TileProjector (tile-local ENU)', () => {
  const p = new TileProjector(14, 2621, 6341);
  it('maps the tile centre to the origin and corners to ± half a tile', () => {
    const o = [0, 0];
    p.toLocal(2048, 2048, o, 0);
    expect(Math.hypot(o[0], o[1])).toBeLessThan(1e-6);
    p.toLocal(0, 0, o, 0);
    const w = tileWidthMeters(p.centerLat, 14);
    expect(o[0]).toBeCloseTo(-w / 2, -1);
    expect(o[1]).toBeLessThan(-w * 0.45); // north-west corner: west (−x) and north (−z, since z = south)
    expect(p.unitM * 4096).toBeCloseTo(w, 0);
  });

  it('round-trips tile coordinates ↔ local metres ↔ lon/lat to < 1 mm', () => {
    const o = [0, 0];
    for (const [px, py] of [[0, 0], [4096, 4096], [100, 3900], [2500, 1200]]) {
      p.toLocal(px, py, o, 0);
      const back = p.toTile(o[0], o[1]);
      expect(Math.abs(back.px - px) * p.unitM).toBeLessThan(1e-3);
      expect(Math.abs(back.py - py) * p.unitM).toBeLessThan(1e-3);
    }
  });

  it('places neighbouring tiles so a shared edge point coincides in the render frame', () => {
    const frame = new LocalFrame(37.62, -122.37, 0);
    const a = new TileProjector(14, 2621, 6341), b = new TileProjector(14, 2622, 6341), c = new TileProjector(14, 2621, 6342);
    const pa = new TilePlacement(), pb = new TilePlacement(), pc = new TilePlacement();
    pa.set(a.frame, frame); pb.set(b.frame, frame); pc.set(c.frame, frame);
    const la = [0, 0], lb = [0, 0];
    const wa = { x: 0, y: 0, z: 0 }, wb = { x: 0, y: 0, z: 0 };
    for (const t of [0, 0.3, 1]) {
      a.toLocal(4096, 4096 * t, la, 0); // east edge of a
      b.toLocal(0, 4096 * t, lb, 0); // west edge of b
      pa.toWorld(la[0], 0, la[1], wa); pb.toWorld(lb[0], 0, lb[1], wb);
      expect(Math.hypot(wa.x - wb.x, wa.z - wb.z)).toBeLessThan(0.01);
      // the dropped vertical (curvature) differs by < 0.2 m and is replaced by ground sampling
      expect(Math.abs(wa.y - wb.y)).toBeLessThan(0.2);
      a.toLocal(4096 * t, 4096, la, 0); // south edge of a
      c.toLocal(4096 * t, 0, lb, 0);
      pa.toWorld(la[0], 0, la[1], wa); pc.toWorld(lb[0], 0, lb[1], wb);
      expect(Math.hypot(wa.x - wb.x, wa.z - wb.z)).toBeLessThan(0.01);
    }
  });

  it('matches the geodetic position of a point through the render frame', () => {
    const frame = new LocalFrame(37.7, -122.5, 0); // ≈ 15 km away: convergence + tilt matter
    const pl = new TilePlacement();
    pl.set(p.frame, frame);
    const ll = { lon: 0, lat: 0 };
    p.lonLat(300, 3500, ll);
    const loc = [0, 0];
    p.toLocal(300, 3500, loc, 0);
    const w = { x: 0, y: 0, z: 0 };
    pl.toWorld(loc[0], 0, loc[1], w);
    const g = frame.threeToGeodetic(w.x, w.y, w.z);
    const ky = 111195, kx = ky * Math.cos((ll.lat * Math.PI) / 180);
    expect(Math.hypot((g.lon - ll.lon) * kx, (g.lat - ll.lat) * ky)).toBeLessThan(0.01);
  });
});

describe('hashing', () => {
  it('is deterministic and spread', () => {
    expect(hash2(1, 2)).toBe(hash2(1, 2));
    expect(hash2(1, 2)).not.toBe(hash2(2, 1));
    expect(tileSeed(14, 1, 2)).toBe(tileSeed(14, 1, 2));
    let s = 0;
    for (let i = 0; i < 1000; i++) s += hash01(i, 7);
    expect(s / 1000).toBeGreaterThan(0.45);
    expect(s / 1000).toBeLessThan(0.55);
    const c = tileCenter(14, 2621, 6341);
    expect(c.lat).toBeGreaterThan(37.5);
    expect(c.lon).toBeLessThan(-122.3);
  });
});
