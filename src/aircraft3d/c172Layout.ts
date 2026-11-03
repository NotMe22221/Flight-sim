/**
 * Cessna 172 dimensions and the placement of every sub-assembly, in model-local metres
 * (nose −Z, up +Y, right wing +X, origin at the empty CG). Numbers come from
 * docs/research/02-flight-dynamics-model.md §2.1/§5.1/§6 and the 172S POH:
 * span 11.0 m, length 8.28 m, height 2.72 m, S 16.2 m², MAC 1.49 m, prop 1.93 m.
 *
 * What is taken from the AircraftConfig (so the FDM and the model agree): eye point, prop
 * hub position/diameter/blade count/sense, gear contact points, tyre radii, steering range,
 * span. The fuselage shape itself is fixed C172 geometry.
 */
import * as THREE from 'three';
import type { AircraftConfig, GearSpec, PropellerSpec, Vec3 } from '../core/types';
import { bodyVecToThreeLocal } from './frames';
import type { LoftStation } from './loft';
import type { WingSection } from './airfoil';

/** The subset of {@link AircraftConfig} the 3D model needs. A full AircraftConfig is accepted too. */
export interface AircraftModelConfig {
  geometry: AircraftConfig['geometry'];
  propeller?: PropellerSpec;
  gear: GearSpec[];
}

const D2R = Math.PI / 180;

/** Stand-alone C172 model config (also the unit-test fixture). Body frame FRD, metres. */
export function c172ModelConfig(): AircraftModelConfig {
  const gear = (name: string, pos: Vec3, tyreRadius: number, maxSteerDeg: number, brakeGroup: GearSpec['brakeGroup']): GearSpec => ({
    name, pos, type: 'wheel', k: 78_800, cComp: 23_400, cRebound: 46_800, tyreRadius,
    muStatic: 0.8, muDynamic: 0.5, muRolling: 0.02, pacejka: { B: 10, C: 1.9, E: 0.97 },
    maxSteerDeg, casters: false, brakeGroup, retractable: false,
  });
  return {
    geometry: {
      S: 16.2, b: 11.0, cbar: 1.49, arpOffset: [-0.05, 0, -0.9], macHeightOnGround: 2.1,
      lengthM: 8.28, heightM: 2.72, eyePoint: [0.4, -0.25, -0.55],
    },
    propeller: {
      diameterM: 1.93, blades: 2, inertia: 1.7,
      Ct: { xs: [0, 0.5, 1], ys: [0.1, 0.06, 0] }, Cp: { xs: [0, 0.5, 1], ys: [0.05, 0.04, 0.01] },
      sense: 1, pFactorM: 0.05, position: [1.98, 0, -0.05], fixedPitch: true,
    },
    gear: [
      gear('nose', [1.7, 0, 1.2], 0.18, 10, 'none'),
      gear('left main', [-0.44, -1.27, 1.2], 0.22, 0, 'left'),
      gear('right main', [-0.44, 1.27, 1.2], 0.22, 0, 'right'),
    ],
  };
}

/** Narrow a full AircraftConfig (or pass a model config through). */
export function toModelConfig(config: AircraftConfig | AircraftModelConfig): AircraftModelConfig {
  if ('propulsion' in config) return { geometry: config.geometry, propeller: config.propulsion.propeller, gear: config.gear };
  return config;
}

export interface GearLayout {
  /** index into AircraftState.gear / config.gear */
  index: number;
  name: string;
  /** strut attachment on the airframe (model local) */
  attach: THREE.Vector3;
  /** unloaded tyre contact point (model local) */
  contact: THREE.Vector3;
  tyreRadius: number;
  maxSteerRad: number;
  /** wheel width */
  width: number;
}

export interface C172Layout {
  /** total length range used for livery u mapping */
  zNose: number; zTail: number;
  cowlStations: LoftStation[];
  cabinStations: LoftStation[];
  /** window patches on the cabin loft: [z0, z1, t0, t1] */
  windows: { name: string; z0: number; z1: number; t0: number; t1: number }[];
  /** lining patches of the cockpit shell (opaque): [z0, z1, t0, t1] */
  lining: { z0: number; z1: number; t0: number; t1: number }[];
  wing: {
    /** right-wing sections (mirror for the left) */
    sections: WingSection[];
    hingeFraction: number;
    flapSpan: [number, number];
    aileronSpan: [number, number];
    dihedralRad: number;
    halfSpan: number;
  };
  strut: { fuselage: THREE.Vector3; wing: THREE.Vector3 };
  hstab: { sections: WingSection[]; hingeFraction: number; halfSpan: number };
  fin: { sections: WingSection[]; hingeFraction: number; rootY: number; span: number };
  prop: { hub: THREE.Vector3; diameter: number; blades: number; sense: 1 | -1 };
  gear: { nose: GearLayout | null; mains: GearLayout[] };
  eye: THREE.Vector3;
  panel: { center: THREE.Vector3; width: number; height: number; tiltRad: number; g1000Height: number };
  glareshield: { center: THREE.Vector3; width: number; depth: number };
  lights: {
    navLeft: THREE.Vector3; navRight: THREE.Vector3; navTail: THREE.Vector3; beacon: THREE.Vector3;
    strobeLeft: THREE.Vector3; strobeRight: THREE.Vector3;
    landing: THREE.Vector3; taxi: THREE.Vector3;
  };
  /** CG height above ground with unloaded gear, m */
  cgAglM: number;
}

/**
 * Resolve the full placement from a config. Pure (no Three.js scene objects), so it is
 * unit-testable; Vector3 is used only as a value type.
 */
export function resolveC172Layout(cfg: AircraftModelConfig): C172Layout {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const halfSpan = cfg.geometry.b / 2;
  const dihedralRad = 1.7 * D2R;
  const dz = Math.tan(dihedralRad);
  const rootY = 1.0, leZ = -0.33, rootChord = 1.63, tipChord = 1.13;
  const breakX = Math.min(3.0, halfSpan * 0.55);
  const wingSections: WingSection[] = [
    { x: 0.0, chord: rootChord, le: { x: 0, y: rootY, z: leZ } },
    { x: breakX, chord: rootChord, le: { x: 0, y: rootY + breakX * dz, z: leZ } },
    { x: halfSpan, chord: tipChord, le: { x: 0, y: rootY + halfSpan * dz, z: leZ } },
  ];

  const cgAglM = Math.max(0.9, ...cfg.gear.map((g) => g.pos[2]));

  const gearLayouts: GearLayout[] = cfg.gear
    .map((g, index): GearLayout | null => {
      if (g.type !== 'wheel') return null;
      const contact = bodyVecToThreeLocal(g.pos, new THREE.Vector3());
      const isNose = g.pos[0] > 0.5 || /nose/i.test(g.name);
      const attach = isNose
        ? v(contact.x, -0.42, contact.z + 0.05)
        : v(Math.sign(contact.x) * 0.42, -0.5, contact.z - 0.05);
      return { index, name: g.name, attach, contact, tyreRadius: g.tyreRadius, maxSteerRad: g.maxSteerDeg * D2R, width: isNose ? 0.11 : 0.14 };
    })
    .filter((g): g is GearLayout => g !== null);
  const nose = gearLayouts.find((g) => g.contact.z < 0) ?? null;
  const mains = gearLayouts.filter((g) => g !== nose);

  const propSpec = cfg.propeller;
  const hub = propSpec ? bodyVecToThreeLocal(propSpec.position, new THREE.Vector3()) : v(0, 0.05, -1.98);
  const diameter = propSpec?.diameterM ?? 1.93;

  const eye = bodyVecToThreeLocal(cfg.geometry.eyePoint, new THREE.Vector3());
  const panelCenter = v(0, eye.y - 0.35, eye.z - 0.65);

  const cowlStations: LoftStation[] = [
    { z: hub.z - 0.1, width: 0.42, height: 0.42, yCenter: hub.y, n: 2 },
    { z: hub.z + 0.03, width: 0.74, height: 0.62, yCenter: hub.y - 0.02, n: 2.4 },
    { z: hub.z + 0.48, width: 0.92, height: 0.8, yCenter: 0.04, n: 2.6 },
    { z: -1.05, width: 1.06, height: 1.02, yCenter: 0.04, n: 2.8 },
    { z: -0.95, width: 1.1, height: 1.1, yCenter: 0.0, n: 3.0 },
  ];
  const cabinStations: LoftStation[] = [
    { z: -0.95, width: 1.1, height: 1.1, yCenter: 0.0, n: 3.0 },
    { z: -0.35, width: 1.1, height: 1.5, yCenter: 0.2, n: 3.2 },
    { z: 0.5, width: 1.1, height: 1.5, yCenter: 0.2, n: 3.2 },
    { z: 1.1, width: 1.05, height: 1.48, yCenter: 0.2, n: 3.0 },
    { z: 1.7, width: 0.85, height: 1.15, yCenter: 0.28, n: 2.6 },
    { z: 2.6, width: 0.6, height: 0.8, yCenter: 0.33, n: 2.3 },
    { z: 3.6, width: 0.42, height: 0.56, yCenter: 0.4, n: 2.2 },
    { z: 4.6, width: 0.3, height: 0.42, yCenter: 0.47, n: 2.1 },
    { z: 5.4, width: 0.2, height: 0.34, yCenter: 0.53, n: 2.0 },
    { z: 5.95, width: 0.12, height: 0.28, yCenter: 0.58, n: 2.0 },
  ];

  const T_RIGHT = Math.PI / 2, T_TOP = Math.PI, T_LEFT = 1.5 * Math.PI;
  const SIDE_UP = 0.92; // from the sill (side mid) up to the roof shoulder
  const TOP_HALF = 0.8; // half-width of the top band (windscreen / roof / rear window)
  const windows = [
    { name: 'windscreen', z0: -0.93, z1: -0.38, t0: T_TOP - TOP_HALF, t1: T_TOP + TOP_HALF },
    { name: 'rightDoor', z0: -0.42, z1: 0.42, t0: T_RIGHT, t1: T_RIGHT + SIDE_UP },
    { name: 'rightRear', z0: 0.5, z1: 1.08, t0: T_RIGHT, t1: T_RIGHT + SIDE_UP },
    { name: 'leftDoor', z0: -0.42, z1: 0.42, t0: T_LEFT - SIDE_UP, t1: T_LEFT },
    { name: 'leftRear', z0: 0.5, z1: 1.08, t0: T_LEFT - SIDE_UP, t1: T_LEFT },
    { name: 'rear', z0: 1.18, z1: 1.62, t0: T_TOP - TOP_HALF, t1: T_TOP + TOP_HALF },
  ];
  const zF = -0.95, zB = 1.7;
  const lining = [
    // lower half: left sill → bottom → right sill
    { z0: zF, z1: zB, t0: T_LEFT, t1: 2 * Math.PI },
    { z0: zF, z1: zB, t0: 0, t1: T_RIGHT },
    // shoulders between the side-window top and the top band
    { z0: zF, z1: zB, t0: T_RIGHT + SIDE_UP, t1: T_TOP - TOP_HALF },
    { z0: zF, z1: zB, t0: T_TOP + TOP_HALF, t1: T_LEFT - SIDE_UP },
    // side pillars (A / B / C posts and the rear quarter)
    { z0: zF, z1: -0.42, t0: T_RIGHT, t1: T_RIGHT + SIDE_UP },
    { z0: 0.42, z1: 0.5, t0: T_RIGHT, t1: T_RIGHT + SIDE_UP },
    { z0: 1.08, z1: zB, t0: T_RIGHT, t1: T_RIGHT + SIDE_UP },
    { z0: zF, z1: -0.42, t0: T_LEFT - SIDE_UP, t1: T_LEFT },
    { z0: 0.42, z1: 0.5, t0: T_LEFT - SIDE_UP, t1: T_LEFT },
    { z0: 1.08, z1: zB, t0: T_LEFT - SIDE_UP, t1: T_LEFT },
    // roof between windscreen and rear window, and the rear bulkhead strip
    { z0: -0.38, z1: 1.18, t0: T_TOP - TOP_HALF, t1: T_TOP + TOP_HALF },
    { z0: 1.62, z1: zB, t0: T_TOP - TOP_HALF, t1: T_TOP + TOP_HALF },
  ];

  const hHalf = 1.72;
  const hstabSections: WingSection[] = [
    { x: 0, chord: 1.15, le: { x: 0, y: 0.56, z: 4.9 } },
    { x: hHalf, chord: 0.72, le: { x: 0, y: 0.56, z: 5.25 } },
  ];
  const finTop = cfg.geometry.heightM - cgAglM;
  const finRootY = 0.64; // tailcone top where the fin root sits
  const finSpan = Math.max(0.5, finTop - finRootY);
  // fin sections: 'x' is the vertical span (0 at the root, up), y = 0 (centred laterally)
  const finSections: WingSection[] = [
    { x: 0, chord: 1.5, le: { x: 0, y: 0, z: 4.4 } },
    { x: 0.3 * finSpan, chord: 1.15, le: { x: 0, y: 0, z: 4.85 } },
    { x: finSpan, chord: 0.62, le: { x: 0, y: 0, z: 5.4 } },
  ];

  const tipY = rootY + halfSpan * dz;
  const wingTipLE = leZ;
  return {
    zNose: cowlStations[0].z, zTail: cabinStations[cabinStations.length - 1].z + 0.05,
    cowlStations, cabinStations, windows, lining,
    wing: { sections: wingSections, hingeFraction: 0.75, flapSpan: [0.6, breakX - 0.05], aileronSpan: [breakX + 0.08, halfSpan - 0.15], dihedralRad, halfSpan },
    strut: { fuselage: v(0.5, -0.38, -0.3), wing: v(breakX * 0.95, rootY + breakX * 0.95 * dz - 0.02, leZ + rootChord * 0.4) },
    hstab: { sections: hstabSections, hingeFraction: 0.62, halfSpan: hHalf },
    fin: { sections: finSections, hingeFraction: 0.62, rootY: finRootY, span: finSpan },
    prop: { hub, diameter, blades: propSpec?.blades ?? 2, sense: propSpec?.sense ?? 1 },
    gear: { nose, mains },
    eye,
    panel: { center: panelCenter, width: 1.0, height: 0.45, tiltRad: 8 * D2R, g1000Height: 0.36 },
    glareshield: { center: v(0, panelCenter.y + 0.26, panelCenter.z + 0.12), width: 1.04, depth: 0.28 },
    lights: {
      navLeft: v(-halfSpan + 0.03, tipY + 0.02, wingTipLE + tipChord * 0.15),
      navRight: v(halfSpan - 0.03, tipY + 0.02, wingTipLE + tipChord * 0.15),
      navTail: v(0, finRootY + finSpan - 0.06, 6.0),
      beacon: v(0, finRootY + finSpan + 0.03, 5.58),
      strobeLeft: v(-halfSpan + 0.03, tipY + 0.02, wingTipLE + tipChord * 0.3),
      strobeRight: v(halfSpan - 0.03, tipY + 0.02, wingTipLE + tipChord * 0.3),
      landing: v(-0.22, hub.y - 0.16, hub.z + 0.06),
      taxi: v(-0.22, hub.y - 0.22, hub.z + 0.06),
    },
    cgAglM,
  };
}
