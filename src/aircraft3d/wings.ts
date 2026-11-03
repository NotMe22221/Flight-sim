/**
 * High wing with 1.7° dihedral, lift struts, wing-tip fairings, and hinged flaps/ailerons.
 * The right half is built in wing-local coordinates (span +X) and mirrored for the left.
 */
import * as THREE from 'three';
import type { C172Layout } from './c172Layout';
import { NACA2412, buildWingPanel, mirrorGeometryX, planformPoint, type WingSection } from './airfoil';
import { attachToHinge } from './hinge';
import type { ModelMaterials } from './materials';

export interface WingAssembly {
  group: THREE.Group;
  aileronLeft: THREE.Group;
  aileronRight: THREE.Group;
  flapLeft: THREE.Group;
  flapRight: THREE.Group;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** sections of the planform cropped to [x0, x1] (interpolating chord/LE at the ends) */
export function cropSections(sections: WingSection[], x0: number, x1: number): WingSection[] {
  const out: WingSection[] = [];
  const at = (x: number): WingSection => {
    const p = planformPoint(sections, x, 0, tmpA);
    const q = planformPoint(sections, x, 1, tmpB);
    return { x, chord: q.z - p.z, le: { x: 0, y: p.y, z: p.z } };
  };
  out.push(at(x0));
  for (const s of sections) if (s.x > x0 + 1e-6 && s.x < x1 - 1e-6) out.push({ x: s.x, chord: s.chord, le: { ...s.le } });
  out.push(at(x1));
  return out;
}

export function buildWings(layout: C172Layout, mats: ModelMaterials): WingAssembly {
  const group = new THREE.Group();
  group.name = 'wings';
  const { sections, hingeFraction: hf, flapSpan, aileronSpan, halfSpan } = layout.wing;

  // --- main panel (chord cropped at the hinge line over the full span) ---
  const mainR = buildWingPanel({ airfoil: NACA2412, sections, chordTo: hf, capRoot: true, capTip: true, spanSubdivisions: 2 });
  const mainL = mirrorGeometryX(mainR);
  const meshR = new THREE.Mesh(mainR, mats.paintPlain); meshR.name = 'wingRight';
  const meshL = new THREE.Mesh(mainL, mats.paintPlain); meshL.name = 'wingLeft';
  group.add(meshR, meshL);

  // --- fixed trailing-edge pieces between the moving surfaces ---
  const fixedSpans: [number, number][] = [
    [0, flapSpan[0] - 0.01],
    [flapSpan[1] + 0.01, aileronSpan[0] - 0.01],
    [aileronSpan[1] + 0.01, halfSpan],
  ];
  for (const [x0, x1] of fixedSpans) {
    if (x1 - x0 < 0.02) continue;
    const g = buildWingPanel({ airfoil: NACA2412, sections: cropSections(sections, x0, x1), chordFrom: hf, capRoot: x0 > 0.01, capTip: true });
    group.add(new THREE.Mesh(g, mats.paintPlain), new THREE.Mesh(mirrorGeometryX(g), mats.paintPlain));
  }

  // --- hinged surfaces ---
  const hinged = (span: [number, number], name: string): { right: THREE.Group; left: THREE.Group } => {
    const gR = buildWingPanel({ airfoil: NACA2412, sections: cropSections(sections, span[0], span[1]), chordFrom: hf });
    const gL = mirrorGeometryX(gR);
    const mR = new THREE.Mesh(gR, mats.paintPlain); mR.name = `${name}Right`;
    const mL = new THREE.Mesh(gL, mats.paintPlain); mL.name = `${name}Left`;
    const p0 = planformPoint(sections, span[0], hf, new THREE.Vector3());
    const p1 = planformPoint(sections, span[1], hf, new THREE.Vector3());
    const hingeR = attachToHinge(mR, p0, p1, 'x');
    const p0L = p0.clone().setX(-p0.x), p1L = p1.clone().setX(-p1.x);
    const hingeL = attachToHinge(mL, p0L, p1L, 'x');
    const right = hingeR.pivot, left = hingeL.pivot;
    right.name = `${name}RightPivot`; left.name = `${name}LeftPivot`;
    group.add(hingeR.mount, hingeL.mount);
    return { right, left };
  };
  const flaps = hinged(flapSpan, 'flap');
  const ailerons = hinged(aileronSpan, 'aileron');

  // --- wing-tip fairings (white, slightly drooped like the 172's conical-camber tips) ---
  const tipChord = sections[sections.length - 1].chord;
  for (const side of [1, -1]) {
    const tip = planformPoint(sections, halfSpan, 0.45, new THREE.Vector3());
    const fairing = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), mats.paintPlain);
    fairing.position.set(side * (halfSpan - 0.005), tip.y - 0.005, tip.z);
    fairing.scale.set(0.06, 0.07, tipChord * 0.5);
    fairing.name = 'tipFairing';
    group.add(fairing);
  }

  // --- lift struts ---
  for (const side of [1, -1]) {
    const a = layout.strut.fuselage.clone().setX(side * layout.strut.fuselage.x);
    const b = layout.strut.wing.clone().setX(side * layout.strut.wing.x);
    const len = a.distanceTo(b);
    const geo = new THREE.CylinderGeometry(0.028, 0.028, len, 10);
    const strut = new THREE.Mesh(geo, mats.paintPlain);
    strut.position.copy(a).lerp(b, 0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    strut.scale.set(1, 1, 2.2); // streamlined section, long axis fore-aft
    strut.name = 'strut';
    group.add(strut);
  }

  return { group, aileronLeft: ailerons.left, aileronRight: ailerons.right, flapLeft: flaps.left, flapRight: flaps.right };
}
