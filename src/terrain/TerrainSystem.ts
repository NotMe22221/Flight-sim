/**
 * TerrainSystem — streamed real-world terrain for the Three.js scene (docs/research/03).
 *
 * Per update(): CDLOD selection over the Web-Mercator quadtree (every ~100 ms or after the
 * camera moved 5 % of range0) → prioritised requests to the worker pool (AWS Terrarium →
 * parent tile → procedural; EOX → GIBS → procedural colours) → a budget of GPU uploads from
 * finished tiles → a coverage plan that draws every selected node with its own mesh, four
 * ready children, or the nearest ready ancestor's sub-square (never holes) → LRU eviction
 * above `maxResidentTiles`. Collision heights come from each tile's own mesh vertex lattice,
 * interpolated on its triangles, so the flight model touches exactly the surface that is drawn.
 *
 * Every tile mesh is a rigid object positioned from its float64 ECEF centre, so a floating-
 * origin rebase (`setFrame`) only rewrites object matrices. Nothing here throws into the
 * render loop: network and worker failures degrade to fallbacks.
 */
import { Frustum, Group, Matrix4, Quaternion, Sphere, Vector3, WebGLCoordinateSystem, type Color, type PerspectiveCamera, type Texture } from 'three';
import type { Geodetic, LocalFrameInfo, Vec3 } from '../core/types';
import { MAX_LAT, lonLatToTile, tileWidthMeters } from '../geo/mercator';
import { LocalFrame } from '../geo/wgs84';
import { DrawPlanner, tileId, type DrawItem } from './drawPlan';
import { subSquareRanges } from './gridIndex';
import { GroundQueries } from './groundQueries';
import { HeightField } from './heightfield';
import { imageryUvTransform } from './imagery';
import { DETAIL_PERIOD_M, createTerrainSharedUniforms, textureFromBitmap, textureFromRgba, type TerrainSharedUniforms } from './materials';
import type { SkySharedUniforms } from '../sky/skyUniforms';
import { DEFAULT_PROCEDURAL_PARAMS, type ProceduralParams } from './procedural';
import type { ErrorResponse, TileResponse } from './protocol';
import { DEFAULT_IMAGERY_CHAIN, awsTerrarium, collectAttribution, proceduralElevation, proceduralImagery, type ElevationProvider, type ImageryProvider } from './providers';
import { Quadtree, type SelectedNode } from './quadtree';
import { DEFAULT_QUADS_PER_LEVEL, buildLoadRequest, type RequestConfig } from './requests';
import { RUNWAY_FEATHER_M, RUNWAY_SHOULDER_M, tileTouchesRunways, type RunwayFlatteningSpec } from './runways';
import { TextureCache } from './textureCache';
import type { FetchFn } from './tileFetch';
import { SharedIndices, applyDrawRanges, createTileGpu, disposeTileGpu, frameRotation, placeTile } from './tileGpu';
import { TileLoader, defaultWorkerCount, type LoaderMode } from './tileLoader';
import { createTileRecord, discardResponse, updateRecordCenter, type TileRecord } from './tileRecord';

export type ImageryMode = 'satellite' | 'procedural';
export type DepthMode = 'reversed' | 'logarithmic';

export interface TerrainSystemOptions {
  /** texture anisotropy (pass `renderer.capabilities.getMaxAnisotropy()`; default 4) */
  maxAnisotropy?: number;
  /**
   * the sky's shared uniforms (ambient irradiance, sky colours, cloud shadows) referenced by every tile
   * material; default the process-wide `SKY_UNIFORMS` that `SkySystem` publishes into
   */
  skyUniforms?: SkySharedUniforms;
  /** imagery chain: EOX → GIBS → procedural ('satellite', default) or procedural colours only */
  imagery?: ImageryMode;
  /** CDLOD level-0 range, m (3500 desktop ≈ 2 px SSE at 1080p; 1800 low-end) */
  range0M?: number;
  /** finest zoom (level 0), default 15 */
  maxZoom?: number;
  /** coarsest zoom (root level), default 7 */
  minZoom?: number;
  /** module workers (default hardwareConcurrency − 2, clamped 2…4) */
  workers?: number;
  /** depth technique of the renderer; the shaders support both (three injects the log-depth chunks) */
  depthMode?: DepthMode;
  /** network fetch override (tests); implies in-thread loading */
  fetch?: FetchFn;
  /** load tiles on the main thread instead of module workers */
  inThread?: boolean;
  /** LRU budget of resident tiles (default 500) */
  maxResidentTiles?: number;
  /** finished tiles turned into GPU objects per update() (default 4; Infinity in tests) */
  uploadsPerFrame?: number;
  /** selection period, ms (default 100) */
  selectIntervalMs?: number;
  /** mesh quads per side by level (index 0 = maxZoom) */
  quadsPerLevel?: readonly number[];
  /** procedural fallback parameters (seed, airport plateaus) */
  procedural?: ProceduralParams;
  /** ancestor levels tried when a provider tile fails (default 3) */
  parentFallbackLevels?: number;
  /** grid size of procedural heights (default 128) */
  proceduralTileSize?: number;
  /** skip tiles hidden below the horizon (default true) */
  horizonCull?: boolean;
  /**
   * Also keep the ancestor this many levels above every selected tile, down to
   * minZoom − anchorLevels, as a stand-in while finer tiles load (0 disables; default 3).
   */
  anchorLevels?: number;
  /** network elevation providers in order (default AWS Terrarium) */
  elevationProviders?: readonly ElevationProvider[];
  /** clock in ms (tests) */
  now?: () => number;
}

export interface TerrainStats {
  /** tiles with data (heights + mesh or pending upload) */
  resident: number;
  /** tile meshes drawn by the current plan (before three's frustum culling) */
  drawn: number;
  /** requests issued and not answered yet (queued or running) */
  inflight: number;
  /** tiles whose last load failed (retried with backoff, drawn by ancestors meanwhile) */
  failed: number;
}

/** Runway centreline for flattening (`AirportsLayer.flatteningSegments()`); `alt` = threshold elevation. */
export interface RunwaySegment { a: Geodetic; b: Geodetic; widthM: number }

/**
 * Reloads of a tile whose imagery failed transiently (network, timeout, 5xx). Synthetic
 * heights standing in for unreachable real elevation are retried without a limit.
 */
const MAX_DEGRADED_RETRIES = 4;
/** Radius around the camera (beyond the nearest selected tile) used by readyFraction, m. */
export const READY_RADIUS_M = 5000;
const IDENTITY_UV: readonly number[] = [0, 0, 1];
const IDENTITY_Q = new Quaternion();

const imageryChain = (mode: ImageryMode): readonly ImageryProvider[] => (mode === 'procedural' ? [proceduralImagery] : DEFAULT_IMAGERY_CHAIN);
const sameFrame = (a: LocalFrameInfo, b: LocalFrameInfo): boolean => a.lat0 === b.lat0 && a.lon0 === b.lon0 && a.alt0 === b.alt0;

export class TerrainSystem {
  /** Add to the scene. Holds one mesh per resident tile (+ ocean child meshes). */
  readonly group = new Group();
  readonly depthMode: DepthMode;
  readonly maxZoom: number;
  readonly minZoom: number;
  readonly range0: number;

  private frame: LocalFrame;
  private readonly heights: HeightField;
  private readonly ground: GroundQueries;
  private readonly quadtree: Quadtree;
  private readonly planner = new DrawPlanner();
  private readonly loader: TileLoader;
  private readonly shared: TerrainSharedUniforms;
  private readonly indices = new SharedIndices();
  private readonly textures = new TextureCache();
  private readonly records = new Map<number, TileRecord>();
  private readonly byReqKey = new Map<string, TileRecord>();
  private readonly uploadQueue: TileRecord[] = [];
  private readonly evictScratch: TileRecord[] = [];
  private readonly pinned = new Set<number>();
  private readonly waiters = new Map<number, (() => void)[]>();
  private idleWaiters: (() => void)[] = [];
  private readonly frames = new Map<string, LocalFrame>();
  private readonly rotations = new Map<LocalFrame, Quaternion>();
  private readonly requestCfg: RequestConfig;
  private runwayMap = new Map<string, RunwayFlatteningSpec>();
  private runways: RunwayFlatteningSpec[] = [];
  private imageryMode: ImageryMode;
  private readonly anisotropy: number;
  private readonly maxResident: number;
  private readonly uploadsPerFrame: number;
  private readonly selectIntervalMs: number;
  private readonly anchorLevels: number;
  /** coarsest zoom kept as a coverage anchor (and searched for ancestor stand-ins) */
  private readonly anchorFloor: number;
  private readonly now: () => number;
  private selection: readonly SelectedNode[] = [];
  private pass = 0;
  private drawPassNo = 0;
  private lastSelectAt = -Infinity;
  private readonly selectCam = new Vector3(NaN, NaN, NaN);
  private planDirty = false;
  private drawnCount = 0;
  /** records holding procedural heights that stand in for unreachable real elevation */
  private degradedCount = 0;
  private disposed = false;
  private lastErrorLog = -Infinity;
  private hasFrustum = false;
  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();
  private readonly sphere = new Sphere();
  private readonly camArr = new Float64Array(3);
  private readonly rangeScratch = new Int32Array(10);
  private readonly uvScratch = [0, 0, 1];
  private readonly nedScratch: Vec3 = [0, 0, 0];
  private readonly readyFn = (z: number, x: number, y: number): boolean => {
    const r = this.records.get(tileId(z, x, y));
    return r !== undefined && r.gpu !== null;
  };

  constructor(frame: LocalFrame, options: TerrainSystemOptions = {}) {
    this.frame = frame;
    this.shared = createTerrainSharedUniforms(options.skyUniforms);
    this.maxZoom = options.maxZoom ?? 15;
    this.minZoom = options.minZoom ?? 7;
    if (!(this.minZoom >= 0 && this.minZoom <= this.maxZoom && this.maxZoom <= 22)) {
      throw new Error(`TerrainSystem: need 0 ≤ minZoom (${this.minZoom}) ≤ maxZoom (${this.maxZoom}) ≤ 22`);
    }
    this.range0 = options.range0M ?? 3500;
    this.depthMode = options.depthMode ?? 'reversed';
    this.imageryMode = options.imagery ?? 'satellite';
    this.anisotropy = Math.max(1, options.maxAnisotropy ?? 4);
    this.maxResident = options.maxResidentTiles ?? 500;
    this.uploadsPerFrame = options.uploadsPerFrame ?? 4;
    this.selectIntervalMs = options.selectIntervalMs ?? 100;
    this.anchorLevels = Math.max(0, options.anchorLevels ?? 3);
    this.anchorFloor = Math.max(0, this.minZoom - this.anchorLevels);
    this.now = options.now ?? (() => performance.now());
    this.heights = new HeightField(this.maxZoom, 0);
    this.ground = new GroundQueries(this.heights);
    this.quadtree = new Quadtree(
      frame,
      { finestZoom: this.maxZoom, coarsestZoom: this.minZoom, range0: this.range0, horizonCull: options.horizonCull ?? true },
      (z, x, y, out) => this.heights.heightRange(z, x, y, out),
    );
    this.requestCfg = {
      elevation: options.elevationProviders ?? [awsTerrarium],
      imagery: imageryChain(this.imageryMode),
      parentFallbackLevels: options.parentFallbackLevels ?? 3,
      proceduralTileSize: options.proceduralTileSize ?? 128,
      quadsPerLevel: options.quadsPerLevel ?? DEFAULT_QUADS_PER_LEVEL,
      finestZoom: this.maxZoom,
      procedural: options.procedural ?? DEFAULT_PROCEDURAL_PARAMS,
    };
    this.loader = new TileLoader({
      workers: options.workers ?? defaultWorkerCount(),
      inThread: options.inThread ?? false,
      fetch: options.fetch,
      cancelGraceMs: 2000,
      onTile: (r) => this.onTile(r),
      onError: (r) => this.onError(r),
      onAborted: (key) => this.onAborted(key),
      onReset: () => this.onReset(),
    });
    this.group.name = 'terrain';
    this.updateEarthCenter();
  }

  /** How tiles are loaded right now ('worker' or 'in-thread'). */
  get loaderMode(): LoaderMode { return this.loader.mode; }
  /** Uniforms shared by every terrain/ocean material (for debugging or direct driving). */
  get uniforms(): TerrainSharedUniforms { return this.shared; }
  /** CDLOD selection of the last update (reused array). */
  get selectedNodes(): readonly SelectedNode[] { return this.selection; }
  /** Draw plan of the last update: which tile mesh covers each selected node (reused array). */
  get drawItems(): readonly DrawItem[] { return this.planner.items; }
  /** Selected nodes that nothing loaded can draw yet (non-zero only while the first tiles stream in). */
  get holes(): number { return this.planner.holes; }

  /**
   * Per-frame update. `cameraPosThree` is the camera position in the render frame (it may be
   * a smoothed or interpolated position, not necessarily `camera.position`).
   */
  update(cameraPosThree: Vector3, camera: PerspectiveCamera, dtS: number): void {
    if (this.disposed) return;
    try {
      const now = this.now();
      const t = this.shared.uTime.value + (Number.isFinite(dtS) ? dtS : 0);
      this.shared.uTime.value = t > 3600 ? t - 3600 : t;
      const lim = 0.05 * this.range0;
      if (now - this.lastSelectAt >= this.selectIntervalMs || !(cameraPosThree.distanceToSquared(this.selectCam) <= lim * lim)) {
        this.select(cameraPosThree, camera, now);
      }
      this.loader.pump(now);
      if (this.uploadPending(this.uploadsPerFrame) > 0) this.planDirty = true;
      if (this.planDirty) this.rebuildPlan(now);
      this.evictIfNeeded();
    } catch (err) {
      this.logError(err);
    }
  }

  // ───────────────────────────── selection and requests ─────────────────────────────

  private select(cam: Vector3, camera: PerspectiveCamera | null, now: number): void {
    if (!Number.isFinite(cam.x) || !Number.isFinite(cam.y) || !Number.isFinite(cam.z)) return;
    this.pass++;
    this.lastSelectAt = now;
    this.selectCam.copy(cam);
    this.hasFrustum = false;
    if (camera) {
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen, WebGLCoordinateSystem, camera.reversedDepth);
      this.hasFrustum = true;
    }
    const c = this.camArr;
    c[0] = cam.x; c[1] = cam.y; c[2] = cam.z;
    this.selection = this.quadtree.select(c, null);
    for (const s of this.selection) {
      const tz = s.parentPatch ? s.z - 1 : s.z, tx = s.parentPatch ? s.x >> 1 : s.x, ty = s.parentPatch ? s.y >> 1 : s.y;
      const rec = this.want(tz, tx, ty, now);
      this.ensureRequested(rec, -s.distance / rec.widthM + (this.inFrustum(rec) ? 4 : 0), now);
      const anchor = this.wantAnchor(tz, tx, ty, now);
      if (anchor) this.ensureRequested(anchor, 8 - s.distance / anchor.widthM, now);
    }
    for (const id of this.pinned) {
      const rec = this.records.get(id);
      if (!rec) { this.pinned.delete(id); this.resolveWaiters(id); continue; }
      rec.wantedPass = this.pass;
      rec.lastUsed = now;
      this.ensureRequested(rec, 50, now);
      // nothing outstanding any more (e.g. a worker failover dropped it during a retry backoff)
      if (!rec.reqKey) { this.pinned.delete(id); this.resolveWaiters(id); }
    }
    for (const rec of this.records.values()) {
      if (rec.wantedPass === this.pass) continue;
      if (rec.reqKey) this.loader.release(rec.reqKey, now);
      else if (!rec.hasData && !rec.gpu && !rec.pending) this.records.delete(rec.id);
    }
    const up = this.ground.groundUp(this.frame, -cam.z, cam.x);
    if (up !== null) this.shared.uFogGroundY.value = up;
    this.planDirty = true;
  }

  private want(z: number, x: number, y: number, now: number): TileRecord {
    const id = tileId(z, x, y);
    let rec = this.records.get(id);
    if (!rec) { rec = createTileRecord(z, x, y, this.frame); this.records.set(id, rec); }
    rec.wantedPass = this.pass;
    rec.lastUsed = now;
    return rec;
  }

  /**
   * Coverage anchor of tile (z, x, y): its ancestor `anchorLevels` up, but never above the
   * anchor floor (minZoom − anchorLevels), so even root-level nodes entering the selection
   * have a coarse stand-in. Null when anchors are disabled.
   */
  private wantAnchor(z: number, x: number, y: number, now: number): TileRecord | null {
    if (this.anchorLevels === 0) return null;
    const az = Math.max(this.anchorFloor, z - this.anchorLevels);
    if (az >= z) return null;
    const k = z - az;
    return this.want(az, x >> k, y >> k, now);
  }

  private inFrustum(rec: TileRecord): boolean {
    if (!this.hasFrustum) return false;
    this.sphere.center.copy(rec.center);
    this.sphere.radius = 0.75 * rec.widthM;
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** Issue (or re-prioritise) the tile's request when it has no current data. */
  private ensureRequested(rec: TileRecord, priority: number, now: number): void {
    if (rec.reqKey) {
      if (this.loader.has(rec.reqKey) && rec.req) { this.loader.request(rec.req, priority); return; }
      this.byReqKey.delete(rec.reqKey); // dropped without an answer
      rec.reqKey = '';
      rec.req = null;
    }
    const missing = !rec.gpu && !rec.pending;
    if (!missing && rec.haveVersion >= rec.wantVersion) return;
    if (now < rec.retryAt) return; // backoff after a failure or a degraded (fallback) load
    rec.reqVersion = rec.wantVersion;
    rec.reqKey = `${rec.key}@${rec.reqVersion}`;
    // Once a tile has data, or real data covers it from an ancestor, a network outage must not
    // replace that with synthetic heights: the worker then answers a transient error instead.
    const proceduralOnTransient = !rec.hasData && !this.hasRealCover(rec);
    rec.req = buildLoadRequest(rec.reqKey, rec.z, rec.x, rec.y, this.frame, this.requestCfg, this.runways, proceduralOnTransient);
    this.byReqKey.set(rec.reqKey, rec);
    this.loader.request(rec.req, priority);
  }

  /** Take the record answering pool request `key`, clearing its outstanding request. */
  private settle(key: string): TileRecord | null {
    const rec = this.byReqKey.get(key);
    this.byReqKey.delete(key);
    if (!rec || rec.reqKey !== key || this.records.get(rec.id) !== rec) return null;
    rec.reqKey = '';
    rec.req = null;
    return rec;
  }

  private onTile(r: TileResponse): void {
    const rec = this.disposed ? null : this.settle(r.key);
    if (!rec) { discardResponse(r); this.checkIdle(); return; }
    const now = this.now();
    const synthetic = r.elevationProviderId === proceduralElevation.id;
    const standIn = r.transientFailure && synthetic; // procedural heights only because the network failed
    if (standIn && this.hasRealCover(rec)) {
      // Real data covers this tile (its own, or an ancestor drawn in its place): keep that
      // instead of synthetic terrain, and retry the tile like a failed load.
      discardResponse(r);
      if (rec.degraded) this.dropData(rec);
      this.failLoad(rec, now);
      return;
    }
    rec.failed = false;
    rec.haveVersion = rec.reqVersion;
    const stale = rec.haveVersion < rec.wantVersion; // e.g. runways changed while this version loaded
    if (r.transientFailure && (standIn || rec.failures < MAX_DEGRADED_RETRIES)) {
      // a better source failed for a transient reason: keep this data, reload it later
      rec.failures++;
      rec.retryAt = now + Math.min(120_000, 10_000 * 2 ** (rec.failures - 1));
      rec.wantVersion = Math.max(rec.wantVersion, rec.haveVersion + 1);
    } else if (!r.transientFailure) {
      rec.failures = 0;
      rec.retryAt = 0;
    }
    // Collision samples the vertex lattice of the mesh that will be drawn, on its own
    // triangles, so wheels rest on the visible surface (not on a smoother bilinear DEM).
    const lattice = r.mesh.height.subarray(0, (r.mesh.quads + 1) * (r.mesh.quads + 1));
    this.heights.setMeshLattice(rec.z, rec.x, rec.y, lattice, r.mesh.quads, r.mesh.minH, r.mesh.maxH, now);
    rec.hasData = true;
    rec.dataProviderId = r.elevationProviderId;
    if (rec.degraded !== standIn) { rec.degraded = standIn; this.degradedCount += standIn ? 1 : -1; }
    discardResponse(rec.pending); // an older response that never reached the GPU
    rec.pending = r;
    if (!rec.queued) { rec.queued = true; this.uploadQueue.push(rec); }
    // real data arrived: descendants showing synthetic stand-ins fall back to it right away
    if (!synthetic && this.degradedCount > 0) this.dropDegradedBelow(rec, now);
    // A prefetch target is done once nothing newer is coming: a stale answer (the runways
    // changed meanwhile) re-requests the current version first, even without update().
    if (stale && this.pinned.has(rec.id)) this.ensureRequested(rec, 100, now);
    if (!rec.reqKey) {
      this.pinned.delete(rec.id);
      this.resolveWaiters(rec.id);
    }
    this.loader.pump(now);
    this.checkIdle();
  }

  private onError(r: ErrorResponse): void {
    const rec = this.disposed ? null : this.settle(r.key);
    if (rec) this.failLoad(rec, this.now());
    else this.checkIdle();
  }

  /** The load failed: draw ancestors meanwhile (keeping any older data) and retry with backoff. */
  private failLoad(rec: TileRecord, now: number): void {
    rec.failed = true;
    rec.failures++;
    rec.retryAt = now + Math.min(60_000, 2000 * 2 ** (rec.failures - 1));
    this.pinned.delete(rec.id);
    this.resolveWaiters(rec.id);
    this.loader.pump(now);
    this.checkIdle();
  }

  /** Real (non-procedural) elevation covers the tile: its own data or a resident ancestor's. */
  private hasRealCover(rec: TileRecord): boolean {
    const synthetic = proceduralElevation.id;
    if (rec.hasData && rec.dataProviderId !== synthetic) return true;
    for (let z = rec.z - 1, x = rec.x >> 1, y = rec.y >> 1; z >= this.anchorFloor; z--, x >>= 1, y >>= 1) {
      const a = this.records.get(tileId(z, x, y));
      if (a && a.hasData && a.dataProviderId !== synthetic) return true;
    }
    return false;
  }

  /** Drop the synthetic stand-ins below `anc` (which now has real data) and reload them now. */
  private dropDegradedBelow(anc: TileRecord, now: number): void {
    for (const rec of this.records.values()) {
      if (!rec.degraded || rec.z <= anc.z) continue;
      const k = rec.z - anc.z;
      if (rec.x >> k !== anc.x || rec.y >> k !== anc.y) continue;
      this.dropData(rec);
      rec.retryAt = now;
      this.lastSelectAt = -Infinity;
    }
  }

  /** Forget a record's heights and GPU objects (the record itself stays). */
  private dropData(rec: TileRecord): void {
    this.heights.delete(rec.z, rec.x, rec.y);
    if (rec.gpu) disposeTileGpu(rec.gpu, this.textures, true);
    discardResponse(rec.pending);
    rec.gpu = null;
    rec.pending = null;
    rec.hasData = false;
    rec.dataProviderId = '';
    if (rec.degraded) { rec.degraded = false; this.degradedCount--; }
    this.planDirty = true;
  }

  private onAborted(key: string): void {
    this.settle(key);
    this.checkIdle();
  }

  /** The loader dropped every outstanding request (worker failover): forget them and reselect. */
  private onReset(): void {
    for (const rec of this.byReqKey.values()) { rec.reqKey = ''; rec.req = null; }
    this.byReqKey.clear();
    this.lastSelectAt = -Infinity;
    this.selectCam.set(NaN, NaN, NaN);
    this.checkIdle();
  }

  // ───────────────────────────── uploads, draw plan, eviction ─────────────────────────────

  /** Turn up to `budget` finished tiles into GPU objects. Returns how many were uploaded. */
  private uploadPending(budget: number): number {
    const q = this.uploadQueue;
    let n = 0, i = 0;
    for (; i < q.length && n < budget; i++) {
      const rec = q[i];
      rec.queued = false;
      const r = rec.pending;
      if (!r || this.records.get(rec.id) !== rec) continue;
      rec.pending = null;
      this.upload(rec, r);
      n++;
    }
    if (i > 0) { q.copyWithin(0, i); q.length -= i; }
    return n;
  }

  private upload(rec: TileRecord, r: TileResponse): void {
    const img = r.imagery;
    let texture: Texture | null = null, textureKey: string | null = null;
    let uv: ArrayLike<number> = IDENTITY_UV;
    if (img?.kind === 'bitmap') {
      textureKey = `${img.providerId}/${img.zI}/${img.x}/${img.y}`;
      const existing = this.textures.acquire(textureKey);
      if (existing) { texture = existing; img.bitmap.close(); }
      else texture = this.textures.add(textureKey, textureFromBitmap(img.bitmap, this.anisotropy));
      uv = imageryUvTransform(r.z, r.x, r.y, img.zI, this.uvScratch);
    } else if (img?.kind === 'rgba') {
      texture = textureFromRgba(img.data, img.width, this.anisotropy);
    }
    const gpu = createTileGpu(rec.key, r.mesh, r.water, this.indices, this.shared, texture, textureKey, uv, img?.kind === 'rgba');
    const build = this.frameFor(r.frame);
    placeTile(gpu.mesh, r.mesh.centerEcef, this.frame, this.rotationFor(build));
    this.group.add(gpu.mesh);
    if (rec.gpu) disposeTileGpu(rec.gpu, this.textures, true); // replaced version (reload)
    rec.gpu = gpu;
    rec.centerEcef = r.mesh.centerEcef;
    rec.buildFrame = build;
    rec.elevationProviderId = r.elevationProviderId;
    rec.imageryProviderId = img ? img.providerId : '';
  }

  /** Map the selection to tile meshes and sub-squares (geometry groups); hide everything else. */
  private rebuildPlan(now: number): void {
    this.planDirty = false;
    const items = this.planner.plan(this.selection, this.readyFn, this.anchorFloor);
    const pass = ++this.drawPassNo;
    const scratch = this.rangeScratch;
    for (const it of items) {
      const rec = this.records.get(tileId(it.z, it.x, it.y));
      if (!rec || !rec.gpu) continue;
      if (rec.drawPass !== pass) { rec.drawPass = pass; rec.ranges.clear(); }
      const n = subSquareRanges(rec.gpu.quads, it.depth, it.code, scratch);
      for (let k = 0; k < n; k++) rec.ranges.add(scratch[2 * k], scratch[2 * k + 1]);
      rec.lastUsed = now;
    }
    let drawn = 0;
    for (const rec of this.records.values()) {
      const gpu = rec.gpu;
      if (!gpu) continue;
      if (rec.drawPass === pass) { rec.ranges.normalize(); applyDrawRanges(gpu, rec.ranges); drawn++; }
      else if (gpu.mesh.visible) { rec.ranges.clear(); applyDrawRanges(gpu, rec.ranges); }
    }
    this.drawnCount = drawn;
  }

  private evictIfNeeded(): void {
    const excess = this.heights.size - this.maxResident;
    if (excess <= 0) return;
    const cands = this.evictScratch;
    for (const rec of this.records.values()) {
      if (!rec.hasData || rec.reqKey || rec.drawPass === this.drawPassNo || rec.wantedPass === this.pass || this.pinned.has(rec.id)) continue;
      cands.push(rec);
    }
    cands.sort(byLastUsed);
    const n = Math.min(excess, cands.length);
    for (let i = 0; i < n; i++) this.evict(cands[i]);
    cands.length = 0;
  }

  private evict(rec: TileRecord): void {
    this.dropData(rec);
    this.records.delete(rec.id);
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** Height (m, DEM datum ≈ MSL, treated as ellipsoidal) of the drawn surface of the finest loaded tile, or null. */
  heightAt(latDeg: number, lonDeg: number): number | null {
    if (this.disposed || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
    return this.heights.heightAt(lonDeg, latDeg);
  }

  /**
   * Local up coordinate (−D) of the ground under NED (north, east) in the current frame —
   * the curved surface the meshes draw — or null when nothing covers the point.
   */
  heightAtLocalNED(north: number, east: number): number | null {
    if (this.disposed || !Number.isFinite(north) || !Number.isFinite(east)) return null;
    return this.ground.groundUp(this.frame, north, east);
  }

  /** Unit ground normal in NED (flat ground at the origin → [0, 0, −1]), or null when nothing is loaded there. */
  groundNormalNED(north: number, east: number, out: Vec3): Vec3 | null {
    if (this.disposed || !Number.isFinite(north) || !Number.isFinite(east)) return null;
    return this.ground.groundNormal(this.frame, north, east, out);
  }

  /**
   * Fraction (0..1) of the selected tiles near the camera that are loaded: those within
   * 5 km beyond the nearest selected tile (so it works at altitude). Passing a camera position
   * that moved since the last update re-runs the selection (useful on a loading screen).
   */
  readyFraction(cameraPosThree?: Vector3): number {
    if (this.disposed) return 0;
    try {
      if (cameraPosThree) {
        const lim = 0.05 * this.range0;
        if (!(cameraPosThree.distanceToSquared(this.selectCam) <= lim * lim)) {
          const now = this.now();
          this.select(cameraPosThree, null, now);
          this.loader.pump(now);
        }
      }
      const sel = this.selection;
      let minD = Infinity;
      for (const s of sel) if (s.distance < minD) minD = s.distance;
      const lim = Math.max(READY_RADIUS_M, minD + READY_RADIUS_M);
      let total = 0, ok = 0;
      for (const s of sel) {
        if (s.distance > lim) continue;
        total++;
        const rec = this.records.get(s.parentPatch ? tileId(s.z - 1, s.x >> 1, s.y >> 1) : tileId(s.z, s.x, s.y));
        if (rec && (rec.gpu || rec.pending || rec.failed)) ok++;
      }
      return total > 0 ? ok / total : 0;
    } catch (err) {
      this.logError(err);
      return 0;
    }
  }

  /**
   * Load the finest two zooms around a spawn point (radius in metres). Resolves when nothing
   * more is outstanding for the finest tile under the point: it has current data (real,
   * parent-derived or procedural — a resident tile made stale by setRunways is reloaded first,
   * so a respawn never starts on unflattened ground) or its load failed. Never rejects. Works
   * without update() being called.
   */
  prefetch(latDeg: number, lonDeg: number, radiusM = 1500): Promise<void> {
    if (this.disposed || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return Promise.resolve();
    try {
      const now = this.now();
      let target: TileRecord | null = null;
      // the pyramid stops at ±85.05°: widths there (cos(90°) → 0 would make the loops unbounded)
      const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg));
      for (let z = this.maxZoom; z >= Math.max(this.minZoom, this.maxZoom - 1); z--) {
        const t = lonLatToTile(lonDeg, lat, z);
        const w = tileWidthMeters(lat, z), n = 2 ** z;
        const cx = Math.floor(t.x), cy = Math.min(n - 1, Math.floor(t.y));
        const r = Math.min(32, Math.ceil(Math.max(0, Number.isFinite(radiusM) ? radiusM : 0) / w));
        for (let dy = -r; dy <= r; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= n) continue;
          for (let dx = -r; dx <= r; dx++) {
            const d = Math.hypot((cx + dx + 0.5 - t.x) * w, (y + 0.5 - t.y) * w);
            if (d > radiusM + 0.71 * w) continue;
            const rec = this.want(z, (((cx + dx) % n) + n) % n, y, now);
            this.pin(rec, 100 - d / w, now);
            if (z === this.maxZoom && dx === 0 && dy === 0) target = rec;
          }
        }
        const anchor = this.wantAnchor(z, ((cx % n) + n) % n, cy, now); // lon = 180 gives cx = n
        if (anchor) this.pin(anchor, 110, now);
      }
      this.loader.pump(now);
      const tgt = target;
      // Done when nothing is outstanding for the target: its data is current (a resident tile
      // with stale data, e.g. after setRunways, was re-requested above), or it failed and waits
      // for a retry. Otherwise the answer to the outstanding request resolves it.
      if (!tgt || !tgt.reqKey) { if (tgt) this.pinned.delete(tgt.id); return Promise.resolve(); }
      return new Promise<void>((resolve) => {
        const list = this.waiters.get(tgt.id);
        if (list) list.push(resolve); else this.waiters.set(tgt.id, [resolve]);
      });
    } catch (err) {
      this.logError(err);
      return Promise.resolve();
    }
  }

  /**
   * Keep a prefetch tile wanted until its request is answered. Tiles with nothing to load
   * (already current, or waiting out a retry backoff) are not pinned: a pin is only released by
   * an answer, so pinning them would exempt them from eviction for the rest of the session.
   */
  private pin(rec: TileRecord, priority: number, now: number): void {
    this.ensureRequested(rec, priority, now);
    if (rec.reqKey) this.pinned.add(rec.id);
    else this.pinned.delete(rec.id);
  }

  /** Resolves when no tile request is outstanding (tests, loading screens). Uploads still need update(). */
  whenIdle(): Promise<void> {
    if (this.disposed || this.byReqKey.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  // ───────────────────────────── configuration ─────────────────────────────

  /**
   * Floating-origin rebase: every tile object is re-placed from its float64 ECEF centre (with
   * the rotation between its build frame and `newFrame`); no vertex is rebuilt.
   */
  setFrame(newFrame: LocalFrame): void {
    if (this.disposed) return;
    // keep the procedural detail noise attached to the ground: the new origin in the old frame's render axes
    const ned = this.frame.ecefToNED(newFrame.origin, this.nedScratch);
    const off = this.shared.uDetailOffset.value;
    const P = DETAIL_PERIOD_M;
    off.set((((off.x + ned[1]) % P) + P) % P, (((off.y - ned[0]) % P) + P) % P);
    this.frame = newFrame;
    this.quadtree.setFrame(newFrame);
    this.rotations.clear();
    if (this.frames.size > 16) this.frames.clear();
    for (const rec of this.records.values()) {
      updateRecordCenter(rec, newFrame);
      if (rec.gpu && rec.centerEcef && rec.buildFrame) placeTile(rec.gpu.mesh, rec.centerEcef, newFrame, this.rotationFor(rec.buildFrame));
    }
    this.updateEarthCenter();
    this.lastSelectAt = -Infinity;
    this.selectCam.set(NaN, NaN, NaN);
    this.planDirty = true;
  }

  /** Runway flattening input. Tiles touching added or removed runways are reloaded (old data stays drawn meanwhile). */
  setRunways(segments: readonly RunwaySegment[]): void {
    if (this.disposed) return;
    const next = new Map<string, RunwayFlatteningSpec>();
    for (const s of segments) {
      const vals = [s.a.lat, s.a.lon, s.a.alt, s.b.lat, s.b.lon, s.b.alt, s.widthM];
      if (!vals.every(Number.isFinite)) continue;
      const spec: RunwayFlatteningSpec = {
        a: { lat: s.a.lat, lon: s.a.lon, elev: s.a.alt },
        b: { lat: s.b.lat, lon: s.b.lon, elev: s.b.alt },
        halfWidthM: Math.max(0, s.widthM) / 2 + RUNWAY_SHOULDER_M,
        featherM: RUNWAY_FEATHER_M,
      };
      next.set(vals.map((v, i) => v.toFixed(i === 2 || i === 5 ? 2 : 7)).join(','), spec);
    }
    const changed: RunwayFlatteningSpec[] = [];
    for (const [k, spec] of next) if (!this.runwayMap.has(k)) changed.push(spec);
    for (const [k, spec] of this.runwayMap) if (!next.has(k)) changed.push(spec);
    if (changed.length === 0) return;
    this.runwayMap = next;
    this.runways = [...next.values()];
    for (const rec of this.records.values()) {
      if ((rec.hasData || rec.reqKey) && tileTouchesRunways(rec.z, rec.x, rec.y, changed)) rec.wantVersion++;
    }
    this.lastSelectAt = -Infinity;
  }

  /** Switch the imagery chain; resident tiles reload in the background (keeping their old look until then). */
  setImagery(mode: ImageryMode): void {
    if (this.disposed || mode === this.imageryMode) return;
    this.imageryMode = mode;
    this.requestCfg.imagery = imageryChain(mode);
    for (const rec of this.records.values()) rec.wantVersion++;
    this.lastSelectAt = -Infinity;
  }

  /** Sun direction (render frame, toward the sun), linear colour, irradiance scale (DirectionalLight units) and ambient irradiance. */
  setSun(dirThree: Vector3, color: Color, intensity: number, ambient: Color): void {
    const u = this.shared;
    if (dirThree.lengthSq() > 0 && Number.isFinite(dirThree.lengthSq())) u.uSunDir.value.copy(dirThree).normalize();
    u.uSunColor.value.copy(color);
    u.uSunIntensity.value = Number.isFinite(intensity) ? Math.max(0, intensity) : 0;
    u.uAmbient.value.copy(ambient);
  }

  /**
   * Aerial perspective, matching the sky's height fog: linear haze colour, extinction β0 (1/m)
   * and height falloff (1/m, = 1 / scale height). `sunGlow` tints the haze toward the sun
   * (defaults to `color`). The fog's reference height is the ground under the camera.
   */
  setFog(color: Color, density: number, heightFalloff: number, sunGlow?: Color): void {
    const u = this.shared;
    u.uFogColor.value.copy(color);
    u.uSunGlow.value.copy(sunGlow ?? color);
    u.uFogDensity.value = Number.isFinite(density) ? Math.max(0, density) : 0;
    u.uFogFalloff.value = Number.isFinite(heightFalloff) && heightFalloff > 0 ? heightFalloff : 1 / 1200;
  }

  /** Attribution lines for the providers whose data is on screen (the configured primaries before any tile loads). */
  attribution(): string[] {
    const elev = new Set<string>(), img = new Set<string>();
    for (const rec of this.records.values()) {
      if (!rec.gpu) continue;
      elev.add(rec.elevationProviderId);
      if (rec.imageryProviderId) img.add(rec.imageryProviderId);
    }
    const elevationProviders = [...this.requestCfg.elevation, proceduralElevation];
    const used: { attribution: readonly string[] }[] = [];
    if (elev.size === 0) {
      used.push(elevationProviders[0], this.requestCfg.imagery[0]);
    } else {
      for (const p of elevationProviders) if (elev.has(p.id)) used.push(p);
      for (const p of this.requestCfg.imagery) if (img.has(p.id)) used.push(p);
    }
    return collectAttribution(used);
  }

  stats(): TerrainStats {
    let failed = 0;
    for (const rec of this.records.values()) if (rec.failed) failed++;
    return { resident: this.heights.size, drawn: this.drawnCount, inflight: this.byReqKey.size, failed };
  }

  /** Stop loading and free every GPU resource. The system is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loader.dispose();
    for (const rec of this.records.values()) {
      if (rec.gpu) disposeTileGpu(rec.gpu, this.textures, false);
      discardResponse(rec.pending);
      rec.gpu = null;
      rec.pending = null;
    }
    this.records.clear();
    this.byReqKey.clear();
    this.uploadQueue.length = 0;
    this.drawnCount = 0;
    this.degradedCount = 0;
    this.selection = [];
    this.pinned.clear();
    this.heights.clear();
    this.textures.dispose();
    this.group.clear();
    this.group.removeFromParent();
    for (const list of this.waiters.values()) for (const resolve of list) resolve();
    this.waiters.clear();
    this.checkIdle();
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** The LocalFrame a response was built in (the current frame, or a cached earlier one). */
  private frameFor(info: LocalFrameInfo): LocalFrame {
    if (sameFrame(info, this.frame)) return this.frame;
    const key = `${info.lat0},${info.lon0},${info.alt0}`;
    let f = this.frames.get(key);
    if (!f) { f = new LocalFrame(info.lat0, info.lon0, info.alt0); this.frames.set(key, f); }
    return f;
  }

  /** Rotation from `build`'s render axes to the current frame's (identity when they coincide). */
  private rotationFor(build: LocalFrame): Quaternion {
    if (build === this.frame || sameFrame(build, this.frame)) return IDENTITY_Q;
    let q = this.rotations.get(build);
    if (!q) { q = frameRotation(build, this.frame); this.rotations.set(build, q); }
    return q;
  }

  private updateEarthCenter(): void {
    const c = this.frame.ecefToThree([0, 0, 0]);
    this.shared.uEarthCenter.value.set(c[0], c[1], c[2]);
  }

  private resolveWaiters(id: number): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const resolve of list) resolve();
  }

  private checkIdle(): void {
    if (this.idleWaiters.length === 0 || (this.byReqKey.size > 0 && !this.disposed)) return;
    const list = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of list) resolve();
  }

  private logError(err: unknown): void {
    const now = this.now();
    if (now - this.lastErrorLog < 5000) return;
    this.lastErrorLog = now;
    console.error('[terrain] update failed', err);
  }
}

const byLastUsed = (a: TileRecord, b: TileRecord): number => a.lastUsed - b.lastUsed;
