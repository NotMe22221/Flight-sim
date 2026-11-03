/**
 * Which steam panel an aircraft gets: layout and markings by `AircraftConfig.panel`. The C172S
 * (steam and G1000 variants share the airframe; the G1000 variant falls back to this panel when no
 * glass cockpit is attached) keeps its historical layout and constants; the Super Cub gets
 * `CUB_STEAM_LAYOUT` with markings from its own limits, tanks and 14 V system.
 */
import type { AircraftConfig } from '../core/types';
import { CUB_STEAM_LAYOUT, cubPanelSpec } from './cub';
import { C172S_PANEL_SPEC, type PanelSpec } from './panelSpec';
import { C172_STEAM_LAYOUT, type PanelLayout } from './SteamPanel';

/** Instrument markings and systems for an aircraft's steam panel. */
export function panelSpecFor(cfg: AircraftConfig): Readonly<PanelSpec> {
  return cfg.panel === 'cub-steam' ? cubPanelSpec(cfg) : C172S_PANEL_SPEC;
}

/** The 1024×512 steam-panel layout for an aircraft. */
export function steamLayoutFor(cfg: Pick<AircraftConfig, 'panel'>): PanelLayout {
  return cfg.panel === 'cub-steam' ? CUB_STEAM_LAYOUT : C172_STEAM_LAYOUT;
}

/** True when the aircraft has an autopilot (and AP annunciations): not the Super Cub. */
export function hasAutopilot(cfg: Pick<AircraftConfig, 'panel'>): boolean {
  return cfg.panel !== 'cub-steam';
}
