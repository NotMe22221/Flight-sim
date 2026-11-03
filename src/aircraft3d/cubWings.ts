/**
 * Super Cub wing: constant-chord flat-bottomed panels sitting on the cabin roof (root ribs at
 * ±`rootX`, the skylight between them), rounded tip bows, hinged flaps and ailerons, V lift
 * struts with jury struts, fuel filler caps and the pitot tube under the left wing.
 * The right half is built in wing-local coordinates (span +X) and mirrored for the left.
 */
import * as THREE from 'three';
import type { CubLayout, TubeLayout } from './cubLayout';
import { buildWingPanel, mirrorGeometryX, planformPoint } from './airfoil';
import { attachToHinge } from './hinge';
import type { ModelMaterials } from './materials';
import { cropSections, type WingAssembly } from './wings';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * A tube from a to b: cylinder of radius r (elliptical with `flatten` > 1 along the local z,
 * which stays fore-aft for struts running mostly spanwise / vertically).
 */
export function tubeBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, flatten = 1, segments = 8): THREE.Mesh {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(r, r, len, segments);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).lerp(b, 0.5);
  m.quaternion.setFromUnitVectors(Y_AXIS, b.clone().sub(a).normalize());
  if (flatten !== 1) m.scale.set(1, 1, flatten);
  return m;
}

/**
 * Merge static meshes that share one material into a single mesh (one draw call): each mesh's
 * geometry is baked with its local transform. The source geometries are disposed.
 */
export function mergeStatic(meshes: THREE.Mesh[], mat: THREE.Material, name: string): THREE.Mesh {
  const pos: number[] = [], nor: number[] = [];
  for (const m of meshes) {
    m.updateMatrix();
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
    // applyMatrix4 renormalises the normals with the normal matrix (non-uniform scales included)
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    g.dispose();
    m.geometry.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const out = new THREE.Mesh(geo, mat);
  out.name = name;
  return out;
}

/** mirror a right-side point to the left */
const mx = (p: THREE.Vector3): THREE.Vector3 => p.clone().setX(-p.x);

export function buildCubWings(layout: CubLayout, mats: ModelMaterials): WingAssembly {
  const group = new THREE.Group();
  group.name = 'wings';
  const W = layout.wing;
  const { sections, hingeFraction: hf, flapSpan, aileronSpan, halfSpan, airfoil } = W;
  const add = (geo: THREE.BufferGeometry, name: string, mat: THREE.Material = mats.paintPlain): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    group.add(m);
    return m;
  };

  // --- main panels (chord cropped at the hinge line over the full span; root rib capped) ---
  const mainR = buildWingPanel({ airfoil, sections, chordTo: hf, capRoot: true, capTip: true, points: 16 });
  add(mainR, 'wingRight');
  add(mirrorGeometryX(mainR), 'wingLeft');

  // --- fixed trailing-edge pieces between the moving surfaces (and around the tip bow) ---
  const x0 = sections[0].x;
  const fixedSpans: [number, number][] = [
    [x0, flapSpan[0] - 0.01],
    [flapSpan[1] + 0.01, aileronSpan[0] - 0.01],
    [aileronSpan[1] + 0.01, halfSpan],
  ];
  for (const [a, b] of fixedSpans) {
    if (b - a < 0.02) continue;
    const g = buildWingPanel({ airfoil, sections: cropSections(sections, a, b), chordFrom: hf, capRoot: true, capTip: true });
    add(g, 'wingTE');
    add(mirrorGeometryX(g), 'wingTE');
  }

  // --- hinged surfaces ---
  const hinged = (span: [number, number], name: string): { right: THREE.Group; left: THREE.Group } => {
    const gR = buildWingPanel({ airfoil, sections: cropSections(sections, span[0], span[1]), chordFrom: hf });
    const mR = new THREE.Mesh(gR, mats.paintPlain); mR.name = `${name}Right`;
    const mL = new THREE.Mesh(mirrorGeometryX(gR), mats.paintPlain); mL.name = `${name}Left`;
    const p0 = planformPoint(sections, span[0], hf, new THREE.Vector3());
    const p1 = planformPoint(sections, span[1], hf, new THREE.Vector3());
    const hingeR = attachToHinge(mR, p0, p1, 'x');
    const hingeL = attachToHinge(mL, mx(p0), mx(p1), 'x');
    hingeR.pivot.name = `${name}RightPivot`; hingeL.pivot.name = `${name}LeftPivot`;
    group.add(hingeR.mount, hingeL.mount);
    return { right: hingeR.pivot, left: hingeL.pivot };
  };
  const flaps = hinged(flapSpan, 'flap');
  const ailerons = hinged(aileronSpan, 'aileron');

  // --- V lift struts (streamlined steel tubes) with jury struts; static parts are merged per
  // material (struts in the airframe paint, fittings / caps / pitot in metal) ---
  const S = layout.struts;
  const painted: THREE.Mesh[] = [], metal: THREE.Mesh[] = [];
  const strutsOf = (front: TubeLayout, rear: TubeLayout, side: 1 | -1): void => {
    const f = side > 0 ? front : [mx(front[0]), mx(front[1])];
    const r = side > 0 ? rear : [mx(rear[0]), mx(rear[1])];
    for (const [a, b] of [f, r]) {
      painted.push(tubeBetween(a, b, 0.019, mats.paintPlain, 2.3, 10));
      // fork fitting at the wing end
      metal.push(tubeBetween(b.clone().lerp(a, 0.03), b, 0.012, mats.metal, 1, 6));
    }
    // jury struts: from each lift strut straight up to the spar, plus a diagonal between them
    const jf = f[0].clone().lerp(f[1], S.juryAt), jr = r[0].clone().lerp(r[1], S.juryAt);
    const wingY = (p: THREE.Vector3): number => f[1].y + (Math.abs(p.x) - Math.abs(f[1].x)) * Math.tan(W.dihedralRad);
    const jfTop = new THREE.Vector3(jf.x, wingY(jf), jf.z), jrTop = new THREE.Vector3(jr.x, wingY(jr), jr.z);
    for (const [a, b] of [[jf, jfTop], [jr, jrTop], [jf, jrTop]] as const) painted.push(tubeBetween(a, b, 0.009, mats.paintPlain, 1.6, 6));
  };
  strutsOf(S.front, S.rear, 1);
  strutsOf(S.front, S.rear, -1);

  // --- fuel filler caps on the upper surface over the wing-root tanks ---
  for (const side of [1, -1]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.038, 0.016, 14), mats.metal);
    c.position.set(side * layout.details.fuelCap.x, layout.details.fuelCap.y + 0.004, layout.details.fuelCap.z);
    metal.push(c);
  }

  // --- pitot tube under the left wing: a mast down from the lower surface, a tube forward ---
  const P = layout.details.pitot;
  const tubeEnd = P.tip.clone().setZ(P.tip.z + P.length);
  metal.push(tubeBetween(P.tip, tubeEnd, 0.007, mats.metal, 1, 8));
  const mastTop = tubeEnd.clone(); mastTop.y += 0.1; mastTop.z -= 0.08;
  metal.push(tubeBetween(tubeEnd.clone().setZ(tubeEnd.z - 0.12), mastTop, 0.012, mats.metal, 2, 8));
  group.add(mergeStatic(painted, mats.paintPlain, 'struts'), mergeStatic(metal, mats.metal, 'wingFittings'));

  return { group, aileronLeft: ailerons.left, aileronRight: ailerons.right, flapLeft: flaps.left, flapRight: flaps.right };
}
