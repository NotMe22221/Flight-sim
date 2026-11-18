import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AircraftModel } from './AircraftModel';
import { mergeStatic } from './mergeStatic';

const meshes = (o: THREE.Object3D) => { const out: THREE.Mesh[] = []; o.traverse((x) => { if ((x as THREE.Mesh).isMesh) out.push(x as THREE.Mesh); }); return out; };

describe('mergeStatic', () => {
  it('merges an aircraft exterior into one mesh per material, same shape and size', () => {
    const model = new AircraftModel(undefined, { shadows: false });
    model.setVisibility(true, false);
    const lod = mergeStatic(model.root);
    const merged = meshes(lod.group);
    expect(lod.sources.length).toBeGreaterThan(30);
    expect(merged.length).toBeLessThan(lod.sources.length / 2.5);
    // bounding box of the merged meshes matches the opaque source meshes'
    const a = new THREE.Box3(), b = new THREE.Box3();
    for (const m of lod.sources) a.expandByObject(m, true);
    model.root.add(lod.group);
    model.root.updateMatrixWorld(true);
    for (const m of merged) b.expandByObject(m, true);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(b.min[k]).toBeCloseTo(a.min[k], 3);
      expect(b.max[k]).toBeCloseTo(a.max[k], 3);
    }
    lod.dispose();
    model.dispose();
  });

  it('skips hidden and transparent meshes', () => {
    const root = new THREE.Group();
    const opaque = new THREE.MeshStandardMaterial(), glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), opaque); a.position.x = 2;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), opaque); b.position.x = -2;
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), opaque); hidden.visible = false;
    const window_ = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glass);
    root.add(a, b, hidden, window_);
    const lod = mergeStatic(root);
    expect(lod.sources).toEqual([a, b]);
    expect(meshes(lod.group).length).toBe(1);
    const box = new THREE.Box3().setFromObject(lod.group);
    expect(box.min.x).toBeCloseTo(-2.5); expect(box.max.x).toBeCloseTo(2.5);
  });
});
