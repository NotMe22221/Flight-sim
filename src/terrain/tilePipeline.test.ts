import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToTile } from '../geo/mercator';
import { HeightField } from './heightfield';
import { decodeTerrariumPng } from './terrarium';
import { runTilePipeline } from './tilePipeline';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const frame = { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 };
const fixture = (n: string) => decodeTerrariumPng(new Uint8Array(readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url))));

describe('tile pipeline', () => {
  it('KSFO z15: mesh + ocean patch (the bay) + full heights, runway flattening applied', () => {
    const d = fixture('terrarium-15-5246-12684.png');
    const rw = { a: { lat: 37.613538, lon: -122.35716, elev: 3.96 }, b: { lat: 37.6100, lon: -122.3610, elev: 3.0 }, halfWidthM: 60, featherM: 150 };
    const out = runTilePipeline({ z: 15, x: 5246, y: 12684, heights: d.heights, width: 256, frame, quads: 64, skirt: 48, runways: [rw], fullHeights: true, water: true });
    expect(out.mesh.vertexCount).toBe(65 * 65 + 6 * 65);
    expect(out.heightsWidth).toBe(256);
    expect(out.heights).toBe(d.heights);
    expect(out.waterFraction).toBeGreaterThan(0.05); // part of the bay is in this tile
    expect(out.water).not.toBeNull();
    expect(out.flattenedPixels).toBeGreaterThan(100);
    const hf = new HeightField(15);
    hf.set(15, 5246, 12684, out.heights, out.heightsWidth, out.mesh.minH, out.mesh.maxH);
    expect(hf.heightAt(KSFO.lon, KSFO.lat)!).toBeCloseTo(3.96, 1);
  });

  it('coarse tiles return a 4× downsample and no water when dry', () => {
    const d = fixture('terrarium-15-17415-11490.png'); // Innsbruck: all land
    const out = runTilePipeline({ z: 10, x: 544, y: 359, heights: d.heights, width: 256, frame, quads: 32, skirt: 100, runways: [], fullHeights: false, water: true });
    expect(out.heightsWidth).toBe(64);
    expect(out.heights.length).toBe(64 * 64);
    expect(out.water).toBeNull();
    expect(out.waterFraction).toBe(0);
    // the downsample preserves the mean
    let a = 0, b = 0;
    for (let i = 0; i < d.heights.length; i++) a += d.heights[i];
    for (let i = 0; i < out.heights.length; i++) b += out.heights[i];
    expect(a / d.heights.length).toBeCloseTo(b / out.heights.length, 3);
    const t = lonLatToTile(11.3309, 47.2588, 10);
    expect(Math.floor(t.x)).toBe(544);
  });
});
