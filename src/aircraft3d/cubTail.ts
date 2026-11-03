/**
 * Super Cub empennage: a wire-braced stabiliser on the tail post with rounded tips, a
 * one-piece elevator (inboard corners cut away for the rudder), a small fin and the tall,
 * rounded rudder hinged on the tail post. Fin and rudder are built as "wings" along +X and
 * rotated so their span runs up (+Y).
 */
import * as THREE from 'three';
import type { CubLayout } from './cubLayout';
import { buildWingPanel, mirrorGeometryX, type AirfoilSpec, type WingSection } from './airfoil';
import { attachToHinge } from './hinge';
import type { ModelMaterials } from './materials';
import type { TailAssembly } from './tail';
import { tubeBetween } from './cubWings';

/** thin symmetric sections: tube-and-fabric tail surfaces are only ≈ 3–4 cm thick */
const FIN_FOIL: AirfoilSpec = { thickness: 0.055, camber: 0, camberPos: 0.4 };
const STAB_FOIL: AirfoilSpec = { thickness: 0.06, camber: 0, camberPos: 0.4 };
/** the rudder is the aft 70 % of a symmetric section: thickest at the hinge (tail post) */
const RUDDER_FROM = 0.3;

/**
 * Sections whose aft part [from, 1] is the given surface (LE at the hinge `le.z`, `chord`):
 * a virtual full chord chord/(1 − from) starting `from` of it ahead of the hinge.
 */
function aftPart(sections: WingSection[], from: number): WingSection[] {
  return sections.map((s) => {
    const c = s.chord / (1 - from);
    return { x: s.x, chord: c, le: { x: 0, y: s.le.y, z: s.le.z - from * c } };
  });
}

export function buildCubTail(layout: CubLayout, mats: ModelMaterials): TailAssembly {
  const group = new THREE.Group();
  group.name = 'tail';
  const H = layout.hstab;

  // --- stabiliser: one planform with the elevator, so both halves meet flush at the hinge ---
  // stab + elevator share the hinge fraction of the combined chord everywhere outboard of the
  // elevator's root cut-out; the stab is the front part, the elevator the aft part.
  const combined: WingSection[] = H.stab.map((s, i) => ({ x: s.x, chord: s.chord + H.elevator[Math.min(i + 1, H.elevator.length - 1)].chord, le: { ...s.le } }));
  const hfStab = H.stab[0].chord / combined[0].chord;
  const stabR = buildWingPanel({ airfoil: STAB_FOIL, sections: combined, chordTo: hfStab, capRoot: false, capTip: true, points: 10 });
  const stabMeshR = new THREE.Mesh(stabR, mats.paintPlain); stabMeshR.name = 'stabRight';
  const stabMeshL = new THREE.Mesh(mirrorGeometryX(stabR), mats.paintPlain); stabMeshL.name = 'stabLeft';
  group.add(stabMeshR, stabMeshL);

  // elevator: the aft part of the same section; the root (cut-out) sections get a virtual chord
  const elevSections = aftPart(H.elevator, hfStab);
  const elevR = new THREE.Mesh(buildWingPanel({ airfoil: STAB_FOIL, sections: elevSections, chordFrom: hfStab, capRoot: true, capTip: true, points: 10 }), mats.paintPlain);
  const elevL = new THREE.Mesh(mirrorGeometryX(elevR.geometry), mats.paintPlain);
  elevR.name = 'elevatorRight'; elevL.name = 'elevatorLeft';
  const y0 = H.stab[0].le.y;
  const elevatorHinge = attachToHinge([elevR, elevL], new THREE.Vector3(-H.halfSpan, y0, H.hingeZ), new THREE.Vector3(H.halfSpan, y0, H.hingeZ), 'x');
  const elevator = elevatorHinge.pivot;
  elevator.name = 'elevatorPivot';
  group.add(elevatorHinge.mount);

  // --- fin (fixed), from inside the turtle deck up to the rounded top ---
  const fin = layout.fin;
  const upAt = (y: number) => new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, y, 0); // local x → +y
  const finGeo = buildWingPanel({ airfoil: FIN_FOIL, sections: fin.sections, capRoot: false, capTip: true, points: 10 });
  finGeo.applyMatrix4(upAt(fin.rootY)); finGeo.computeVertexNormals();
  const finMesh = new THREE.Mesh(finGeo, mats.paintPlain); finMesh.name = 'fin';
  group.add(finMesh);

  // --- rudder on the tail post ---
  const R = layout.rudder;
  const rudGeo = buildWingPanel({ airfoil: FIN_FOIL, sections: aftPart(R.sections, RUDDER_FROM), chordFrom: RUDDER_FROM, capRoot: true, capTip: true, points: 10 });
  rudGeo.applyMatrix4(upAt(R.bottomY)); rudGeo.computeVertexNormals();
  const rudMesh = new THREE.Mesh(rudGeo, mats.paintPlain); rudMesh.name = 'rudder';
  const top = R.bottomY + R.sections[R.sections.length - 1].x;
  const rudderHinge = attachToHinge(rudMesh, new THREE.Vector3(0, R.bottomY, R.hingeZ), new THREE.Vector3(0, top, R.hingeZ), 'y');
  const rudder = rudderHinge.pivot;
  rudder.name = 'rudderPivot';
  group.add(rudderHinge.mount);

  // --- flying wires (streamlined wires, both sides) and the tail post ---
  for (const [a, b] of layout.wires) {
    for (const s of [1, -1]) {
      const w = tubeBetween(new THREE.Vector3(a.x * s, a.y, a.z), new THREE.Vector3(b.x * s, b.y, b.z), 0.0045, mats.metal, 1, 5);
      w.name = 'flyingWire';
      group.add(w);
    }
  }
  const post = tubeBetween(new THREE.Vector3(0, R.bottomY - 0.01, R.hingeZ - 0.012), new THREE.Vector3(0, fin.rootY + 0.05, R.hingeZ - 0.012), 0.016, mats.paintPlain, 1, 8);
  post.name = 'tailPost';
  group.add(post);

  return { group, elevator, rudder };
}
