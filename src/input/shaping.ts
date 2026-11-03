/**
 * Axis shaping shared by gamepads, joysticks, the mouse yoke and the touch stick (§B5.5):
 * deadzone → rescale → saturation → cubic-blend response curve → gain, plus the unipolar
 * (lever) mapping used for throttle sliders (§B5.6). All functions are pure and allocation-free.
 */
import { clamp } from '../core/math';

export interface AxisShaping {
  /** |x| below this reads 0; output starts at 0 at the deadzone edge (default 0.05) */
  deadzone: number;
  /** |x| above this reads full scale (default 0.98) */
  saturation: number;
  /** 0 = linear, 1 = pure cubic (k·x³ + (1−k)·x blend) */
  curve: number;
  /** flip the sign of the raw value before shaping */
  invert: boolean;
  /** output gain applied after the curve, result clamped to ±1 (default 1) */
  gain: number;
}

export const DEFAULT_SHAPING: Readonly<AxisShaping> = { deadzone: 0.05, saturation: 0.98, curve: 0, invert: false, gain: 1 };

/** Fills in defaults for a partial shaping spec (allocates; call at bind time, not per frame). */
export function makeShaping(p: Partial<AxisShaping> = {}): AxisShaping {
  return {
    deadzone: p.deadzone ?? DEFAULT_SHAPING.deadzone,
    saturation: p.saturation ?? DEFAULT_SHAPING.saturation,
    curve: p.curve ?? DEFAULT_SHAPING.curve,
    invert: p.invert ?? DEFAULT_SHAPING.invert,
    gain: p.gain ?? DEFAULT_SHAPING.gain,
  };
}

/** Rescales a magnitude 0..∞ through deadzone/saturation into 0..1. */
export function rescaleMagnitude(a: number, deadzone: number, saturation: number): number {
  if (a <= deadzone) return 0;
  const span = saturation - deadzone;
  if (span <= 1e-9) return 1;
  return Math.min(1, (a - deadzone) / span);
}

/** k·m³ + (1−k)·m response curve on a magnitude 0..1 (k clamped to 0..1). */
export function curveMagnitude(m: number, curve: number): number {
  const k = clamp(curve, 0, 1);
  return (1 - k) * m + k * m * m * m;
}

/**
 * Shapes one bipolar axis value (−1..1). Odd-symmetric (f(−x) = −f(x)), monotonic
 * non-decreasing in x, 0 inside the deadzone, ±gain (clamped to ±1) at saturation.
 */
export function shapeAxis(x: number, s: AxisShaping): number {
  if (!Number.isFinite(x)) return 0;
  const v = s.invert ? -x : x;
  const m = curveMagnitude(rescaleMagnitude(Math.abs(v), s.deadzone, s.saturation), s.curve);
  const out = Math.min(1, m * s.gain);
  return out === 0 ? 0 : v < 0 ? -out : out;
}

/**
 * Shapes a 2-D stick with a scaled *radial* deadzone (no square-corner snapping).
 * Writes [x, y] into `out` and returns it.
 */
export function shapeStick(x: number, y: number, s: AxisShaping, out: [number, number]): [number, number] {
  const sx = s.invert ? -x : x;
  const sy = s.invert ? -y : y;
  const mag = Math.hypot(sx, sy);
  if (!(mag > s.deadzone)) { out[0] = 0; out[1] = 0; return out; }
  const m = Math.min(1, curveMagnitude(rescaleMagnitude(mag, s.deadzone, s.saturation), s.curve) * s.gain);
  const k = m / mag;
  out[0] = clamp(sx * k, -1, 1);
  out[1] = clamp(sy * k, -1, 1);
  return out;
}

/**
 * Maps a raw slider value (−1..1) to a lever position 0..1 (§B5.6).
 * `inverted` = full forward reads −1 (most Logitech / Thrustmaster sliders): lever = (1 − a)/2.
 * `endDeadzone` (default 0.03) makes idle and full reachable on worn pots.
 */
export function unipolarFromRaw(a: number, inverted: boolean, endDeadzone = 0.03): number {
  if (!Number.isFinite(a)) return 0;
  const lever = inverted ? (1 - a) / 2 : (a + 1) / 2;
  const d = clamp(endDeadzone, 0, 0.45);
  return clamp((lever - d) / (1 - 2 * d), 0, 1);
}

/**
 * MSFS-style sensitivity slider (−100..100) to shaping: negative values add response
 * curve (finer centre), positive values add gain (§B5.5).
 */
export function shapingFromSensitivity(sensitivity: number, base: Partial<AxisShaping> = {}): AxisShaping {
  const s = clamp(sensitivity, -100, 100);
  return makeShaping({ ...base, curve: Math.max(base.curve ?? 0, -s / 100), gain: 1 + Math.max(0, s / 100) * 0.5 });
}

/**
 * Square "deadzone box" mapping for one mouse-yoke component: pixel offset from centre →
 * −1..1. Inside ±deadzonePx reads 0; full deflection at ±radiusPx/sensitivity.
 */
export function boxDeadzone(offsetPx: number, deadzonePx: number, radiusPx: number, sensitivity: number): number {
  const a = Math.abs(offsetPx);
  const dz = Math.max(0, deadzonePx);
  const full = Math.max(dz + 1, dz + (radiusPx - dz) / Math.max(1e-3, sensitivity));
  const m = rescaleMagnitude(a, dz, full);
  return m === 0 ? 0 : offsetPx < 0 ? -m : m;
}
