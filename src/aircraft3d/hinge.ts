/**
 * Hinge helper: wraps a mesh (built in parent coordinates at zero deflection) in two groups:
 *
 *  - `mount`: fixed, positioned on the hinge line with its local +X (or +Y for vertical
 *    hinges) aligned to the hinge direction. Add the mount to the parent.
 *  - `pivot`: child of the mount; set `pivot.rotation.x = δ` (or `.y`) to deflect.
 *
 * The split matters: an Object3D's Euler is applied as Rx·Ry·Rz, so writing `rotation.x` on a
 * group whose quaternion also carries the hinge alignment would rotate about the *parent's*
 * X axis, not the swept / dihedral hinge line, and the surface would tear away from the wing.
 *
 * Sign: with the hinge axis chosen to have a positive world-X component (or +Y for vertical
 * hinges), a positive rotation about it moves the aft (+Z) part *down* for horizontal hinges
 * (TE down, matching δe > 0 / δa > 0) and to the *right* (+X) for vertical hinges.
 */
import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();

/** A hinged surface: add `mount` to the parent, deflect with `pivot.rotation`. */
export interface Hinge {
  mount: THREE.Group;
  pivot: THREE.Group;
}

/**
 * Create a hinge at `p0` whose local axis (+X for `axis === 'x'`, +Y for 'y') runs along
 * p1 − p0 (flipped so the axis has a non-negative world component), move the mesh geometry
 * into the hinge's local frame and parent the mesh to the pivot.
 */
export function attachToHinge(mesh: THREE.Mesh | THREE.Mesh[], p0: THREE.Vector3, p1: THREE.Vector3, axis: 'x' | 'y' = 'x'): Hinge {
  tmpDir.subVectors(p1, p0).normalize();
  const comp = axis === 'x' ? tmpDir.x : tmpDir.y;
  if (comp < 0) tmpDir.negate();
  const mount = new THREE.Group();
  mount.position.copy(p0);
  mount.quaternion.setFromUnitVectors(axis === 'x' ? X_AXIS : Y_AXIS, tmpDir);
  mount.updateMatrix();
  tmpMat.copy(mount.matrix).invert();
  const pivot = new THREE.Group();
  mount.add(pivot);
  for (const m of Array.isArray(mesh) ? mesh : [mesh]) {
    m.geometry.applyMatrix4(tmpMat);
    m.geometry.computeVertexNormals();
    pivot.add(m);
  }
  return { mount, pivot };
}
