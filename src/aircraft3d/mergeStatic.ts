/**
 * Distant level of detail for a model: the visible meshes under `root`, baked in their current
 * pose (relative to `root`) and merged into one mesh per material (and attribute layout). An AI
 * aircraft's exterior is ~70 meshes (70 draw calls, plus shadow passes); merged it is one per
 * material, ~15. Animated parts (propeller, control surfaces, gear) stay where they were when
 * baked, which nobody can see from a few hundred metres away.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface MergedLod {
  group: THREE.Group;
  /** the source meshes that the merged ones replace (hide these while the LOD is shown) */
  sources: THREE.Mesh[];
  dispose(): void;
}

const visibleUnder = (o: THREE.Object3D, root: THREE.Object3D): boolean => {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return root.visible;
};

export function mergeStatic(root: THREE.Object3D): MergedLod {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean; order: number }>();
  const sources: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (Array.isArray(m.material) || !visibleUnder(m, root)) return;
    const mat = m.material as THREE.Material;
    // transparent pieces keep their own draw order: leave them as they are
    if (mat.transparent) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    rel.multiplyMatrices(inv, m.matrixWorld);
    g.applyMatrix4(rel);
    // attribute layout must match within a bucket; morph targets and groups are dropped
    g.morphAttributes = {};
    g.clearGroups();
    const names = Object.keys(g.attributes).sort();
    // keep only position/normal/uv/color: other attributes (e.g. tangents) vary between pieces
    for (const n of names) if (!['position', 'normal', 'uv', 'color'].includes(n)) g.deleteAttribute(n);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    // shadow flags and draw order are per mesh: they go into the key too
    const key = `${mat.uuid}|${Object.keys(g.attributes).sort().join(',')}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}`;
    let b = buckets.get(key);
    if (!b) { b = { material: mat, geos: [], cast: m.castShadow, receive: m.receiveShadow, order: m.renderOrder }; buckets.set(key, b); }
    b.geos.push(g);
    sources.push(m);
    g = null as unknown as THREE.BufferGeometry;
  });
  const group = new THREE.Group();
  group.name = 'lod-merged';
  const merged: THREE.BufferGeometry[] = [];
  for (const b of buckets.values()) {
    const geo = mergeGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!geo) continue;
    merged.push(geo);
    const mesh = new THREE.Mesh(geo, b.material);
    mesh.name = `lod:${b.material.name || b.material.type}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = b.cast; mesh.receiveShadow = b.receive; mesh.renderOrder = b.order;
    group.add(mesh);
  }
  return {
    group,
    sources,
    dispose() { for (const g of merged) g.dispose(); group.removeFromParent(); },
  };
}
