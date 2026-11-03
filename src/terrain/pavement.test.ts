import { describe, expect, it } from 'vitest';
import { lonLatToTile, tileToLonLat } from '../geo/mercator';
import { LocalFrame } from '../geo/wgs84';
import {
  PAVEMENT_MIN_ZOOM, applyPavementFlattening, makePavementSpec, pavementForTile, planeHeightAt, tileTouchesPavement,
  type PavementFlatteningSpec, type PavementPlane,
} from './pavement';
import { runTilePipeline } from './tilePipeline';

const Z = 15;
const T = lonLatToTile(-122.3896, 37.6155, Z);
const TX = Math.floor(T.x), TY = Math.floor(T.y);
const C = tileToLonLat(TX + 0.5, TY + 0.5, Z);
const KX = 111_194.93 * Math.cos((C.lat * Math.PI) / 180), KY = 111_194.93;
/** lon/lat of a point `e`, `n` metres east / north of the tile centre */
const ll = (e: number, n: number): [number, number] => [C.lon + e / KX, C.lat + n / KY];
const rect = (e0: number, n0: number, e1: number, n1: number): number[] => [...ll(e0, n0), ...ll(e1, n0), ...ll(e1, n1), ...ll(e0, n1)];
const PLANE: PavementPlane = { lat0: C.lat, lon0: C.lon, h0: 5, dhdE: 0.002, dhdN: -0.001 };
/** bumpy synthetic DEM, 18…42 m */
const dem = (lon: number, lat: number): number => {
  const e = (lon - C.lon) * KX, n = (lat - C.lat) * KY;
  return 30 + 8 * Math.sin(e / 41) * Math.cos(n / 57) + 4 * Math.sin(n / 23);
};
function grid(x: number, y: number, w = 256): Float32Array {
  const h = new Float32Array(w * w);
  for (let j = 0; j < w; j++) {
    const lat = tileToLonLat(x, y + (j + 0.5) / w, Z).lat;
    for (let i = 0; i < w; i++) h[j * w + i] = dem(tileToLonLat(x + (i + 0.5) / w, y, Z).lon, lat);
  }
  return h;
}
const pixel = (x: number, y: number, w: number, i: number, j: number) => ({
  lon: tileToLonLat(x + (i + 0.5) / w, y, Z).lon, lat: tileToLonLat(x, y + (j + 0.5) / w, Z).lat,
});
const local = (lon: number, lat: number) => ({ e: (lon - C.lon) * KX, n: (lat - C.lat) * KY });

describe('pavement flattening', () => {
  // a 600 × 500 m apron with a 200 m square hole; narrow feather so the hole centre stays natural ground
  const apron = makePavementSpec('apron', { rings: [rect(-300, -250, 300, 250), rect(-100, -100, 100, 100)] }, PLANE, { featherMinM: 20, featherMaxM: 40 })!;

  it('flattens an apron to its plane (shoulder included), keeps a large hole open, leaves the rest untouched', () => {
    const w = 256, h = grid(TX, TY, w), before = h.slice();
    const n = applyPavementFlattening(h, w, Z, TX, TY, [apron]);
    expect(n).toBeGreaterThan(1000);
    let inside = 0, hole = 0, far = 0, shoulder = 0;
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const p = pixel(TX, TY, w, i, j), q = local(p.lon, p.lat), k = j * w + i;
        const ae = Math.abs(q.e), an = Math.abs(q.n);
        const inOuter = ae < 300 && an < 250, inHole = ae < 100 && an < 100;
        const target = planeHeightAt(PLANE, p.lon, p.lat);
        if (inOuter && !inHole) { expect(h[k]).toBeCloseTo(target, 3); inside++; }
        // shoulder: within 15 m outside the outline / inside the hole's edge
        const outDist = Math.hypot(Math.max(0, ae - 300), Math.max(0, an - 250));
        if ((!inOuter && outDist < 14.5) || (inHole && Math.min(100 - ae, 100 - an) < 14.5)) { expect(h[k]).toBeCloseTo(target, 3); shoulder++; }
        // hole centre: further than shoulder + feather (15 + 40 m) from its edge → natural ground
        if (ae < 40 && an < 40) { expect(h[k]).toBe(before[k]); hole++; }
        // beyond the outline + shoulder + widest feather: untouched
        if (ae > 360 || an > 310) { expect(h[k]).toBe(before[k]); far++; }
      }
    }
    expect(inside).toBeGreaterThan(5000);
    expect(hole).toBeGreaterThan(300);
    expect(shoulder).toBeGreaterThan(500);
    expect(far).toBeGreaterThan(10000);
  });

  it('feathers continuously into the DEM: no step, no cliff steeper than the bank limit allows', () => {
    const spec = makePavementSpec('a', { rings: [rect(-150, -150, 150, 150)] }, { ...PLANE, h0: 40 })!; // 5…20 m cuts / fills
    const w = 256, h = grid(TX, TY, w);
    applyPavementFlattening(h, w, Z, TX, TY, [spec]);
    const px = (KX * 360) / 2 ** Z / w; // pixel width in metres
    let maxStep = 0;
    for (let j = 0; j < w; j++) {
      for (let i = 1; i < w; i++) maxStep = Math.max(maxStep, Math.abs(h[j * w + i] - h[j * w + i - 1]));
    }
    for (let i = 0; i < w; i++) for (let j = 1; j < w; j++) maxStep = Math.max(maxStep, Math.abs(h[j * w + i] - h[(j - 1) * w + i]));
    // natural slopes of the DEM reach ≈ 0.35; the bank adds at most maxBankSlope (0.25) plus a fraction of the DEM slope
    expect(maxStep / px).toBeLessThan(0.75);
    expect(maxStep).toBeLessThan(3);
  });

  it('buffers taxiway centre lines to their width (+ shoulder) and leaves ground beyond the reach alone', () => {
    const line = [...ll(-400, -60), ...ll(0, 0), ...ll(400, 80)];
    const spec = makePavementSpec('twy', { line, halfWidthM: 9 }, PLANE)!;
    const w = 256, h = grid(TX, TY, w), before = h.slice();
    applyPavementFlattening(h, w, Z, TX, TY, [spec]);
    const seg = (q: { e: number; n: number }, a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((q.e - a[0]) * dx + (q.n - a[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(q.e - a[0] - t * dx, q.n - a[1] - t * dy);
    };
    let flat = 0, outside = 0;
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const p = pixel(TX, TY, w, i, j), q = local(p.lon, p.lat), k = j * w + i;
        const d = Math.min(seg(q, [-400, -60], [0, 0]), seg(q, [0, 0], [400, 80]));
        if (d < 9 + 15 - 0.5) { expect(h[k]).toBeCloseTo(planeHeightAt(PLANE, p.lon, p.lat), 3); flat++; }
        if (d > 9 + 15 + 160 + 0.5) { expect(h[k]).toBe(before[k]); outside++; }
      }
    }
    expect(flat).toBeGreaterThan(500);
    expect(outside).toBeGreaterThan(10000);
  });

  it('gives identical heights on both sides of a tile edge inside the area (mesh lattice)', () => {
    // the apron straddles the east edge of tile TX
    const edgeLon = tileToLonLat(TX + 1, TY, Z).lon, eEdge = (edgeLon - C.lon) * KX;
    const spec = makePavementSpec('edge', { rings: [rect(eEdge - 200, -300, eEdge + 200, 300)] }, PLANE)!;
    const frame = new LocalFrame(C.lat, C.lon, 0);
    const run = (x: number) => runTilePipeline({ z: Z, x, y: TY, heights: grid(x, TY), width: 256, frame: frame.info, quads: 128, skirt: 20, runways: [], pavement: [spec], fullHeights: true, water: false });
    const a = run(TX), b = run(TX + 1);
    const N = 128, W = N + 1;
    let checked = 0;
    for (let j = 0; j <= N; j++) {
      const lat = tileToLonLat(TX, TY + j / N, Z).lat, n = (lat - C.lat) * KY;
      if (Math.abs(n) > 280) continue;
      const ha = a.mesh.height[j * W + N], hb = b.mesh.height[j * W];
      expect(Math.abs(ha - hb)).toBeLessThan(1e-3);
      expect(ha).toBeCloseTo(planeHeightAt(PLANE, edgeLon, lat), 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('a runway strip wins over pavement in the pipeline; coarse tiles and far tiles are skipped', () => {
    const spec = makePavementSpec('a', { rings: [rect(-300, -300, 300, 300)] }, PLANE)!;
    const rw = { a: { lat: C.lat, lon: ll(-250, 0)[0], elev: 2 }, b: { lat: C.lat, lon: ll(250, 0)[0], elev: 2 }, halfWidthM: 60, featherM: 150 };
    const frame = new LocalFrame(C.lat, C.lon, 0);
    const out = runTilePipeline({ z: Z, x: TX, y: TY, heights: grid(TX, TY), width: 256, frame: frame.info, quads: 128, skirt: 20, runways: [rw], pavement: [spec], fullHeights: true, water: false });
    const mid = 64 * 129 + 64; // lattice centre ≈ tile centre, on the runway
    expect(out.mesh.height[mid]).toBeCloseTo(2, 3);
    // walking north across the strip edge (60 m) and the runway feather (to 210 m) onto the apron
    // (plane ≈ 5 m, 3 m above the strip): no step anywhere, the strip inside, the plane beyond
    const N = 128, W = N + 1;
    let maxStep = 0, rows = 0;
    for (let j = 64; j > 0; j--) {
      const lat = tileToLonLat(TX, TY + j / N, Z).lat, lon = tileToLonLat(TX + 0.5, TY, Z).lon, n = local(lon, lat).n;
      if (n > 290) break;
      const h = out.mesh.height[j * W + 64], hNext = out.mesh.height[(j - 1) * W + 64];
      maxStep = Math.max(maxStep, Math.abs(hNext - h));
      if (n < 55) expect(h).toBeCloseTo(2, 3);
      if (n > 215) expect(h).toBeCloseTo(planeHeightAt(PLANE, lon, lat), 3);
      rows++;
    }
    expect(rows).toBeGreaterThan(30);
    // smoothstep over 150 m: at most 1.5 · 3 m / 150 m = 3 % → ≤ 0.23 m per 7.6 m lattice step
    expect(maxStep).toBeLessThan(0.25);
    expect(tileTouchesPavement(PAVEMENT_MIN_ZOOM - 1, TX >> 5, TY >> 5, [spec])).toBe(false);
    expect(pavementForTile(Z, TX + 5, TY, [spec])).toHaveLength(0);
    expect(pavementForTile(Z, TX, TY, [spec])).toHaveLength(1);
    expect(makePavementSpec('bad', { rings: [[1, 2, 3]] }, PLANE)).toBeNull();
  });

  it('overlapping areas of one airport merge (min distance), split pieces join without a seam', () => {
    // one apron split into two pieces along n = 0 (as the scenery clips features to its tiles)
    const top = makePavementSpec('t', { rings: [rect(-200, 0, 200, 150)] }, PLANE)!;
    const bottom = makePavementSpec('b', { rings: [rect(-200, -150, 200, 0)] }, PLANE)!;
    const whole = makePavementSpec('w', { rings: [rect(-200, -150, 200, 150)] }, PLANE)!;
    const w = 256;
    const h1 = grid(TX, TY, w), h2 = grid(TX, TY, w);
    applyPavementFlattening(h1, w, Z, TX, TY, [top, bottom]);
    applyPavementFlattening(h2, w, Z, TX, TY, [whole]);
    let maxDiff = 0;
    for (let k = 0; k < h1.length; k++) maxDiff = Math.max(maxDiff, Math.abs(h1[k] - h2[k]));
    // identical except where the split's inner edge is nearer than the outline (none: the seam is inside both)
    expect(maxDiff).toBeLessThan(1e-4);
  });
});

/** Shared with other tests: a spec over the KSFO terminal-apron area. */
export function testApron(plane: PavementPlane): PavementFlatteningSpec {
  return makePavementSpec('test-apron', { rings: [rect(-200, -150, 200, 150)] }, plane)!;
}
