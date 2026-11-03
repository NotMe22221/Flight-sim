/**
 * Time-of-day helpers for the flight-conditions panels: a longitude-based local clock
 * (the sim has no timezone database), the custom-time slider mapping, and the sun hint.
 */
import { formatTimeLocal, formatTimeUtc, formatUtcOffset, timezoneOffsetFromLon } from './format';
import { SUN_PHASE_LABEL, startOfUtcDay, sunElevationDeg, sunPhase, type SunPhase } from './solar';

export const MINUTES_PER_DAY = 1440;

/** Local minutes-of-day → UTC instant on the local day that contains `nowMs`. */
export function localMinutesToUtc(localMinutes: number, offsetMin: number, nowMs: number): number {
  const localDay0 = startOfUtcDay(nowMs + offsetMin * 60_000) - offsetMin * 60_000;
  return localDay0 + localMinutes * 60_000;
}

/** UTC instant → local minutes-of-day in [0, 1440). */
export function utcToLocalMinutes(utcMs: number, offsetMin: number): number {
  const m = Math.floor((utcMs + offsetMin * 60_000) / 60_000) % MINUTES_PER_DAY;
  return (m + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** '14:05 local (UTC-8) · 22:05Z' for an airport at longitude `lon`. */
export function timeReadout(utcMs: number, lon: number): string {
  const off = timezoneOffsetFromLon(lon);
  return `${formatTimeLocal(utcMs, off)} local (${formatUtcOffset(off)}) · ${formatTimeUtc(utcMs)}`;
}

export interface SunHint { elevationDeg: number; phase: SunPhase; text: string; /** moon icon instead of sun */ night: boolean }

/** 'Golden hour · sun +4°' at a place and instant. */
export function sunHint(utcMs: number, lat: number, lon: number): SunHint {
  const el = sunElevationDeg(utcMs, lat, lon);
  const phase = sunPhase(el);
  const r = Math.round(el);
  return {
    elevationDeg: el,
    phase,
    text: `${SUN_PHASE_LABEL[phase]} · sun ${r >= 0 ? '+' : '−'}${Math.abs(r)}°`,
    night: phase === 'night' || phase === 'astronomical' || phase === 'nautical',
  };
}
