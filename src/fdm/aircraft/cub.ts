/**
 * Piper PA-18-150 Super Cub class (Lycoming O-320 150 hp, 74 in fixed-pitch climb propeller),
 * a tandem two-seat tail-dragger for bush flying.
 *
 * Body axes FRD (m) relative to the EMPTY CG, shared with src/aircraft3d (both are built to the
 * same numbers): wing leading edge x = +0.42, trailing edge x = −1.18, chord plane z = −1.02,
 * spinner tip x = +1.92, rudder trailing edge x = −4.96, propeller hub (1.80, 0, −0.05).
 * The Piper datum is the wing leading edge, so a Piper arm of A inches aft of the datum is
 * x = 0.42 − A·0.0254 m.
 *
 * Numbers: PA-18-150 owner's handbook and type certificate figures (facts), Lycoming O-320-A
 * data, NACA Report 640 (propeller), NACA TR 315/USA 35B section characteristics, USAF DATCOM
 * methods for the tail, damping and control derivatives, JSBSim J3Cub/c172p as reference
 * numbers only. See `meta.sources`.
 */
import type { AircraftConfig, ElectricalSpec, GearSpec, PistonEngineSpec, Vec3 } from '../../core/types';
import { AVGAS_KG_PER_GAL, HP, LB } from '../../core/units';

const IN = 0.0254;
/** Piper arm (inches aft of the wing leading edge datum) → body x relative to the empty CG */
export const cubArm = (inchesAftOfDatum: number): number => 0.42 - inchesAftOfDatum * IN;

/** Shared airframe numbers (also used by src/aircraft3d). */
export const CUB_GEOMETRY = {
  spanM: 10.73,
  wingAreaM2: 16.58,
  chordM: 1.6,
  wingLeadingEdgeX: 0.42,
  wingTrailingEdgeX: -1.18,
  wingChordPlaneZ: -1.02,
  dihedralDeg: 1,
  lengthM: 6.88,
  heightM: 2.04,
  propHub: [1.8, 0, -0.05] as Vec3,
  propDiameterM: 1.88,
  mainGear: [0.5, 0.92, 1.12] as Vec3, // y is ± per side
  mainTyreRadiusM: 0.28,
  tailWheel: [-4.4, 0, 0.15] as Vec3,
  tailTyreRadiusM: 0.08,
  eyePoint: [0.05, 0, -0.6] as Vec3,
} as const;

const G = CUB_GEOMETRY;
const tipY = G.spanM / 2;
const tipZ = G.wingChordPlaneZ - tipY * Math.tan(G.dihedralDeg * Math.PI / 180);

const wheel = (name: string, pos: Vec3, k: number, cComp: number, cRebound: number, tyreRadius: number, brake: GearSpec['brakeGroup']): GearSpec => ({
  name, pos, type: 'wheel', k, cComp, cRebound, tyreRadius,
  muStatic: 0.8, muDynamic: 0.5, muRolling: 0.02, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: 0, casters: false, brakeGroup: brake, retractable: false,
});
const structure = (name: string, pos: Vec3): GearSpec => ({
  name, pos, type: 'structure', k: 200_000, cComp: 20_000, cRebound: 20_000, tyreRadius: 0,
  muStatic: 0.35, muDynamic: 0.3, muRolling: 0.3, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: 0, casters: false, brakeGroup: 'none', retractable: false,
});

const FUEL_TANK_GAL = 18;
const FUEL_USABLE_GAL = 17.9;

export const CUB_MASS: AircraftConfig['mass'] = {
  // standard empty weight with the 14 V electrical system, starter and full oil: ≈ 990 lb
  emptyMassKg: 450,
  emptyCG: [0, 0, 0], // ≈ +16.5 in aft of the leading-edge datum (envelope +7 … +20 in at 1,750 lb)
  // Component build-up (wing panels and struts 90 kg spread over the span, engine and propeller
  // ≈ 140 kg 1.3 m ahead, tail group ≈ 30 kg 4.4 m aft, wing 1 m above the CG).
  emptyInertia: { Ixx: 820, Iyy: 1100, Izz: 1650, Ixz: 0 },
  stations: [
    // TCDS arms: front seat +9 in, rear seat +36 in, baggage +50 in (max 50 lb)
    { name: 'Front seat', pos: [0.15, 0, -0.1], massKg: 77, maxKg: 120 },
    { name: 'Rear seat', pos: [cubArm(36), 0, -0.15], massKg: 0, maxKg: 120 },
    { name: 'Baggage', pos: [cubArm(50), 0, 0], massKg: 0, maxKg: 50 * LB },
  ],
  tanks: [
    { name: 'Left', pos: [-0.2, -0.8, -1.0], capacityKg: FUEL_TANK_GAL * AVGAS_KG_PER_GAL, usableKg: FUEL_USABLE_GAL * AVGAS_KG_PER_GAL, contentsKg: FUEL_TANK_GAL * AVGAS_KG_PER_GAL, selector: 'left' },
    { name: 'Right', pos: [-0.2, 0.8, -1.0], capacityKg: FUEL_TANK_GAL * AVGAS_KG_PER_GAL, usableKg: FUEL_USABLE_GAL * AVGAS_KG_PER_GAL, contentsKg: FUEL_TANK_GAL * AVGAS_KG_PER_GAL, selector: 'right' },
  ],
  maxTakeoffKg: 1750 * LB, // 793.8 kg
};

/**
 * Gear: bungee-sprung split-axle mains (soft, lightly damped: a firm arrival bounces) on 8.00-6
 * tyres, a leaf-spring steerable/full-swivel tail wheel behind the CG, structural points for
 * the propeller disc, the tail post and the wing tips.
 */
export const CUB_GEAR: GearSpec[] = [
  // heel brakes (single-puck discs): torque-limited well below tyre grip, so standing on them in the
  // three-point attitude does not stand the aircraft on its nose (that needs μ ≈ 0.7 here)
  { ...wheel('Left main', [G.mainGear[0], -G.mainGear[1], G.mainGear[2]], 40_000, 1_500, 3_000, G.mainTyreRadiusM, 'left'), brakeMu: 0.4 },
  { ...wheel('Right main', [G.mainGear[0], G.mainGear[1], G.mainGear[2]], 40_000, 1_500, 3_000, G.mainTyreRadiusM, 'right'), brakeMu: 0.4 },
  // Scott 3200-style tail wheel: steered by the rudder springs through ±25°, unlocks into full swivel
  // when the tyre is dragged sideways (brake-assisted pivots, ground loops), relocks near centre
  { ...wheel('Tail', [...G.tailWheel] as Vec3, 25_000, 900, 1_400, G.tailTyreRadiusM, 'none'), maxSteerDeg: 25, casters: true, swivel: { breakoutN: 400, relockDeg: 6 } },
  // lowest point of the 74 in propeller disc
  structure('Propeller', [G.propHub[0], 0, G.propHub[2] + G.propDiameterM / 2]),
  structure('Tail post', [-4.5, 0, -0.02]),
  structure('Left wingtip', [(G.wingLeadingEdgeX + G.wingTrailingEdgeX) / 2, -tipY, tipZ]),
  structure('Right wingtip', [(G.wingLeadingEdgeX + G.wingTrailingEdgeX) / 2, tipY, tipZ]),
];

export const CUB_PROPELLER: NonNullable<AircraftConfig['propulsion']['propeller']> = {
  diameterM: G.propDiameterM,
  blades: 2,
  inertia: 1.9, // 74 in aluminium climb propeller ≈ 1.4 slug·ft²
  // Scaled from NACA Report 640 (2-blade, Clark Y) to a 74 × 42 in climb propeller
  // (P/D 0.57, β0.75R ≈ 14°): static Ct 0.112 / Cp 0.056 (≈ 600 lbf at 2,370 rpm), η 0.68 at the
  // best-rate J ≈ 0.43, peak η 0.81 at the cruise J ≈ 0.66, zero thrust near J 0.95.
  Ct: { xs: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 3.0], ys: [0.112, 0.109, 0.103, 0.094, 0.083, 0.0715, 0.0605, 0.048, 0.031, 0.011, -0.009, -0.027, -0.041, -0.051, -0.063, -0.074, -0.079] },
  Cp: { xs: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 3.0], ys: [0.056, 0.0555, 0.0545, 0.053, 0.0512, 0.049, 0.0458, 0.0415, 0.035, 0.025, 0.012, 0, -0.012, -0.022, -0.036, -0.05, -0.055] },
  sense: 1, // clockwise seen from the cockpit, as the C172
  pFactorM: 0.24,
  position: [...G.propHub] as Vec3,
  fixedPitch: true,
};

// ───────────────────────────── aerodynamics ─────────────────────────────
// USA 35B section (≈ 5 % camber) on a constant-chord, strut-braced wing: zero lift at body
// α ≈ −7.4°, CL ≈ 0.61 at zero body α, lift-curve slope 4.7/rad for AR 6.9 (lifting line), gentle
// round-topped stall (CLmax 1.74) at body α ≈ 15.5°, about 4.5° above the three-point attitude, so
// a three-point touchdown near the stall speed does not balloon.

/** CL vs body α: rows α (rad), columns [attached branch, post-stall branch]. */
const CL_ALPHA = [-0.35, -0.28, -0.23, -0.17, -0.1, -0.05, 0, 0.05, 0.1, 0.13, 0.16, 0.18, 0.2, 0.22, 0.24, 0.26, 0.27, 0.29, 0.31, 0.33, 0.36];
const CL_NORMAL = [-0.55, -0.7, -0.47, -0.19, 0.14, 0.375, 0.61, 0.845, 1.08, 1.215, 1.345, 1.43, 1.51, 1.58, 1.65, 1.71, 1.74, 1.72, 1.64, 1.52, 1.36];
const CL_POST = [-0.55, -0.7, -0.47, -0.19, 0.14, 0.375, 0.61, 0.845, 1.03, 1.08, 1.12, 1.15, 1.17, 1.19, 1.21, 1.23, 1.24, 1.26, 1.28, 1.3, 1.33];
const FLAPS = [0, 25, 50];
/** ΔCL at constant α (plain flaps over ≈ 40 % of the span) */
const FLAP_DCL = [0, 0.27, 0.45];
/** induced drag factor 1/(π·e·AR), e ≈ 0.70 (strut-braced constant-chord wing, slab-sided fuselage) */
const K_INDUCED = 1 / (Math.PI * 0.7 * ((10.73 * 10.73) / 16.58));
/**
 * α/flap drag table: induced drag of the flapped wing plus separated-flow drag as the stall
 * approaches (the flap's own profile drag is `CD.dFlap`).
 */
const CD_DATA = CL_ALPHA.flatMap((a, i) => FLAPS.map((_, j) => {
  const cl = CL_NORMAL[i] + FLAP_DCL[j];
  const sep = a > 0.18 ? 6 * (a - 0.18) * (a - 0.18) : a < -0.2 ? 3 * (a + 0.2) * (a + 0.2) : 0;
  return K_INDUCED * cl * cl + sep;
}));

const CUB_AERO: AircraftConfig['aero'] = {
  CL: {
    table: { rows: CL_ALPHA, cols: [0, 1], data: CL_ALPHA.flatMap((_, i) => [CL_NORMAL[i], CL_POST[i]]) },
    hystOnRad: 0.29,
    hystOffRad: 0.14,
    dFlap: { xs: FLAPS, ys: FLAP_DCL },
    dElev: 0.36,
    q: 4.2,
    adot: 1.6,
    CD90: 1.6,
  },
  CD: {
    // zero-lift drag ≈ 8 ft² flat plate: fabric, struts and wires, 8.00-6 tyres, open tail bracing
    CD0: 0.045,
    alphaFlapTable: { rows: CL_ALPHA, cols: FLAPS, data: CD_DATA },
    dFlap: { xs: FLAPS, ys: [0, 0.014, 0.05] },
    dElevAbs: 0.06,
    betaAbs: 0.15,
    gearDown: 0,
    speedbrake: 0,
  },
  CY: { beta: -0.31, p: -0.05, r: 0.2, da: 0, dr: 0.17 },
  // Cl_r, Cy_p/r and Cn_δa get α terms in aero.ts (they grow with lift); these are the zero-α values
  Cl: { beta: -0.075, p: -0.5, r: 0.11, da: 0.17, dr: 0.012 },
  Cm: {
    Cm0: -0.11,
    alpha: -0.75,
    q: -10.5,
    adot: -4.5,
    de: -1.0,
    dFlap: { xs: FLAPS, ys: [0, -0.03, -0.06] },
    highAlphaScale: { xs: [0, 0.35, 0.44, 0.61, 0.79, 0.96, 1.13, 1.57], ys: [1, 1, 0.6, 0.4, 0.5, 0.4, 0.2, 0.1] },
    deHighAlphaScale: { xs: [0, 0.33, 0.44, 0.61, 0.79, 0.96], ys: [1, 1, 0.6, 0.3, 0.15, 0.1] },
  },
  // plain (non-Frise, non-differential) ailerons: large adverse yaw, growing with lift in aero.ts.
  // Spiralling slipstream: ≈ 7–8° of swirl at the immersed part of the 1.1 m² fin is ≈ 950 N·m nose-left
  // at full static power (the C172's −0.05 would give twice that, as much as full rudder in the wash).
  Cn: { beta: 0.05, p: -0.05, r: -0.085, da: -0.035, dr: -0.05, slipstream: -0.025 },
  groundEffect: {
    hOverB: [0, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
    kCL: [1.203, 1.127, 1.09, 1.073, 1.046, 1.028, 1.019, 1.013, 1.008, 1.006, 1.003, 1.002, 1.0],
    kCD: [0.48, 0.515, 0.629, 0.709, 0.815, 0.882, 0.928, 0.962, 0.988, 1.0, 1.0, 1.0, 1.0],
  },
  controlsUseSlipstreamQ: { elevator: true, rudder: true },
  // The contracted wake (≈ 1.4 m) covers ≈ 40 % of the 3.2 m stabiliser; the fin and the big
  // rudder sit right behind the propeller, most of them in it.
  slipstreamImmersion: { elevator: 0.3, rudder: 0.65 },
  // most of Cm_q and Cn_r comes from the tail, which keeps damping in the wash at taxi speeds
  slipstreamDamping: { pitch: 0.85, yaw: 0.75 },
  blendStartRad: 0.36,
  blendEndRad: 0.55,
  // stall-warning vane on the left wing: ≈ 5 kt above the stall
  stallWarnAlphaRad: 0.19,
  stalledAlphaRad: 0.29,
};

// ───────────────────────────── engine, systems, controls ─────────────────────────────

/** Lycoming O-320-A2B: 150 hp at 2,700 rpm, 319.8 in³, 7.0:1, float carburettor. */
const CUB_ENGINE: PistonEngineSpec = {
  type: 'piston',
  ratedPowerW: 150 * HP,
  ratedRPM: 2700,
  idleRPM: 600,
  displacementM3: 319.8 * 1.6387064e-5,
  VE: 0.88,
  // 7.0:1 compression: less efficient than the 172S's 8.5:1 IO-360
  ISFC: 0.52,
  maxMAPinHg: 28.5,
  minMAPinHg: 9,
  frictionA: 14,
  frictionB: 0.07,
  inertia: 0.25,
  mixtureEfficiency: {
    xs: [0.05, 0.0514, 0.0518, 0.0543, 0.0584, 0.0631, 0.0694, 0.0779, 0.0885, 0.0927, 0.1012, 0.1146, 0.1216, 0.13, 0.15, 0.18],
    ys: [0, 0.0086, 0.2155, 0.4828, 0.7069, 0.8362, 0.931, 1.0, 1.0, 0.9828, 0.931, 0.726, 0.582, 0.4425, 0.2065, 0],
  },
  cylinders: 4,
  starterTorqueNm: 110,
  throttleAreaIdleM2: 4.2e-5,
  throttleAreaMaxM2: 1.1e-3,
  manifoldVolumeM3: 0.0035,
  minFiringRPM: 120,
};

/**
 * 14 V system: 12 V 25 Ah battery, 40 A alternator, master switch, a radio/transponder bus.
 * No pitot heat and no electric fuel pump (gravity-fed wing tanks).
 */
export const PA18_ELECTRICAL: ElectricalSpec = {
  capacityAh: 25,
  internalOhm: 0.012,
  alternatorMaxA: 40,
  regulatorV: 14.2,
  alternatorFullRpm: 1700,
  alternatorCutInRpm: 600,
  dropOutV: 9,
  lowVoltsV: 12.5,
  loadsA: { base: 1.0, avionics: 4, nav: 4.5, beacon: 3, strobe: 4, landing: 7.5, taxi: 7.5, panel: 1, pitotHeat: 0, fuelPump: 0, starter: 200 },
  batteryNominalV: 12,
};

export const PA18_150: AircraftConfig = {
  id: 'pa18-150',
  name: 'Piper PA-18-150 Super Cub',
  manufacturer: 'Piper',
  category: 'ga-piston',
  meta: {
    sources: [
      'Piper PA-18-150 Super Cub owner\'s handbook: performance and airspeed limits (facts)',
      'FAA Type Certificate Data Sheet 1A2 (PA-18 series): weights, C.G. range, seat/baggage/fuel arms',
      'Lycoming O-320-A operator\'s manual: rating, displacement, compression, idle',
      'NACA Report 640 propeller coefficients (public domain), scaled to a 74 × 42 in climb propeller',
      'NACA TR 315 / USA 35B section characteristics (public domain)',
      'USAF DATCOM methods: tail volumes, damping and control derivatives (public domain)',
      'JSBSim J3Cub and c172p (LGPL-2.1) — reference numbers only',
      'MIL-F-8785C (public domain)',
    ],
    license: 'Compilation © Flight Sim contributors, MIT; underlying engineering data as cited',
    notes: 'Validated in cub.test.ts against the handbook figures (stall 41/37 KIAS at 1,750 lb, '
      + 'climb 960 fpm, 113/100 KTAS, take-off run 200 ft, landing roll 350 ft). No published ASI '
      + 'calibration: IAS = CAS.',
  },
  geometry: {
    S: G.wingAreaM2,
    b: G.spanM,
    cbar: 1.58,
    // wing quarter chord in the chord plane
    arpOffset: [G.wingLeadingEdgeX - 0.25 * G.chordM, 0, G.wingChordPlaneZ],
    macHeightOnGround: 2.0,
    lengthM: G.lengthM,
    heightM: G.heightM,
    eyePoint: [...G.eyePoint] as Vec3,
  },
  mass: CUB_MASS,
  aero: CUB_AERO,
  propulsion: { engine: CUB_ENGINE, propeller: CUB_PROPELLER, enginePositions: [[...G.propHub] as Vec3] },
  gear: CUB_GEAR,
  controls: {
    elevator: { minDeg: -30, maxDeg: 20, tauS: 0.06, rateDegPerS: 80 },
    // Rigged for hands-off cruise at ≈ 90 KCAS (wing washout at the rear-strut forks, fixed rudder
    // tab): wings level, ball centred. Climb power needs right rudder, idle a little left.
    aileron: { upDeg: 20, downDeg: 18, tauS: 0.05, rateDegPerS: 100, rigNorm: 0.0205 },
    rudder: { maxDeg: 25, tauS: 0.05, rateDegPerS: 100, rigNorm: 0.004 },
    // manual flap handle: up / first notch / full
    flaps: { detentsDeg: FLAPS, transitS: [1, 1] },
    // stabiliser trim (jack screw) modelled as elevator trim
    trim: { elevatorFraction: [0.6, 0.6], rateNormPerS: 0.25 },
    // tail wheel steering arc through the rudder springs
    nosewheelSteerDeg: 25,
  },
  limits: {
    // handbook mph → kt: Vne 153, Vno 122, Vfe 70, Vs0 43, Vs1 47 mph; Va = Vs1·√3.8
    VneKt: 133, VnoKt: 106, VaKt: 80, VfeKt: [61, 61], VsoKt: 37, Vs1Kt: 41,
    VxKt: 50, VyKt: 61, VrKt: 40, VgKt: 55,
    nzMax: 3.8, nzMin: -1.52, maxRPM: 2700, redlineRPM: 2700,
  },
  panel: 'cub-steam',
  airframe: 'cub',
  electrical: PA18_ELECTRICAL,
  airspeedCalibration: {
    flapsUp: { xs: [30, 140], ys: [30, 140] },
    flapsFull: { xs: [30, 140], ys: [30, 140] },
  },
};
