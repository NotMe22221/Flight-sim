/**
 * SceneryManager — streams z14 OpenMapTiles vector tiles around the camera and turns them into
 * autogen scenery (buildings, airport surfaces and lights, trees, streetlights).
 *
 * Per update(): wanted tiles (nearest first, re-evaluated every 0.5 s or 150 m) → requests up
 * to the concurrency limit → at most one finished tile turned into meshes → ground sampling
 * within a sample and time budget (first passes nearest first, then gradual re-sampling) →
 * distance LOD → LRU eviction with full disposal. Nothing here throws into the render loop.
 */
import * as THREE from 'three';
import type { SceneryHostOptions } from '../app/plugins';
import type { SceneryLike } from '../app/Simulator';
import type { LocalFrame } from '../geo/wgs84';
import { ATTRIBUTION, nightFactor, qualityProfile, type BuildSettings, type SceneryQuality, type StreamSettings } from './config';
import { GroundSampler } from './grounding';
import { SceneryLoader, type LoaderMode, type WorkerLike } from './loader';
import { SceneryMaterials, makeTreeGeometries } from './materials';
import { selectParking, type ParkingSpot } from './parking';
import type { BuildRequest, ParkingSpotLocal, WorkerResponse } from './protocol';
import { TileSource, type FetchJson } from './source';
import { SCENERY_ZOOM, TileProjector, expandTileUrl, tilesAround, type TileDist } from './tileMath';
import { TileObject, type SharedTreeGeometry } from './tileObject';
import type { FetchLike } from './workerCore';

export interface SceneryManagerOptions extends SceneryHostOptions {
  /** fetch override (tests); implies the in-thread loader */
  fetch?: FetchLike;
  loaderMode?: LoaderMode;
  createWorker?: () => WorkerLike;
  tileJsonUrl?: string;
  fetchJson?: FetchJson;
  now?: () => number;
  stream?: Partial<StreamSettings>;
  build?: Partial<BuildSettings>;
  log?: (msg: string) => void;
}

type EntryState = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

interface TileEntry {
  key: string;
  z: number; x: number; y: number;
  state: EntryState;
  obj: TileObject | null;
  failures: number;
  retryAt: number;
  requestId: number;
  lastWanted: number;
  dist: number;
}

const MAX_RETRIES = 3;
const MOVE_RESELECT_M = 150;
const RESELECT_S = 0.5;
const RESAMPLE_CHUNK = 48;
/** share of the ground budget spent on re-sampling once tiles are placed */
const RESAMPLE_SHARE = 0.3;

export class SceneryManager implements SceneryLike {
  readonly root = new THREE.Group();
  private frame: LocalFrame;
  private readonly host: SceneryHostOptions;
  private quality: SceneryQuality;
  private build: BuildSettings;
  private stream: StreamSettings;
  private readonly overrides: { stream?: Partial<StreamSettings>; build?: Partial<BuildSettings> };
  private readonly loader: SceneryLoader;
  private readonly source: TileSource;
  private readonly materials: SceneryMaterials;
  private readonly treeGeo: SharedTreeGeometry;
  private readonly sampler: GroundSampler;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly logged = new Set<string>();
  private readonly entries = new Map<string, TileEntry>();
  private readonly ready: TileEntry[] = [];
  private readonly arrivals: WorkerResponse[] = [];
  private readonly parkingWaiters = new Map<number, (r: WorkerResponse | null) => void>();
  private readonly parkingCache = new Map<string, ParkingSpotLocal[]>();
  private wanted: TileDist[] = [];
  private nextId = 1;
  private frameNo = 0;
  /** selection generation: entries wanted by the latest selection carry this in lastWanted */
  private selectGen = 0;
  private sinceSelect = Infinity;
  private readonly lastSelect = new THREE.Vector3(NaN, NaN, NaN);
  private readonly geo = { lat: 0, lon: 0, alt: 0 };
  private resampleCursor = 0;
  private night = 0;
  private disposed = false;
  private visible = true;
  private lastEvictCheck = 0;
  private failedCount = 0;
  /** last frame's main-thread time (ms) */
  lastUpdateMs = 0;
  /** automation / debugging: geodetic camera pose forced every frame (see debugView) */
  private debugPose: { lat: number; lon: number; alt: number; headingDeg: number; pitchDeg: number; fovDeg?: number } | null = null;
  private readonly debugPos = new THREE.Vector3();

  constructor(opts: SceneryManagerOptions) {
    this.host = opts;
    this.frame = opts.frame;
    this.quality = (opts.quality ?? 'high') as SceneryQuality;
    this.overrides = { stream: opts.stream, build: opts.build };
    const p = qualityProfile(this.quality);
    this.build = { ...p.build, ...opts.build };
    this.stream = { ...p.stream, ...opts.stream };
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.log = opts.log ?? ((m) => console.warn(m));
    this.root.name = 'osm-scenery';
    opts.parent.add(this.root);
    this.materials = new SceneryMaterials();
    const tg = makeTreeGeometries();
    this.treeGeo = { conifer: tg.conifer, broadleaf: tg.broadleaf, coniferTris: tg.conifer.getAttribute('position').count / 3, broadleafTris: tg.broadleaf.getAttribute('position').count / 3 };
    this.sampler = new GroundSampler((n, e) => this.host.groundUp(n, e));
    this.source = new TileSource({ template: opts.tileUrl, tileJsonUrl: opts.tileJsonUrl, fetchJson: opts.fetchJson, log: (m) => this.logOnce('tilejson', m) });
    this.loader = new SceneryLoader({ mode: opts.loaderMode, fetch: opts.fetch, createWorker: opts.createWorker, onResponse: (r) => this.onResponse(r) });
  }

  // ───────────────────────────── SceneryLike ─────────────────────────────

  update(_dt: number, camIn: THREE.Vector3, camera: THREE.PerspectiveCamera, sunElevationRad: number): void {
    if (this.disposed) return;
    const t0 = this.now();
    let cam = camIn;
    if (this.debugPose) cam = this.applyDebugPose(camera);
    try {
      this.frameNo++;
      this.night = nightFactor(sunElevationRad);
      this.materials.setNight(this.night);
      this.sinceSelect += Math.max(0, Number.isFinite(_dt) ? _dt : 0);
      const moved = Number.isNaN(this.lastSelect.x) || this.lastSelect.distanceToSquared(cam) > MOVE_RESELECT_M * MOVE_RESELECT_M;
      if (moved || this.sinceSelect >= RESELECT_S) this.select(cam);
      this.issueRequests();
      this.processArrivals(t0);
      this.groundTiles(t0);
      for (let i = 0; i < this.ready.length; i++) {
        const o = this.ready[i].obj;
        if (o) o.updateLod(cam, this.stream, this.night);
      }
      if (t0 - this.lastEvictCheck > 1000) { this.lastEvictCheck = t0; this.evict(); }
    } catch (e) {
      this.logOnce('update', `[scenery] update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.lastUpdateMs = this.now() - t0;
  }

  setFrame(frame: LocalFrame): void {
    this.frame = frame;
    for (let i = 0; i < this.ready.length; i++) this.ready[i].obj?.place(frame);
    this.lastSelect.set(NaN, NaN, NaN);
  }

  setQuality(q: SceneryQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    const p = qualityProfile(q);
    this.build = { ...p.build, ...this.overrides.build };
    this.stream = { ...p.stream, ...this.overrides.stream };
    this.lastSelect.set(NaN, NaN, NaN);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.visible = on;
  }

  attribution(): string[] { return [ATTRIBUTION]; }

  stats(): Record<string, number> {
    let loaded = 0, pending = 0, empty = 0, buildings = 0, trees = 0, lights = 0, triangles = 0, waiting = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') loaded++;
      else if (e.state === 'loading') pending++;
      else if (e.state === 'empty') empty++;
      if (e.obj) {
        buildings += e.obj.buildingCount;
        trees += e.obj.treeCount;
        lights += e.obj.lightCount;
        triangles += e.obj.drawnTriangles();
        waiting += e.obj.pendingBuildings;
      }
    }
    for (const w of this.wanted) {
      const e = this.entries.get(w.key);
      if (e && e.state === 'idle') pending++;
    }
    return {
      tilesLoaded: loaded, tilesPending: pending, tilesFailed: this.failedCount, tilesEmpty: empty, tilesWanted: this.wanted.length,
      buildings, trees, lights, triangles, buildingsWaiting: waiting, inFlight: this.loader.inFlight,
      workerMode: this.loader.mode === 'worker' ? 1 : 0, updateMs: this.lastUpdateMs,
    };
  }

  /** Gates and apron stands within `radiusM`, nearest first; loads the needed tiles on demand. */
  async parkingSpots(lat: number, lon: number, radiusM: number): Promise<ParkingSpot[]> {
    if (this.disposed || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const r = Math.max(10, Math.min(radiusM, 10000));
    const tiles = tilesAround(lat, lon, r, SCENERY_ZOOM, []);
    const template = await this.source.whenReady();
    if (!template) return [];
    const lists = await Promise.all(tiles.map(async (t) => ({ projector: new TileProjector(t.z, t.x, t.y), spots: await this.parkingForTile(t, template) })));
    return selectParking(lists, lat, lon, r);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loader.dispose();
    for (const e of this.entries.values()) { e.obj?.dispose(); e.obj = null; }
    this.entries.clear();
    this.ready.length = 0;
    for (const w of this.parkingWaiters.values()) w(null);
    this.parkingWaiters.clear();
    this.materials.dispose();
    this.treeGeo.conifer.dispose();
    this.treeGeo.broadleaf.dispose();
    this.root.removeFromParent();
  }

  /**
   * Automation / debugging aid (screenshots): force the render camera to a geodetic pose every
   * frame (heading true, pitch up positive); null releases it. Inert unless called.
   */
  debugView(v: { lat: number; lon: number; alt: number; headingDeg: number; pitchDeg: number; fovDeg?: number } | null): void {
    this.debugPose = v;
    this.lastSelect.set(NaN, NaN, NaN);
  }

  private applyDebugPose(camera: THREE.PerspectiveCamera): THREE.Vector3 {
    const v = this.debugPose!;
    const p = this.frame.geodeticToThree(v.lat, v.lon, v.alt);
    this.debugPos.set(p[0], p[1], p[2]);
    if (camera && camera.isPerspectiveCamera) {
      camera.position.copy(this.debugPos);
      camera.rotation.set((v.pitchDeg * Math.PI) / 180, (-v.headingDeg * Math.PI) / 180, 0, 'YXZ');
      if (v.fovDeg && Math.abs(camera.fov - v.fovDeg) > 1e-6) { camera.fov = v.fovDeg; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld(true);
    }
    return this.debugPos;
  }

  get isVisible(): boolean { return this.visible; }
  get loaderMode(): LoaderMode { return this.loader.mode; }
  /** resident tile objects (tests / debugging) */
  tileObjects(): TileObject[] { return this.ready.map((e) => e.obj).filter((o): o is TileObject => o !== null); }
  tileState(key: string): EntryState | undefined { return this.entries.get(key)?.state; }
  get materialSet(): SceneryMaterials { return this.materials; }

  // ───────────────────────────── streaming ─────────────────────────────

  private select(cam: THREE.Vector3): void {
    this.sinceSelect = 0;
    this.selectGen++;
    this.lastSelect.copy(cam);
    this.frame.threeToGeodetic(cam.x, cam.y, cam.z, this.geo);
    const z = Math.min(SCENERY_ZOOM, this.source.maxZoom);
    this.wanted = tilesAround(this.geo.lat, this.geo.lon, this.stream.radiusM, z, this.wanted);
    for (let i = 0; i < this.wanted.length; i++) {
      const w = this.wanted[i];
      let e = this.entries.get(w.key);
      if (!e) {
        e = { key: w.key, z: w.z, x: w.x, y: w.y, state: 'idle', obj: null, failures: 0, retryAt: 0, requestId: 0, lastWanted: 0, dist: w.distM };
        this.entries.set(w.key, e);
      }
      e.lastWanted = this.selectGen;
      e.dist = w.distM;
    }
  }

  private issueRequests(): void {
    const max = this.stream.maxInFlight;
    if (this.loader.inFlight >= max || this.wanted.length === 0) return;
    const template = this.source.get();
    if (!template) return;
    const now = this.now();
    for (let i = 0; i < this.wanted.length && this.loader.inFlight < max; i++) {
      const e = this.entries.get(this.wanted[i].key);
      if (!e) continue;
      if (e.state === 'failed' && e.failures < MAX_RETRIES && now >= e.retryAt) e.state = 'idle';
      if (e.state !== 'idle') continue;
      e.state = 'loading';
      e.requestId = this.nextId++;
      const req: BuildRequest = { type: 'build', id: e.requestId, key: e.key, z: e.z, x: e.x, y: e.y, url: expandTileUrl(template, e.z, e.x, e.y), settings: this.build };
      this.loader.request(req);
    }
  }

  private onResponse(r: WorkerResponse): void {
    const waiter = this.parkingWaiters.get(r.id);
    if (waiter) { this.parkingWaiters.delete(r.id); waiter(r); return; }
    if (this.disposed) return;
    this.arrivals.push(r);
  }

  private processArrivals(t0: number): void {
    let made = 0;
    while (this.arrivals.length > 0) {
      const r = this.arrivals[0];
      const e = this.entries.get(r.key);
      if (!e || e.requestId !== r.id) { this.arrivals.shift(); continue; }
      if (r.type === 'failed') {
        this.arrivals.shift();
        this.onFailure(e, r.kind, r.status, r.message);
        continue;
      }
      const res = r.result;
      this.parkingCache.set(e.key, res.parking);
      const hasContent = !!(res.buildings || res.surfaces || res.markings || res.trees || res.streetlights || res.airportLights || res.lightPools);
      if (!hasContent) { this.arrivals.shift(); e.state = 'empty'; continue; }
      // one tile object per frame (and none once the frame budget is spent)
      if (made >= 1 || this.now() - t0 > this.stream.frameBudgetMs * 0.6) break;
      this.arrivals.shift();
      if (res.decodeErrors > 0) this.logOnce('decode-errors', `[scenery] ${res.decodeErrors} malformed features skipped in tile ${res.key}`);
      const obj = new TileObject(res, this.materials, this.treeGeo);
      obj.place(this.frame);
      this.root.add(obj.group);
      e.obj = obj;
      e.state = 'ready';
      this.ready.push(e);
      made++;
    }
  }

  private onFailure(e: TileEntry, kind: string, status: number, message: string): void {
    if (kind === 'empty') { e.state = 'empty'; return; }
    e.failures++;
    const permanent = kind === 'decode' || (kind === 'http' && status >= 400 && status < 500 && status !== 408 && status !== 429);
    if (permanent || e.failures >= MAX_RETRIES) {
      e.state = 'failed';
      e.failures = MAX_RETRIES;
      this.failedCount++;
    } else {
      e.state = 'failed';
      e.retryAt = this.now() + 4000 * 2 ** (e.failures - 1);
    }
    this.logOnce(`fail-${kind}`, `[scenery] tile ${e.key} ${kind} failure${status ? ` (HTTP ${status})` : ''}: ${message} — skipped`);
  }

  // ───────────────────────────── ground ─────────────────────────────

  private groundTiles(t0: number): void {
    const budgetMs = this.stream.frameBudgetMs;
    let left = this.stream.groundSamplesPerFrame;
    // 1) first passes, nearest tiles first (the wanted list is sorted by distance)
    for (let i = 0; i < this.wanted.length && left > 0; i++) {
      const e = this.entries.get(this.wanted[i].key);
      const o = e?.obj;
      if (!o || !o.settling) continue;
      left -= o.groundStep(left, this.sampler, true);
      if (this.now() - t0 > budgetMs) return;
    }
    // 2) gradual re-sampling round-robin over every resident tile (a share of the budget)
    left = Math.min(left, Math.ceil(this.stream.groundSamplesPerFrame * RESAMPLE_SHARE));
    const n = this.ready.length;
    for (let k = 0; k < n && left > 0; k++) {
      this.resampleCursor = (this.resampleCursor + 1) % n;
      const o = this.ready[this.resampleCursor].obj;
      if (!o) continue;
      left -= o.groundStep(Math.min(left, RESAMPLE_CHUNK), this.sampler, false);
      if (this.now() - t0 > budgetMs) return;
    }
  }

  // ───────────────────────────── eviction ─────────────────────────────

  private evict(): void {
    const max = this.stream.maxResidentTiles;
    while (this.ready.length > max) {
      let worst = -1, oldest = Infinity;
      for (let i = 0; i < this.ready.length; i++) {
        const e = this.ready[i];
        if (e.lastWanted === this.selectGen) continue; // still wanted
        if (e.lastWanted < oldest) { oldest = e.lastWanted; worst = i; }
      }
      if (worst < 0) break;
      const e = this.ready[worst];
      this.ready.splice(worst, 1);
      e.obj?.dispose();
      e.obj = null;
      e.state = 'idle';
      this.entries.delete(e.key);
    }
    // forget stale bookkeeping entries (empty / failed / idle) far behind
    if (this.entries.size > 4 * max + 200) {
      for (const [k, e] of this.entries) if (!e.obj && e.state !== 'loading' && e.lastWanted < this.selectGen - 120) this.entries.delete(k);
    }
    if (this.parkingCache.size > 400) this.parkingCache.clear();
  }

  // ───────────────────────────── parking ─────────────────────────────

  private parkingForTile(t: TileDist, template: string): Promise<ParkingSpotLocal[]> {
    const e = this.entries.get(t.key);
    if (e?.obj) return Promise.resolve(e.obj.result.parking);
    if (e?.state === 'empty') return Promise.resolve([]);
    const cached = this.parkingCache.get(t.key);
    if (cached) return Promise.resolve(cached);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.parkingWaiters.delete(id); this.loader.cancel(id); resolve([]); }, 15000);
      this.parkingWaiters.set(id, (r) => {
        clearTimeout(timer);
        if (r && r.type === 'built') { this.parkingCache.set(t.key, r.result.parking); resolve(r.result.parking); }
        else resolve([]);
      });
      this.loader.request({ type: 'build', id, key: t.key, z: t.z, x: t.x, y: t.y, url: expandTileUrl(template, t.z, t.x, t.y), settings: this.build, parkingOnly: true });
    });
  }

  private logOnce(kind: string, msg: string): void {
    if (this.logged.has(kind)) return;
    this.logged.add(kind);
    this.log(msg);
  }
}
