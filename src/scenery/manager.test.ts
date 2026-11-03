import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LocalFrame } from '../geo/wgs84';
import { SceneryManager, type SceneryManagerOptions } from './manager';
import { createScenery } from './index';
import { NEAR_DROP_M } from './materials';
import { resetTileSourceCache } from './source';
import { KSFO_FRAME, makeHost, worldFetch, type HeightFn } from './testUtil';
import { qualityProfile } from './config';
import { tileToLonLat } from '../geo/mercator';

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

  it('re-expresses everything on setFrame (rebase): geodetic positions unchanged to the centimetre', async () => {
    const frameA = KSFO_FRAME();
    const terrain: HeightFn = (lat, lon) => 20 + 15 * Math.sin(lat * 400) * Math.cos(lon * 300);
    const host = makeHost(frameA, terrain);
    const m = manager(host, { stream: { radiusM: 1200, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 } });
    const cam = new THREE.Vector3(-5000, 200, 0); // over the synthetic city
    await pump(m, cam, 400, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 0 && m.tileObjects().every((o) => !o.settling));
    const probe = (frame: LocalFrame) => {
      const out: { lat: number; lon: number; alt: number }[] = [];
      for (const o of m.tileObjects()) {
        o.group.updateMatrixWorld(true);
        for (const mesh of o.group.children.filter((c) => c.name === 'walls' || c.name === 'plain' || c.name === 'roofs') as THREE.Mesh[]) {
          const pos = mesh.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i += 37) {
            const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            out.push(frame.threeToGeodetic(v.x, v.y, v.z));
          }
        }
      }
      return out;
    };
    const before = probe(frameA);
    expect(before.length).toBeGreaterThan(10);
    // rebase 20 km north-east (the simulator's floating origin) and re-express
    const frameB = new LocalFrame(frameA.lat0 + 0.13, frameA.lon0 + 0.16, 0);
    host.setFrame(frameB);
    m.setFrame(frameB);
    const after = probe(frameB);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      const ky = 111195, kx = ky * Math.cos((before[i].lat * Math.PI) / 180);
      expect(Math.hypot((after[i].lon - before[i].lon) * kx, (after[i].lat - before[i].lat) * ky)).toBeLessThan(0.02);
      expect(Math.abs(after[i].alt - before[i].alt)).toBeLessThan(0.02);
    }
    // and the ground under the buildings still agrees after a few re-sampling frames in the new frame
    await pump(m, new THREE.Vector3(-23000, 200, 14000), 30);
    for (const o of m.tileObjects()) {
      const b = o.result.buildings;
      if (!b) continue;
      o.group.updateMatrixWorld(true);
      for (let i = 0; i < b.count; i += 53) {
        // the base is the lowest terrain under the building's ground samples
        let lowest = Infinity, baseAlt = 0;
        for (let k = 0; k < b.sampleCount[i]; k++) {
          const p = new THREE.Vector3(b.samples[(i * 5 + k) * 2], o.buildingGround(i), b.samples[(i * 5 + k) * 2 + 1]).applyMatrix4(o.group.matrixWorld);
          const g = frameB.threeToGeodetic(p.x, p.y, p.z);
          lowest = Math.min(lowest, terrain(g.lat, g.lon));
          baseAlt = g.alt;
        }
        expect(Math.abs(baseAlt - lowest)).toBeLessThan(0.3);
      }
    }
    m.dispose();
  });

  it('follows a local terrain refinement within about two seconds with the default ground budget', async () => {
    // the terrain refines one terrain tile at a time: here the ground under one scenery tile
    // (not the one under the camera) rises by 6 m, and its buildings must follow promptly
    const frame = KSFO_FRAME();
    let box: { w: number; e: number; s: number; n: number } | null = null;
    const terrain: HeightFn = (lat, lon) => 4 + (box && lon > box.w && lon < box.e && lat > box.s && lat < box.n ? 6 : 0);
    const host = makeHost(frame, terrain);
    const m = manager(host, { stream: { radiusM: 2500, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 } });
    const cam = new THREE.Vector3(-3500, 300, -300); // over the synthetic downtown
    await pump(m, cam, 400, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 3 && m.tileObjects().every((o) => !o.settling));
    // back to the shipped 'high' budget, then refine the ground under the second most distant city tile
    m.setStreamOverrides({ groundSamplesPerFrame: qualityProfile('high').stream.groundSamplesPerFrame, frameBudgetMs: 1e9 });
    await pump(m, cam, 5);
    const objs = m.tileObjects().filter((o) => (o.result.buildings?.count ?? 0) > 50).sort((a, b) => a.distM - b.distM);
    expect(objs.length).toBeGreaterThan(2);
    const target = objs[objs.length - 2];
    const nw = tileToLonLat(target.result.x, target.result.y, 14), se = tileToLonLat(target.result.x + 1, target.result.y + 1, 14);
    box = { w: nw.lon, e: se.lon, s: se.lat, n: nw.lat };
    const b = target.result.buildings!;
    const p = new THREE.Vector3();
    const worst = () => {
      target.group.updateMatrixWorld(true);
      let w = 0;
      for (let i = 0; i < b.count; i++) {
        p.set(b.centroids[i * 2], target.buildingGround(i), b.centroids[i * 2 + 1]).applyMatrix4(target.group.matrixWorld);
        w = Math.max(w, Math.abs(p.y - host.groundUp(-p.z, p.x)!));
      }
      return w;
    };
    expect(worst()).toBeGreaterThan(5);
    let frames = 0;
    while (frames < 2000 && worst() > 0.3) { m.update(1 / 60, cam, camera, 0.8); frames++; }
    expect(frames, 'frames until every building of the refined tile sits on the new ground').toBeLessThan(150);
    m.dispose();
  });

  it('also follows a refinement too small for the probe grid, once re-sampling meets a moved building', async () => {
    // +6 m on a 90 m disc centred between four probe points (the nearest is ~170 m away)
    const frame = KSFO_FRAME();
    let disc: { lat: number; lon: number } | null = null;
    const R = 90;
    const terrain: HeightFn = (lat, lon) => {
      if (!disc) return 4;
      const d = Math.hypot((lat - disc.lat) * 111195, (lon - disc.lon) * 111195 * Math.cos((lat * Math.PI) / 180));
      return d < R ? 10 : 4;
    };
    const host = makeHost(frame, terrain);
    const m = manager(host, { stream: { radiusM: 2500, groundSamplesPerFrame: 20000, frameBudgetMs: 1e9 } });
    const cam = new THREE.Vector3(-3500, 300, -300);
    await pump(m, cam, 400, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 3 && m.tileObjects().every((o) => !o.settling));
    m.setStreamOverrides({ groundSamplesPerFrame: qualityProfile('high').stream.groundSamplesPerFrame, frameBudgetMs: 1e9 });
    await pump(m, cam, 120); // probe baselines everywhere, first-sweep cycles done
    const objs = m.tileObjects().filter((o) => (o.result.buildings?.count ?? 0) > 50).sort((a, b) => a.distM - b.distM);
    const target = objs[objs.length - 2];
    const b = target.result.buildings!;
    // the probe-cell corner with the most building centroids within 50 m
    let best = { n: -1, x: 0, z: 0 };
    const xz = [0, 0];
    for (let j = 1; j < 8; j++) for (let i = 1; i < 8; i++) {
      target.projector.toLocal((i / 8) * 4096, (j / 8) * 4096, xz, 0);
      let n = 0;
      for (let k = 0; k < b.count; k++) if (Math.hypot(b.centroids[k * 2] - xz[0], b.centroids[k * 2 + 1] - xz[1]) < 50) n++;
      if (n > best.n) best = { n, x: xz[0], z: xz[1] };
    }
    expect(best.n).toBeGreaterThan(2);
    const inside: number[] = [];
    for (let k = 0; k < b.count; k++) if (Math.hypot(b.centroids[k * 2] - best.x, b.centroids[k * 2 + 1] - best.z) < 50) inside.push(k);
    const g = target.projector.toLonLat(best.x, best.z);
    disc = { lat: g.lat, lon: g.lon };
    const p = new THREE.Vector3();
    const worst = () => {
      target.group.updateMatrixWorld(true);
      let w = 0;
      for (const k of inside) {
        p.set(b.centroids[k * 2], target.buildingGround(k), b.centroids[k * 2 + 1]).applyMatrix4(target.group.matrixWorld);
        w = Math.max(w, Math.abs(p.y - host.groundUp(-p.z, p.x)!));
      }
      return w;
    };
    let frames = 0;
    while (frames < 3000 && worst() > 0.3) { m.update(1 / 60, cam, camera, 0.8); frames++; }
    expect(frames, 'frames until the buildings on the small refined patch sit on the new ground').toBeLessThan(80);
    m.dispose();
  });

  it('evicts least recently wanted tiles beyond the budget and disposes them fully', async () => {
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = manager(host, { stream: { radiusM: 1500, maxResidentTiles: 4, groundSamplesPerFrame: 5000, frameBudgetMs: 1e9 } });
    const disposed: string[] = [];
    const proto = THREE.BufferGeometry.prototype;
    const orig = proto.dispose;
    proto.dispose = function (this: THREE.BufferGeometry) { disposed.push(this.uuid); return orig.call(this); };
    try {
      await pump(m, new THREE.Vector3(0, 300, 0), 300, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 0);
      const first = m.tileObjects();
      expect(first.length).toBeGreaterThan(0);
      // fly 6 km west over the city: new tiles stream in, the old ones are evicted (budget 4)
      await pump(m, new THREE.Vector3(-6000, 300, -1000), 400, 0.8, () => m.stats().tilesPending === 0 && m.tileObjects().length > 0 && first.every((o) => o.isDisposed));
      expect(m.tileObjects().length).toBeLessThanOrEqual(Math.max(4, m.stats().tilesWanted));
      expect(first.some((o) => o.isDisposed)).toBe(true);
      expect(disposed.length).toBeGreaterThan(0);
      for (const o of first) if (o.isDisposed) expect(o.group.parent).toBeNull();
    } finally { proto.dispose = orig; }
    const mats = m.materialSet;
    const spies = [vi.spyOn(mats.walls, 'dispose'), vi.spyOn(mats.surfaces, 'dispose'), vi.spyOn(mats.streetlights, 'dispose')];
    const texSpies = mats.textures.map((t) => vi.spyOn(t, 'dispose'));
    m.dispose();
    for (const sp of [...spies, ...texSpies]) expect(sp).toHaveBeenCalled();
    expect(m.tileObjects()).toHaveLength(0);
    m.update(1 / 60, new THREE.Vector3(), camera, 0); // no-op after dispose
  });

  it('survives a failed TileJSON quietly (logged once) and never throws from update', async () => {
    const logs: string[] = [];
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = new SceneryManager({ ...host, fetch: worldFetch(), fetchJson: async () => { throw new TypeError('Failed to fetch'); }, tileJsonUrl: 'https://tiles.example/planet-fail', log: (s) => logs.push(s) });
    await pump(m, new THREE.Vector3(0, 300, 0), 20);
    expect(m.stats().tilesLoaded).toBe(0);
    expect(m.stats().inFlight).toBe(0);
    expect(logs.filter((l) => l.includes('unavailable'))).toHaveLength(1);
    expect(await m.parkingSpots(37.6158, -122.3934, 300)).toEqual([]);
    m.dispose();
  });

  it('uses the TileJSON tiles[0] template when no override is given', async () => {
    const urls: string[] = [];
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = new SceneryManager({ ...host, fetch: worldFetch({ log: urls }), fetchJson: async () => ({ tiles: ['http://fixtures/v2/{z}/{x}/{y}.pbf'], maxzoom: 14 }), tileJsonUrl: 'https://tiles.example/planet-ok', stream: { radiusM: 800 }, log: () => {} });
    await pump(m, new THREE.Vector3(0, 300, 0), 50, 0.8, () => m.stats().tilesLoaded > 0);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /^http:\/\/fixtures\/v2\/14\/\d+\/\d+\.pbf$/.test(u))).toBe(true);
    m.dispose();
  });

  it('skips 404 / network / corrupt tiles, retries transient failures with backoff and logs each kind once', async () => {
    const logs: string[] = [];
    let attempts = 0;
    let clock = 0;
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = new SceneryManager({
      ...host, tileUrl: TEMPLATE, log: (s) => logs.push(s), now: () => clock,
      stream: { radiusM: 2500 },
      fetch: worldFetch({ fail: (url) => {
        if (url.includes('/2622/')) return 404;
        if (url.includes('/2623/')) { attempts++; return 'network'; }
        return null;
      } }),
    });
    for (let i = 0; i < 40; i++) { clock += 2000; m.update(1 / 60, new THREE.Vector3(0, 300, 0), camera, 0.8); await tick(); }
    const st = m.stats();
    expect(st.tilesEmpty).toBeGreaterThan(0);
    expect(st.tilesFailed).toBeGreaterThan(0);
    // each network-failing tile is tried MAX_RETRIES (3) times, not every frame
    expect(attempts).toBeLessThanOrEqual(3 * m.stats().tilesWanted);
    expect(logs.filter((l) => l.includes('network'))).toHaveLength(1);
    m.dispose();
  });

  it('finds parking near the gates, loading the tiles on demand without streaming them', async () => {
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = manager(host);
    const spots = await m.parkingSpots(37.615867, -122.393443, 350);
    expect(spots.length).toBeGreaterThan(3);
    expect(spots.slice(0, 4).some((s) => /^Gate A\d$/.test(s.name))).toBe(true);
    expect(spots.some((s) => /^Apron stand/.test(s.name))).toBe(true);
    const d = (s: { lat: number; lon: number }) => Math.hypot((s.lat - 37.615867) * 111195, (s.lon + 122.393443) * 88070);
    for (let i = 1; i < spots.length; i++) expect(d(spots[i])).toBeGreaterThanOrEqual(d(spots[i - 1]) - 1e-6);
    for (const s of spots) { expect(d(s)).toBeLessThanOrEqual(350); expect(s.headingDeg).toBeGreaterThanOrEqual(0); expect(s.headingDeg).toBeLessThan(360); }
    expect(new Set(spots.map((s) => s.name)).size).toBe(spots.length);
    expect(m.tileObjects()).toHaveLength(0);
    m.dispose();
  });

  it('fades lights with the sun and hides small buildings and trees by distance', async () => {
    const host = makeHost(KSFO_FRAME(), flat(0));
    const m = manager(host, { stream: { radiusM: 2500, groundSamplesPerFrame: 50000, frameBudgetMs: 1e9, smallBuildingRangeM: 1000, treeRangeM: 1500 } });
    const cam = new THREE.Vector3(-5500, 300, 0); // over the synthetic city
    await pump(m, cam, 300, 0.8, () => m.stats().tilesPending === 0 && m.stats().tilesLoaded > 0 && m.tileObjects().every((o) => !o.settling));
    const mats = m.materialSet;
    expect(mats.streetlights.opacity).toBe(0);
    expect(mats.walls.emissiveIntensity).toBe(0);
    await pump(m, cam, 2, -0.3); // sun 17° below the horizon
    expect(mats.streetlights.opacity).toBeCloseTo(1, 6);
    expect(mats.walls.emissiveIntensity).toBeGreaterThan(0.5);
    expect(m.tileObjects().some((o) => o.group.children.some((c) => c.name === 'streetlights' && c.visible))).toBe(true);
    const far = m.tileObjects().filter((o) => o.distM > 1100 && o.result.buildings);
    for (const o of far) {
      const walls = o.group.children.find((c) => c.name === 'walls') as THREE.Mesh | undefined;
      if (walls) expect(walls.geometry.drawRange.count).toBe(o.result.buildings!.bigIndexCount[0]);
    }
    m.dispose();
  });

  it('lowers airport surfaces near the camera only when the camera is near the ground', () => {
    const host = makeHost(KSFO_FRAME(), flat(4));
    const m = manager(host);
    const mats = m.materialSet;
    m.update(1 / 60, new THREE.Vector3(0, 300, 0), camera, 0.8); // 296 m above the ground
    expect(mats.nearDrop.value).toBe(0);
    m.update(1 / 60, new THREE.Vector3(0, 6, 0), camera, 0.8); // chase camera, 2 m up
    expect(mats.nearDrop.value).toBeCloseTo(NEAR_DROP_M, 6);
    m.update(1 / 60, new THREE.Vector3(0, 44, 0), camera, 0.8); // 40 m up: half way
    expect(mats.nearDrop.value).toBeGreaterThan(0.2 * NEAR_DROP_M);
    expect(mats.nearDrop.value).toBeLessThan(0.8 * NEAR_DROP_M);
    host.setHeight(null); // no terrain under the camera: keep the last value
    m.update(1 / 60, new THREE.Vector3(0, 6, 0), camera, 0.8);
    expect(mats.nearDrop.value).toBeGreaterThan(0.2 * NEAR_DROP_M);
    expect(mats.nearDrop.value).toBeLessThan(0.8 * NEAR_DROP_M);
    m.dispose();
  });
});
