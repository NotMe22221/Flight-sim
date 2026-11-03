/**
 * Main-thread object of one built tile: Three.js meshes over the worker's typed arrays,
 * placement in the current frame, ground layers, distance LOD and full disposal.
 */
import * as THREE from 'three';
import type { StreamSettings } from './config';
import { GroundLayer, TilePlacement, type GroundSampler } from './grounding';
import { BuildingLayer, DrapeLayer, PointLayer, TreeLayer } from './layers';
import type { SceneryMaterials } from './materials';
import type { MeshData, TileBuildResult } from './protocol';
import { TileProjector } from './tileMath';

export interface SharedTreeGeometry { conifer: THREE.BufferGeometry; broadleaf: THREE.BufferGeometry; coniferTris: number; broadleafTris: number }

function geometryFrom(m: MeshData, position: THREE.BufferAttribute | null, sphere: THREE.Sphere): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', position ?? new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  if (m.color) g.setAttribute('color', new THREE.BufferAttribute(m.color, 3, true));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.boundingSphere = sphere;
  return g;
}

const _tmpV = new THREE.Vector3();
/** Probe grid per tile side (8 × 8 points, ~240 m apart at z14) watched for terrain refinements. */
export const PROBE_GRID = 8;
/** A probe point whose ground moved more than this (m) marks the tile for priority re-sampling. */
export const PROBE_EPS_M = 0.1;

export class TileObject {
  readonly key: string;
  readonly result: TileBuildResult;
  readonly group = new THREE.Group();
  readonly projector: TileProjector;
  readonly placement = new TilePlacement();
  readonly layers: GroundLayer[] = [];
  /** distance from the camera to the tile (m), refreshed by updateLod */
  distM = Infinity;
  lastUsedFrame = 0;
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  private readonly halfDiag: number;
  private buildings: BuildingLayer | null = null;
  private wallMeshes: (THREE.Mesh | null)[] = [];
  private fullIndex = [0, 0, 0];
  private surfaceLayer: DrapeLayer | null = null;
  private markingLayer: DrapeLayer | null = null;
  private poolLayer: DrapeLayer | null = null;
  private surfaceMesh: THREE.Mesh | null = null;
  private markingMesh: THREE.Mesh | null = null;
  private poolMesh: THREE.Mesh | null = null;
  private street: PointLayer | null = null;
  private airport: PointLayer | null = null;
  private streetPoints: THREE.Points | null = null;
  private airportPoints: THREE.Points | null = null;
  private trees: TreeLayer[] = [];
  private treeTris = [0, 0];
  private sphereLo = Infinity;
  private sphereHi = -Infinity;
  private disposed = false;
  /** layer being re-sampled (round-robin, see groundStep) */
  private resampleLayer = 0;
  /** coarse grid of tile-local points (x, z) watched for terrain refinements, and the ground last seen there */
  private readonly probeXZ: Float32Array;
  private readonly probeY: Float32Array;
  private probeCursor = 0;
  private probeSweeps = 0;
  /** samples of one full re-sampling cycle over every layer */
  private readonly cycleCost: number;
  /**
   * Re-sampling still owed (samples) since the terrain changed under the tile: the manager
   * serves such tiles first, nearest first, until one full cycle over every layer is done.
   */
  hotSamples = 0;

  constructor(result: TileBuildResult, mats: SceneryMaterials, trees: SharedTreeGeometry) {
    this.key = result.key;
    this.result = result;
    this.projector = new TileProjector(result.z, result.x, result.y);
    this.group.name = `scenery:${result.key}`;
    this.group.matrixAutoUpdate = false;
    const w = this.projector.unitM * this.projector.extent;
    this.halfDiag = w * 0.7072 + 40;
    this.sphere.radius = this.halfDiag;

    const b = result.buildings;
    if (b) {
      const layer = new BuildingLayer(b);
      this.buildings = layer;
      this.layers.push(layer);
      const mats3 = [mats.walls, mats.plain, mats.roofs];
      const datas = [b.walls, b.plain, b.roofs];
      for (let m = 0; m < 3; m++) {
        if (datas[m].index.length === 0) { this.wallMeshes.push(null); continue; }
        const mesh = new THREE.Mesh(geometryFrom(datas[m], layer.attrs[m], this.sphere), mats3[m]);
        mesh.matrixAutoUpdate = false;
        mesh.name = ['walls', 'plain', 'roofs'][m];
        this.group.add(mesh);
        this.wallMeshes.push(mesh);
        this.fullIndex[m] = datas[m].index.length;
      }
    }
    const drape = (d: TileBuildResult['surfaces'], mat: THREE.Material, name: string, order: number, receiveShadow = true): [DrapeLayer, THREE.Mesh] | null => {
      if (!d) return null;
      const layer = new DrapeLayer(d);
      this.layers.push(layer);
      const geo = geometryFrom(d.mesh, layer.attr, this.sphere);
      geo.setAttribute('aBias', layer.bias);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.name = name;
      mesh.renderOrder = order;
      mesh.visible = false;
      // pavement takes the aircraft's shadow like the AirportsLayer runway slabs (it never casts)
      mesh.receiveShadow = receiveShadow;
      this.group.add(mesh);
      return [layer, mesh];
    };
    const s = drape(result.surfaces, mats.surfaces, 'pavement', 0);
    if (s) [this.surfaceLayer, this.surfaceMesh] = s;
    const mk = drape(result.markings, mats.markings, 'markings', 1);
    if (mk) [this.markingLayer, this.markingMesh] = mk;
    const pl = drape(result.lightPools, mats.pools, 'light-pools', 3, false);
    if (pl) [this.poolLayer, this.poolMesh] = pl;

    const points = (d: TileBuildResult['streetlights'], mat: THREE.PointsMaterial, name: string): [PointLayer, THREE.Points] | null => {
      if (!d) return null;
      const layer = new PointLayer(d);
      this.layers.push(layer);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', layer.attr);
      g.setAttribute('color', layer.color);
      g.boundingSphere = this.sphere;
      const p = new THREE.Points(g, mat);
      p.matrixAutoUpdate = false;
      p.name = name;
      p.renderOrder = 4;
      p.visible = false;
      this.group.add(p);
      return [layer, p];
    };
    const st = points(result.streetlights, mats.streetlights, 'streetlights');
    if (st) [this.street, this.streetPoints] = st;
    const ap = points(result.airportLights, mats.airportLights, 'airport-lights');
    if (ap) [this.airport, this.airportPoints] = ap;

    const t = result.trees;
    if (t) {
      const add = (src: Float32Array, col: Uint8Array, geo: THREE.BufferGeometry, tris: number, k: number) => {
        if (src.length === 0) return;
        const layer = new TreeLayer(src, col, geo, mats.trees);
        layer.mesh.boundingSphere = this.sphere;
        layer.mesh.name = k === 0 ? 'conifers' : 'broadleaf';
        this.layers.push(layer);
        this.trees.push(layer);
        this.treeTris[this.trees.length - 1] = tris;
        this.group.add(layer.mesh);
      };
      add(t.conifer, t.coniferColor, trees.conifer, trees.coniferTris, 0);
      add(t.broadleaf, t.broadleafColor, trees.broadleaf, trees.broadleafTris, 1);
    }

    let cost = 0;
    for (const l of this.layers) cost += l.n * l.cost;
    this.cycleCost = cost;
    const g = PROBE_GRID, ext = this.projector.extent, xz = [0, 0];
    this.probeXZ = new Float32Array(g * g * 2);
    this.probeY = new Float32Array(g * g).fill(NaN);
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        this.projector.toLocal(((i + 0.5) / g) * ext, ((j + 0.5) / g) * ext, xz, 0);
        this.probeXZ[(j * g + i) * 2] = xz[0]; this.probeXZ[(j * g + i) * 2 + 1] = xz[1];
      }
    }
  }

  /**
   * Watch the terrain under the tile: sample up to `budget` probe points (round-robin). A
   * ground change since the last look (or ground appearing where there was none, after the
   * first sweep) means the terrain refined there: restart every settled layer's pass and owe
   * one full re-sampling cycle (`hotSamples`). Returns the samples used.
   */
  checkTerrain(s: GroundSampler, budget: number): number {
    const n = this.probeY.length;
    if (this.layers.length === 0) return 0;
    let used = 0;
    for (; used < budget; used++) {
      const i = this.probeCursor;
      const swept = this.probeSweeps > 0;
      if (++this.probeCursor >= n) { this.probeCursor = 0; this.probeSweeps++; }
      const prev = this.probeY[i];
      const y = s.sample(this.placement, this.probeXZ[i * 2], this.probeXZ[i * 2 + 1], Number.isFinite(prev) ? prev : this.layers[0].meanGround);
      if (Number.isNaN(y)) continue;
      this.probeY[i] = y;
      const changed = Number.isFinite(prev) ? Math.abs(y - prev) > PROBE_EPS_M : swept;
      if (changed) this.markHot();
    }
    return used;
  }

  private markHot(): void {
    if (this.hotSamples <= 0) {
      // buildings first; already hot: keep going (restarting again could starve a layer's tail)
      for (const l of this.layers) if (l.firstPassDone) l.cursor = 0;
      this.resampleLayer = 0;
    }
    // the round-robin spends this over every layer in turn: one more full cycle from here
    this.hotSamples = this.cycleCost;
  }

  /** Place the tile group in a frame (new flight origin or rebase). */
  place(frame: import('../geo/wgs84').LocalFrame): void {
    this.placement.set(this.projector.frame, frame);
    this.placement.toMatrixArray(this.group.matrix.elements);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** True while some layer has not finished its first pass. */
  get settling(): boolean {
    const ls = this.layers;
    for (let i = 0; i < ls.length; i++) if (!ls[i].firstPassDone) return true;
    return false;
  }

  /**
   * Spend up to `budget` ground samples. `firstPassOnly`: layers that have not finished their
   * first pass, in order (buildings first). Otherwise gradual re-sampling: one layer at a time,
   * a full pass each, round-robin over all layers, so pavement, lights and trees follow terrain
   * refinements as well as buildings do.
   */
  groundStep(budget: number, s: GroundSampler, firstPassOnly: boolean): number {
    let used = 0;
    const ls = this.layers;
    if (firstPassOnly) {
      for (let i = 0; i < ls.length && used < budget; i++) {
        const l = ls[i];
        if (l.firstPassDone) continue;
        used += l.step(budget - used, s, this.placement, true);
      }
    } else {
      for (let k = 0; k < ls.length && used < budget; k++) {
        if (this.resampleLayer >= ls.length) this.resampleLayer = 0;
        const l = ls[this.resampleLayer];
        const wraps = l.wraps;
        used += l.step(budget - used, s, this.placement, true);
        // budget spent inside this layer: continue with it next time
        if (l.n > 0 && l.wraps === wraps) break;
        this.resampleLayer++;
      }
      if (this.hotSamples > 0) this.hotSamples = Math.max(0, this.hotSamples - used);
    }
    for (let i = 0; i < ls.length; i++) ls[i].flush();
    this.refreshVisibility();
    return used;
  }

  private refreshVisibility(): void {
    if (this.surfaceMesh && this.surfaceLayer) this.surfaceMesh.visible = this.surfaceLayer.firstPassDone;
    if (this.markingMesh && this.markingLayer) this.markingMesh.visible = this.markingLayer.firstPassDone;
    let lo = Infinity, hi = -Infinity;
    const ls = this.layers;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      if (l.groundedCount === 0) continue;
      if (l.minG < lo) lo = l.minG;
      if (l.maxG > hi) hi = l.maxG;
    }
    if (lo !== Infinity && (lo < this.sphereLo - 1 || hi > this.sphereHi + 1)) {
      this.sphereLo = Math.min(lo, this.sphereLo);
      this.sphereHi = Math.max(hi, this.sphereHi);
      const top = this.sphereHi + (this.buildings?.maxHeight ?? 0) + 25;
      const bottom = this.sphereLo - 5;
      const half = (top - bottom) / 2;
      this.sphere.center.set(0, (top + bottom) / 2, 0);
      this.sphere.radius = Math.sqrt(this.halfDiag * this.halfDiag + half * half);
    }
  }

  /** Distance LOD; `night` 0..1 gates the light objects. */
  updateLod(cam: THREE.Vector3, st: StreamSettings, night: number): void {
    const p = this.placement;
    _tmpV.set(p.tx - cam.x, p.ty + (this.sphereLo === Infinity ? 0 : this.sphereLo) - cam.y, p.tz - cam.z);
    const half = this.halfDiag - 40;
    this.distM = Math.max(0, Math.hypot(_tmpV.x, _tmpV.z) - half * 0.85);
    const vertical = Math.abs(_tmpV.y);
    const d = Math.hypot(this.distM, vertical * 0.5);
    if (this.result.buildings) {
      const far = d > st.smallBuildingRangeM;
      const big = this.result.buildings.bigIndexCount;
      for (let m = 0; m < 3; m++) {
        const mesh = this.wallMeshes[m];
        if (!mesh) continue;
        const count = far ? big[m] : this.fullIndex[m];
        mesh.geometry.setDrawRange(0, count);
        mesh.visible = count > 0;
      }
    }
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const range = st.treeRangeM;
      const vis = d < range && t.firstPassDone;
      t.mesh.visible = vis;
      if (vis) {
        const k = d < range * 0.6 ? 1 : 1 - 0.75 * ((d - range * 0.6) / (range * 0.4));
        t.mesh.count = Math.max(1, Math.round(t.n * k));
      }
    }
    const lit = night > 0.01;
    const lightsOn = lit && d < st.lightRangeM;
    if (this.streetPoints && this.street) this.streetPoints.visible = lightsOn && this.street.firstPassDone;
    if (this.airportPoints && this.airport) this.airportPoints.visible = lightsOn && this.airport.firstPassDone;
    if (this.poolMesh && this.poolLayer) this.poolMesh.visible = lightsOn && this.poolLayer.firstPassDone;
  }

  setVisible(on: boolean): void { this.group.visible = on; }

  /** Triangles currently drawn (after LOD). */
  drawnTriangles(): number {
    let n = 0;
    for (let m = 0; m < 3; m++) {
      const mesh = this.wallMeshes[m];
      if (mesh && mesh.visible) n += Math.min(mesh.geometry.drawRange.count, this.fullIndex[m]) / 3;
    }
    for (const mesh of [this.surfaceMesh, this.markingMesh, this.poolMesh]) if (mesh && mesh.visible) n += (mesh.geometry.index?.count ?? 0) / 3;
    this.trees.forEach((t, i) => { if (t.mesh.visible) n += t.mesh.count * this.treeTris[i]; });
    return n;
  }

  get buildingCount(): number { return this.result.stats.buildings; }
  get treeCount(): number { return this.result.stats.trees; }
  get lightCount(): number { return this.result.stats.lights; }
  /** buildings still waiting for terrain */
  get pendingBuildings(): number { return this.buildings ? this.buildings.n - this.buildings.groundedCount : 0; }
  /** ground (tile-local y) of building i, NaN while waiting (tests) */
  buildingGround(i: number): number { return this.buildings ? this.buildings.groundOf(i) : NaN; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) { o.dispose(); return; } // shared tree geometry stays
      const g = (o as THREE.Mesh | THREE.Points).geometry as THREE.BufferGeometry | undefined;
      if (g) { g.boundingSphere = null; g.dispose(); }
    });
    this.group.removeFromParent();
    this.group.clear();
  }

  get isDisposed(): boolean { return this.disposed; }
}
