import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LocalFrame } from '../geo/wgs84';
import { SceneryManager, type SceneryManagerOptions } from './manager';
import { createScenery } from './index';
import { resetTileSourceCache } from './source';
import { KSFO_FRAME, makeHost, worldFetch, type HeightFn } from './testUtil';

const TEMPLATE = 'http://fixtures/{z}/{x}/{y}.pbf';
const flat = (h: number): HeightFn => () => h;
const tick = () => new Promise((r) => setTimeout(r, 0));
const camera = new THREE.PerspectiveCamera();

async function pump(m: SceneryManager, cam: THREE.Vector3, frames: number, sunRad = 0.8, until?: () => boolean): Promise<void> {
  for (let i = 0; i < frames; i++) {
    m.update(1 / 60, cam, camera, sunRad);
    await tick();
    if (until?.()) return;
  }
}

function manager(host: ReturnType<typeof makeHost>, extra: Partial<SceneryManagerOptions> = {}): SceneryManager {
  return new SceneryManager({
    ...host,
    tileUrl: TEMPLATE,
    fetch: worldFetch(),
    stream: { radiusM: 2500, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 },
    log: () => {},
    ...extra,
  });
}

afterEach(() => { resetTileSourceCache(); vi.restoreAllMocks(); });

describe('SceneryManager (sync path)', () => {
  it('streams tiles nearest first, builds them and grounds every building', async () => {
    const frame = KSFO_FRAME();
    const host = makeHost(frame, flat(4));
    const m = manager(host);
    expect(m.loaderMode).toBe('sync');
    const cam = new THREE.Vector3(0, 300, 0);
    await pump(m, cam, 400, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 0 && m.stats().buildingsWaiting === 0 && m.tileObjects().every((o) => !o.settling));
    const st = m.stats();
    expect(st.tilesLoaded).toBeGreaterThan(0);
    expect(st.buildings).toBeGreaterThan(0);
    expect(st.lights).toBeGreaterThan(0);
    expect(st.buildingsWaiting).toBe(0);
    expect(st.triangles).toBeGreaterThan(0);
    // every building base sits on the terrain: world y of the base = groundUp there
    const p = new THREE.Vector3();
    for (const o of m.tileObjects()) {
      o.group.updateMatrixWorld(true);
      const walls = o.group.children.find((c) => c.name === 'walls') as THREE.Mesh | undefined;
      if (!walls) continue;
      const b = o.result.buildings!;
      for (let i = 0; i < b.count; i += 37) {
        const g = o.buildingGround(i);
        expect(Number.isFinite(g)).toBe(true);
        p.set(b.centroids[i * 2], g, b.centroids[i * 2 + 1]).applyMatrix4(o.group.matrixWorld);
        const up = host.groundUp(-p.z, p.x)!;
        expect(Math.abs(p.y - up)).toBeLessThan(0.05);
      }
    }
    m.dispose();
  });

  it('createScenery returns the plugin contract', () => {
    const host = makeHost(KSFO_FRAME(), flat(0));
    const s = createScenery({ ...host, tileUrl: TEMPLATE });
    expect(typeof s.update).toBe('function');
    expect(typeof s.setFrame).toBe('function');
    expect(s.attribution?.()).toEqual(['© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap']);
    expect(s.stats?.()).toMatchObject({ tilesLoaded: 0 });
    s.dispose?.();
    expect(host.parent.children).toHaveLength(0);
  });
});
