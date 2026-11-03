import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../geo/wgs84';
import { makePavementSpec, planeHeightAt, type PavementPlane } from './pavement';
import type { FetchFn } from './tileFetch';
import { TerrainSystem, type TerrainSystemOptions } from './TerrainSystem';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const FIXTURES = new Map<string, Uint8Array>(
  ['15/5246/12684', '12/655/1585', '12/656/1585'].map((k) => [
    `${AWS}/${k}.png`,
    new Uint8Array(readFileSync(new URL(`./__fixtures__/terrarium-${k.replace(/\//g, '-')}.png`, import.meta.url))),
  ]),
);
const fixtureFetch: FetchFn = async (url) => {
  const body = FIXTURES.get(url);
  return body ? new Response(body.slice(), { status: 200 }) : new Response(null, { status: 404 });
};

function makeSystem(frame: LocalFrame, extra: Partial<TerrainSystemOptions> = {}) {
  const clock = { t: 0 };
  const ts = new TerrainSystem(frame, {
    fetch: fixtureFetch, uploadsPerFrame: Infinity, minZoom: 12, maxZoom: 15, range0M: 2000,
    horizonCull: false, proceduralTileSize: 64, quadsPerLevel: [64, 32], maxAnisotropy: 1,
    now: () => clock.t, ...extra,
  });
  return { ts, clock };
}
function cameraAt(x: number, y: number, z: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.3, 600_000);
  cam.position.set(x, y, z);
  cam.lookAt(x, y - 100, z - 1000);
  cam.updateMatrixWorld();
  return cam;
}
async function settle(ts: TerrainSystem, clock: { t: number }, cam: PerspectiveCamera): Promise<void> {
  for (let i = 0; i < 20; i++) {
    clock.t += 200;
    ts.update(cam.position, cam, 0.2);
    if (ts.stats().inflight === 0) return;
    await ts.whenIdle();
  }
  throw new Error('terrain did not settle');
}

const KX = 111_194.93 * Math.cos((KSFO.lat * Math.PI) / 180), KY = 111_194.93;
const ll = (e: number, n: number): [number, number] => [KSFO.lon + e / KX, KSFO.lat + n / KY];
const rect = (e0: number, n0: number, e1: number, n1: number): number[] => [...ll(e0, n0), ...ll(e1, n0), ...ll(e1, n1), ...ll(e0, n1)];
// an apron 300 m west of the 28R threshold, raised to 7.5 m (the DEM there is ≈ 2–4 m)
const PLANE: PavementPlane = { lat0: KSFO.lat, lon0: KSFO.lon, h0: 7.5, dhdE: 0.001, dhdN: 0 };
const APRON = makePavementSpec('apron-1', { rings: [rect(-420, -80, -220, 80)] }, PLANE)!;

describe('TerrainSystem pavement flattening', () => {
  it('reloads the touched tiles: ground and collision on the apron are the plane (< 1 cm); unchanged input is a no-op', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    const cam = cameraAt(0, 300, 0);
    await settle(ts, clock, cam);
    const [lon, lat] = ll(-320, 0);
    const before = ts.heightAt(lat, lon)!;
    expect(Math.abs(before - planeHeightAt(PLANE, lon, lat))).toBeGreaterThan(1);
    const rev0 = ts.revision();
    ts.setPavement([APRON]);
    expect(ts.pavementCount).toBe(1);
    await settle(ts, clock, cam);
    for (const [e, n] of [[-320, 0], [-410, -70], [-230, 75], [-300, 40]]) {
      const [lo, la] = ll(e, n);
      expect(Math.abs(ts.heightAt(la, lo)! - planeHeightAt(PLANE, lo, la))).toBeLessThan(0.01);
    }
    // 400 m away from the apron: natural ground (reach = 15 + 160 m)
    const [flo, fla] = ll(-320, 420);
    expect(Math.abs(ts.heightAt(fla, flo)! - 7.5)).toBeGreaterThan(1);
    // the change signal names the reloaded tiles
    expect(ts.revision()).toBeGreaterThan(rev0);
    const changes = ts.changesSince(rev0)!;
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.z === 15)).toBe(true);
    expect(ts.changesSince(ts.revision())).toEqual([]);
    ts.setPavement([APRON]); // unchanged → no reload
    expect(ts.stats().inflight).toBe(0);
    // removing it restores the DEM
    ts.setPavement([]);
    await settle(ts, clock, cam);
    expect(ts.heightAt(lat, lon)!).toBeCloseTo(before, 3);
    ts.dispose();
  });

  it('prefetch waits for the flattened version: a spawn on the apron never starts on unflattened ground', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    await settle(ts, clock, cameraAt(0, 300, 0)); // resident, unflattened
    const [lon, lat] = ll(-320, 0);
    ts.setPavement([APRON]);
    await ts.prefetch(lat, lon, 500); // no update() in between
    expect(Math.abs(ts.heightAt(lat, lon)! - planeHeightAt(PLANE, lon, lat))).toBeLessThan(0.01);
    // pushed before a cold prefetch: the first data is already flattened
    const fresh = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    fresh.ts.setPavement([APRON]);
    await fresh.ts.prefetch(lat, lon, 500);
    expect(Math.abs(fresh.ts.heightAt(lat, lon)! - planeHeightAt(PLANE, lon, lat))).toBeLessThan(0.01);
    ts.dispose();
    fresh.ts.dispose();
  });

  it('changesSince returns null once the log no longer reaches back that far', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    expect(ts.changesSince(0)).toEqual([]);
    await settle(ts, clock, cameraAt(0, 300, 0));
    expect(ts.changesSince(0)!.length).toBe(ts.revision());
    expect(ts.changesSince(-5)).toBeNull();
    ts.dispose();
  });
});
