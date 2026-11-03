/**
 * Empennage: horizontal stabiliser with a one-piece elevator, swept fin with rudder.
 * The fin is built as a "wing" along +X and rotated so its span runs up (+Y).
 */
import * as THREE from 'three';
import type { C172Layout } from './c172Layout';
import { NACA0009, buildWingPanel, mirrorGeometryX, planformPoint } from './airfoil';
import { attachToHinge } from './hinge';
import type { ModelMaterials } from './materials';

export interface TailAssembly {
  group: THREE.Group;
  elevator: THREE.Group;
  rudder: THREE.Group;
}

export function buildTail(layout: C172Layout, mats: ModelMaterials): TailAssembly {
  const group = new THREE.Group();
  group.name = 'tail';

  // --- horizontal stabiliser ---
  const hs = layout.hstab;
  const stabR = buildWingPanel({ airfoil: NACA0009, sections: hs.sections, chordTo: hs.hingeFraction, capRoot: false, capTip: true });
  const stabL = mirrorGeometryX(stabR);
  group.add(new THREE.Mesh(stabR, mats.paintPlain), new THREE.Mesh(stabL, mats.paintPlain));
  const elevR = new THREE.Mesh(buildWingPanel({ airfoil: NACA0009, sections: hs.sections, chordFrom: hs.hingeFraction, capRoot: false, capTip: true }), mats.paintPlain);
  const elevL = new THREE.Mesh(mirrorGeometryX(elevR.geometry), mats.paintPlain);
  elevR.name = 'elevatorRight'; elevL.name = 'elevatorLeft';
  const hMid = planformPoint(hs.sections, hs.halfSpan * 0.5, hs.hingeFraction, new THREE.Vector3());
  const p0 = new THREE.Vector3(-hs.halfSpan, hMid.y, hMid.z);
  const p1 = new THREE.Vector3(hs.halfSpan, hMid.y, hMid.z);
  const elevator = attachToHinge([elevR, elevL], p0, p1, 'x');
  elevator.name = 'elevatorPivot';
  group.add(elevator);

  // --- vertical fin + rudder (built along +X, then rotated up) ---
  const fin = layout.fin;
  const up = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, fin.rootY, 0); // local x → +y
  const finGeo = buildWingPanel({ airfoil: NACA0009, sections: fin.sections, chordTo: fin.hingeFraction, capRoot: false, capTip: true });
  finGeo.applyMatrix4(up); finGeo.computeVertexNormals();
  const finMesh = new THREE.Mesh(finGeo, mats.paintPlain); finMesh.name = 'fin';
  group.add(finMesh);
  // fin-tip cap in trim colour
  const tipSec = fin.sections[fin.sections.length - 1];
  const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mats.trim);
  cap.position.set(0, fin.rootY + tipSec.x + 0.01, tipSec.le.z + tipSec.chord * 0.42);
  cap.scale.set(0.04, 0.05, tipSec.chord * 0.5);
  group.add(cap);

  const rudGeo = buildWingPanel({ airfoil: NACA0009, sections: fin.sections, chordFrom: fin.hingeFraction, capRoot: true, capTip: true });
  rudGeo.applyMatrix4(up); rudGeo.computeVertexNormals();
  const rudMesh = new THREE.Mesh(rudGeo, mats.paintPlain); rudMesh.name = 'rudder';
  const r0 = planformPoint(fin.sections, 0, fin.hingeFraction, new THREE.Vector3());
  const r1 = planformPoint(fin.sections, tipSec.x, fin.hingeFraction, new THREE.Vector3());
  // span coordinate x → world y
  const h0 = new THREE.Vector3(0, fin.rootY + r0.x, r0.z);
  const h1 = new THREE.Vector3(0, fin.rootY + r1.x, r1.z);
  const rudder = attachToHinge(rudMesh, h0, h1, 'y');
  rudder.name = 'rudderPivot';
  group.add(rudder);

  return { group, elevator, rudder };
}
