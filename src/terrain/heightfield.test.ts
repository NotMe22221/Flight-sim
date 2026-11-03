import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToTile, tileToLonLat } from '../geo/mercator';
import { HeightField } from './heightfield';
import { applyRunwayFlattening, flattenedHeightAt, tileTouchesRunways, type RunwayFlatteningSpec } from './runways';
import { bilinearSample } from './sampling';
import { decodeTerrariumPng } from './terrarium';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const lonLatOf = (x: number, y: number) => tileToLonLat(x, y, 12);
const ksfo = () => decodeTerrariumPng(new Uint8Array(readFileSync(new URL('./__fixtures__/terrarium-15-5246-12684.png', import.meta.url))));

describe('HeightField', () => {
  it('samples the KSFO 28R threshold within 0.5 m of the fixture pixel', () => {
    const hf = new HeightField(15);
    const d = ksfo();
    hf.set(15, 5246, 12684, d.heights, 256, d.minH, d.maxH);
    const s = hf.sample(KSFO.lon, KSFO.lat);
    expect(s).not.toBeNull();
    expect(s!.z).toBe(15);
    expect(Math.abs(s!.h - 3.96)).toBeLessThan(0.5);
    expect(hf.heightAt(KSFO.lon, KSFO.lat)).toBe(s!.h);
    // outside the only tile → null
    expect(hf.sample(KSFO.lon + 1, KSFO.lat)).toBeNull();
    expect(hf.size).toBe(1);
  });

  it('bilinear between two pixels equals their average at the midpoint', () => {
    const w = 4;
    const h = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) h[j * w + i] = 10 * i + 100 * j;
    expect(bilinearSample(h, w, w, 1.0, 0.5)).toBeCloseTo(5, 10);       // between pixel 0 and 1 in x
    expect(bilinearSample(h, w, w, 2.0, 2.0)).toBeCloseTo((110 + 120 + 210 + 220) / 4, 10);
    expect(bilinearSample(h, w, w, 1.5, 1.5)).toBe(h[1 * w + 1]);     // pixel centre
    // beyond the outermost pixel centres: the edge cell extrapolated to the tile border, then clamped
    expect(bilinearSample(h, w, w, 0, 0)).toBeCloseTo(-55, 10);       // plane 10·(px−½) + 100·(py−½) at the NW corner
    expect(bilinearSample(h, w, w, -3, -3)).toBeCloseTo(-55, 10);
    expect(bilinearSample(h, w, w, 4, 4)).toBeCloseTo(385, 10);
    expect(bilinearSample(h, w, w, 99, 99)).toBeCloseTo(385, 10);
    // same through the HeightField: synthetic z10 tile, probe exactly half way between two pixel centres
    const hf = new HeightField(15);
    hf.set(10, 163, 395, h, w);
    const c = tileToLonLat(163 + 1.0 / w, 395 + 0.5 / w, 10);
    expect(hf.heightAt(c.lon, c.lat)!).toBeCloseTo(5, 6);
  });

  it('finest-first: a z15 tile wins over a z12 tile covering the same point; ancestors give the height range', () => {
    const hf = new HeightField(15);
    const coarse = new Float32Array(16).fill(123);
    hf.set(12, 655, 1585, coarse, 4, 123, 123);
    const d = ksfo();
    hf.set(15, 5246, 12684, d.heights, 256, d.minH, d.maxH);
    expect(hf.sample(KSFO.lon, KSFO.lat)!.z).toBe(15);
    const c = tileToLonLat(655.1, 1585.9, 12);
    expect(hf.sample(c.lon, c.lat)!.h).toBe(123);
    const out = new Float64Array(2);
    expect(hf.heightRange(15, 5246, 12684, out)).toBe(15);
    expect(out[0]).toBe(d.minH);
    expect(hf.heightRange(15, 5240, 12680, out)).toBe(12); // descendant of 655/1585
    expect(out[1]).toBe(123);
    expect(hf.heightRange(15, 1, 1, out)).toBe(-1);
    expect(hf.nearestResident(15, 5240, 12680)!.z).toBe(12);
  });

  it('mesh lattice: queries follow the drawn triangles, not a bilinear surface', () => {
    const hf = new HeightField(15);
    // 2 quads per side, one raised centre vertex: the mesh is a pyramid with straight ridges
    const lattice = new Float32Array([0, 0, 0, 0, 8, 0, 0, 0, 0]);
    hf.setMeshLattice(12, 655, 1585, lattice, 2);
    const at = (u: number, v: number) => { const c = tileToLonLat(655 + u, 1585 + v, 12); return hf.heightAt(c.lon, c.lat)!; };
    expect(at(0.5, 0.5)).toBeCloseTo(8, 5);
    // NW and SE quads: their NE–SW diagonals join two zero vertices → 0 (a bilinear surface gives 2)
    expect(at(0.25, 0.25)).toBeCloseTo(0, 5);
    expect(at(0.75, 0.75)).toBeCloseTo(0, 5);
    // NE and SW quads: their diagonals run through the raised vertex → 4 half way
    expect(at(0.75, 0.25)).toBeCloseTo(4, 5);
    expect(at(0.25, 0.75)).toBeCloseTo(4, 5);
    expect(at(0.25, 0.5)).toBeCloseTo(4, 5);   // mid edge between (0,1) and the raised vertex
    expect(hf.sample(lonLatOf(655.75, 1585.75).lon, lonLatOf(655.75, 1585.75).lat)!.tile!.layout).toBe('mesh');
    // the gradient is the face slope: in the SE quad's NW triangle the height falls 8 m per quad eastward
    const g = new Float64Array(2);
    const c = tileToLonLat(655.6, 1585.55, 12);
    expect(hf.gradient(c.lon, c.lat, g)).toBe(true);
    const mpq = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (2 * 2 ** 12);
    expect(g[0]).toBeCloseTo(-8 / mpq, 6);
    expect(g[1]).toBeCloseTo(8 / mpq, 6); // falls southward → rises northward
    expect(() => hf.setMeshLattice(12, 0, 0, new Float32Array(8), 2)).toThrow();
    // numeric-id storage still answers the string API
    expect(hf.getByKey('12/655/1585')!.layout).toBe('mesh');
    expect(hf.deleteKey('12/655/1585')).toBe(true);
    expect(hf.size).toBe(0);
  });

  it('gradient and ENU normal of a tilted plane', () => {
    const w = 8, h = new Float32Array(w * w);
    const hf = new HeightField(15);
    // height rises 1 m per pixel eastward
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) h[j * w + i] = i;
    hf.set(12, 655, 1585, h, w);
    const c = tileToLonLat(655.5, 1585.5, 12);
    const g = new Float64Array(2);
    expect(hf.gradient(c.lon, c.lat, g)).toBe(true);
    const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (w * 2 ** 12);
    expect(g[0]).toBeCloseTo(1 / mpp, 8);
    expect(Math.abs(g[1])).toBeLessThan(1e-9);
    const n: [number, number, number] = [0, 0, 0];
    hf.normalENU(c.lon, c.lat, n);
    expect(n[0]).toBeLessThan(0);
    expect(n[2]).toBeGreaterThan(0.99);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 10);
  });

  it('LRU eviction removes least recently touched tiles and respects protection', () => {
    const hf = new HeightField(15);
    const h = new Float32Array(4);
    for (let i = 0; i < 6; i++) hf.set(10, i, 0, h, 2, 0, 0, i);
    hf.touch(hf.get(10, 0, 0)!, 100);
    const evicted = hf.evictLRU(3, (t) => t.x === 1);
    expect(evicted.map((t) => t.x)).toEqual([2, 3, 4]);
    expect(hf.size).toBe(3);
    expect(hf.has(10, 0, 0)).toBe(true);
    expect(hf.has(10, 1, 0)).toBe(true);
    expect(hf.evictLRU(10)).toEqual([]);
    expect(hf.delete(10, 5, 0)).toBe(true);
    expect(hf.delete(10, 5, 0)).toBe(false);
    expect(hf.sample(0, 0)).toBeNull();
  });
});

describe('runway flattening', () => {
  // Synthetic z15 tile around KSFO 28R with a sloping DEM; runway from A to B with different threshold elevations.
  const z = 15, x = 5246, y = 12684, w = 256;
  const A = { lat: 37.6130, lon: -122.3650, elev: 20 };
  const B = { lat: 37.6070, lon: -122.3560, elev: 50 };
  const spec: RunwayFlatteningSpec = { a: A, b: B, halfWidthM: 60, featherM: 120 };
  const dem = () => {
    const h = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) h[j * w + i] = 200 + 0.3 * i - 0.2 * j;
    return h;
  };

  it('forces heights along the segment to the linear threshold interpolation and feathers outside', () => {
    const h = dem();
    const before = h.slice();
    const modified = applyRunwayFlattening(h, w, z, x, y, [spec]);
    expect(modified).toBeGreaterThan(1000);
    const hf = new HeightField(15);
    hf.set(z, x, y, h, w);
    for (let t = 0.05; t <= 0.95; t += 0.1) {
      const lon = A.lon + (B.lon - A.lon) * t, lat = A.lat + (B.lat - A.lat) * t;
      expect(hf.heightAt(lon, lat)!).toBeCloseTo(A.elev + (B.elev - A.elev) * t, 1);
      expect(flattenedHeightAt(lon, lat, 999, [spec])).toBeCloseTo(A.elev + (B.elev - A.elev) * t, 6);
    }
    // the SE corner of the tile is > 300 m from the strip: nothing changed there
    const corner = lonLatToTile(-122.3550, 37.6140, z);
    const k = Math.floor((corner.y - y) * w) * w + Math.floor((corner.x - x) * w);
    expect(h[k]).toBe(before[k]);
    expect(flattenedHeightAt(A.lon, A.lat + 0.018, 999, [spec])).toBe(999);
    // feather zone: strictly between the DEM and the runway height
    const mid = { lon: (A.lon + B.lon) / 2, lat: (A.lat + B.lat) / 2 };
    const side = { lon: mid.lon, lat: mid.lat + 150 / 111320 }; // ~150 m north of the centreline (strip half-width 60 + feather 120)
    const hDem = 200, hRwy = 35;
    const hs = flattenedHeightAt(side.lon, side.lat, hDem, [spec]);
    expect(hs).toBeGreaterThan(Math.min(hDem, hRwy));
    expect(hs).toBeLessThan(Math.max(hDem, hRwy));
  });

  it('tiles that miss every runway are untouched and reported', () => {
    const h = dem(), copy = h.slice();
    expect(applyRunwayFlattening(h, w, z, x + 10, y, [spec])).toBe(0);
    expect(h).toEqual(copy);
    expect(tileTouchesRunways(z, x, y, [spec])).toBe(true);
    expect(tileTouchesRunways(z, x + 10, y, [spec])).toBe(false);
    expect(applyRunwayFlattening(h, w, z, x, y, [])).toBe(0);
  });
});
