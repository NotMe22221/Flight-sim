/**
 * Quality knobs of the OSM scenery. `BuildSettings` travel to the worker with every tile
 * request; `StreamSettings` stay on the main thread.
 */

export type SceneryQuality = 'low' | 'medium' | 'high' | 'ultra';

/** Per-tile geometry generation (worker side). */
export interface BuildSettings {
  /** cap on building triangles per tile; the least important buildings are dropped first */
  maxBuildingTriangles: number;
  /** buildings with footprint area below this (m²) are skipped */
  minBuildingAreaM2: number;
  /** pitched (hip / gable) roofs for small residential buildings */
  pitchedRoofs: boolean;
  /** tree cap per tile */
  maxTrees: number;
  /** nominal spacing of forest trees (m); parks and gardens use multiples of it */
  forestSpacingM: number;
  /** grid cell (m) used to drape apron polygons on the terrain */
  drapeCellM: number;
  /** spacing (m) of ribbon cross-sections along taxiway centre lines */
  ribbonStepM: number;
  /** streetlights along roads */
  streetlights: boolean;
  /** cap on streetlight points per tile */
  maxStreetlights: number;
}

/** Streaming / main-thread knobs. */
export interface StreamSettings {
  /** tiles whose nearest point is within this radius of the camera are loaded (m) */
  radiusM: number;
  /** resident tile budget (LRU beyond the wanted set) */
  maxResidentTiles: number;
  /** concurrent tile requests */
  maxInFlight: number;
  /** small buildings are not drawn beyond this distance (m) */
  smallBuildingRangeM: number;
  /** trees are drawn within this distance (m), thinning out over the last third */
  treeRangeM: number;
  /** streetlights and airport lights are drawn within this distance (m) */
  lightRangeM: number;
  /** ground samples per frame (initial placement + gradual re-sampling) */
  groundSamplesPerFrame: number;
  /** main-thread time budget per frame for scenery work (ms) */
  frameBudgetMs: number;
}

export interface QualityProfile { build: BuildSettings; stream: StreamSettings }

export const QUALITY_PROFILES: Record<SceneryQuality, QualityProfile> = {
  low: {
    build: { maxBuildingTriangles: 40_000, minBuildingAreaM2: 40, pitchedRoofs: false, maxTrees: 1200, forestSpacingM: 16, drapeCellM: 24, ribbonStepM: 24, streetlights: true, maxStreetlights: 800 },
    stream: { radiusM: 4000, maxResidentTiles: 40, maxInFlight: 3, smallBuildingRangeM: 1800, treeRangeM: 1500, lightRangeM: 4000, groundSamplesPerFrame: 300, frameBudgetMs: 1.2 },
  },
  medium: {
    build: { maxBuildingTriangles: 80_000, minBuildingAreaM2: 25, pitchedRoofs: true, maxTrees: 3000, forestSpacingM: 13, drapeCellM: 20, ribbonStepM: 20, streetlights: true, maxStreetlights: 1500 },
    stream: { radiusM: 5500, maxResidentTiles: 70, maxInFlight: 4, smallBuildingRangeM: 2500, treeRangeM: 2000, lightRangeM: 5500, groundSamplesPerFrame: 450, frameBudgetMs: 1.6 },
  },
  high: {
    build: { maxBuildingTriangles: 140_000, minBuildingAreaM2: 15, pitchedRoofs: true, maxTrees: 6000, forestSpacingM: 11, drapeCellM: 16, ribbonStepM: 16, streetlights: true, maxStreetlights: 2500 },
    stream: { radiusM: 7000, maxResidentTiles: 110, maxInFlight: 4, smallBuildingRangeM: 3000, treeRangeM: 2500, lightRangeM: 7000, groundSamplesPerFrame: 600, frameBudgetMs: 2 },
  },
  ultra: {
    build: { maxBuildingTriangles: 220_000, minBuildingAreaM2: 10, pitchedRoofs: true, maxTrees: 10_000, forestSpacingM: 9, drapeCellM: 12, ribbonStepM: 12, streetlights: true, maxStreetlights: 4000 },
    stream: { radiusM: 8000, maxResidentTiles: 150, maxInFlight: 6, smallBuildingRangeM: 3500, treeRangeM: 2800, lightRangeM: 8000, groundSamplesPerFrame: 800, frameBudgetMs: 2 },
  },
};

export function qualityProfile(q: string | undefined): QualityProfile {
  const p = QUALITY_PROFILES[(q ?? 'high') as SceneryQuality] ?? QUALITY_PROFILES.high;
  return { build: { ...p.build }, stream: { ...p.stream } };
}

/** Sun elevation (deg) above which there are no night lights, and below which they are full. */
export const NIGHT_FADE_START_DEG = 3;
export const NIGHT_FULL_DEG = -4;

/** 0 by day … 1 at night (sun below about −4°), smooth in between. */
export function nightFactor(sunElevationRad: number): number {
  const deg = (sunElevationRad * 180) / Math.PI;
  if (!Number.isFinite(deg)) return 0;
  const t = (NIGHT_FADE_START_DEG - deg) / (NIGHT_FADE_START_DEG - NIGHT_FULL_DEG);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap';
