/**
 * Piper PA-18-150 Super Cub class tail-dragger: dimensions and the placement of every
 * sub-assembly in model-local metres (nose −Z, up +Y, right wing +X, origin at the empty CG).
 *
 * Shared airframe numbers (src/fdm/aircraft/cub.ts is built to the same, body FRD relative to
 * the empty CG): span 10.73 m, S 16.58 m², constant chord 1.60 m (wing LE x +0.42, TE −1.18,
 * chord plane z −1.02, 1° dihedral), length 6.88 m (spinner tip +1.92, rudder TE −4.96),
 * prop hub (1.80, 0, −0.05) Ø 1.88 m, mains (0.50, ±0.92, 1.12) r 0.28 (8.00-6), tail wheel
 * (−4.40, 0, 0.15) r 0.08, eye (0.05, 0, −0.60), wing-root tanks (−0.20, ±0.80, −1.00).
 *
 * Taken from the AircraftConfig at runtime (so the FDM and the model agree): eye point, prop
 * hub/diameter/blades/sense, gear contact points, tyre radii, steering range, span, tank
 * capacities. The airframe around them is fixed Cub geometry (the fuselage, tail and wing
 * chord plane do not move with the config); the pilot's seat and stick follow the eye.
 */
import * as THREE from 'three';
import type { GearSpec, Vec3 } from '../core/types';
import { AVGAS_KG_PER_GAL } from '../core/units';
import { bodyVecToThreeLocal } from './frames';
import type { AirfoilSpec, WingSection } from './airfoil';
import type { LoftStation } from './loft';
import type { SideXY, SkinOutline } from './skin';
import type { PaintScheme } from './materials';
import type {
  AircraftModelConfig, FuselageDetails, FuselageLayout, GearLayout, GlareshieldLayout, LightLayout, PanelLayout, PropLayout,
} from './layoutTypes';

const D2R = Math.PI / 180;

/**
 * USA 35B-like flat-bottomed section (11.7 % thick, max camber 5.5 % at 30 %): with the NACA
 * 4-digit thickness form the lower surface stays within 1.5 % of the chord line.
 */
export const USA35B: AirfoilSpec = { thickness: 0.117, camber: 0.055, camberPos: 0.3 };

/**
 * Our own Cub scheme (not a copy of any operator's or game's livery): cream-yellow fabric with
 * a dark-red cheat line and pinstripe that sweep up toward the tail, dark-red registration and
 * spinner.
 */
export const CUB_PAINT: PaintScheme = {
  livery: {
    base: '#f0d68c',
    bands: [],
    // a straight cheat line and pinstripe from the spinner, sweeping gently up to the tail
    lines: [
      { y0: 0.07, y1: 0.14, slope: 0.035, color: '#7c1d24', from: 0.3 },
      { y0: 0.025, y1: 0.04, slope: 0.035, color: '#7c1d24', from: 0.3 },
    ],
    regColor: '#5a1419', regF: 0.7, capF: 0.3,
  },
  plain: 0xf0d68c, trim: 0x7c1d24, fallback: 0xf0d68c,
};

/** Stand-alone Super Cub model config (also the unit-test fixture). Body frame FRD, metres. */
export function cubModelConfig(): AircraftModelConfig {
  const wheel = (name: string, pos: Vec3, tyreRadius: number, maxSteerDeg: number, casters: boolean, brakeGroup: GearSpec['brakeGroup']): GearSpec => ({
    name, pos, type: 'wheel', k: 40_000, cComp: 1_500, cRebound: 2_500, tyreRadius,
    muStatic: 0.8, muDynamic: 0.5, muRolling: 0.02, pacejka: { B: 10, C: 1.9, E: 0.97 },
    maxSteerDeg, casters, brakeGroup, retractable: false,
  });
  const tankKg = 18 * AVGAS_KG_PER_GAL;
  return {
    airframe: 'cub',
    geometry: {
      // PA-18-150 owner's handbook: span 35 ft 2.5 in, area 178.5 ft², chord 63 in, length 22 ft 7 in, height 6 ft 8.5 in
      S: 16.58, b: 10.73, cbar: 1.6, arpOffset: [0.02, 0, -1.02], macHeightOnGround: 2.0,
      lengthM: 6.88, heightM: 2.04, eyePoint: [0.05, 0, -0.6],
    },
    propeller: {
      diameterM: 1.88, blades: 2, inertia: 1.9,
      Ct: { xs: [0, 0.5, 1], ys: [0.11, 0.076, -0.01] }, Cp: { xs: [0, 0.5, 1], ys: [0.056, 0.049, 0.012] },
      sense: 1, pFactorM: 0.24, position: [1.8, 0, -0.05], fixedPitch: true,
    },
    gear: [
      wheel('Left main', [0.5, -0.92, 1.12], 0.28, 0, false, 'left'),
      wheel('Right main', [0.5, 0.92, 1.12], 0.28, 0, false, 'right'),
      wheel('Tail', [-4.4, 0, 0.15], 0.08, 25, true, 'none'),
      // structure contacts are skipped by the model
      { ...wheel('Tail post', [-4.5, 0, -0.02], 0, 0, false, 'none'), type: 'structure' },
    ],
    tanks: [
      { name: 'Left', pos: [-0.2, -0.8, -1.0], capacityKg: tankKg },
      { name: 'Right', pos: [-0.2, 0.8, -1.0], capacityKg: tankKg },
    ],
  };
}

/** Main gear: front (bungee) leg to `attach`, rear V leg, split axle hinged under the belly. */
export interface CubMainGearLayout extends GearLayout {
  /** rear V-leg fitting on the lower longeron */
  rearAttach: THREE.Vector3;
  /** split-axle hinge fitting under the belly (centreline) */
  axleHinge: THREE.Vector3;
  /** bungee fairing over the top of the front leg: centre, length along the leg, width, depth */
  bungee: { center: THREE.Vector3; length: number; width: number; depth: number };
}

/** Steerable / full-swivel tail wheel on a leaf spring. `attach` is the swivel-axis top. */
export interface CubTailWheelLayout extends GearLayout {
  /** leaf-spring root under the tail cone (the spring runs aft and down to the swivel) */
  springRoot: THREE.Vector3;
  /** the swivel axis is this far ahead of the axle (caster trail, m) */
  trail: number;
  /** full-swivel beyond the steering range (config `casters`) */
  casters: boolean;
}

/** A tube between two points (right-side placement; the builders mirror to the left). */
export type TubeLayout = [THREE.Vector3, THREE.Vector3];

export interface CubLayout extends FuselageLayout {
  airframe: 'cub';
  /** design heights the cabin is built around (model y, m) */
  cabin: { floorY: number; bellyY: number; deckY: number; roofY: number; sillY: number; windowTopY: number; width: number };
  wing: {
    /** right-wing sections from the root rib at `rootX` to the rounded tip (mirror for the left) */
    sections: WingSection[];
    airfoil: AirfoilSpec;
    hingeFraction: number;
    flapSpan: [number, number];
    aileronSpan: [number, number];
    dihedralRad: number;
    halfSpan: number;
    rootX: number;
    /** the rounded tip bow starts here */
    tipStartX: number;
  };
  /** V lift struts (right side): front-spar and rear-spar struts from the lower longeron, jury struts at `juryAt` of their length */
  struts: { front: TubeLayout; rear: TubeLayout; juryAt: number };
  /** horizontal tail: fixed stabiliser LE → hinge line, elevator hinge line → TE (right side) */
  hstab: { stab: WingSection[]; elevator: WingSection[]; hingeZ: number; halfSpan: number };
  /** fin LE → rudder hinge (`x` = height above rootY) and the rudder hinge → TE (`x` = height above rudder.bottomY) */
  fin: { sections: WingSection[]; rootY: number };
  rudder: { sections: WingSection[]; bottomY: number; hingeZ: number };
  /** stabiliser flying wires (right side) */
  wires: TubeLayout[];
  prop: PropLayout;
  gear: { nose: GearLayout | null; tail: CubTailWheelLayout | null; mains: CubMainGearLayout[] };
  eye: THREE.Vector3;
  /** instrument panel plane (2:1 like its 1024×512 texture); the G1000 fields mirror it (no glass variant) */
  panel: PanelLayout;
  glareshield: GlareshieldLayout;
  lights: LightLayout;
  details: FuselageDetails & {
    /** carburettor air box scoop under the nose: centre, size (x, y, z) */
    carbScoop: { center: THREE.Vector3; size: THREE.Vector3 };
    /** fuel filler caps on the wing upper surface (right side) */
    fuelCap: THREE.Vector3;
    /** pitot tube under the left wing: tip and length */
    pitot: { tip: THREE.Vector3; length: number };
  };
  cockpit: {
    /** stick pivots on the floor and lengths (front: pilot; rear: passenger) */
    frontStick: { pivot: THREE.Vector3; length: number };
    rearStick: { pivot: THREE.Vector3; length: number };
    /** front rudder pedals: centre of the right pedal (mirror x for the left) */
    pedal: THREE.Vector3;
    /** throttle quadrant on the left wall: lever pivot, lever length, fore-aft travel (rad) */
    throttle: { pivot: THREE.Vector3; length: number; travelRad: number };
    /** trim crank on the left wall (axis along x) */
    trimCrank: { center: THREE.Vector3; radius: number };
    /** flap handle on the left wall: pivot, length, full-flap angle (rad) */
    flapHandle: { pivot: THREE.Vector3; length: number; fullRad: number };
    /** wing-root fuel sight gauges overhead (right; mirror for the left) */
    fuelGauge: { center: THREE.Vector3; radius: number };
    seats: { front: { y: number; z: number }; rear: { y: number; z: number } };
    /** visible steel-tube frame members inside the cabin (explicit for both sides) */
    tubes: TubeLayout[];
  };
  /** fuel tank capacities (kg) for the sight gauges: [left, right] */
  tankCapacityKg: [number, number];
  /** fuselage station range of the registration (model z) */
  livery: { regZ: [number, number] };
  /** CG height above the ground in the three-point attitude (unloaded gear), m */
  cgAglM: number;
  /** nose-up pitch of the three-point attitude, rad */
  threePointPitchRad: number;
}

/** Upper-surface height (fraction of the chord above the chord line) of a 4-digit-like section at chord fraction f. */
export function airfoilUpper(spec: AirfoilSpec, f: number): number {
  const x = Math.max(0, Math.min(1, f));
  const yt = 5 * spec.thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const m = spec.camber, p = spec.camberPos;
  const yc = m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
  return yc + yt;
}

/**
 * Resolve the full placement from a config. Pure (no Three.js scene objects), so it is
 * unit-testable; Vector3 is used only as a value type.
 */
export function resolveCubLayout(cfg: AircraftModelConfig): CubLayout {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const eye = bodyVecToThreeLocal(cfg.geometry.eyePoint, new THREE.Vector3());

  // ── cabin design heights (fixed airframe, model y) ──
  const bellyY = -0.34;   // lower longerons at the cabin
  const floorY = -0.3;    // floor boards
  const deckY = 0.46;     // cowl deck at the windshield base
  const roofY = 1.02;     // cabin roof = wing chord plane at the root (the wing sits on the roof)
  const sillY = 0.36;     // side-window sill = split line of the right door
  const winTopY = 0.95;   // window tops (upper longerons)
  const zW0 = -0.95, zW1 = -0.42; // windshield base / top (wing leading edge)
  const firewallZ = -1.0;
  const cabinW = 0.76;

  // ── wing: constant 1.60 m chord on the roof, 1° dihedral, rounded tip bows ──
  const halfSpan = cfg.geometry.b / 2;
  const dihedralRad = 1 * D2R;
  const dz = Math.tan(dihedralRad);
  const chord = 1.6, leZ = -0.42, chordY = roofY;
  const yAt = (x: number) => chordY + x * dz;
  const rootX = 0.26;
  const tipR = Math.min(0.45, halfSpan * 0.1);
  const tipStartX = halfSpan - tipR;
  const leBack = 0.55, teFwd = 0.85; // the tip bow's outermost point sits at ≈ 40 % chord
  const bow = (s: number) => 1 - Math.sqrt(Math.max(0, 1 - s * s));
  const wingSections: WingSection[] = [{ x: rootX, chord, le: { x: 0, y: yAt(rootX), z: leZ } }];
  for (const s of [0, 0.3, 0.5, 0.65, 0.78, 0.88, 0.95, 1]) {
    const x = tipStartX + s * tipR, k = bow(s);
    const le = leZ + leBack * k, te = leZ + chord - teFwd * k;
    wingSections.push({ x, chord: te - le, le: { x: 0, y: yAt(x), z: le } });
  }
  const hf = 0.76;
  const flapSpan: [number, number] = [rootX + 0.04, halfSpan * 0.525];
  const aileronSpan: [number, number] = [flapSpan[1] + 0.08, tipStartX - 0.04];

  // V lift struts: front- and rear-spar struts converge on the lower longeron (≈ 55 % semi-span)
  const strutX = halfSpan * 0.55, strutY = yAt(strutX) - 0.012;
  const struts = {
    front: [v(0.335, bellyY + 0.07, -0.06), v(strutX, strutY, leZ + 0.14 * chord)] as TubeLayout,
    rear: [v(0.335, bellyY + 0.07, 0.12), v(strutX, strutY, leZ + 0.66 * chord)] as TubeLayout,
    juryAt: 0.62,
  };

  // ── propeller (config) and the nose built around its hub ──
  const propSpec = cfg.propeller;
  const hubCfg = propSpec ? bodyVecToThreeLocal(propSpec.position, new THREE.Vector3()) : v(0, 0.05, -1.8);
  const hub = v(hubCfg.x, Math.max(-0.15, Math.min(0.25, hubCfg.y)), Math.min(hubCfg.z, firewallZ - 0.55));
  const prop: PropLayout = {
    hub, diameter: propSpec?.diameterM ?? 1.88, blades: propSpec?.blades ?? 2, sense: propSpec?.sense ?? 1,
    // small spinner: base 8 cm behind the blade plane, tip 12 cm ahead of it (spinner tip x +1.92)
    spinner: { radius: 0.105, length: 0.2, baseZ: 0.08 }, bladeZ: 0,
  };

  // ── fuselage profile (top / bottom / width), spinner → tail post ──
  const st = (z: number, width: number, top: number, bottom: number, n: number): LoftStation =>
    ({ z, width, height: top - bottom, yCenter: (top + bottom) / 2, n });
  const hy = hub.y, hz = hub.z;
  const stations: LoftStation[] = [
    // blunt Cub nose: a near-vertical bowl face with the spinner low on it, then an almost flat
    // cowl top (visible over the deck from the front seat)
    st(hz + 0.085, 0.215, hy + 0.108, hy - 0.108, 2.0), // ring behind the spinner
    st(hz + 0.115, 0.56, hy + 0.32, hy - 0.235, 3.0),   // nose bowl face with the two inlets
    st(hz + 0.24, 0.66, hy + 0.37, hy - 0.3, 3.3),
    st(-1.22, 0.7, deckY - 0.02, bellyY + 0.015, 3.5),
    st(firewallZ, 0.715, deckY - 0.008, bellyY + 0.005, 3.7),
    st(zW0, 0.72, deckY, bellyY, 3.8),                 // windshield base
    st(-0.8, 0.735, deckY + 0.17, bellyY, 4.2),
    st(-0.62, 0.75, deckY + 0.4, bellyY, 4.6),
    st(zW1, cabinW, roofY, bellyY, 5.0),               // windshield top at the wing leading edge
    st(0.6, cabinW, roofY, bellyY, 5.0),
    st(1.2, 0.7, roofY - 0.03, bellyY + 0.05, 4.2),    // wing trailing edge, turtle deck begins
    st(1.7, 0.6, 0.905, -0.25, 3.2),
    st(2.5, 0.47, 0.81, -0.135, 2.8),
    st(3.3, 0.34, 0.735, -0.025, 2.6),
    st(3.95, 0.2, 0.68, 0.05, 2.4),
    st(4.27, 0.06, 0.65, 0.085, 2.2),                  // tail post
  ];

  // ── windows (side view (z, y), counter-clockwise; the skylight in the top view (z, x)) ──
  // The windshield's side edge runs from the base corner to the wing leading edge; the side
  // windows' front edges are parallel to it, 3.2 cm aft (the frame tube).
  const aY0 = deckY - 0.06, aY1 = winTopY - 0.01;
  const zA = (y: number) => zW0 + 0.02 + ((y - aY0) * (zW1 - zW0 - 0.04)) / (aY1 - aY0);
  const zF = (y: number) => zA(y) + 0.032;
  const sideWin = (z1: number): SideXY[] => [[zF(sillY), sillY], [z1, sillY], [z1, winTopY], [zF(winTopY), winTopY]];
  const windows: SkinOutline[] = [
    { name: 'windscreen', side: 'both', radius: 0.03, outline: [[zW0 - 0.08, aY0], [zA(aY0), aY0], [zA(aY1), aY1], [zA(aY1), roofY + 0.4], [zW0 - 0.08, roofY + 0.4]] },
    { name: 'skylight', side: 'both', view: 'top', minY: roofY - 0.17, radius: 0.05, outline: [[-0.36, -0.21], [0.3, -0.21], [0.3, 0.21], [-0.36, 0.21]] },
    // right: the upper half of the split door is one big window; a small window behind it
    { name: 'doorRight', side: 'right', radius: 0.04, outline: sideWin(0.58) },
    { name: 'rearRight', side: 'right', radius: 0.05, outline: [[0.68, sillY + 0.03], [1.02, sillY + 0.06], [1.02, winTopY - 0.03], [0.68, winTopY - 0.01]] },
    // left: front (sliding) window and the rear window
    { name: 'frontLeft', side: 'left', radius: 0.04, outline: sideWin(0.18) },
    { name: 'rearLeft', side: 'left', radius: 0.05, outline: [[0.26, sillY + 0.02], [1.02, sillY + 0.06], [1.02, winTopY - 0.03], [0.26, winTopY]] },
  ];
  // split door seams (right side): upper half around the window, lower half below the split
  const doorRear = 0.605, splitY = sillY - 0.018;
  const doors: SkinOutline[] = [
    { name: 'door:upper', side: 'right', radius: 0.03, outline: [[zF(splitY + 0.006) - 0.025, splitY + 0.006], [doorRear, splitY + 0.006], [doorRear, winTopY + 0.03], [zF(winTopY + 0.03) - 0.025, winTopY + 0.03]] },
    { name: 'door:lower', side: 'right', radius: 0.03, outline: [[zF(splitY) - 0.025, bellyY + 0.12], [doorRear, bellyY + 0.12], [doorRear, splitY - 0.006], [zF(splitY) - 0.025, splitY - 0.006]] },
  ];

  // ── empennage: braced stabiliser on the tail post, small fin, big rounded rudder ──
  const stabY = 0.66, hingeZ = 4.22, stabLE = 3.62, elevChord = 0.42, hHalf = 1.5, tailR = 0.5;
  const tipK = (x: number) => (x <= hHalf - tailR ? 0 : bow(Math.min(1, (x - (hHalf - tailR)) / tailR)));
  const tailXs = [0, hHalf - tailR, hHalf - tailR * 0.6, hHalf - tailR * 0.35, hHalf - tailR * 0.18, hHalf - tailR * 0.07, hHalf];
  const stab: WingSection[] = tailXs.map((x) => {
    const le = stabLE + (hingeZ - stabLE) * tipK(x);
    return { x, chord: Math.max(0.03, hingeZ - le), le: { x: 0, y: stabY, z: Math.min(le, hingeZ - 0.03) } };
  });
  // elevator: inboard trailing corner cut away so the rudder can swing between the halves
  const elevator: WingSection[] = [{ x: 0.05, chord: 0.12, le: { x: 0, y: stabY, z: hingeZ } }, { x: 0.3, chord: elevChord, le: { x: 0, y: stabY, z: hingeZ } }];
  for (const x of tailXs.slice(1)) elevator.push({ x, chord: Math.max(0.03, elevChord * (1 - tipK(x))), le: { x: 0, y: stabY, z: hingeZ } });
  const rudderHingeZ = 4.29;
  const finRootY = 0.62;
  // fin: straight leading edge, rounded into the top of the rudder hinge (`x` = height above finRootY)
  const finPts: [number, number][] = [[0, 3.48], [0.78, 4.05], [0.86, 4.14], [0.905, 4.22], [0.925, 4.265]];
  const finSections: WingSection[] = finPts.map(([h, le]) => ({ x: h, chord: rudderHingeZ - le, le: { x: 0, y: 0, z: le } }));
  // rudder: diagonal bottom edge from the tail post, near-vertical trailing edge, big rounded top
  const rudderBottomY = 0.085;
  const rudderTE: [number, number][] = [
    [0.085, 4.33], [0.2, 4.53], [0.32, 4.76], [0.42, 4.86], [0.55, 4.925], [0.7, 4.955], [0.9, 4.96],
    [1.1, 4.955], [1.25, 4.925], [1.37, 4.86], [1.46, 4.76], [1.52, 4.64], [1.555, 4.5], [1.568, 4.38], [1.572, 4.315],
  ];
  const rudderSections: WingSection[] = rudderTE.map(([y, te]) => ({ x: y - rudderBottomY, chord: Math.max(0.025, te - rudderHingeZ), le: { x: 0, y: 0, z: rudderHingeZ } }));
  // flying wires (right side): two above to the fin, two below to the tail-post bottom
  const wireX = 0.95, wFront = 3.7, wRear = 4.17;
  const wires: TubeLayout[] = [
    [v(0, finRootY + 0.56, 3.99), v(wireX, stabY + 0.02, wFront)],
    [v(0, finRootY + 0.56, 4.22), v(wireX, stabY + 0.02, wRear)],
    [v(wireX, stabY - 0.02, wFront), v(0.03, 0.1, 4.05)],
    [v(wireX, stabY - 0.02, wRear), v(0.02, 0.095, 4.24)],
  ];

  // ── gear (config contact points and tyre radii) ──
  const wheels = cfg.gear.map((g, index) => ({ g, index })).filter(({ g }) => g.type === 'wheel');
  const tailCand = wheels.reduce<{ g: GearSpec; index: number } | null>((best, w) => (w.g.pos[0] < -1 && (!best || w.g.pos[0] < best.g.pos[0]) ? w : best), null)
    ?? wheels.find(({ g }) => /tail/i.test(g.name)) ?? null;
  let tail: CubTailWheelLayout | null = null;
  if (tailCand) {
    const { g, index } = tailCand;
    const contact = bodyVecToThreeLocal(g.pos, new THREE.Vector3());
    const r = g.tyreRadius, trail = 0.04;
    // swivel-axis top 2 cm above the tyre; the leaf spring runs aft from under the tail cone to it
    const attach = v(contact.x, contact.y + 2 * r + 0.02, contact.z - trail);
    tail = {
      index, name: g.name, contact, tyreRadius: r, maxSteerRad: g.maxSteerDeg * D2R, width: Math.max(0.04, r * 0.75),
      attach, springRoot: v(0, 0.045, Math.min(3.98, attach.z - 0.25)), trail, casters: g.casters,
    };
  }
  const mains: CubMainGearLayout[] = wheels.filter((w) => w !== tailCand).map(({ g, index }) => {
    const contact = bodyVecToThreeLocal(g.pos, new THREE.Vector3());
    const s = contact.x < 0 ? -1 : 1;
    const axle = contact.clone(); axle.y += g.tyreRadius;
    const attach = v(s * 0.335, bellyY + 0.05, -0.86);
    const dir = axle.clone().sub(attach).normalize();
    return {
      index, name: g.name, contact, tyreRadius: g.tyreRadius, maxSteerRad: g.maxSteerDeg * D2R, width: 0.2,
      attach, rearAttach: v(s * 0.335, bellyY + 0.05, -0.1), axleHinge: v(s * 0.04, bellyY - 0.05, axle.z),
      bungee: { center: attach.clone().addScaledVector(dir, 0.15), length: 0.34, width: 0.085, depth: 0.12 },
    };
  });
  // three-point attitude: the ground line through a main contact and the tail contact
  let cgAglM = Math.max(0.9, ...cfg.gear.map((g) => g.pos[2]));
  let threePointPitchRad = 0;
  if (tailCand && mains.length) {
    const m = cfg.gear[mains[0].index].pos, t = tailCand.g.pos;
    const ax = t[0] - m[0], az = t[2] - m[2];
    threePointPitchRad = Math.atan2(m[2] - t[2], m[0] - t[0]);
    cgAglM = Math.abs(ax * -m[2] - az * -m[0]) / Math.hypot(ax, az);
  }

  // ── lights ──
  const navS = 0.75, navX = tipStartX + navS * tipR, navLE = leZ + leBack * bow(navS);
  const lampY = (x: number) => yAt(x) + 0.012;
  const lights: LightLayout = {
    navLeft: v(-(navX + 0.015), yAt(navX) + 0.015, navLE - 0.015),
    navRight: v(navX + 0.015, yAt(navX) + 0.015, navLE - 0.015),
    navTail: v(0, rudderBottomY + 0.045, 4.3),
    beacon: v(0, finRootY + 0.96, 4.17),
    strobeLeft: v(-(halfSpan - 0.005), yAt(halfSpan) + 0.02, leZ + leBack + 0.06),
    strobeRight: v(halfSpan - 0.005, yAt(halfSpan) + 0.02, leZ + leBack + 0.06),
    landing: v(-2.2, lampY(2.2), leZ - 0.012),
    taxi: v(2.2, lampY(2.2), leZ - 0.012),
  };

  // ── cockpit (panel fixed under the windshield; seat and stick follow the eye) ──
  const tilt = 5 * D2R, pw = 0.6, ph = 0.3, panelTopY = deckY - 0.03, panelZ = -0.75;
  const panelCenter = v(0, panelTopY - (ph / 2) * Math.cos(tilt), panelZ);
  const panel: PanelLayout = { center: panelCenter, width: pw, height: ph, tiltRad: tilt, g1000Center: panelCenter.clone(), g1000Height: ph };
  const glareshield: GlareshieldLayout = { lipY: panelTopY + 0.015, lipZ: panelZ - (ph / 2) * Math.sin(tilt) - 0.002, frontY: deckY - 0.005, frontZ: zW0 + 0.012, width: 0.66 };
  const ez = Math.max(-0.5, Math.min(0.3, eye.z)), ey = Math.max(0.3, Math.min(0.85, eye.y));
  const cockpit: CubLayout['cockpit'] = {
    frontStick: { pivot: v(0, floorY + 0.03, ez - 0.36), length: 0.62 },
    rearStick: { pivot: v(0, floorY + 0.06, ez + 0.42), length: 0.55 },
    pedal: v(0.12, floorY + 0.13, -0.86),
    throttle: { pivot: v(-0.335, 0.06, ez - 0.25), length: 0.2, travelRad: 0.7 },
    trimCrank: { center: v(-0.345, 0.02, ez + 0.06), radius: 0.055 },
    flapHandle: { pivot: v(-0.29, -0.14, ez + 0.14), length: 0.3, fullRad: 0.9 },
    fuelGauge: { center: v(0.285, roofY - 0.1, 0.06), radius: 0.035 },
    seats: { front: { y: ey - 0.8, z: ez + 0.08 }, rear: { y: floorY + 0.24, z: Math.max(0.64, ez + 0.69) } },
    tubes: [
      // (the windshield-side frame is the lining strip between the cut-outs, with dark channels)
      ...[1, -1].map((s): TubeLayout => [v(s * 0.345, winTopY + 0.03, zW1 + 0.02), v(s * 0.335, winTopY + 0.02, 1.12)]), // upper longerons
      [v(-0.34, roofY - 0.045, zW1 + 0.03), v(0.34, roofY - 0.045, zW1 + 0.03)],            // front-spar carry-through
      [v(-0.34, roofY - 0.045, 0.64), v(0.34, roofY - 0.045, 0.64)],                         // rear-spar carry-through
      [v(0.335, sillY - 0.03, 0.63), v(0.345, winTopY + 0.02, 0.63)],                       // right: door rear post
      [v(-0.335, sillY - 0.03, 0.22), v(-0.345, winTopY + 0.02, 0.22)],                     // left: window post
    ],
  };
  const tanks = cfg.tanks ?? [];
  const cap = (side: number) => tanks.find((t) => Math.sign(t.pos[1]) === side)?.capacityKg ?? 18 * AVGAS_KG_PER_GAL;

  const capX = 0.8, capZ = 0.2;
  return {
    airframe: 'cub',
    zNose: hz - 0.12, zTail: 4.96,
    fuselage: { stations, cowlEndZ: zW0, cabinEndZ: 1.2, firewallZ },
    windows, doors,
    cabin: { floorY, bellyY, deckY, roofY, sillY, windowTopY: winTopY, width: cabinW },
    wing: { sections: wingSections, airfoil: USA35B, hingeFraction: hf, flapSpan, aileronSpan, dihedralRad, halfSpan, rootX, tipStartX },
    struts,
    hstab: { stab, elevator, hingeZ, halfSpan: hHalf },
    fin: { sections: finSections, rootY: finRootY },
    rudder: { sections: rudderSections, bottomY: rudderBottomY, hingeZ: rudderHingeZ },
    wires,
    prop,
    gear: { nose: null, tail, mains },
    eye,
    panel, glareshield, lights,
    details: {
      noseInlets: { x: 0.18, y: hy + 0.11, r: 0.068, squash: 1.1 },
      exhaust: { x: 0.13, z: -1.12, length: 0.22, radius: 0.026, dir: v(0, -0.85, 0.53).normalize() },
      antenna: { z: 1.75, length: 0.5, radius: 0.006, dir: v(0, Math.cos(30 * D2R), Math.sin(30 * D2R)) },
      carbScoop: { center: v(0, hy - 0.3 - 0.025, hz + 0.33), size: v(0.17, 0.07, 0.24) },
      fuelCap: v(capX, yAt(capX) + airfoilUpper(USA35B, (capZ - leZ) / chord) * chord, capZ),
      pitot: { tip: v(-3.6, yAt(3.6) - 0.1, leZ - 0.2), length: 0.45 },
    },
    cockpit,
    tankCapacityKg: [cap(-1), cap(1)],
    livery: { regZ: [1.72, 3.02] },
    cgAglM, threePointPitchRad,
  };
}
