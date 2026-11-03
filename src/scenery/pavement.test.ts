import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { tileBounds } from '../geo/mercator';
import { PavementRegistry } from '../world/pavement';
import type { Airport } from '../core/types';
import { buildTile } from './builder';
import { qualityProfile } from './config';
import { SceneryManager } from './manager';
import { resetTileSourceCache } from './source';
import { KSFO_FRAME, makeHost, tileBytesAt, worldFetch } from './testUtil';

const settings = qualityProfile('high').build;
const GATE_A1 = { lat: 37.615867, lon: -122.393443 }; // terminal apron (synthetic world)
const ARP = { lat: 37.619806, lon: -122.374821 };
const camera = new THREE.PerspectiveCamera();
const tick = () => new Promise((r) => setTimeout(r, 0));
const KSFO: Airport = {
  icao: 'KSFO', name: 'SFO', position: { ...ARP, alt: 4 }, elevationM: 4, type: 'large', country: 'US',
  runways: [{ ident: '10L/28R', threshold: { lat: 37.628742, lon: -122.39341, alt: 1.5 }, end: { lat: 37.613538, lon: -122.35716, alt: 4 }, headingDeg: 118, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 }],
};

afterEach(() => { resetTileSourceCache(); vi.restoreAllMocks(); });

describe('scenery pavement for terrain flattening', () => {
  it('a tile publishes its aprons (with holes) and taxiway centre lines in lon/lat, also from a parking-only build', () => {
    const t = tileBytesAt(GATE_A1.lat, GATE_A1.lon);
    const full = buildTile(t.bytes, t.z, t.x, t.y, settings);
    const park = buildTile(t.bytes, t.z, t.x, t.y, settings, true);
    expect(park.pavement).toEqual(full.pavement);
    const aprons = full.pavement.filter((a) => a.kind === 'apron');
    const lines = full.pavement.filter((a) => a.kind === 'taxiline');
    expect(aprons.length).toBeGreaterThan(0);
    // the terminal apron's grass island (in the tile south of the gates): outer ring + hole
    const h = tileBytesAt(37.6135, -122.3901);
    expect(buildTile(h.bytes, h.z, h.x, h.y, settings, true).pavement.some((a) => a.kind === 'apron' && a.rings.length === 2)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.widthM >= 4 && l.line.length >= 4)).toBe(true);
    expect(new Set(full.pavement.map((a) => a.key)).size).toBe(full.pavement.length);
    // clipped to the tile square (lon/lat within the tile bounds)
    const b = tileBounds(t.x, t.y, t.z), eps = 1e-6;
    for (const a of full.pavement) {
      for (const pts of [...a.rings, a.line]) {
        for (let i = 0; i + 1 < pts.length; i += 2) {
          expect(pts[i]).toBeGreaterThanOrEqual(b.west - eps); expect(pts[i]).toBeLessThanOrEqual(b.east + eps);
          expect(pts[i + 1]).toBeGreaterThanOrEqual(b.south - eps); expect(pts[i + 1]).toBeLessThanOrEqual(b.north + eps);
        }
      }
    }
  });

  it('the manager publishes the pavement of every tile it has (streamed or parking-only), bumping a revision; the registry bounds and deduplicates it', async () => {
    const host = makeHost(KSFO_FRAME(), () => 4);
    const m = new SceneryManager({ ...host, tileUrl: 'http://fixtures/{z}/{x}/{y}.pbf', fetch: worldFetch(), stream: { radiusM: 2500, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 }, log: () => {} });
    expect(m.pavementAreas()).toHaveLength(0);
    const rev0 = m.pavementRevision();
    await m.parkingSpots(GATE_A1.lat, GATE_A1.lon, 300); // parking-only builds, no tile objects
    expect(m.tileObjects()).toHaveLength(0);
    expect(m.pavementRevision()).toBeGreaterThan(rev0);
    const parked = m.pavementAreas().length;
    expect(parked).toBeGreaterThan(0);
    // streaming the same tiles again does not duplicate them; new tiles add theirs
    const cam = new THREE.Vector3(0, 300, 0);
    for (let i = 0; i < 400 && m.stats().tilesPending > 0 || i < 5; i++) { m.update(1 / 60, cam, camera, 0.8); await tick(); }
    const all = m.pavementAreas();
    expect(all.length).toBeGreaterThanOrEqual(parked);
    expect(new Set(all.map((a) => a.key)).size).toBe(all.length);
    const rev1 = m.pavementRevision();
    m.update(1 / 60, cam, camera, 0.8);
    expect(m.pavementRevision()).toBe(rev1);
    expect(m.pavementAreas()).toBe(all); // reused until the revision changes
    // the world side: only areas near KSFO, pieces of one apron across tiles each kept once
    const reg = new PavementRegistry();
    const specs = reg.sync({ pavementRevision: () => m.pavementRevision(), pavementAreas: () => m.pavementAreas() }, [KSFO])!;
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.length).toBeLessThanOrEqual(all.length);
    expect(new Set(specs.map((s) => s.key)).size).toBe(specs.length);
    m.dispose();
  });
});
