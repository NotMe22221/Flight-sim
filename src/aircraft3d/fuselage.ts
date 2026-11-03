/**
 * Fuselage: one loft profile split into three regions so everything shades seamlessly:
 *  - cowl (spinner ring → windshield base): always visible, also over the glareshield;
 *  - cabin shell (windshield base → behind the rear window): skin with exact window
 *    cut-outs, glass, rubber gaskets, door seams and a dark inner face (seen through the
 *    windows from outside). Hidden in the cockpit view, where the cockpit lining replaces it;
 *  - tailcone (→ tail): always visible, so the empennage stays attached when looking back.
 */
import * as THREE from 'three';
import type { FuselageLayout } from './layoutTypes';
import { LoftProfile, type LoftStation } from './loft';
import type { ModelMaterials } from './materials';
import { band, buildSkin, innerBand, inside, outlineField, outside, type SkinOutline } from './skin';

export interface FuselageAssembly {
  group: THREE.Group;
  cowl: THREE.Mesh;
  /** cabin skin + exterior glass: hidden in cockpit view */
  cabinShell: THREE.Group;
  /** the fuselage profile (the cockpit lining follows it) */
  cabinProfile: LoftProfile;
  windows: THREE.Mesh[];
}

/** Flat fan closing the loft at z; faces −Z (front) or +Z (back). */
export function buildLoftCap(profile: LoftProfile, z: number, facing: 1 | -1, radial = 48, maxY = Infinity): THREE.BufferGeometry {
  const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
  profile.sectionAt(z, sec);
  const p = new THREE.Vector3();
  const cy = Math.min(sec.yCenter, maxY - 0.05);
  const pos: number[] = [0, cy, z];
  for (let j = 0; j <= radial; j++) {
    profile.pointAt(z, (2 * Math.PI * j) / radial, p, sec);
    pos.push(p.x, Math.min(p.y, maxY), z);
  }
  const idx: number[] = [];
  // ring order (bottom → right → top → left) is counter-clockwise seen from behind (+Z)
  for (let j = 1; j <= radial; j++) { if (facing > 0) idx.push(0, j, j + 1); else idx.push(0, j + 1, j); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** z extent of an outline, padded and clamped to [lo, hi]. */
function zRange(o: SkinOutline, lo: number, hi: number): [number, number] {
  const zs = o.outline.map((q) => q[0]);
  return [Math.max(lo, Math.min(...zs) - 0.02), Math.min(hi, Math.max(...zs) + 0.02)];
}

export function buildFuselage(layout: FuselageLayout, mats: ModelMaterials): FuselageAssembly {
  const group = new THREE.Group();
  group.name = 'fuselage';
  const F = layout.fuselage;
  const profile = new LoftProfile(F.stations);
  const uRange: [number, number] = [layout.zNose, layout.zTail];
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    parent.add(m);
    return m;
  };

  // --- cowl (always visible): a finely sampled nose bowl (its radius doubles in 8 cm), then the
  // rest; both share the boundary row, so they join seamlessly ---
  const noseEnd = Math.min(profile.zMin + 0.36, F.cowlEndZ - 0.1);
  mesh(buildSkin(profile, { z0: profile.zMin, z1: noseEnd, dz: 0.012, radial: 96, uRange }).geometry, mats.paint, 'noseBowl', group);
  const cowl = mesh(buildSkin(profile, { z0: noseEnd, z1: F.cowlEndZ, dz: 0.05, radial: 96, uRange }).geometry, mats.paint, 'cowl', group);
  mesh(buildLoftCap(profile, profile.zMin, -1, 32), mats.interiorDark, 'cowlFront', group);
  // cooling-air inlets either side of the spinner (dark openings on the nose bowl's front face)
  const D = layout.details, inlet = D.noseInlets;
  const inletField = (x: number, y: number): number => Math.hypot(Math.abs(x) - inlet.x, (y - inlet.y) / inlet.squash) - inlet.r;
  mesh(buildSkin(profile, { z0: profile.zMin, z1: noseEnd, dz: 0.006, radial: 192, offset: 0.004, keep: [(x, y) => -inletField(x, y)] }).geometry, mats.gasket, 'noseInlets', group);
  // exhaust stack under the cowl (right side) and the COM whip antenna on the tailcone top
  const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
  const stick = (name: string, mat: THREE.Material, base: THREE.Vector3, dir: THREE.Vector3, length: number, rBase: number, rTip: number): void => {
    const geo = new THREE.CylinderGeometry(rTip, rBase, length, 8);
    geo.translate(0, length / 2, 0); // base at the origin, along +Y
    const m = mesh(geo, mat, name, group);
    m.position.copy(base);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  };
  profile.sectionAt(D.exhaust.z, sec);
  stick('exhaust', mats.metal, new THREE.Vector3(D.exhaust.x, sec.yCenter - sec.height / 2 + 0.04, D.exhaust.z), D.exhaust.dir, D.exhaust.length, D.exhaust.radius, D.exhaust.radius);
  profile.sectionAt(D.antenna.z, sec);
  stick('antenna', mats.blade, new THREE.Vector3(0, sec.yCenter + sec.height / 2 - 0.01, D.antenna.z), D.antenna.dir, D.antenna.length, D.antenna.radius, D.antenna.radius * 0.45);

  // --- tailcone (always visible) ---
  mesh(buildSkin(profile, { z0: F.cabinEndZ, z1: profile.zMax, dz: 0.08, radial: 48, uRange }).geometry, mats.paint, 'tailcone', group);
  mesh(buildLoftCap(profile, profile.zMax, 1, 24), mats.paint, 'tailCap', group);

  // --- cabin shell (hidden in the cockpit view) ---
  const cabinShell = new THREE.Group();
  cabinShell.name = 'cabinShell';
  const winFields = layout.windows.map(outlineField);
  const skin = buildSkin(profile, { z0: F.cowlEndZ, z1: F.cabinEndZ, dz: 0.04, radial: 72, uRange, keep: winFields.map(outside) }).geometry;
  mesh(skin, mats.paint, 'cabin', cabinShell);
  // the same skin seen from inside: dark, so windows read as tinted glass over a dark cabin
  const inner = mesh(skin, mats.cabinInner, 'cabinInner', cabinShell);
  inner.castShadow = false;

  const windows: THREE.Mesh[] = [];
  layout.windows.forEach((w, i) => {
    const [z0, z1] = zRange(w, F.cowlEndZ, F.cabinEndZ);
    const glass = mesh(buildSkin(profile, { z0, z1, dz: 0.04, radial: 72, offset: 0.002, keep: [inside(winFields[i])] }).geometry, mats.glass, `window:${w.name}`, cabinShell);
    glass.renderOrder = 2;
    windows.push(glass);
    // rubber gasket just inside the opening
    mesh(buildSkin(profile, { z0, z1, dz: 0.04, radial: 72, offset: 0.004, keep: innerBand(winFields[i], 0.014) }).geometry, mats.gasket, `gasket:${w.name}`, cabinShell);
  });
  // door seams
  for (const d of layout.doors) {
    const [z0, z1] = zRange(d, F.cowlEndZ, F.cabinEndZ);
    mesh(buildSkin(profile, { z0, z1, dz: 0.03, radial: 96, offset: 0.003, keep: band(outlineField(d), 0.005) }).geometry, mats.gasket, d.name, cabinShell);
  }
  group.add(cabinShell);
  return { group, cowl, cabinShell, cabinProfile: profile, windows };
}
