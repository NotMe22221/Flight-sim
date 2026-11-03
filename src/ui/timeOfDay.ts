/**
 * Time-of-day helpers for the flight-conditions panels: a longitude-based local clock
 * (the sim has no timezone database), the custom-time slider mapping, and the sun hint.
 */
import { formatTimeLocal, formatTimeUtc, formatUtcOffset, timezoneOffsetFromLon } from './format';
import { SUN_PHASE_LABEL, startOfUtcDay, sunElevationDeg, sunPhase, timeForPreset, type SunPhase, type TimePreset } from './solar';

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

// ── in flight: which time-of-day choice describes the simulator clock ───────────────────

/** The sim clock still runs on the real clock (the 'Now' choice) within this. */
export const NOW_TOLERANCE_MS = 5 * 60_000;
/**
 * A preset still describes the sim clock this far from its instant. Wide enough for the simulator's
 * own presets (a landing challenge's 'dusk' is sunset − 20 min; the UI's is the −1° crossing).
 */
export const PRESET_TOLERANCE_MS = 45 * 60_000;
const DAY_MS = 86_400_000;
const PRESETS: readonly TimePreset[] = ['dawn', 'noon', 'dusk', 'night'];

/** The four preset instants for the local day containing `utcMs` at a place (cache it: ~1k sun samples). */
export function presetTimes(utcMs: number, lat: number, lon: number): Record<TimePreset, number> {
  return {
    dawn: timeForPreset('dawn', utcMs, lat, lon), noon: timeForPreset('noon', utcMs, lat, lon),
    dusk: timeForPreset('dusk', utcMs, lat, lon), night: timeForPreset('night', utcMs, lat, lon),
  };
}

/**
 * In flight, the time-of-day choice that describes the simulator clock (a landing challenge sets
 * its own time; time passes): 'now' while it runs on the real clock, else the preset whose instant
 * is nearest within PRESET_TOLERANCE_MS (instants a day apart count too: night wraps midnight),
 * else null (no choice highlighted; the readout still shows the sim time).
 */
export function flightTimeMode(simUtcMs: number, realNowMs: number, presets: Readonly<Record<TimePreset, number>>): 'now' | TimePreset | null {
  if (!Number.isFinite(simUtcMs)) return null;
  if (Math.abs(simUtcMs - realNowMs) <= NOW_TOLERANCE_MS) return 'now';
  let best: TimePreset | null = null;
  let bestD = PRESET_TOLERANCE_MS;
  for (const p of PRESETS) {
    const t = presets[p];
    const d = Math.min(Math.abs(simUtcMs - t), Math.abs(simUtcMs - t - DAY_MS), Math.abs(simUtcMs - t + DAY_MS));
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}
