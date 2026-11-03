import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import type { Airport, NavDatabase, Navaid, Runway } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import { planeHeightAt } from '../terrain/pavement';
import type { FetchFn } from '../terrain/tileFetch';
import { TerrainSystem } from '../terrain/TerrainSystem';
import { NEAR_DROP_M } from '../scenery/materials';
import { MARKING_LIFT_M, NEAR_RUNWAY_LIFT_M, RIBBON_LIFT_M, SURFACE_LIFT_M, TAXIWAY_AREA_LIFT_M } from '../scenery/builder';
import type { PavementArea, PavementSource } from './pavement';
import { World } from './World';

const THR = { lat: 37.613538, lon: -122.35716 }; // KSFO 28R threshold
const AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const FIXTURES = new Map<string, Uint8Array>(
  ['15/5246/12684', '12/655/1585', '12/656/1585'].map((k) => [
    `${AWS}/${k}.png`,
    new Uint8Array(readFileSync(new URL(`../terrain/__fixtures__/terrarium-${k.replace(/\//g, '-')}.png`, import.meta.url))),
  ]),
);
const fixtureFetch: FetchFn = async (url) => {
  const body = FIXTURES.get(url);
  return body ? new Response(body.slice(), { status: 200 }) : new Response(null, { status: 404 });
};

// thresholds raised to ≈ 9 m so the pavement plane is well clear of the ≈ 0–4 m DEM
const rw: Runway = { ident: '10L/28R', threshold: { lat: 37.628742, lon: -122.39341, alt: 8.5 }, end: { lat: 37.613538, lon: -122.35716, alt: 9 }, headingDeg: 118, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 };
const ksfo: Airport = { icao: 'KSFO', name: 'SFO', position: { lat: 37.62, lon: -122.375, alt: 4 }, elevationM: 4, type: 'large', country: 'US', runways: [rw] };
const nav: NavDatabase = {
  loadRegion: async () => {}, getAirport: () => ksfo, nearestAirports: () => [ksfo], nearestNavaids: (): Navaid[] => [],
  searchAirports: () => [ksfo], findNavaidByFrequency: () => undefined, findIlsByFrequency: () => undefined,
};

const KX = 111_194.93 * Math.cos((THR.lat * Math.PI) / 180), KY = 111_194.93;
const ll = (e: number, n: number): [number, number] => [THR.lon + e / KX, THR.lat + n / KY];
const rect = (e0: number, n0: number, e1: number, n1: number): number[] => [...ll(e0, n0), ...ll(e1, n0), ...ll(e1, n1), ...ll(e0, n1)];
/** an apron north of the 28R threshold, clear of the runway strip and its feather */
const APRON: PavementArea = { key: '14/2620/6342/a0', kind: 'apron', rings: [rect(-320, 450, -80, 620)], line: [], widthM: 0 };

class Source implements PavementSource {
  constructor(public areas: PavementArea[]) {}
  pavementRevision(): number { return this.areas.length; }
  pavementAreas(): readonly PavementArea[] { return this.areas; }
}

function setup(areas: PavementArea[]) {
  const clock = { t: 0 };
  const terrain = new TerrainSystem(new LocalFrame(THR.lat, THR.lon, 0), {
    fetch: fixtureFetch, uploadsPerFrame: Infinity, minZoom: 12, maxZoom: 15, range0M: 2000,
    horizonCull: false, proceduralTileSize: 64, quadsPerLevel: [128, 64], maxAnisotropy: 1, now: () => clock.t,
  });
  const world = new World(terrain, nav, null, THR.lat, THR.lon);
  const source = new Source(areas);
  world.setPavementSource(() => source);
  world.airports.ensureAirport(ksfo);
  world.syncRunways();
  return { terrain, world, source, clock };
}
async function settle(terrain: TerrainSystem, clock: { t: number }): Promise<void> {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.3, 600_000);
  cam.position.set(-200, 300, -500);
  cam.lookAt(-200, 0, -1500);
  cam.updateMatrixWorld();
  for (let i = 0; i < 30; i++) {
    clock.t += 200;
    terrain.update(cam.position, cam, 0.2);
    if (terrain.stats().inflight === 0) return;
    await terrain.whenIdle();
  }
  throw new Error('terrain did not settle');
}
/** local-up of the apron plane at a NED point */
function planeUp(world: World, n: number, e: number): number {
  const g = world.frame.nedToGeodetic(n, e, 0);
  const p = world.pavement.specs()[0].plane;
  return -world.frame.geodeticToNED(g.lat, g.lon, planeHeightAt(p, g.lon, g.lat))[2];
}

describe('World pavement flattening (terrain in-thread on the KSFO fixtures)', () => {
  it('spawn order: pavement pushed before the prefetch → the first ground under the stand is already flat', async () => {
    const { terrain, world } = setup([APRON]);
    world.syncPavement(true); // what Simulator.beginFlight does before its prefetch
    const [lon, lat] = ll(-200, 530);
    await terrain.prefetch(lat, lon, 300);
    const p = world.frame.geodeticToNED(lat, lon, 0);
    expect(Math.abs(world.groundHeight(p[0], p[1])! - planeUp(world, p[0], p[1]))).toBeLessThan(0.01);
    terrain.dispose();
  });

  it('drawn pavement near the camera sits 0–1 cm above the collision ground everywhere on the apron (also between drape vertices)', async () => {
    const { terrain, world, clock } = setup([APRON]);
    world.syncPavement(true);
    await settle(terrain, clock);
    // near-camera lift of every tier: what the wheels see under the drawn surface
    const tiers = [SURFACE_LIFT_M, TAXIWAY_AREA_LIFT_M, RIBBON_LIFT_M, RIBBON_LIFT_M + MARKING_LIFT_M].map((l) => l - NEAR_DROP_M);
    tiers.push(NEAR_RUNWAY_LIFT_M, NEAR_RUNWAY_LIFT_M + 0.004);
    for (const l of tiers) { expect(l).toBeGreaterThan(0); expect(l).toBeLessThanOrEqual(0.0101); }
    // drape grid of the scenery (16 m cells), triangles (00, 10, 11): interpolated vs collision at interior points
    const g = (n: number, e: number) => world.groundHeight(n, e)!;
    const [lon0, lat0] = ll(-300, 460);
    const o = world.frame.geodeticToNED(lat0, lon0, 0);
    let worst = 0, cells = 0;
    for (let a = 0; a < 9; a++) {
      for (let b = 0; b < 12; b++) {
        const n0 = o[0] + 16 * a, e0 = o[1] + 16 * b;
        const h00 = g(n0, e0), h10 = g(n0, e0 + 16), h11 = g(n0 + 16, e0 + 16);
        for (const [u, v] of [[0.5, 0.25], [0.75, 0.5], [0.66, 0.33], [0.9, 0.1]]) {
          const drawn = h00 + (h10 - h00) * u + (h11 - h10) * v + tiers[0];
          const diff = drawn - g(n0 + 16 * v, e0 + 16 * u);
          worst = Math.max(worst, Math.abs(diff - tiers[0]));
          expect(diff).toBeGreaterThanOrEqual(-1e-3);
          expect(diff).toBeLessThan(0.01);
        }
        cells++;
      }
    }
    expect(cells).toBe(108);
    expect(worst).toBeLessThan(0.002);
    terrain.dispose();
  });

  it('groundShift reports the height change a reload makes under a standing aircraft, once', async () => {
    const { terrain, world, source, clock } = setup([]);
    await settle(terrain, clock);
    const [lon, lat] = ll(-200, 530);
    const p = world.frame.geodeticToNED(lat, lon, 0);
    expect(world.groundShift(p[0], p[1])).toBe(0); // reference
    const before = world.groundHeight(p[0], p[1])!;
    source.areas = [APRON];
    world.syncPavement();
    await settle(terrain, clock);
    const after = world.groundHeight(p[0], p[1])!;
    expect(Math.abs(after - before)).toBeGreaterThan(1); // the stand was raised to the plane (≈ 9 m vs a ≈ 0–4 m DEM)
    expect(world.groundShift(p[0] + 0.05, p[1])).toBeCloseTo(after - before, 2);
    expect(world.groundShift(p[0] + 0.1, p[1])).toBe(0);
    // a teleport (slew, respawn) is not a terrain change
    terrain.setPavement([]);
    await settle(terrain, clock);
    expect(world.groundShift(p[0] + 500, p[1])).toBe(0);
    terrain.dispose();
  });
});
