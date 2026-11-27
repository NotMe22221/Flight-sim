/**
 * Airbus A320-style twin-jet airliner (CFM56-5B-class engines). Public figures (dimensions, weights,
 * thrust, speeds) with a coefficient build-up tuned to them; not a certified data set.
 *
 * Body frame: x forward, y right, z down, origin at the empty-aircraft CG (fuselage centreline,
 * about 17 m behind the nose). Low swept wing, two underwing engines, tricycle retractable gear.
 *
 * Handbook ballpark targets (src/fdm/aircraft/a320.test.ts): lift-off ≈ 145 kt in ≈ 1,800 m at 65 t
 * with flaps 1+F; cruise FL350 M0.78 at ≈ 85 % N1; approach ≈ 135 kt flaps FULL; stall ≈ 145 kt clean,
 * ≈ 107 kt FULL at 65 t.
 */
import type { AircraftConfig, GearSpec, Vec3 } from '../../core/types';

const KG = 1;

/** α rows (rad); CL normal branch and post-stall branch. */
const CL_ALPHA = [-0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.24, 0.27, 0.3, 0.35, 0.45, 0.6];
const CL_NORMAL = [-0.85, -0.31, 0.22, 0.485, 0.75, 1.015, 1.28, 1.45, 1.52, 1.4, 1.15, 1.0, 0.9];
const CL_POST = [-0.85, -0.31, 0.22, 0.485, 0.75, 1.0, 1.12, 1.15, 1.13, 1.1, 1.02, 0.96, 0.9];
/** flap detents (deg) and their lift increments (slats + flaps: 1, 2, 3, FULL) */
const FLAPS = [0, 10, 15, 20, 35];
const DCL_FLAP = [0, 0.38, 0.62, 0.82, 1.22];
/** induced drag factor k = 1 / (π e AR), AR = 34.1² / 122.6 ≈ 9.5, e ≈ 0.78 */
const K_IND = 0.043;

const clAt = (a: number): number => {
  for (let i = 1; i < CL_ALPHA.length; i++) {
    if (a <= CL_ALPHA[i]) { const t = (a - CL_ALPHA[i - 1]) / (CL_ALPHA[i] - CL_ALPHA[i - 1]); return CL_NORMAL[i - 1] + (CL_NORMAL[i] - CL_NORMAL[i - 1]) * Math.max(0, t); }
  }
  return CL_NORMAL[CL_NORMAL.length - 1];
};
/** CD(α, flap) table: induced drag of the total lift (table CL + flap increment). */
const CD_DATA = CL_ALPHA.flatMap((a) => FLAPS.map((_, j) => { const cl = clAt(a) + DCL_FLAP[j]; return K_IND * cl * cl; }));

const mainGear = (name: string, y: number): GearSpec => ({
  name, pos: [-0.9, y, 3.3], type: 'wheel', k: 1_300_000, cComp: 180_000, cRebound: 320_000, tyreRadius: 0.57,
  muStatic: 0.8, muDynamic: 0.55, muRolling: 0.015, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: 0, casters: false, brakeGroup: y < 0 ? 'left' : 'right', retractable: true, brakeMu: 0.45,
});
const structure = (name: string, pos: Vec3): GearSpec => ({
  name, pos, type: 'structure', k: 2_000_000, cComp: 200_000, cRebound: 200_000, tyreRadius: 0,
  muStatic: 0.35, muDynamic: 0.3, muRolling: 0.3, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
  maxSteerDeg: 0, casters: false, brakeGroup: 'none', retractable: false,
});

/** engines: under the wings, thrust line ≈ 1.6 m below the CG */
const ENGINES: Vec3[] = [[2.6, -5.75, 1.6], [2.6, 5.75, 1.6]];

export const A320: AircraftConfig = {
  id: 'a320',
  name: 'Airbus A320-style airliner',
  manufacturer: 'Airbus',
  category: 'airliner',
  airframe: 'a320',
  meta: {
    sources: ['Airbus A320 Aircraft Characteristics for Airport Planning (public figures)', 'CFM56-5B published thrust and TSFC (facts)', 'Standard performance estimates (Raymer, Torenbeek)'],
    license: 'Compilation © Flight Sim contributors, MIT',
    notes: 'Tuned to handbook ballpark figures; simplified (no MCDU, single throttle for both engines).',
  },
  geometry: {
    S: 122.6, b: 34.1, cbar: 4.19,
    arpOffset: [0.2, 0, 0.9],
    macHeightOnGround: 2.9,
    lengthM: 37.57, heightM: 11.76,
    // captain's eye: left seat, about 2.5 m behind the nose tip, near the top of the windscreen band
    eyePoint: [14.6, -0.55, -0.9],
  },
  mass: {
    emptyMassKg: 42_600,
    emptyCG: [0, 0, 0],
    emptyInertia: { Ixx: 0.95e6, Iyy: 2.6e6, Izz: 3.45e6, Ixz: 0 },
    stations: [
      { name: 'Flight crew', pos: [14.2, 0, -0.2], massKg: 170 * KG, maxKg: 250 },
      { name: 'Passengers, front cabin', pos: [6, 0, 0], massKg: 5_000, maxKg: 7_200 },
      { name: 'Passengers, rear cabin', pos: [-6.5, 0, 0], massKg: 5_000, maxKg: 7_200 },
      { name: 'Forward cargo hold', pos: [5.5, 0, 1.3], massKg: 1_500, maxKg: 3_400 },
      { name: 'Aft cargo hold', pos: [-7.5, 0, 1.3], massKg: 1_500, maxKg: 4_500 },
    ],
    tanks: [
      { name: 'Left wing', pos: [-1, -6, 1.4], capacityKg: 6_200, usableKg: 6_150, contentsKg: 4_500, selector: 'left' },
      { name: 'Right wing', pos: [-1, 6, 1.4], capacityKg: 6_200, usableKg: 6_150, contentsKg: 4_500, selector: 'right' },
      { name: 'Centre', pos: [0.5, 0, 1.6], capacityKg: 6_500, usableKg: 6_450, contentsKg: 0, selector: 'center' },
    ],
    maxTakeoffKg: 78_000,
    // ≈ 17 % … 40 % MAC in body x (MAC 4.19 m, leading edge ≈ 1.25 m ahead of the empty CG)
    cgLimitsM: [0.54, -0.43],
  },
  aero: {
    CL: {
      table: { rows: CL_ALPHA, cols: [0, 1], data: CL_ALPHA.flatMap((_, i) => [CL_NORMAL[i], CL_POST[i]]) },
      hystOnRad: 0.28, hystOffRad: 0.18,
      dFlap: { xs: FLAPS, ys: DCL_FLAP },
      dElev: 0.35, q: 6.5, adot: 2.5, CD90: 1.6,
      spoiler: -0.45,
    },
    CD: {
      CD0: 0.019,
      alphaFlapTable: { rows: CL_ALPHA, cols: FLAPS, data: CD_DATA },
      dFlap: { xs: FLAPS, ys: [0, 0.012, 0.02, 0.032, 0.075] },
      dElevAbs: 0.03, betaAbs: 0.25,
      gearDown: 0.022, speedbrake: 0.03,
      mach: { xs: [0, 0.6, 0.72, 0.78, 0.82, 0.86, 0.9, 1.0], ys: [0, 0, 0.0005, 0.002, 0.006, 0.016, 0.035, 0.08] },
    },
    CY: { beta: -0.9, p: 0, r: 0.6, da: 0, dr: 0.3 },
    Cl: { beta: -0.12, p: -0.45, r: 0.15, da: 0.12, dr: 0.015 },
    Cm: {
      Cm0: 0.05, alpha: -1.5, q: -30, adot: -10, de: -1.6,
      dFlap: { xs: FLAPS, ys: [0, -0.02, -0.04, -0.05, -0.08] },
      highAlphaScale: { xs: [0, 0.3, 0.45, 0.785, 1.571], ys: [1, 1, 0.8, 0.5, 0.2] },
      deHighAlphaScale: { xs: [0, 0.3, 0.45, 0.785], ys: [1, 1, 0.6, 0.3] },
    },
    Cn: { beta: 0.12, p: -0.02, r: -0.25, da: -0.005, dr: -0.12, slipstream: 0 },
    groundEffect: {
      hOverB: [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.1],
      kCL: [1.15, 1.1, 1.06, 1.04, 1.025, 1.01, 1.004, 1.001, 1.0],
      kCD: [0.55, 0.6, 0.72, 0.82, 0.88, 0.95, 0.99, 1.0, 1.0],
    },
    controlsUseSlipstreamQ: { elevator: false, rudder: false },
    blendStartRad: 0.45, blendEndRad: 0.65,
    stallWarnAlphaRad: 0.24, stalledAlphaRad: 0.28,
  },
  propulsion: {
    engine: {
      type: 'turbofan',
      ratedThrustN: 120_000,
      // ≈ 0.36 lb/lbf/h static; the model raises it with Mach (≈ 0.6 at cruise)
      tsfc: 1.0e-5,
      idleN1: 0.2,
      spoolTauS: 1.6,
      // fraction of the static rated thrust: Mach (rows) × altitude m (cols), ≈ σ^0.85 × (1 − 0.45 M + 0.3 M²), lapsing faster above 6 km (max climb ≈ 24 % of static at FL350)
      milThrust: {
        rows: [0, 0.2, 0.4, 0.6, 0.8, 0.9],
        cols: [0, 3000, 6000, 9000, 11000, 12500],
        data: [
          1.0, 0.776, 0.565, 0.385, 0.29, 0.232,
          0.922, 0.716, 0.521, 0.355, 0.267, 0.214,
          0.868, 0.674, 0.49, 0.334, 0.252, 0.202,
          0.838, 0.65, 0.473, 0.322, 0.243, 0.195,
          0.832, 0.646, 0.47, 0.32, 0.241, 0.193,
          0.838, 0.65, 0.473, 0.322, 0.243, 0.195,
        ],
      },
      reverserFraction: 0.35,
    },
    enginePositions: ENGINES,
  },
  gear: [
    {
      name: 'Nose', pos: [12.2, 0, 3.3], type: 'wheel', k: 420_000, cComp: 70_000, cRebound: 120_000, tyreRadius: 0.38,
      muStatic: 0.8, muDynamic: 0.55, muRolling: 0.015, pacejka: { B: 0.06, C: 2.8, E: 1.03 },
      maxSteerDeg: 30, casters: false, brakeGroup: 'none', retractable: true,
    },
    mainGear('Left main', -3.8),
    mainGear('Right main', 3.8),
    structure('Tail', [-15.5, 0, 1.75]),
    structure('Belly', [1, 0, 2.0]),
    structure('Nose cone', [16.2, 0, 2.2]),
    structure('Left engine', [3.6, -5.75, 2.75]),
    structure('Right engine', [3.6, 5.75, 2.75]),
    structure('Left wingtip', [-6.5, -17, 1.6]),
    structure('Right wingtip', [-6.5, 17, 1.6]),
  ],
  controls: {
    elevator: { minDeg: -30, maxDeg: 17, tauS: 0.12, rateDegPerS: 40 },
    aileron: { upDeg: 25, downDeg: 20, tauS: 0.08, rateDegPerS: 50, rigNorm: 0 },
    rudder: { maxDeg: 25, tauS: 0.1, rateDegPerS: 40, rigNorm: 0 },
    flaps: { detentsDeg: FLAPS, transitS: [8, 6, 6, 10] },
    trim: { elevatorFraction: [0.5, 0.5], rateNormPerS: 0.08 },
    nosewheelSteerDeg: 30,
    gearTransitS: 8,
    groundSpoilers: true,
    flyByWire: true,
  },
  limits: {
    VneKt: 350, VnoKt: 320, VaKt: 250, VfeKt: [230, 215, 200, 185], VsoKt: 107, Vs1Kt: 145,
    VxKt: 200, VyKt: 250, VrKt: 140, VgKt: 210, VloKt: 250, VleKt: 280,
    nzMax: 2.5, nzMin: -1, maxRPM: 5175, redlineRPM: 5380,
  },
  panel: 'airliner-pfd',
};
