/**
 * Selectable aircraft. The G1000 variant shares the airframe and flight model with the steam-gauge
 * 172S; the Piper PA-18-150 Super Cub is a separate airframe (tail-dragger, 'cub-steam' panel, no
 * autopilot, 14 V electrical system).
 */
import type { AircraftConfig } from '../core/types';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';

export const C172S_G1000: AircraftConfig = { ...C172S, id: 'c172s-g1000', name: 'Cessna 172S Skyhawk G1000', panel: 'c172-g1000' };
export const AIRCRAFT: readonly AircraftConfig[] = [C172S, C172S_G1000, PA18_150];

/**
 * Catalog entry for an id: exact match, else the first entry whose id starts with it (activities name
 * a family: 'c172' → the 172S, 'pa18' → the Super Cub). Undefined when nothing matches.
 */
export function aircraftById(id: string | undefined | null): AircraftConfig | undefined {
  if (!id) return undefined;
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT.find((a) => a.id.startsWith(id));
}

/**
 * True when two configurations fly the same airframe and flight model (the 172S and its G1000
 * variant share every physical sub-object), so switching between them only swaps the panel.
 */
export function sameAirframe(a: AircraftConfig, b: AircraftConfig): boolean {
  return a === b || (a.aero === b.aero && a.mass === b.mass && a.gear === b.gear && a.propulsion === b.propulsion && a.controls === b.controls && (a.airframe ?? 'c172') === (b.airframe ?? 'c172'));
}

/**
 * The aircraft an activity written for `family` flies when `current` is selected: the current one
 * when it belongs to the family (a lesson in the 172 keeps the pilot's steam / G1000 choice), else the
 * family's first catalog entry. Unknown or empty families keep the current aircraft.
 */
export function aircraftForActivity(family: string | undefined, current: AircraftConfig): AircraftConfig {
  if (!family) return current;
  if (current.id === family || current.id.startsWith(family)) return current;
  return aircraftById(family) ?? current;
}

/** ATC callsign and spoken type for an aircraft (registrations match the 3D liveries). */
export function radioCallsign(cfg: AircraftConfig): { callsign: string; aircraftType: string } {
  return cfg.airframe === 'cub' ? { callsign: 'N18FS', aircraftType: 'Super Cub' } : { callsign: 'N172FS', aircraftType: 'Cessna' };
}
