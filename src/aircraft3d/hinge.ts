/**
 * Hinge helper: wraps a mesh (built in parent coordinates at zero deflection) in a pivot
 * Group whose local +X axis runs along the hinge line, so `pivot.rotation.x = δ` deflects
 * the surface about the correct axis. Sign: with the hinge axis chosen to have a positive
 * world-X component (or +Y for vertical hinges), a positive rotation about it moves the
 * aft (+Z) part *down* for horizontal hinges (TE down, matching δe > 0 / δa > 0).
 */
import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();

/**
 * Create a pivot Group at `p0` with its local axis (+X for `axis === 'x'`, +Y for 'y')
 * aligned to p1 − p0 (flipped so the axis has a non-negative world component), move the
 * mesh's geometry into the pivot's local frame and add the mesh to the pivot.
 * The caller adds the pivot to the parent that the hinge points were expressed in.
 */
export function attachToHinge(mesh: THREE.Mesh | THREE.Mesh[], p0: THREE.Vector3, p1: THREE.Vector3, axis: 'x' | 'y' = 'x'): THREE.Group {
  tmpDir.subVectors(p1, p0).normalize();
  const comp = axis === 'x' ? tmpDir.x : tmpDir.y;
  if (comp < 0) tmpDir.negate();
  const pivot = new THREE.Group();
  pivot.position.copy(p0);
  pivot.quaternion.setFromUnitVectors(axis === 'x' ? X_AXIS : Y_AXIS, tmpDir);
  pivot.updateMatrix();
  tmpMat.copy(pivot.matrix).invert();
  for (const m of Array.isArray(mesh) ? mesh : [mesh]) {
    m.geometry.applyMatrix4(tmpMat);
    m.geometry.computeVertexNormals();
    pivot.add(m);
  }
  return pivot;
}
