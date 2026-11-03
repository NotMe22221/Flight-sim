/**
 * Cockpit instruments: 2D-canvas renderers the integrator wraps in `THREE.CanvasTexture`s (or
 * overlays in the DOM). No Three.js imports anywhere in this module. See README.md.
 *
 *  - `SteamPanel`  C172S six-pack + engine cluster + radio stack on one 1024×512 canvas
 *  - `G1000`       PFD + MFD canvases (1024×768 each) with moving map and engine strip
 *  - `Hud`         translucent DOM-overlay HUD for the external views
 *  - `InstrumentModel` the instrument dynamics shared by all of them
 */
export { SteamPanel, C172_STEAM_LAYOUT, type GaugeId, type PanelItem, type PanelLayout, type SteamPanelOptions } from './SteamPanel';
export { G1000, type G1000Options, type NearestAirportInput } from './g1000/G1000';
export { Hud, type HudOptions } from './Hud';
export type { HudValues } from './hud/values';
export {
  InstrumentModel, createReadings, defaultInstrumentConfig, indicatedAltitudeFt, pressureAltitudeFt,
  type InstrumentConfig, type InstrumentReadings,
} from './readings';
export { CANVAS_TEXTURE_SETTINGS, PANEL_TEXTURE_SIZE, createCanvas } from './panelTexture';
export { domCanvasFactory, type CanvasFactory, type CanvasSurface, type Ctx2D } from './canvas';
export { C172S_VSPEEDS, type VSpeeds } from './c172';
export type { ComState } from './radioStack';
export type { CdiSource } from './g1000/palette';
export type { BearingSource, BearingState, CdiState } from './g1000/navData';
export type { MapAirport, MapOrientation } from './g1000/map';
export type { WindOption } from './g1000/infoBoxes';
export { MAP_RANGES_NM, snapMapRange, stepMapRange } from './scales';
