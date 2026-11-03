import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { lonLatToTile } from '../geo/mercator';
import { SceneryManager } from './manager';
import { resetTileSourceCache } from './source';
import { KSFO_FRAME, makeHost, worldFetch, type HeightFn } from './testUtil';

const camera = new THREE.PerspectiveCamera();
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { resetTileSourceCache(); vi.restoreAllMocks(); });

describe('scenery re-grounding from the terrain change signal', () => {
  it('marks exactly the tiles under changed terrain, follows the change there, and stops probing', async () => {
    const frame = KSFO_FRAME();
    let bump: { x: number; y: number } | null = null; // a z15 terrain tile raised by 6 m
    const terrain: HeightFn = (lat, lon) => {
      if (!bump) return 4;
      const t = lonLatToTile(lon, lat, 15);
      return Math.floor(t.x) === bump.x && Math.floor(t.y) === bump.y ? 10 : 4;
    };
    let rev = 1;
    const log: { rev: number; z: number; x: number; y: number }[] = [];
    let forget = false;
    const host = makeHost(frame, terrain, {
      terrainRevision: () => rev,
      terrainChangesSince: (r: number) => (forget ? null : log.filter((c) => c.rev > r).map(({ z, x, y }) => ({ z, x, y }))),
    });
    const m = new SceneryManager({ ...host, tileUrl: 'http://fixtures/{z}/{x}/{y}.pbf', fetch: worldFetch(), stream: { radiusM: 2500, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 }, log: () => {} });
    const cam = new THREE.Vector3(-3500, 300, -300);
    for (let i = 0; i < 400; i++) {
      m.update(1 / 60, cam, camera, 0.8);
      await tick();
      if (m.stats().tilesPending === 0 && m.stats().tilesLoaded > 3 && m.tileObjects().every((o) => !o.settling)) break;
    }
    for (let i = 0; i < 30; i++) m.update(1 / 60, cam, camera, 0.8);
    expect(m.stats().tilesHot).toBe(0);
    // with the signal the probe grids are idle
    const spies = m.tileObjects().map((o) => vi.spyOn(o, 'checkTerrain'));
    for (let i = 0; i < 5; i++) m.update(1 / 60, cam, camera, 0.8);
    for (const sp of spies) expect(sp).not.toHaveBeenCalled();
    // raise one z15 terrain tile under a building-rich scenery tile and signal it
    const objs = m.tileObjects().filter((o) => (o.result.buildings?.count ?? 0) > 50);
    const target = objs[0];
    const c = target.projector.toLonLat(0, 0);
    const t15 = lonLatToTile(c.lon, c.lat, 15);
    bump = { x: Math.floor(t15.x), y: Math.floor(t15.y) };
    log.push({ rev: ++rev, z: 15, x: bump.x, y: bump.y });
    m.update(1 / 60, cam, camera, 0.8);
    const hot = m.tileObjects().filter((o) => o.hotSamples > 0);
    expect(hot).toEqual([target]);
    // the buildings on the raised terrain follow within a few frames
    const b = target.result.buildings!;
    const p = new THREE.Vector3();
    const worst = () => {
      target.group.updateMatrixWorld(true);
      let w = 0;
      for (let k = 0; k < b.count; k++) {
        p.set(b.centroids[k * 2], target.buildingGround(k), b.centroids[k * 2 + 1]).applyMatrix4(target.group.matrixWorld);
        const g = host.groundUp(-p.z, p.x)!;
        const ll = frame.nedToGeodetic(-p.z, p.x, 0);
        const t = lonLatToTile(ll.lon, ll.lat, 15);
        if (Math.floor(t.x) !== bump!.x || Math.floor(t.y) !== bump!.y) continue;
        w = Math.max(w, Math.abs(p.y - g));
      }
      return w;
    };
    for (let i = 0; i < 60 && worst() > 0.05; i++) m.update(1 / 60, cam, camera, 0.8);
    expect(worst()).toBeLessThan(0.05);
    // a log that no longer reaches back marks every resident tile
    const marks = m.tileObjects().map((o) => vi.spyOn(o, 'terrainChanged'));
    forget = true;
    rev++;
    m.update(1 / 60, cam, camera, 0.8);
    for (const sp of marks) expect(sp).toHaveBeenCalledTimes(1);
    m.dispose();
  });
});
