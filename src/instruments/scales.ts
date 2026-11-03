/**
 * Geometry helpers for dials and tapes: value ↔ angle for round gauges, value ↔ pixel for moving
 * tapes, tick iteration without allocation.
 */
import { clamp } from '../core/math';
import { ASI_DIAL } from './c172';

/** Airspeed dial geometry (`ASI_DIAL` for the C172; `panelSpec.ts` AsiDial for others). */
type AsiDialGeometry = { readonly minKt: number; readonly kneeKt: number; readonly maxKt: number; readonly kneeDeg: number; readonly sweepDeg: number; readonly zeroDeg: number };

/** Pixels per unit for a tape of `lengthPx` showing `visibleUnits` (450 px / 60 kt = 7.5 px/kt). */
export function pxPerUnit(lengthPx: number, visibleUnits: number): number {
  return lengthPx / visibleUnits;
}

/**
 * Pixel offset of `value` from the tape centreline for an "up = larger" tape: positive values
 * are drawn above the centre (negative y), so the result is `-(value - centre) * pxPerUnit`.
 */
export function tapeOffsetPx(value: number, centre: number, pxPer: number): number {
  return -(value - centre) * pxPer;
}

/**
 * Call `fn(value, offsetPx)` for every multiple of `step` whose tape offset lies within ±halfLengthPx
 * of the centre. Values are clamped to [min, max]. Allocation free.
 */
export function forEachTick(
  centre: number, step: number, pxPer: number, halfLengthPx: number,
  min: number, max: number, fn: (value: number, offsetPx: number) => void,
): void {
  const visible = halfLengthPx / pxPer;
  const lo = Math.max(min, Math.ceil((centre - visible) / step) * step);
  const hi = Math.min(max, Math.floor((centre + visible) / step) * step);
  for (let v = lo; v <= hi + 1e-9; v += step) fn(Math.round(v / step) * step, tapeOffsetPx(v, centre, pxPer));
}

/** Linear map of `value` in [min, max] to an angle starting at `startDeg` over `sweepDeg` (clockwise, 0 = 12 o'clock). */
export function linearAngleDeg(value: number, min: number, max: number, startDeg: number, sweepDeg: number): number {
  const t = clamp((value - min) / (max - min), 0, 1);
  return startDeg + t * sweepDeg;
}

/**
 * C172 airspeed dial: 0–40 kt compressed into the first 20°, 40–200 kt linear over 320°.
 * Returns degrees of dial travel from the 0-kt position (0 → 0°, 40 → 20°, 120 → 180°, 200 → 340°).
 */
export function asiDialTravelDeg(kt: number, d: AsiDialGeometry = ASI_DIAL): number {
  const v = clamp(kt, d.minKt, d.maxKt);
  if (v <= d.kneeKt) return (v / d.kneeKt) * d.kneeDeg;
  return d.kneeDeg + ((v - d.kneeKt) / (d.maxKt - d.kneeKt)) * d.sweepDeg;
}

/** Needle angle (deg clockwise from 12 o'clock) for an airspeed on the C172 dial (or another `dial`). */
export function asiNeedleDeg(kt: number, dial: AsiDialGeometry = ASI_DIAL): number {
  return dial.zeroDeg + asiDialTravelDeg(kt, dial);
}

/** Degrees → radians for canvas arcs, where 0° is 12 o'clock and positive is clockwise. */
export function dialRad(deg: number): number {
  return (deg - 90) * (Math.PI / 180);
}

/** Pitch-ladder pixel offset for an attitude display with `pxPerDeg`. */
export function pitchPx(pitchDeg: number, pxPerDeg: number): number { return pitchDeg * pxPerDeg; }

/**
 * Map range steps used by the G1000 MFD (nm). `nextRange(r, +1)` zooms out, `-1` zooms in.
 */
export const MAP_RANGES_NM: readonly number[] = Object.freeze([
  0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000,
]);

/** Snap an arbitrary range to the nearest MFD range step. */
export function snapMapRange(nm: number): number {
  let best = MAP_RANGES_NM[0], bestErr = Infinity;
  for (const r of MAP_RANGES_NM) {
    const e = Math.abs(Math.log(r / Math.max(nm, 1e-6)));
    if (e < bestErr) { bestErr = e; best = r; }
  }
  return best;
}

/** Next range step from `nm` in direction `dir` (+1 out, −1 in). */
export function stepMapRange(nm: number, dir: 1 | -1): number {
  const i = MAP_RANGES_NM.indexOf(snapMapRange(nm));
  return MAP_RANGES_NM[clamp(i + dir, 0, MAP_RANGES_NM.length - 1)];
}
