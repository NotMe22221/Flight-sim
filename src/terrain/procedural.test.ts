import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../core/math';
import { tileToLonLat } from '../geo/mercator';
import { PROCEDURAL_MAX_H, PROCEDURAL_MIN_H, ProceduralTerrain } from './procedural';

describe('procedural terrain', () => {
  it('same (lon, lat) → same height from two different tiles/zooms (edge continuity within 1e-6)', () => {
    const p = new ProceduralTerrain({ seed: 42 });
    // z13 tile 1312/3170 (32 px) has exactly the pixel centres of the NW quadrant of z12 tile 656/1585 (64 px)
    const coarse = p.heightsTile(12, 656, 1585, 64), fine = p.heightsTile(13, 1312, 3170, 32);
    for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
      const c = tileToLonLat(656 + (i + 0.5) / 64, 1585 + (j + 0.5) / 64, 12), f = tileToLonLat(1312 + (i + 0.5) / 32, 3170 + (j + 0.5) / 32, 13);
      expect(Math.abs(p.height(c.lon, c.lat) - p.height(f.lon, f.lat))).toBeLessThan(1e-6);
      expect(Math.abs(coarse.heights[j * 64 + i] - fine.heights[j * 32 + i])).toBeLessThan(1e-3); // Float32 storage
    }
    // neighbouring tiles 655 and 656 at z12: the step across the shared edge is no larger than steps inside the tiles
    const a = p.heightsTile(12, 655, 1585, 64), b = p.heightsTile(12, 656, 1585, 64);
    expect(a.heights).not.toEqual(b.heights);
    let maxInside = 0, maxEdge = 0;
    for (let j = 0; j < 64; j++) {
      for (let i = 0; i < 63; i++) maxInside = Math.max(maxInside, Math.abs(a.heights[j * 64 + i + 1] - a.heights[j * 64 + i]), Math.abs(b.heights[j * 64 + i + 1] - b.heights[j * 64 + i]));
      maxEdge = Math.max(maxEdge, Math.abs(a.heights[j * 64 + 63] - b.heights[j * 64]));
    }
    expect(maxEdge).toBeLessThanOrEqual(maxInside * 1.05);
  });

  it('heights stay in a plausible range (−50 .. 3000 m) and are deterministic with the seed', () => {
    const p1 = new ProceduralTerrain({ seed: 7 }), p2 = new ProceduralTerrain({ seed: 7 }), p3 = new ProceduralTerrain({ seed: 8 });
    const rnd = mulberry32(99);
    let minH = Infinity, maxH = -Infinity, same = 0;
    for (let k = 0; k < 20000; k++) {
      const lon = rnd() * 360 - 180, lat = rnd() * 160 - 80;
      const h = p1.height(lon, lat);
      expect(h).toBe(p2.height(lon, lat));
      if (h === p3.height(lon, lat)) same++;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    expect(minH).toBeGreaterThanOrEqual(PROCEDURAL_MIN_H);
    expect(maxH).toBeLessThanOrEqual(PROCEDURAL_MAX_H);
    expect(minH).toBeLessThan(0);      // there are seas
    expect(maxH).toBeGreaterThan(800); // and mountains
    expect(same).toBeLessThan(20);     // a different seed is a different world
  });

  it('plateaus flatten a disc to the given elevation', () => {
    const p = new ProceduralTerrain({ seed: 3, plateaus: [{ lat: 37.6, lon: -122.3, elev: 4, radiusM: 4000, featherM: 2000 }] });
    expect(p.height(-122.3, 37.6)).toBe(4);
    expect(p.height(-122.3 + 0.02, 37.6)).toBe(4);
    const far = p.height(-122.3 + 0.5, 37.6);
    expect(far).toBe(new ProceduralTerrain({ seed: 3 }).height(-122.3 + 0.5, 37.6));
  });

  it('imagery tile is opaque RGBA with water blue and land not blue', () => {
    const p = new ProceduralTerrain({ seed: 5 });
    const w = 32;
    const h = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) h[j * w + i] = i < 16 ? -20 : 10 + (i - 16) * 2;
    const rgba = p.imageryTile(h, w, 12, 655, 1585);
    expect(rgba.length).toBe(w * w * 4);
    for (let k = 0; k < w * w; k++) expect(rgba[k * 4 + 3]).toBe(255);
    const water = rgba.subarray((5 * w + 3) * 4, (5 * w + 3) * 4 + 3), land = rgba.subarray((5 * w + 24) * 4, (5 * w + 24) * 4 + 3);
    expect(water[2]).toBeGreaterThan(water[0]);
    expect(land[1]).toBeGreaterThan(land[2]);
    // deterministic
    expect(p.imageryTile(h, w, 12, 655, 1585)).toEqual(rgba);
  });
});

describe('procedural land cover', () => {
  const p = new ProceduralTerrain({ seed: 7 });
  const tile = (fill: (i: number, j: number) => number, w = 32, z = 13, x = 1310, y = 3170): Uint8ClampedArray => {
    const h = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) h[j * w + i] = fill(i, j);
    return p.imageryTile(h, w, z, x, y);
  };
  const px = (rgba: Uint8ClampedArray, k: number): number[] => [rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]];

  it('beaches at the shore, vegetation inland, rock on cliffs, snow on peaks, dark blue-green water', () => {
    const beach = px(tile(() => 0.7), 300);
    expect(beach[0]).toBeGreaterThan(120); // sand: bright and warm
    expect(beach[0]).toBeGreaterThan(beach[2]);
    const veg = px(tile(() => 120), 300);
    expect(veg[1]).toBeGreaterThanOrEqual(veg[2]); // greens / browns, never blue
    expect(veg[1]).toBeLessThan(170);
    const snow = px(tile(() => 3200), 300);
    expect(Math.min(...snow)).toBeGreaterThan(200);
    // a 50° slope around 900 m: rock grey (channels within a small spread)
    const cliff = px(tile((i) => 900 + i * 30, 32, 15, 5240, 12680), 300);
    expect(Math.max(...cliff) - Math.min(...cliff)).toBeLessThan(40);
    const water = px(tile(() => -30), 300);
    expect(water[2]).toBeGreaterThan(water[0]);
    expect(water[2]).toBeLessThan(90); // dark, not pale
  });

  it('varies across the landscape (not one flat colour) and stays deterministic', () => {
    const w = 64;
    const a = tile((i, j) => 60 + 40 * Math.sin(i / 9) * Math.cos(j / 11), w, 12, 655, 1585);
    const lum = (k: number): number => 0.2126 * a[k * 4] + 0.7152 * a[k * 4 + 1] + 0.0722 * a[k * 4 + 2];
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < w * w; k++) { const l = lum(k); lo = Math.min(lo, l); hi = Math.max(hi, l); }
    expect(hi - lo).toBeGreaterThan(25);
    expect(tile((i, j) => 60 + 40 * Math.sin(i / 9) * Math.cos(j / 11), w, 12, 655, 1585)).toEqual(a);
  });
});
