/**
 * Pure level / frequency laws for wind, buffet, rain and ground roll (docs/research/06 §A4,
 * §A5.4). Unit-testable without Web Audio.
 */
import { clamp } from '../core/math';
import type { AircraftState, Environment, WeatherState } from '../core/types';
import { DEG } from '../core/units';

/** Surface under the wheels (same values as `Environment.surface`). */
export type SurfaceKind = Environment['surface'];

/** IAS normalised for the wind laws: v = clamp(IAS / 70 m/s, 0, 1.4). */
export const windNorm = (iasMs: number): number => (Number.isFinite(iasMs) ? clamp(iasMs / 70, 0, 1.4) : 0);

/** Hard cap of the wind gain. */
export const WIND_CAP = 1;

/**
 * Wind / slipstream noise gain: 0.6·v² (aerodynamic noise grows with a high power of speed),
 * +25 % at full flaps, capped. Proportional to IAS² below the cap.
 */
export const windLevel = (iasMs: number, flapDeg = 0): number => {
  const v = windNorm(iasMs);
  return Math.min(WIND_CAP, v * v * (0.6 + 0.15 * clamp(flapDeg / 30, 0, 1.5)));
};

/** Wind low-pass cutoff, Hz: 300 + 2500·v². */
export const windCutoffHz = (iasMs: number): number => { const v = windNorm(iasMs); return 300 + 2500 * v * v; };

/** Whistle band-pass centre, Hz: 1.2 kHz + 1.5 kHz·v (the sweep). */
export const whistleHz = (iasMs: number): number => 1200 + 1500 * windNorm(iasMs);

/**
 * Stall buffet intensity 0..1: ramps in over the last 2° of α before the break, at least 0.3
 * with the stall warning, 1 when stalled; needs airflow (fades below 20 m/s IAS).
 */
export function buffetIntensity(ac: AircraftState, alphaStallRad: number): number {
  const a = ac.aero.alpha;
  let k = Number.isFinite(a) ? clamp((a - (alphaStallRad - 2 * DEG)) / (2 * DEG), 0, 1) : 0;
  if (ac.aero.stalled) k = 1;
  else if (ac.aero.stallWarning || ac.warnings.stall) k = Math.max(k, 0.3);
  return k * clamp(ac.aero.ias / 20, 0, 1);
}

/** Rain intensity 0..1 from the weather (snow is silent). */
export function rainIntensity(w: WeatherState): number {
  if (w.precipitationType !== 'rain' || !(w.precipitationRate > 0)) return 0;
  return Math.pow(clamp(w.precipitationRate / 25, 0, 1), 0.6); // 25 mm/h ≈ heavy rain
}

/** Rain-on-airframe gain: ∝ intensity × (0.3 + 0.7·v). */
export const rainLevel = (intensity: number, iasMs: number): number =>
  0.25 * clamp(intensity, 0, 1) * (0.3 + 0.7 * Math.min(1, windNorm(iasMs)));

/** Fastest wheel speed among gear legs in ground contact, m/s (0 when airborne). */
export function rollingSpeedMs(ac: AircraftState): number {
  let v = 0, contact = false;
  for (const g of ac.gear) {
    if (!g.onGround) continue;
    contact = true;
    const s = Math.abs(g.wheelSpeedMs);
    if (s > v) v = s;
  }
  if (!contact && ac.gear.length === 0 && ac.onGround) v = Math.abs(ac.groundSpeedMs);
  return Number.isFinite(v) ? v : 0;
}

/** Surface factors for the roll layer: gain multiplier, cutoff multiplier, bump-AM depth, tyre-hiss multiplier. */
export const SURFACE_FACTORS: Readonly<Record<SurfaceKind, { gain: number; cutoff: number; bumps: number; hiss: number }>> = {
  paved: { gain: 1, cutoff: 1, bumps: 0, hiss: 1 },
  grass: { gain: 1.6, cutoff: 0.7, bumps: 0.35, hiss: 0.3 },
  water: { gain: 0.5, cutoff: 2, bumps: 0.2, hiss: 1.5 },
  unknown: { gain: 1, cutoff: 1, bumps: 0.1, hiss: 1 },
};

/** Ground-roll rumble gain: 0.35·s^1.5 × surface factor, s = clamp(v / 40 m/s). */
export const rollLevel = (wheelSpeedMs: number, surface: SurfaceKind): number => {
  const s = clamp(wheelSpeedMs / 40, 0, 1);
  return 0.35 * Math.pow(s, 1.5) * SURFACE_FACTORS[surface].gain;
};

/** Ground-roll low-pass cutoff, Hz: (150 + 250·s) × surface factor. */
export const rollCutoffHz = (wheelSpeedMs: number, surface: SurfaceKind): number =>
  (150 + 250 * clamp(wheelSpeedMs / 40, 0, 1)) * SURFACE_FACTORS[surface].cutoff;

/** Wheel rotation frequency, Hz: v / (2π r). */
export const wheelHz = (wheelSpeedMs: number, tyreRadiusM: number): number =>
  Math.abs(wheelSpeedMs) / (2 * Math.PI * Math.max(0.05, tyreRadiusM));

/** Touchdown thump gain: clamp(|vs|/3, 0.1, 1). */
export const thumpLevel = (vsMs: number): number => clamp(Math.abs(Number.isFinite(vsMs) ? vsMs : 0) / 3, 0.1, 1);

/** Tyre chirp amount 0..1: clamp(groundSpeed/40 + |lateralDrift|/5). */
export const chirpLevel = (groundSpeedMs: number, lateralDriftMs: number): number =>
  clamp((Number.isFinite(groundSpeedMs) ? groundSpeedMs : 0) / 40 + Math.abs(Number.isFinite(lateralDriftMs) ? lateralDriftMs : 0) / 5, 0, 1);
