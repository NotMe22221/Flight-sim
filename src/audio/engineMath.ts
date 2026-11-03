/**
 * Pure acoustic laws for the piston engine and propeller synthesis (docs/research/06 §A2, §A3).
 * No Web Audio here so everything is unit-testable in Node.
 */
import { clamp, mulberry32 } from '../core/math';

/** Firing frequency of a reciprocating engine, Hz: rpm/60 · cylinders / (strokes/2). 4-cyl 4-stroke @2400 → 80 Hz. */
export const firingFrequencyHz = (rpm: number, cylinders: number, strokes: 2 | 4 = 4): number =>
  (Math.max(0, rpm) / 60) * cylinders / (strokes / 2);

/** Full engine-cycle frequency (one firing of every cylinder), Hz: rpm/120 for a 4-stroke. */
export const cycleFrequencyHz = (rpm: number, strokes: 2 | 4 = 4): number => (Math.max(0, rpm) / 60) / (strokes / 2);

/** Crankshaft order, Hz (rpm/60). */
export const crankFrequencyHz = (rpm: number): number => Math.max(0, rpm) / 60;

/** Propeller blade-pass frequency, Hz: blades · rpm/60. 2 blades @2400 → 80 Hz. */
export const bladePassHz = (rpm: number, blades: number): number => (blades * Math.max(0, rpm)) / 60;

/** Rotational tip speed, m/s: π·D·rpm/60. */
export const tipSpeedMs = (rpm: number, diameterM: number): number => (Math.PI * diameterM * Math.max(0, rpm)) / 60;

/** Helical tip Mach number: √(v_tip² + V²)/c. */
export const helicalTipMach = (rpm: number, diameterM: number, tasMs: number, speedOfSound: number): number => {
  const vt = tipSpeedMs(rpm, diameterM);
  return Math.sqrt(vt * vt + tasMs * tasMs) / Math.max(1, speedOfSound);
};

/**
 * Propeller tonal (blade-pass) level 0..1: loading noise rises steeply with tip Mach
 * (`clamp((M − 0.25)/0.55)^2.5`, §A3) and with thrust (blade loading).
 * @param thrustFrac |thrust| / reference static thrust, clamped 0..1
 */
export const propToneLevel = (tipMach: number, thrustFrac: number): number =>
  Math.pow(clamp((tipMach - 0.25) / 0.55, 0, 1), 2.5) * (0.55 + 0.45 * clamp(thrustFrac, 0, 1));

/** Propeller broadband vortex-shedding centre frequency, Hz: f = St·U/h with U the 0.75R section speed. */
export const propVortexHz = (rpm: number, diameterM: number, strouhal = 0.2, trailingEdgeM = 0.015): number =>
  (strouhal * 0.75 * tipSpeedMs(rpm, diameterM)) / trailingEdgeM;

/** Manifold-pressure load fraction 0..1 between the engine's closed-throttle and full-throttle MAP. */
export const mapLoad = (mapInHg: number, minMapInHg: number, maxMapInHg: number): number =>
  Number.isFinite(mapInHg) ? clamp((mapInHg - minMapInHg) / Math.max(1e-6, maxMapInHg - minMapInHg), 0, 1) : 0;

/**
 * Overall engine loudness 0..1 from rpm fraction (rpm / rated) and MAP load. Monotonic
 * non-decreasing in both arguments and clamped to [0, 1] for any input.
 */
export const engineLoudness = (rpmFrac: number, load: number): number => {
  const x = Number.isFinite(rpmFrac) ? clamp(rpmFrac, 0, 1) : 0;
  const l = Number.isFinite(load) ? clamp(load, 0, 1) : 0;
  return clamp((0.25 + 0.75 * Math.pow(x, 1.5)) * (0.55 + 0.45 * l), 0, 1);
};

/** Relative harmonic amplitudes of the firing frequency at 50 % load (§A2.2), [order k, amplitude]. */
export const HARMONIC_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.25], [1, 1], [2, 0.55], [3, 0.42], [4, 0.3], [5, 0.2], [6, 0.14], [7, 0.1], [8, 0.07],
];

/** Base amplitude of firing harmonic k ≥ 1 (table, then −12 dB/oct beyond k = 8). */
export const baseHarmonic = (k: number): number => {
  if (k <= 1) return 1;
  if (k >= 8) return 0.07 * (8 / k) * (8 / k);
  const i = Math.floor(k), f = k - i;
  const a = HARMONIC_TABLE[i][1], b = HARMONIC_TABLE[i + 1][1]; // table index i ↔ order i (index 0 is k=0.5)
  return a + (b - a) * f;
};

/** Load law (§A2.2): A_k(load) = A_k · (0.6 + 0.4·load) · k^(−0.3·(1−load)) — duller at low MAP. */
export const harmonicAmp = (k: number, load: number): number => {
  const l = clamp(load, 0, 1);
  return baseHarmonic(k) * (0.6 + 0.4 * l) * Math.pow(Math.max(k, 1), -0.3 * (1 - l));
};

/** Options for {@link engineCycleWave}. */
export interface CycleWaveOptions {
  cylinders: number;
  /** MAP load 0..1 that sets the brightness of the firing harmonics */
  load: number;
  /** number of firing harmonics to include (default 40) */
  firingHarmonics?: number;
  /** per-cylinder amplitude spread ± (default 0.08) */
  imbalance?: number;
  /** per-cylinder timing spread ± as a fraction of the cycle (default 0.004) */
  timingJitter?: number;
  /** crank-order (rpm/60) amplitude relative to the firing fundamental (default table 0.25) */
  crankOrder?: number;
  /** seed of the fixed per-cylinder irregularities (default 4) */
  seed?: number;
}

/**
 * Fourier coefficients of one full 4-stroke cycle (fundamental = rpm/120) of a pulse train with
 * `cylinders` evenly spaced, slightly unequal firings. Coherent sums put the energy at multiples of
 * the firing frequency (cylinders × fundamental) with the §A2.2 harmonic roll-off; the fixed
 * per-cylinder irregularities leak a little energy into the cam/crank orders, which gives the
 * "lumpy" piston character. Returns arrays for `createPeriodicWave(real, imag)` (index 0 = DC = 0).
 */
export function engineCycleWave(o: CycleWaveOptions): { real: Float32Array; imag: Float32Array } {
  const cyl = Math.max(1, Math.round(o.cylinders));
  const K = o.firingHarmonics ?? 40;
  const n = cyl * K + 1;
  const real = new Float32Array(n), imag = new Float32Array(n);
  const rnd = mulberry32(o.seed ?? 4);
  const imb = o.imbalance ?? 0.08, jit = o.timingJitter ?? 0.004;
  const amps: number[] = [], phases: number[] = [];
  for (let i = 0; i < cyl; i++) {
    amps.push(1 + imb * (rnd() * 2 - 1));
    phases.push(i / cyl + jit * (rnd() * 2 - 1));
  }
  for (let h = 1; h < n; h++) {
    const env = harmonicAmp(Math.max(1, h / cyl), o.load); // spectral envelope at this frequency
    let re = 0, im = 0;
    for (let i = 0; i < cyl; i++) {
      const a = 2 * Math.PI * h * phases[i];
      re += amps[i] * Math.cos(a);
      im += amps[i] * Math.sin(a);
    }
    real[h] = env * re;
    imag[h] = env * im;
  }
  // explicit crank order (rpm/60 = 2nd cycle harmonic): present because cylinders are never identical
  if (n > 2) real[2] += cyl * (o.crankOrder ?? HARMONIC_TABLE[0][1]) * harmonicAmp(1, o.load);
  return { real, imag };
}

/** Fourier coefficients of a propeller blade-pass tone with `harmonics` partials decaying like k^−rollOff. */
export function bladePassWave(harmonics = 6, rollOff = 1.2): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(harmonics + 1), imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) imag[k] = Math.pow(k, -rollOff);
  return { real, imag };
}

/**
 * Doppler pitch ratio for a moving source and listener (§A6), clamped to [0.5, 2]:
 * ratio = (c − v_l)/(c − v_s) with v_s the source speed toward the listener and v_l the
 * listener speed away from the source, both along the source→listener line.
 * Vectors are any consistent frame (NED here). Allocation-free.
 */
export function dopplerRatio(
  srcPos: ArrayLike<number>, srcVel: ArrayLike<number>,
  lisPos: ArrayLike<number>, lisVel: ArrayLike<number>,
  speedOfSound = 340,
): number {
  const dx = lisPos[0] - srcPos[0], dy = lisPos[1] - srcPos[1], dz = lisPos[2] - srcPos[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d > 1e-3)) return 1;
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const vs = srcVel[0] * ux + srcVel[1] * uy + srcVel[2] * uz;
  const vl = lisVel[0] * ux + lisVel[1] * uy + lisVel[2] * uz;
  const c = Math.max(1, speedOfSound);
  const r = (c - vl) / Math.max(1e-3, c - vs);
  return Number.isFinite(r) ? clamp(r, 0.5, 2) : 1;
}

/** Air-absorption low-pass cutoff for a source at distance d, Hz (12 kHz·e^(−d/2500 m) beyond 200 m). */
export const airAbsorptionCutoffHz = (distanceM: number): number =>
  distanceM <= 200 ? 12000 : Math.max(800, 12000 * Math.exp(-(distanceM - 200) / 2500));

/** Inverse-distance attenuation (Web Audio 'inverse' model), clamped to ≤ 1. */
export const inverseDistanceGain = (distanceM: number, refM = 15, rolloff = 1): number =>
  refM / (refM + rolloff * (Math.max(refM, distanceM) - refM));
