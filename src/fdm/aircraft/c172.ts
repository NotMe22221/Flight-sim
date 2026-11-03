/**
 * Cessna 172S Skyhawk (Lycoming IO-360-L2A 180 hp, McCauley 76 in fixed-pitch propeller).
 *
 * Numbers are compiled from docs/research/02-flight-dynamics-model.md: JSBSim c172p/c172x
 * (LGPL-2.1, used as reference data only), the FlightGear c172p project (GPL-2.0, reference
 * only), NACA Report 640 propeller data and Cessna 172S POH figures. Re-tuned where the
 * research recommends it (Cmα, CLmax, gear track and damping, Cnδr).
 *
 * Geometry: JSBSim structural frame (inches; x aft of the firewall datum, y right, z up),
 * converted to body axes (m; x forward, y right, z down) relative to the empty CG at
 * FS 41.0 / BL 0 / WL 36.5.
 */
import type { AircraftConfig, GearSpec, Vec3 } from '../../core/types';
import { HP, KT, LB } from '../../core/units';

const IN = 0.0254;
const CG: Vec3 = [41, 0, 36.5];
/** structural inches → body metres relative to the empty CG */
export const fromStructural = (x: number, y: number, z: number): Vec3 => [-(x - CG[0]) * IN, (y - CG[1]) * IN, -(z - CG[2]) * IN];

const DEG = Math.PI / 180;
const r = (deg: number) => deg * DEG;

const wheel = (name: string, pos: Vec3, k: number, cComp: number, cRebound: number, tyreRadius: number, steer: number, brake: GearSpec['brakeGroup']): GearSpec => ({
  name, pos, type: 'wheel', k, cComp, cRebound, tyreRadius,
  muStatic: 0.8, muDynamic: 0.5, muRolling: 0.02, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: steer, casters: false, brakeGroup: brake, retractable: false,
});
const structure = (name: string, pos: Vec3): GearSpec => ({
  name, pos, type: 'structure', k: 291_878, cComp: 29_188, cRebound: 29_188, tyreRadius: 0,
  muStatic: 0.35, muDynamic: 0.3, muRolling: 0.3, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: 0, casters: false, brakeGroup: 'none', retractable: false,
});

/** CL vs α: rows α (rad), columns [normal branch, post-stall branch]. */
const CL_ALPHA = [-0.3491, -0.2618, -0.2094, -0.1745, -0.09, 0, 0.09, 0.1, 0.12, 0.14, 0.16, 0.17, 0.19, 0.21, 0.24, 0.26, 0.28, 0.3, 0.32, 0.34, 0.36];
const CL_NORMAL = [-0.55, -0.65, -0.75, -0.62, -0.22, 0.25, 0.73, 0.83, 0.92, 1.02, 1.09, 1.15, 1.23, 1.31, 1.42, 1.52, 1.57, 1.52, 1.45, 1.34, 1.15];
const CL_POST = [-0.55, -0.65, -0.75, -0.62, -0.22, 0.25, 0.73, 0.78, 0.79, 0.81, 0.82, 0.83, 0.85, 0.86, 0.88, 0.9, 0.92, 0.95, 0.99, 1.05, 1.15];

/** Drag due to α and flap (c172p CDwbh + FlightGear post-stall rows + negative-α extension). */
const CD_ALPHA = [-0.3491, -0.2618, -0.1745, -0.0873, -0.0698, -0.0524, -0.0349, -0.0175, 0, 0.0175, 0.0349, 0.0524, 0.0698, 0.0873, 0.1047, 0.1222, 0.1396, 0.1571, 0.1745, 0.192, 0.2094, 0.2269, 0.2443, 0.2618, 0.2793, 0.3491, 0.5236, 0.6981, 0.8727, 1.0472, 1.2217, 1.3963, 1.571];
const CD_FLAPS = [0, 10, 20, 30];
// prettier-ignore
const CD_DATA = [
  0.2, 0.21, 0.22, 0.23,
  0.09, 0.095, 0.1, 0.105,
  0.028, 0.03, 0.034, 0.038,
  0.0041, 0.0, 0.0005, 0.0014,
  0.0013, 0.0004, 0.0025, 0.0041,
  0.0001, 0.0023, 0.0059, 0.0084,
  0.0003, 0.0057, 0.0108, 0.0141,
  0.002, 0.0105, 0.0172, 0.0212,
  0.0052, 0.0168, 0.0251, 0.0299,
  0.0099, 0.0248, 0.0346, 0.0402,
  0.0162, 0.0342, 0.0457, 0.0521,
  0.024, 0.0452, 0.0583, 0.0655,
  0.0334, 0.0577, 0.0724, 0.0804,
  0.0442, 0.0718, 0.0881, 0.0968,
  0.0566, 0.0874, 0.1053, 0.1148,
  0.0706, 0.1045, 0.124, 0.1343,
  0.086, 0.1232, 0.1442, 0.1554,
  0.0962, 0.1353, 0.1573, 0.169,
  0.1069, 0.1479, 0.1708, 0.183,
  0.118, 0.161, 0.1849, 0.1975,
  0.1298, 0.1746, 0.1995, 0.2126,
  0.1424, 0.1892, 0.2151, 0.2286,
  0.1565, 0.2054, 0.2323, 0.2464,
  0.1727, 0.224, 0.2521, 0.2667,
  0.1782, 0.2302, 0.2587, 0.2735,
  0.2537, 0.3298, 0.3755, 0.3983,
  0.45, 0.585, 0.666, 0.7065,
  0.7, 0.91, 1.036, 1.099,
  1.0, 1.3, 1.48, 1.57,
  1.35, 1.755, 1.998, 2.1195,
  1.5, 1.95, 2.22, 2.355,
  1.57, 2.041, 2.3236, 2.4649,
  1.6, 2.08, 2.368, 2.512,
];

export const C172S: AircraftConfig = {
  id: 'c172s',
  name: 'Cessna 172S Skyhawk',
  manufacturer: 'Cessna',
  category: 'ga-piston',
  meta: {
    sources: [
      'JSBSim c172p/c172x (LGPL-2.1) — reference numbers only',
      'FlightGear c172p (GPL-2.0) — reference numbers only',
      'NACA Report 640 propeller 5868-9 (public domain)',
      'Cessna 172S POH performance figures (facts)',
      'MIL-F-8785C (public domain)',
    ],
    license: 'Compilation © Flight Sim contributors, MIT; underlying engineering data as cited',
    notes: 'Tuned against docs/research/02 §10 validation checklist.',
  },
  geometry: {
    S: 174 * 0.09290304, // 16.165 m²
    b: 35.8 * 0.3048, // 10.91 m (table reference span)
    cbar: 4.9 * 0.3048, // 1.494 m
    arpOffset: fromStructural(43.2, 0, 59.4),
    macHeightOnGround: 1.9,
    lengthM: 8.28,
    heightM: 2.72,
    // pilot eye (left seat): matches the cockpit geometry of src/aircraft3d (c172Layout)
    eyePoint: [0.15, -0.25, -0.55],
  },
  mass: {
    emptyMassKg: 767,
    emptyCG: [0, 0, 0],
    emptyInertia: { Ixx: 1285, Iyy: 1825, Izz: 2667, Ixz: 0 },
    stations: [
      { name: 'Pilot', pos: fromStructural(36, -14, 24), massKg: 77, maxKg: 140 },
      { name: 'Co-pilot', pos: fromStructural(36, 14, 24), massKg: 0, maxKg: 140 },
      { name: 'Rear left', pos: fromStructural(70, -14, 24), massKg: 0, maxKg: 140 },
      { name: 'Rear right', pos: fromStructural(70, 14, 24), massKg: 0, maxKg: 140 },
      { name: 'Baggage', pos: fromStructural(95, 0, 24), massKg: 0, maxKg: 54 },
    ],
    tanks: [
      { name: 'Left', pos: fromStructural(56, -80, 59.4), capacityKg: 28 * 3.785411784 * 0.72, usableKg: 26.5 * 3.785411784 * 0.72, contentsKg: 28 * 3.785411784 * 0.72, selector: 'left' },
      { name: 'Right', pos: fromStructural(56, 80, 59.4), capacityKg: 28 * 3.785411784 * 0.72, usableKg: 26.5 * 3.785411784 * 0.72, contentsKg: 28 * 3.785411784 * 0.72, selector: 'right' },
    ],
    maxTakeoffKg: 2550 * LB,
  },
  aero: {
    CL: {
      table: { rows: CL_ALPHA, cols: [0, 1], data: CL_ALPHA.flatMap((_, i) => [CL_NORMAL[i], CL_POST[i]]) },
      hystOnRad: 0.36,
      hystOffRad: 0.09,
      dFlap: { xs: [0, 10, 20, 30], ys: [0, 0.2, 0.3, 0.35] },
      dElev: 0.43,
      q: 3.9,
      adot: 1.7,
      CD90: 1.7,
    },
    CD: {
      CD0: 0.027,
      alphaFlapTable: { rows: CD_ALPHA, cols: CD_FLAPS, data: CD_DATA },
      dFlap: { xs: [0, 10, 20, 30], ys: [0, 0.007, 0.012, 0.018] },
      dElevAbs: 0.06,
      betaAbs: 0.17,
      gearDown: 0,
      speedbrake: 0,
    },
    CY: { beta: -0.393, p: -0.075, r: 0.214, da: 0, dr: 0.187 },
    Cl: { beta: -0.0923, p: -0.484, r: 0.0798, da: 0.229, dr: 0.0147 },
    Cm: {
      Cm0: 0.1,
      alpha: -1.2,
      q: -12.4,
      adot: -7.27,
      de: -1.122,
      dFlap: { xs: [0, 10, 20, 30], ys: [0, -0.03, -0.05, -0.06] },
      highAlphaScale: { xs: [0, 0.349, 0.436, 0.611, 0.785, 0.96, 1.134, 1.571], ys: [1, 1, 0.6, 0.4, 0.5, 0.4, 0.2, 0.1] },
      deHighAlphaScale: { xs: [0, 0.314, 0.436, 0.611, 0.785, 0.96], ys: [1, 1, 0.6, 0.3, 0.15, 0.1] },
    },
    Cn: { beta: 0.0587, p: -0.0278, r: -0.0937, da: -0.0216, dr: -0.055, slipstream: -0.05 },
    groundEffect: {
      hOverB: [0, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
      kCL: [1.203, 1.127, 1.09, 1.073, 1.046, 1.028, 1.019, 1.013, 1.008, 1.006, 1.003, 1.002, 1.0],
      kCD: [0.48, 0.515, 0.629, 0.709, 0.815, 0.882, 0.928, 0.962, 0.988, 1.0, 1.0, 1.0, 1.0],
    },
    controlsUseSlipstreamQ: { elevator: true, rudder: true },
    blendStartRad: 0.36,
    blendEndRad: 0.55,
  },
  propulsion: {
    engine: {
      type: 'piston',
      ratedPowerW: 180 * HP,
      ratedRPM: 2700,
      idleRPM: 650,
      displacementM3: 361 * 1.6387064e-5,
      VE: 0.88,
      ISFC: 0.48,
      maxMAPinHg: 28.5,
      minMAPinHg: 9,
      frictionA: 16,
      frictionB: 0.08,
      inertia: 0.3,
      // Fuel/air ratio → combustion efficiency (JSBSim correlation). Rich of 0.10 the product
      // η·FA falls monotonically (excess fuel is not burnt), so enriching never adds power; the
      // tail past 0.12 is gentler than JSBSim's so an un-leaned engine at altitude runs rough
      // instead of quitting.
      mixtureEfficiency: {
        xs: [0.05, 0.0514, 0.0518, 0.0543, 0.0584, 0.0631, 0.0694, 0.0779, 0.0885, 0.0927, 0.1012, 0.1146, 0.1216, 0.13, 0.15, 0.18],
        ys: [0, 0.0086, 0.2155, 0.4828, 0.7069, 0.8362, 0.931, 1.0, 1.0, 0.9828, 0.931, 0.726, 0.582, 0.4425, 0.2065, 0],
      },
      cylinders: 4,
      starterTorqueNm: 120,
      throttleAreaIdleM2: 4.6e-5,
      throttleAreaMaxM2: 1.25e-3,
      manifoldVolumeM3: 0.004,
      minFiringRPM: 120,
    },
    propeller: {
      diameterM: 76 * IN,
      blades: 2,
      inertia: 1.67 * 1.355818,
      // NACA Report 640, propeller 5868-9 at 20° (FlightGear prop_76in2f_NACA_20deg)
      Ct: { xs: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 3.0], ys: [0.104, 0.104, 0.103, 0.101, 0.093, 0.082, 0.07, 0.055, 0.039, 0.024, 0.006, -0.014, -0.033, -0.045, -0.06, -0.072, -0.08] },
      Cp: { xs: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 3.0], ys: [0.066, 0.065, 0.064, 0.0625, 0.06, 0.058, 0.054, 0.0475, 0.037, 0.026, 0.01, 0, -0.01, -0.02, -0.035, -0.05, -0.055] },
      sense: 1,
      pFactorM: 0.25,
      position: fromStructural(-37.7, 0, 26.6),
      fixedPitch: true,
    },
    enginePositions: [fromStructural(-37.7, 0, 26.6)],
  },
  gear: [
    wheel('Nose', fromStructural(-6.8, 0, -19.5), 52_538, 7_000, 11_000, 0.17, 10, 'none'),
    wheel('Left main', fromStructural(58.2, -50, -15.5), 78_807, 12_000, 18_000, 0.19, 0, 'left'),
    wheel('Right main', fromStructural(58.2, 50, -15.5), 78_807, 12_000, 18_000, 0.19, 0, 'right'),
    structure('Propeller', fromStructural(-37.7, 0, 26.6)),
    structure('Tail', fromStructural(188, 0, 8)),
    structure('Left wingtip', fromStructural(43.2, -214.8, 59.4)),
    structure('Right wingtip', fromStructural(43.2, 214.8, 59.4)),
  ],
  controls: {
    elevator: { minDeg: -28, maxDeg: 23, tauS: 0.06, rateDegPerS: 80 },
    aileron: { upDeg: 20, downDeg: 15, tauS: 0.05, rateDegPerS: 100 },
    rudder: { maxDeg: 16, tauS: 0.05, rateDegPerS: 100 },
    flaps: { detentsDeg: [0, 10, 20, 30], transitS: [2.9, 2.9, 2.9] },
    trim: { elevatorFraction: [0.43, 0.39], rateNormPerS: 0.15 },
    nosewheelSteerDeg: 10,
  },
  limits: {
    VneKt: 163, VnoKt: 129, VaKt: 105, VfeKt: [110, 85, 85], VsoKt: 40, Vs1Kt: 48,
    VxKt: 62, VyKt: 74, VrKt: 55, VgKt: 68,
    nzMax: 3.8, nzMin: -1.52, maxRPM: 2700, redlineRPM: 2700,
  },
  panel: 'c172-steam',
};

/** Convenience: unit sanity values for tests. */
export const C172S_CHECK = { Vs1Kcas: 53 * KT, Vs0Kcas: 48 * KT, elevatorUpRad: r(28) };
