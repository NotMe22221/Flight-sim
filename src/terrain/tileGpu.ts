/**
 * Three.js objects of one resident tile: geometry from the worker's transferred buffers (no
 * vertex work on the main thread), the shared Morton index buffer, a per-tile ShaderMaterial,
 * an optional ocean patch (child mesh, same transform), and the rigid placement in the current
 * floating-origin frame computed from the tile's float64 ECEF centre.
 *
 * Meshes use a one-element material array so that the draw plan can select sub-squares of a
 * tile with geometry groups (CDLOD parent patches and nearest-ancestor stand-ins).
 */
import { Box3, BufferAttribute, BufferGeometry, Matrix4, Mesh, Quaternion, Sphere, type Object3D, type ShaderMaterial, type Texture } from 'three';
import type { Vec3 } from '../core/types';
import type { LocalFrame } from '../geo/wgs84';
import type { RangeList } from './drawPlan';
import { gridIndex, gridIndexCount } from './gridIndex';
import { createTerrainMaterial, createWaterMaterial, type TerrainSharedUniforms } from './materials';
import type { MeshPayload, WaterPayload } from './protocol';
import type { TextureCache } from './textureCache';
import { disposeTexture } from './textureCache';
import type { Aabb } from './tileMesh';

/** One shared index attribute (one GPU buffer) per grid size. */
export class SharedIndices {
  private readonly map = new Map<number, BufferAttribute>();
  get(quads: number): BufferAttribute {
    let a = this.map.get(quads);
    if (!a) { a = new BufferAttribute(gridIndex(quads), 1); this.map.set(quads, a); }
    return a;
  }
}

export type TileMesh = Mesh<BufferGeometry, ShaderMaterial[]>;

export interface TileGpu {
  mesh: TileMesh;
  material: ShaderMaterial;
  water: TileMesh | null;
  quads: number;
  /** texture-cache key of shared imagery, or null for a tile-owned (procedural) texture */
  textureKey: string | null;
  texture: Texture | null;
}

/** Render order of ocean patches: after the terrain (0), before the sky dome (1). */
export const WATER_RENDER_ORDER = 0.5;

function geometryFrom(position: Float32Array, normal: Float32Array, uv: Float32Array, aabb: Aabb, index: BufferAttribute): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(index);
  // Bounds straight from the worker's AABB, so three never scans the vertices for culling.
  const box = new Box3();
  box.min.set(aabb.min[0], aabb.min[1], aabb.min[2]);
  box.max.set(aabb.max[0], aabb.max[1], aabb.max[2]);
  g.boundingBox = box;
  const sphere = new Sphere();
  box.getCenter(sphere.center);
  sphere.radius = 0.5 * box.min.distanceTo(box.max);
  g.boundingSphere = sphere;
  return g;
}

/** Build the tile's meshes. The texture (if any) must already be owned/acquired by the caller. */
export function createTileGpu(
  key: string, mesh: MeshPayload, water: WaterPayload | null, indices: SharedIndices,
  shared: TerrainSharedUniforms, texture: Texture | null, textureKey: string | null, uvTransform: ArrayLike<number>,
): TileGpu {
  const index = indices.get(mesh.quads);
  const material = createTerrainMaterial(shared, texture, uvTransform);
  const m: TileMesh = new Mesh(geometryFrom(mesh.position, mesh.normal, mesh.uv, mesh.aabb, index), [material]);
  m.name = `terrain ${key}`;
  m.matrixAutoUpdate = false;
  m.visible = false;
  let w: TileMesh | null = null;
  if (water) {
    const g = geometryFrom(water.position, water.normal, water.uv, water.aabb, indices.get(water.quads));
    g.setAttribute('aDepth', new BufferAttribute(water.depth, 1));
    w = new Mesh(g, [createWaterMaterial(shared)]);
    w.name = `ocean ${key}`;
    w.matrixAutoUpdate = false;
    w.renderOrder = WATER_RENDER_ORDER;
    m.add(w);
  }
  return { mesh: m, material, water: w, quads: mesh.quads, textureKey, texture };
}

/**
 * Free a tile's GPU resources. `keepSharedIndex` detaches the shared index first so the
 * renderer does not delete the index buffer other tiles still use (pass false only when
 * everything is being torn down).
 */
export function disposeTileGpu(gpu: TileGpu, textures: TextureCache, keepSharedIndex: boolean): void {
  gpu.mesh.removeFromParent();
  for (const m of gpu.water ? [gpu.mesh, gpu.water] : [gpu.mesh]) {
    if (keepSharedIndex) m.geometry.setIndex(null);
    m.geometry.dispose();
    for (const mat of m.material) mat.dispose();
  }
  if (gpu.textureKey !== null) textures.release(gpu.textureKey);
  else if (gpu.texture) disposeTexture(gpu.texture);
}

/**
 * Copy the ranges of `list` into `geometry.groups` (reusing group objects), clipped to
 * `[0, limit)`. Returns the number of groups.
 */
export function writeGroups(geometry: BufferGeometry, list: RangeList, limit: number): number {
  const groups = geometry.groups;
  let n = 0;
  for (let i = 0; i < list.n; i++) {
    const start = list.data[2 * i];
    if (start >= limit) continue;
    const count = Math.min(list.data[2 * i + 1], limit - start);
    if (n < groups.length) { const g = groups[n]; g.start = start; g.count = count; g.materialIndex = 0; }
    else groups.push({ start, count, materialIndex: 0 });
    n++;
  }
  groups.length = n;
  return n;
}

/** Apply the draw ranges of this frame to the tile (terrain + ocean); hides it when empty. */
export function applyDrawRanges(gpu: TileGpu, list: RangeList): void {
  const n = writeGroups(gpu.mesh.geometry, list, Infinity);
  gpu.mesh.visible = n > 0;
  if (gpu.water) gpu.water.visible = writeGroups(gpu.water.geometry, list, gridIndexCount(gpu.quads)) > 0;
}

const _m = new Matrix4();

/**
 * Rotation taking vectors expressed in `from`'s render axes (x E, y U, z S) to `to`'s render
 * axes. Identity when both frames are the same tangent plane.
 */
export function frameRotation(from: LocalFrame, to: LocalFrame, out: Quaternion = new Quaternion()): Quaternion {
  const fe = from.east, fu = from.up, fn = from.north;
  const te = to.east, tu = to.up, tn = to.north;
  const d = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // M[i][j] = toAxis_i · fromAxis_j with axes (east, up, south = −north)
  _m.set(
    d(te, fe), d(te, fu), -d(te, fn), 0,
    d(tu, fe), d(tu, fu), -d(tu, fn), 0,
    -d(tn, fe), -d(tn, fu), d(tn, fn), 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(_m);
}

const _p: Vec3 = [0, 0, 0];

/** Place a tile object built in another frame: position from the float64 ECEF centre, rotation between the frames. */
export function placeTile(obj: Object3D, centerEcef: Vec3, frame: LocalFrame, rotation: Quaternion): void {
  frame.ecefToThree(centerEcef, _p);
  obj.position.set(_p[0], _p[1], _p[2]);
  obj.quaternion.copy(rotation);
  obj.updateMatrix();
}
