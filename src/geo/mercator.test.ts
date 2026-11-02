import { describe, expect, it } from 'vitest';
import { lonLatToTile, metersPerPixel, normalizeTile, tileBounds, tileToLonLat, tileWidthMeters } from './mercator';

describe('mercator', () => {
  it('KSFO 28R threshold at z15 is tile 5246/12684 near pixel (199,20)', () => {
    const t = lonLatToTile(-122.35716, 37.613538, 15);
    expect(Math.floor(t.x)).toBe(5246);
    expect(Math.floor(t.y)).toBe(12684);
    expect(Math.round((t.x % 1) * 256)).toBeCloseTo(199, -1);
    expect(Math.round((t.y % 1) * 256)).toBeCloseTo(20, -1);
  });

  it('metres per pixel', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(metersPerPixel(37.6, 15)).toBeCloseTo(3.79, 2);
    expect(metersPerPixel(47.3, 14)).toBeCloseTo(6.48, 2);
    expect(tileWidthMeters(37.6, 12) / 1000).toBeCloseTo(7.75, 1);
  });

  it('tile ↔ lonlat round trip', () => {
    const t = lonLatToTile(11.3309, 47.2588, 12);
    const ll = tileToLonLat(t.x, t.y, 12);
    expect(ll.lon).toBeCloseTo(11.3309, 9);
    expect(ll.lat).toBeCloseTo(47.2588, 9);
  });

  it('tile 0/0/0 covers the world', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.north).toBeCloseTo(85.0511, 3);
    expect(b.south).toBeCloseTo(-85.0511, 3);
  });

  it('normalizes x wrap and y clamp', () => {
    expect(normalizeTile(-1, 5, 3)).toEqual({ x: 7, y: 5 });
    expect(normalizeTile(9, -2, 3)).toEqual({ x: 1, y: 0 });
    expect(normalizeTile(2.7, 100, 3)).toEqual({ x: 2, y: 7 });
  });
});
