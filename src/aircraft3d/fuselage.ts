/**
 * Fuselage: cowl loft (always visible, also from the cockpit), cabin + tailcone loft and
 * the exterior window glass (hidden together when the camera is in the cockpit, since the
 * interior shell replaces them).
 */
import * as THREE from 'three';
import type { C172Layout } from './c172Layout';
import { LoftProfile, buildLoft, buildLoftPatch } from './loft';
import type { ModelMaterials } from './materials';

export interface FuselageAssembly {
  group: THREE.Group;
  cowl: THREE.Mesh;
  /** cabin skin + exterior windows: hidden in cockpit view */
  cabinShell: THREE.Group;
  cabinProfile: LoftProfile;
  windows: THREE.Mesh[];
}

export function buildFuselage(layout: C172Layout, mats: ModelMaterials): FuselageAssembly {
  const group = new THREE.Group();
  group.name = 'fuselage';
  const uRange: [number, number] = [layout.zNose, layout.zTail];

  const cowlProfile = new LoftProfile(layout.cowlStations);
  const cowl = new THREE.Mesh(buildLoft(cowlProfile, { radialSegments: 32, lengthSubdivisions: 3, capFront: true, capBack: false, uRange }), mats.paint);
  cowl.name = 'cowl';
  group.add(cowl);

  const cabinProfile = new LoftProfile(layout.cabinStations);
  const cabinShell = new THREE.Group();
  cabinShell.name = 'cabinShell';
  const cabin = new THREE.Mesh(buildLoft(cabinProfile, { radialSegments: 36, lengthSubdivisions: 3, capFront: false, capBack: true, uRange }), mats.paint);
  cabin.name = 'cabin';
  cabinShell.add(cabin);

  const windows: THREE.Mesh[] = [];
  for (const w of layout.windows) {
    const m = new THREE.Mesh(buildLoftPatch(cabinProfile, { z0: w.z0, z1: w.z1, t0: w.t0, t1: w.t1, offset: 0.012 }), mats.glass);
    m.name = `window:${w.name}`;
    m.castShadow = false;
    m.renderOrder = 2;
    windows.push(m);
    cabinShell.add(m);
  }
  // door outline: thin dark strips around the pilot/copilot doors (cheap decal patches)
  for (const side of [1, -1]) {
    const tMid = side > 0 ? Math.PI / 2 : 1.5 * Math.PI;
    const lo = tMid - 0.75, hi = tMid + 0.03;
    const frame = (z0: number, z1: number, t0: number, t1: number) => {
      const g = buildLoftPatch(cabinProfile, { z0, z1, t0, t1, offset: 0.006, nz: 2, nt: 2 });
      const mm = new THREE.Mesh(g, mats.interiorDark);
      mm.castShadow = false;
      cabinShell.add(mm);
    };
    const t0 = Math.min(lo, hi), t1 = Math.max(lo, hi);
    frame(-0.5, -0.47, t0, t1);
    frame(0.47, 0.5, t0, t1);
  }
  group.add(cabinShell);
  return { group, cowl, cabinShell, cabinProfile, windows };
}
