/**
 * OSM autogen scenery plugin (MSFS-style): buildings, airport aprons / taxiways / lights,
 * trees and streetlights from OpenMapTiles vector tiles (OpenFreeMap by default).
 * Loaded by src/app/plugins.ts through `createScenery`; see README.md in this folder.
 */
import type { SceneryHostOptions } from '../app/plugins';
import type { SceneryLike } from '../app/Simulator';
import { SceneryManager } from './manager';

export function createScenery(options: SceneryHostOptions): SceneryLike {
  const m = new SceneryManager(options);
  // automation handle (stats, parking, debug views), like window.__sim
  if (typeof window !== 'undefined') (window as unknown as { __scenery?: SceneryManager }).__scenery = m;
  return m;
}

export { SceneryManager } from './manager';
export type { SceneryManagerOptions } from './manager';
export { ATTRIBUTION, QUALITY_PROFILES, nightFactor } from './config';
