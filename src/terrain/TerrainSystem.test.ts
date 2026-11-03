import { readFileSync } from 'node:fs';
import { Color, PerspectiveCamera, Vector3, type BufferGeometry, type Material, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
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

/** Serves the fixture PNGs; everything else (other DEM tiles, all imagery) is a 404. */
function fixtureFetch(log: string[] = []): FetchFn {
  return async (url) => {
    log.push(url);
    const body = FIXTURES.get(url);
    return body ? new Response(body.slice(), { status: 200 }) : new Response(null, { status: 404 });
  };
}

function makeSystem(frame: LocalFrame, extra: Partial<TerrainSystemOptions> = {}) {
  const clock = { t: 0 };
  const ts = new TerrainSystem(frame, {
    fetch: fixtureFetch(), uploadsPerFrame: Infinity, minZoom: 12, maxZoom: 15, range0M: 2000,
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

/** update → wait for the pipeline → update until nothing is outstanding. */
async function settle(ts: TerrainSystem, clock: { t: number }, cam: PerspectiveCamera): Promise<void> {
  for (let i = 0; i < 20; i++) {
    clock.t += 200;
    ts.update(cam.position, cam, 0.2);
    if (ts.stats().inflight === 0) return;
    await ts.whenIdle();
  }
  throw new Error('terrain did not settle');
}

const meshes = (ts: TerrainSystem): Mesh<BufferGeometry, Material[]>[] => ts.group.children as Mesh<BufferGeometry, Material[]>[];
const tileMesh = (ts: TerrainSystem, key: string) => meshes(ts).find((m) => m.name === `terrain ${key}`);

describe('TerrainSystem (in-thread, injected fetch)', () => {
  it('streams tiles: fixtures are real data, KSFO 28R threshold height ≈ 3.96 m, procedural elsewhere', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    expect(ts.loaderMode).toBe('in-thread');
    expect(ts.heightAt(KSFO.lat, KSFO.lon)).toBeNull();
    const cam = cameraAt(0, 300, 0);
    ts.update(cam.position, cam, 0.016);
    expect(ts.stats().inflight).toBeGreaterThan(0);
    await settle(ts, clock, cam);
    const st = ts.stats();
    expect(st.resident).toBeGreaterThan(10);
    expect(st.failed).toBe(0);
    expect(st.drawn).toBeGreaterThan(5);
    expect(Math.abs(ts.heightAt(KSFO.lat, KSFO.lon)! - 3.96)).toBeLessThan(0.5);
    // the KSFO z15 tile has the bay in it → an ocean patch child
    const ksfo = tileMesh(ts, '15/5246/12684')!;
    expect(ksfo).toBeDefined();
    expect(ksfo.children.some((c) => c.name.startsWith('ocean'))).toBe(true);
    const lines = ts.attribution();
    expect(lines.some((l) => l.includes('Terrain Tiles'))).toBe(true);
    expect(lines.some((l) => l.includes('Procedural'))).toBe(true); // imagery 404s → procedural colours
    ts.dispose();
  });

  it('heightAtLocalNED(0, 0) at the threshold ≈ 3.96 − alt0, and the normal points up', async () => {
    const alt0 = 5;
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, alt0));
    await settle(ts, clock, cameraAt(0, 300, 0));
    expect(Math.abs(ts.heightAtLocalNED(0, 0)! - (3.96 - alt0))).toBeLessThan(0.5);
    const n: Vec3 = [0, 0, 0];
    expect(ts.groundNormalNED(0, 0, n)).toBe(n);
    expect(n[2]).toBeLessThan(-0.95);
    expect(ts.heightAtLocalNED(NaN, 0)).toBeNull();
    ts.dispose();
  });

  it('readyFraction rises from 0 to 1 near the camera', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    const cam = cameraAt(0, 300, 0);
    expect(ts.readyFraction(cam.position)).toBe(0);
    expect(ts.stats().inflight).toBeGreaterThan(0); // readyFraction(pos) also requests the selection
    await settle(ts, clock, cam);
    expect(ts.readyFraction(cam.position)).toBe(1);
    ts.dispose();
  });

  it('never leaves holes: every selected node is drawn by itself, its children or an ancestor patch', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    const cam = cameraAt(0, 300, 0);
    await settle(ts, clock, cam);
    const check = (): void => {
      const covered = new Array<number>(ts.selectedNodes.length).fill(0);
      for (const it of ts.drawItems) covered[it.node] += it.kind === 'child' && ts.selectedNodes[it.node].parentPatch === false ? 0.25 : 1;
      expect(ts.holes).toBe(0);
      for (const c of covered) expect(c).toBe(1);
      for (const it of ts.drawItems) expect(tileMesh(ts, `${it.z}/${it.x}/${it.y}`)!.visible).toBe(true);
    };
    check();
    expect(ts.drawItems.every((it) => it.kind === 'self')).toBe(true);
    // Fly 2.5 km west: new z15/z14 nodes are selected before their tiles load → ancestors stand in.
    const cam2 = cameraAt(-2500, 300, 0);
    clock.t += 200;
    ts.update(cam2.position, cam2, 0.2);
    expect(ts.stats().inflight).toBeGreaterThan(0);
    check();
    expect(ts.drawItems.some((it) => it.kind === 'ancestor')).toBe(true);
    await settle(ts, clock, cam2);
    check();
    ts.dispose();
  });

  it('setFrame rebases tile objects rigidly and leaves heights unchanged', async () => {
    const A = new LocalFrame(KSFO.lat, KSFO.lon, 0);
    const { ts, clock } = makeSystem(A);
    await settle(ts, clock, cameraAt(0, 300, 0));
    const h0 = ts.heightAt(KSFO.lat, KSFO.lon);
    const mesh = tileMesh(ts, '15/5246/12684')!;
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.getAttribute('position');
    const v = new Vector3().fromBufferAttribute(pos, 100).applyMatrix4(mesh.matrixWorld);
    const ecefOfCentre = A.threeToEcef(mesh.position.x, mesh.position.y, mesh.position.z);
    const ecefOfVertex = A.threeToEcef(v.x, v.y, v.z);

    const B = new LocalFrame(KSFO.lat + 0.15, KSFO.lon - 0.2, 30); // ≈ 24 km away
    ts.setFrame(B);
    mesh.updateMatrixWorld(true);
    const expCentre = B.ecefToThree(ecefOfCentre);
    expect(mesh.position.distanceTo(new Vector3(...expCentre))).toBeLessThan(1e-3);
    // the translation equals the change of the anchor's frame coordinates
    const v2 = new Vector3().fromBufferAttribute(pos, 100).applyMatrix4(mesh.matrixWorld);
    expect(v2.distanceTo(new Vector3(...B.ecefToThree(ecefOfVertex)))).toBeLessThan(0.01);
    expect(ts.heightAt(KSFO.lat, KSFO.lon)).toBe(h0);
    const ned = B.geodeticToNED(KSFO.lat, KSFO.lon, 0);
    const up = ts.heightAtLocalNED(ned[0], ned[1])!;
    expect(B.nedToGeodetic(ned[0], ned[1], -up).alt).toBeCloseTo(h0!, 2);
    ts.dispose();
  });

  it('runway flattening reloads the touched tiles: the threshold takes the runway elevation', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    const cam = cameraAt(0, 300, 0);
    await settle(ts, clock, cam);
    const end = { lat: 37.62873, lon: -122.39320, alt: 3.4 }; // 28R far end (approx.)
    ts.setRunways([{ a: { lat: KSFO.lat, lon: KSFO.lon, alt: 6.5 }, b: end, widthM: 61 }]);
    await settle(ts, clock, cam);
    expect(ts.heightAt(KSFO.lat, KSFO.lon)!).toBeCloseTo(6.5, 1);
    ts.setRunways([{ a: { lat: KSFO.lat, lon: KSFO.lon, alt: 6.5 }, b: end, widthM: 61 }]); // unchanged → no reload
    expect(ts.stats().inflight).toBe(0);
    ts.dispose();
  });

  it('prefetch resolves without update() once the tile under the point is ready (real or procedural)', async () => {
    const { ts } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    await ts.prefetch(KSFO.lat, KSFO.lon, 500);
    expect(Math.abs(ts.heightAt(KSFO.lat, KSFO.lon)! - 3.96)).toBeLessThan(0.5);
    await ts.prefetch(47.26, 11.34, 300); // Innsbruck: no fixture → procedural fallback
    expect(ts.heightAt(47.26, 11.34)).not.toBeNull();
    ts.dispose();
  });

  it('network errors never throw: a rejecting fetch degrades to procedural terrain', async () => {
    const failing: FetchFn = async () => { throw new TypeError('Failed to fetch'); };
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0), { fetch: failing });
    await settle(ts, clock, cameraAt(0, 300, 0));
    expect(ts.stats().failed).toBe(0);
    expect(ts.heightAt(KSFO.lat, KSFO.lon)).not.toBeNull();
    expect(ts.attribution().some((l) => l.includes('Procedural terrain'))).toBe(true);
    ts.dispose();
  });

  it('LRU eviction frees tiles that are no longer used, and dispose frees everything', async () => {
    const { ts, clock } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0), { maxResidentTiles: 10 });
    await settle(ts, clock, cameraAt(0, 300, 0));
    const ksfo = tileMesh(ts, '15/5246/12684')!;
    let disposedKsfo = 0;
    ksfo.geometry.addEventListener('dispose', () => disposedKsfo++);
    // 40 km east: everything around KSFO becomes evictable
    await settle(ts, clock, cameraAt(40_000, 300, 0));
    expect(disposedKsfo).toBe(1);
    expect(ts.heightAt(KSFO.lat, KSFO.lon)).toBeNull();

    let disposed = 0, expected = 0;
    for (const m of meshes(ts)) {
      for (const obj of [m, ...(m.children as Mesh<BufferGeometry, Material[]>[])]) {
        expected += 1 + obj.material.length;
        obj.geometry.addEventListener('dispose', () => disposed++);
        for (const mat of obj.material) mat.addEventListener('dispose', () => disposed++);
      }
    }
    expect(expected).toBeGreaterThan(0);
    ts.dispose();
    expect(disposed).toBe(expected);
    expect(ts.group.children.length).toBe(0);
    expect(ts.stats().resident).toBe(0);
    expect(ts.heightAt(KSFO.lat, KSFO.lon)).toBeNull();
    ts.update(new Vector3(), cameraAt(0, 300, 0), 0.016); // no-op after dispose
  });

  it('setSun / setFog write the shared uniforms', () => {
    const { ts } = makeSystem(new LocalFrame(KSFO.lat, KSFO.lon, 0));
    ts.setSun(new Vector3(0, 2, 0), new Color(1, 0.9, 0.8), 3, new Color(0.2, 0.3, 0.4));
    ts.setFog(new Color(0.5, 0.6, 0.7), 1e-4, 1 / 1500);
    const u = ts.uniforms;
    expect(u.uSunDir.value.y).toBeCloseTo(1, 6);
    expect(u.uSunIntensity.value).toBe(3);
    expect(u.uFogDensity.value).toBe(1e-4);
    expect(u.uFogFalloff.value).toBeCloseTo(1 / 1500, 9);
    expect(u.uSunGlow.value.r).toBeCloseTo(0.5, 6);
    ts.dispose();
  });
});
