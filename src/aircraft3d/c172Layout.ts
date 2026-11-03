/**
 * Cessna 172 dimensions and the placement of every sub-assembly, in model-local metres
 * (nose −Z, up +Y, right wing +X, origin at the empty CG). Numbers come from
 * docs/research/02-flight-dynamics-model.md §2.1/§5.1/§6 and the 172S POH:
 * span 11.0 m, length 8.28 m, height 2.72 m, S 16.2 m², MAC 1.49 m, prop 1.93 m.
 *
 * What is taken from the AircraftConfig (so the FDM and the model agree): eye point, prop
 * hub station/diameter/blade count/sense, gear contact points, tyre radii, steering range,
 * span. The airframe itself is fixed C172 geometry built around the eye point.
 */
import * as THREE from 'three';
import type { GearSpec, Vec3 } from '../core/types';
import { bodyVecToThreeLocal } from './frames';
import type { LoftStation } from './loft';
import type { WingSection } from './airfoil';
import type { SideXY, SkinOutline } from './skin';
import type { AircraftModelConfig, FuselageDetails, GearLayout, GlareshieldLayout, LightLayout, PanelLayout, PropLayout } from './layoutTypes';

export { toModelConfig, type AircraftModelConfig, type GearLayout } from './layoutTypes';

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
      // eye: left seat, just ahead of the FS 36 pilot station (CG FS 41 ⇒ 0.13 m forward)
      lengthM: 8.28, heightM: 2.72, eyePoint: [0.15, -0.25, -0.55],
    },
    propeller: {
      diameterM: 1.93, blades: 2, inertia: 1.7,
      Ct: { xs: [0, 0.5, 1], ys: [0.1, 0.06, 0] }, Cp: { xs: [0, 0.5, 1], ys: [0.05, 0.04, 0.01] },
      // hub FS −37.7 in: 1.98 m ahead of the CG and 0.07 m below its waterline (body z down)
      sense: 1, pFactorM: 0.05, position: [1.98, 0, 0.07], fixedPitch: true,
    },
    // JSBSim c172p stations relative to CG FS 41: nose FS −6.8 in, mains FS 58.2 in
    // (wheelbase 65 in = 1.65 m); real 172S track 100 in = 2.54 m. Equal heights keep the
    // stand-alone model level on the ground (the FDM config supplies its own).
    gear: [
      gear('nose', [1.214, 0, 1.2], 0.18, 10, 'none'),
      gear('left main', [-0.437, -1.27, 1.2], 0.22, 0, 'left'),
      gear('right main', [-0.437, 1.27, 1.2], 0.22, 0, 'right'),
    ],
  };
}

export interface C172Layout {
  airframe: 'c172';
  /** total length range used for livery u mapping */
  zNose: number; zTail: number;
  /**
   * One fuselage profile from the spinner to the tail, so the cowl, the cabin shell and the
   * tailcone are regions of the same surface and shade seamlessly where they meet.
   */
  fuselage: {
    stations: LoftStation[];
    /** windshield base: the cowl (visible from the cockpit too) ends here */
    cowlEndZ: number;
    /** the cabin shell (replaced by the cockpit lining in the cockpit view) ends here */
    cabinEndZ: number;
    /** firewall (front of the cockpit lining, behind the panel) */
    firewallZ: number;
  };
  /** window outlines in the side view (glass on the skin, holes in the skin and the lining) */
  windows: SkinOutline[];
  /** door outlines (exterior seam lines) */
  doors: SkinOutline[];
  /** design heights the cabin is built around (model y, m) */
  cabin: { floorY: number; sillY: number; windowTopY: number; roofY: number; deckY: number; bellyY: number };
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
  /** fin sections: `x` is the height above `rootY`; `dorsal` is the fillet ahead of the fin */
  fin: { sections: WingSection[]; dorsal: WingSection[]; hingeFraction: number; rootY: number; span: number };
  prop: PropLayout;
  /** tricycle gear: `tail` is always null */
  gear: { nose: GearLayout | null; tail: GearLayout | null; mains: GearLayout[] };
  eye: THREE.Vector3;
  /** steam panel plane (2:1 like its 1024×512 texture) and the G1000 plane (PFD+MFD, 2.74:1) */
  panel: PanelLayout;
  /** padded glareshield hood: rear lip over the panel, top surface running to the windshield */
  glareshield: GlareshieldLayout;
  lights: LightLayout;
  /** small exterior details (positions on the skin are found from the fuselage profile) */
  details: FuselageDetails;
  /** CG height above ground with unloaded gear, m */
  cgAglM: number;
}

/**
 * Resolve the full placement from a config. Pure (no Three.js scene objects), so it is
 * unit-testable; Vector3 is used only as a value type.
 *
 * The airframe is built around the pilot eye point with real C172 proportions (eye ≈ 1.0 m
 * above the floor, 0.15 m above the cowl deck, 0.27 m below the wing chord line, window sill
 * 0.29 m below the eye). The visual thrust line sits at most 0.62 m below the eye so the cowl
 * keeps its shape even when the flight model puts its thrust axis lower.
 */
export function resolveC172Layout(cfg: AircraftModelConfig): C172Layout {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const eye = bodyVecToThreeLocal(cfg.geometry.eyePoint, new THREE.Vector3());
  const E = eye.y;

  // ── cabin design heights (model y) ──
  const deckY = E - 0.15;      // cowl deck / windshield base on the centreline
  const roofY = E + 0.25;      // cabin roof under the wing root
  const bellyY = E - 1.12;     // cabin belly
  const floorY = E - 1.0;      // cabin floor
  const sillY = E - 0.29;      // side-window sill
  const winTopY = E + 0.18;    // side-window top (door frame under the wing)
  const zW0 = -0.93, zW1 = -0.36; // windshield base / top (at the wing leading edge)
  const firewallZ = -1.04;     // FS 0 (CG at FS 41)

  // ── wing ──
  const halfSpan = cfg.geometry.b / 2;
  const dihedralRad = 1.7 * D2R;
  const dz = Math.tan(dihedralRad);
  const rootY = E + 0.27, leZ = -0.33, rootChord = 1.63, tipChord = 1.13;
  // constant chord inboard of WS 100 (2.54 m), tapered outboard
  const breakX = Math.min(2.55, halfSpan * 0.5);
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
        ? v(contact.x, deckY - 0.82, contact.z + 0.05)
        : v(Math.sign(contact.x) * 0.42, bellyY + 0.07, contact.z - 0.05);
      return { index, name: g.name, attach, contact, tyreRadius: g.tyreRadius, maxSteerRad: g.maxSteerDeg * D2R, width: isNose ? 0.11 : 0.14 };
    })
    .filter((g): g is GearLayout => g !== null);
  const nose = gearLayouts.find((g) => g.contact.z < 0) ?? null;
  const mains = gearLayouts.filter((g) => g !== nose);

  const propSpec = cfg.propeller;
  const hubCfg = propSpec ? bodyVecToThreeLocal(propSpec.position, new THREE.Vector3()) : v(0, -0.07, -1.98);
  const hub = v(hubCfg.x, Math.max(hubCfg.y, E - 0.62), hubCfg.z);
  const diameter = propSpec?.diameterM ?? 1.93;

  // ── fuselage profile (top / bottom / width), spinner → tail ──
  const st = (z: number, width: number, top: number, bottom: number, n: number): LoftStation =>
    ({ z, width, height: top - bottom, yCenter: (top + bottom) / 2, n });
  const hy = hub.y, hz = hub.z;
  const stations: LoftStation[] = [
    st(hz - 0.015, 0.34, hy + 0.17, hy - 0.17, 2.0),     // ring behind the spinner
    st(hz + 0.06, 0.78, hy + 0.27, hy - 0.36, 2.4),      // nose bowl with the inlets
    st(hz + 0.30, 0.96, hy + 0.36, hy - 0.45, 2.8),
    st(-1.30, 1.04, deckY - 0.035, bellyY + 0.06, 2.6), // rounded cowl top (a hump from the seat)
    st(firewallZ, 1.08, deckY - 0.012, bellyY + 0.02, 2.8),
    st(zW0, 1.10, deckY, bellyY, 3.1),                  // windshield base
    st(zW1, 1.12, roofY, bellyY, 4.0),                  // windshield top / wing LE
    st(0.45, 1.12, roofY, bellyY, 4.0),                 // door rear post
    st(1.10, 1.06, roofY - 0.02, bellyY + 0.05, 3.8),
    st(1.55, 0.96, roofY - 0.10, bellyY + 0.12, 3.4),
    st(2.00, 0.80, roofY - 0.30, bellyY + 0.19, 3.0),   // end of the rear window
    st(3.00, 0.58, roofY - 0.45, bellyY + 0.33, 2.6),
    st(4.00, 0.41, roofY - 0.53, bellyY + 0.43, 2.4),
    st(5.00, 0.27, roofY - 0.58, bellyY + 0.51, 2.2),
    st(5.70, 0.17, roofY - 0.60, bellyY + 0.57, 2.0),
    st(6.02, 0.07, roofY - 0.61, bellyY + 0.63, 2.0),
  ];

  // ── windows (side view, counter-clockwise: z to the right, y up) ──
  // The A-pillar runs from the windshield's lower corner to the roof corner at the wing LE;
  // the door window's front edge is parallel to it, 0.07 m further aft (a ≈ 4 cm post: the
  // fixed pillar plus the door's 2 cm window frame).
  const aY0 = deckY - 0.08, aY1 = winTopY - 0.03;
  const pillarSlope = (zW1 - 0.02 - zW0) / (aY1 - aY0); // dz per dy
  const pillarW = 0.07, doorFrameW = 0.022;
  const doorFrontZ = (y: number) => zW0 + pillarW + (y - aY0) * pillarSlope;
  const windows: SkinOutline[] = [
    { name: 'windscreen', side: 'both', radius: 0.035, outline: [[zW0 - 0.06, aY0], [zW0, aY0], [zW1 - 0.02, aY1], [zW1 - 0.02, roofY + 0.4], [zW0 - 0.06, roofY + 0.4]] },
    { name: 'rear', side: 'both', radius: 0.06, outline: [[1.38, winTopY - 0.08], [1.95, deckY + 0.02], [1.95, roofY + 0.4], [1.38, roofY + 0.4]] },
  ];
  const doorWindow: SideXY[] = [[zW0 + pillarW, sillY], [0.37, sillY], [0.37, winTopY], [doorFrontZ(winTopY), winTopY], [zW0 + pillarW, aY0]];
  const rearSide: SideXY[] = [[0.47, sillY + 0.02], [1.10, sillY + 0.04], [1.30, winTopY - 0.08], [1.22, winTopY - 0.02], [0.47, winTopY - 0.02]];
  const doorOutline: SideXY[] = [[zW0 + pillarW - doorFrameW, bellyY + 0.16], [0.42, bellyY + 0.16], [0.42, winTopY + 0.045], [doorFrontZ(winTopY + 0.045) - doorFrameW, winTopY + 0.045], [zW0 + pillarW - doorFrameW, aY0]];
  for (const [side, sfx] of [['right', 'Right'], ['left', 'Left']] as const) {
    windows.push({ name: `door${sfx}`, side, radius: 0.05, outline: doorWindow });
    windows.push({ name: `rear${sfx}`, side, radius: 0.06, outline: rearSide });
  }
  const doors: SkinOutline[] = (['right', 'left'] as const).map((side) => ({ name: `door:${side}`, side, radius: 0.04, outline: doorOutline }));

  // ── empennage: stabiliser on the tailcone, swept fin (≈1.36 m) with a dorsal fillet ──
  const hHalf = 1.72;
  const stabY = bellyY + 0.66;
  const hstabSections: WingSection[] = [
    { x: 0, chord: 1.28, le: { x: 0, y: stabY, z: 4.72 } },
    { x: hHalf, chord: 0.82, le: { x: 0, y: stabY, z: 5.12 } },
  ];
  const finRootY = roofY - 0.61; // tailcone top under the fin
  const finSpan = 1.36;
  const finSections: WingSection[] = [
    { x: 0, chord: 1.62, le: { x: 0, y: 0, z: 4.42 } },
    { x: 0.35, chord: 1.3, le: { x: 0, y: 0, z: 4.7 } },
    { x: finSpan, chord: 0.66, le: { x: 0, y: 0, z: 5.42 } },
  ];
  const finLeAt = (h: number) => 4.42 + (h / finSpan) * (5.42 - 4.42);
  const dorsal: WingSection[] = [
    { x: 0, chord: 1.35, le: { x: 0, y: 0, z: 3.2 } },
    { x: 0.3, chord: 0.12, le: { x: 0, y: 0, z: finLeAt(0.3) - 0.02 } },
  ];

  const tipY = rootY + halfSpan * dz;
  const wingTipLE = leZ;
  // landing / taxi lights in the left wing leading edge (172S), just outboard of the strut
  const lampY = (x: number) => rootY + x * dz - 0.01;
  return {
    airframe: 'c172',
    zNose: hz - 0.28, zTail: 6.08,
    fuselage: { stations, cowlEndZ: zW0, cabinEndZ: 2.0, firewallZ },
    windows, doors,
    cabin: { floorY, sillY, windowTopY: winTopY, roofY, deckY, bellyY },
    wing: { sections: wingSections, hingeFraction: 0.75, flapSpan: [0.6, breakX - 0.05], aileronSpan: [breakX + 0.08, halfSpan - 0.15], dihedralRad, halfSpan },
    strut: { fuselage: v(0.53, bellyY + 0.17, -0.05), wing: v(breakX - 0.1, rootY + (breakX - 0.1) * dz - 0.05, leZ + rootChord * 0.25) },
    hstab: { sections: hstabSections, hingeFraction: 0.62, halfSpan: hHalf },
    fin: { sections: finSections, dorsal, hingeFraction: 0.62, rootY: finRootY, span: finSpan },
    prop: { hub, diameter, blades: propSpec?.blades ?? 2, sense: propSpec?.sense ?? 1 },
    gear: { nose, tail: null, mains },
    eye,
    panel: {
      // top edge 3.8 cm below the deck, just under the glareshield lip
      center: v(0, deckY - 0.038 - 0.24 * Math.cos(8 * D2R), -0.8), width: 0.96, height: 0.48, tiltRad: 8 * D2R,
      g1000Center: v(0, deckY - 0.038 - 0.175 * Math.cos(8 * D2R), -0.8 - 0.065 * Math.sin(8 * D2R)), g1000Height: 0.35,
    },
    glareshield: { lipY: deckY - 0.01, lipZ: -0.785, frontY: deckY - 0.02, frontZ: zW0 + 0.01, width: 1.02 },
    lights: {
      navLeft: v(-halfSpan + 0.03, tipY + 0.02, wingTipLE + tipChord * 0.15),
      navRight: v(halfSpan - 0.03, tipY + 0.02, wingTipLE + tipChord * 0.15),
      navTail: v(0, finRootY + finSpan - 0.08, 6.08),
      beacon: v(0, finRootY + finSpan + 0.04, 5.65),
      strobeLeft: v(-halfSpan + 0.03, tipY + 0.02, wingTipLE + tipChord * 0.3),
      strobeRight: v(halfSpan - 0.03, tipY + 0.02, wingTipLE + tipChord * 0.3),
      landing: v(-(breakX + 0.35), lampY(breakX + 0.35), leZ - 0.012),
      taxi: v(-(breakX + 0.62), lampY(breakX + 0.62), leZ - 0.012),
    },
    details: {
      noseInlets: { x: 0.265, y: hy - 0.035, r: 0.074, squash: 1.1 },
      exhaust: { x: 0.2, z: -1.22, length: 0.17, radius: 0.024, dir: v(0, -0.8, 0.6).normalize() },
      antenna: { z: 2.25, length: 0.55, radius: 0.007, dir: v(0, Math.cos(32 * D2R), Math.sin(32 * D2R)) },
    },
    cgAglM,
  };
}
