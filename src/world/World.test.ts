import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Airport, NavDatabase, Navaid, Runway, Vec3 } from '../core/types';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import type { PavementArea } from './pavement';
import { World } from './World';

const rw: Runway = { ident: '10L/28R', threshold: { lat: 37.628742, lon: -122.39341, alt: 1.5 }, end: { lat: 37.613538, lon: -122.35716, alt: 4 }, headingDeg: 118, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 };
const ksfo: Airport = { icao: 'KSFO', name: 'SFO', position: { lat: 37.62, lon: -122.375, alt: 4 }, elevationM: 4, type: 'large', country: 'US', runways: [rw] };
const nav: NavDatabase = {
  loadRegion: async () => {}, getAirport: () => ksfo, nearestAirports: () => [ksfo], nearestNavaids: (): Navaid[] => [],
  searchAirports: () => [ksfo], findNavaidByFrequency: () => undefined, findIlsByFrequency: () => undefined,
};

/** Fake terrain: land at +4 m west of −122.36, bay floor at −3 m east of it (in local-up coordinates relative to alt0 = 0). */
function fakeTerrain(world: () => World): TerrainSystem {
  return {
    group: new (class { add() {} })() as never,
    heightAtLocalNED: (n: number, e: number) => {
      const g = world().frame.nedToGeodetic(n, e, 0);
      return g.lon < -122.36 ? 4 - (n * n + e * e) / (2 * 6371000) : -3;
    },
    groundNormalNED: (_n: number, _e: number, out: Vec3) => { out[0] = 0; out[1] = 0; out[2] = -1; return out; },
    setFrame: () => {}, setRunways: () => {}, update: () => {}, dispose: () => {},
  } as unknown as TerrainSystem;
}

describe('World', () => {
  it('ground never below the sea surface; water detected over the bay; runway is paved', () => {
    let w!: World;
    w = new World(fakeTerrain(() => w), nav, null, 37.613538, -122.35716);
    w.airports.ensureAirport(ksfo);
    w.syncRunways();
    const bay = w.frame.geodeticToNED(37.6, -122.30, 0);
    expect(w.groundHeight(bay[0], bay[1])).toBeCloseTo(w.seaLevelUp(bay[0], bay[1]), 6);
    expect(w.surfaceAt(bay[0], bay[1])).toBe('water');
    const onRwy = w.frame.geodeticToNED(37.62102, -122.375, 2); // on the 10L/28R centreline
    expect(w.surfaceAt(onRwy[0], onRwy[1])).toBe('paved');
    const land = w.frame.geodeticToNED(37.7, -122.45, 0);
    expect(w.surfaceAt(land[0], land[1])).toBe('grass');
    expect(w.groundHeight(land[0], land[1])! - w.seaLevelUp(land[0], land[1])).toBeCloseTo(4, 3); // 4 m MSL
  });

  it('keeps a runway below sea level at its real elevation (EHAM-style fields are not floated to MSL)', () => {
    let w!: World;
    w = new World(fakeTerrain(() => w), nav, null, 37.613538, -122.35716);
    w.airports.ensureAirport(ksfo);
    w.syncRunways();
    // the east end of 10L/28R lies over the fake terrain's -3 m area
    const p = w.frame.geodeticToNED(37.614101, -122.3585, 0);
    expect(w.surfaceAt(p[0], p[1])).toBe('paved');
    expect(w.groundHeight(p[0], p[1])).toBeCloseTo(-3, 6);
    // off the runway the same terrain is open water at the sea surface
    const q = w.frame.geodeticToNED(37.6100, -122.3585, 0);
    expect(w.groundHeight(q[0], q[1])).toBeCloseTo(w.seaLevelUp(q[0], q[1]), 6);
  });

  it('falls back to the spawn elevation before terrain loads', () => {
    const w = new World(null, nav, null, 37.613538, -122.35716);
    w.setOrigin(37.613538, -122.35716, 4);
    expect(w.env.groundHeight(0, 0)).toBe(4);
  });

  it('spawn window: frames updated with the previous (far) aircraft position keep the spawn airport, its runways and its pavement flattened', () => {
    // beginFlight awaits the terrain prefetch while the frame loop runs World.update with the aircraft
    // state from before the spawn (the initial state, or the last flight hundreds of km away)
    const near: NavDatabase = { ...nav, nearestAirports: (g) => (Math.abs(g.lat - 37.62) < 1 && Math.abs(g.lon + 122.37) < 1 ? [ksfo] : []) };
    const pushed = { runways: [] as number[], pavement: [] as number[] };
    let w!: World;
    const terrain = fakeTerrain(() => w) as unknown as Record<string, unknown>;
    terrain.setRunways = (s: unknown[]) => { pushed.runways.push(s.length); };
    terrain.setPavement = (s: unknown[]) => { pushed.pavement.push(s.length); };
    w = new World(terrain as unknown as TerrainSystem, near, null, 37.613538, -122.35716);
    const d = 0.001, lat = 37.617, lon = -122.38; // an apron beside 10L/28R
    const apron: PavementArea = { key: '14/1/1/a0', kind: 'apron', rings: [[lon - d, lat - d, lon + d, lat - d, lon + d, lat + d, lon - d, lat + d]], line: [], widthM: 0 };
    w.setPavementSource(() => ({ pavementRevision: () => 1, pavementAreas: () => [apron] }));
    // Simulator.beginFlight up to its prefetch
    w.setOrigin(lat, lon, 4);
    w.airports.ensureAirport(ksfo);
    w.syncRunways();
    w.syncPavement(true);
    expect(pushed.runways.at(-1)).toBe(1);
    expect(pushed.pavement.at(-1)).toBe(1);
    // frames while the prefetch is pending (airport refresh every 4 s, flattening sync every 2 s)
    const cam = new THREE.PerspectiveCamera();
    for (let i = 0; i < 6; i++) w.update(1.5, new THREE.Vector3(0, 2, 0), cam, { lat: 0, lon: 0, alt: 0 }, [0, 0, 0], 0);
    expect(w.airports.isBuilt('KSFO')).toBe(true);
    expect(pushed.runways.at(-1)).toBe(1);
    expect(pushed.pavement.at(-1)).toBe(1);
    // once the aircraft has flown far from it, the spawn airport goes like any other
    w.airports.ensureAirport({ ...ksfo, icao: 'KOTHER', position: { lat: 0.1, lon: 0.1, alt: 0 }, runways: [] });
    for (let i = 0; i < 4; i++) w.update(1.5, new THREE.Vector3(0, 2, 0), cam, { lat: 0, lon: 0, alt: 0 }, [0, 0, 0], 0);
    expect(w.airports.isBuilt('KSFO')).toBe(false);
  });

  it('rebases beyond 20 km, keeping the frame anchored under the aircraft', () => {
    const w = new World(null, nav, null, 37.613538, -122.35716);
    expect(w.maybeRebase([10000, 0, -1000])).toBeNull();
    const t = w.maybeRebase([21000, 3000, -1000]);
    expect(t).not.toBeNull();
    expect(w.frame.lat0).toBeGreaterThan(37.7);
    expect(w.frame.alt0).toBe(0);
  });
});
