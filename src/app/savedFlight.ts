/** Storage helpers for the one saved-flight slot (Simulator.saveFlight / restoreFlight). */
import type { SavedFlight } from './Simulator';

export const SAVED_FLIGHT_KEY = 'flightsim.savedFlight.v1';

/** A stored save, or null when absent, unreadable or not this format. */
export function parseSavedFlight(raw: string | null): SavedFlight | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SavedFlight> | null;
    const ok = !!s && s.v === 1 && typeof s.fdm === 'string' && typeof s.aircraftId === 'string' && !!s.frame && !!s.geo
      && Number.isFinite(s.geo.lat) && Number.isFinite(s.geo.lon) && !!s.controls && !!s.weather && Array.isArray(s.plan);
    return ok ? (s as SavedFlight) : null;
  } catch { return null; }
}

export function readSavedFlight(): SavedFlight | null {
  try { return parseSavedFlight(localStorage.getItem(SAVED_FLIGHT_KEY)); } catch { return null; }
}

/** "Piper PA-18 Super Cub in flight near KOAK" */
export function savedFlightLabel(s: Pick<SavedFlight, 'airportIcao' | 'geo' | 'onGround'>, aircraftName: string): string {
  const where = s.airportIcao ? `near ${s.airportIcao}` : `at ${s.geo.lat.toFixed(2)}°, ${s.geo.lon.toFixed(2)}°`;
  return `${aircraftName} ${s.onGround ? 'on the ground' : 'in flight'} ${where}`;
}
