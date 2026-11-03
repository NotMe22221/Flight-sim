/**
 * Terrain module: streamed real-world elevation + imagery on a curved WGS84 world,
 * CDLOD tile quadtree, worker decode, ground height queries for the flight model.
 * See README.md in this directory.
 */
export { TerrainSystem, READY_RADIUS_M } from './TerrainSystem';
export type { DepthMode, ImageryMode, RunwaySegment, TerrainStats, TerrainSystemOptions } from './TerrainSystem';
export { HeightField } from './heightfield';
export type { HeightSample, ResidentTile } from './heightfield';
export { GroundQueries } from './groundQueries';
export { Quadtree, computeTileAabb, DEFAULT_QUADTREE_OPTIONS } from './quadtree';
export type { QuadtreeOptions, SelectedNode } from './quadtree';
export { DrawPlanner, tileId } from './drawPlan';
export type { DrawItem, DrawKind } from './drawPlan';
export {
  DEFAULT_ELEVATION_CHAIN, DEFAULT_IMAGERY_CHAIN, TERRAIN_TILES_ATTRIBUTION, awsTerrarium, collectAttribution,
  eoxS2Cloudless2016, eoxS2Cloudless2023, gibsBlueMarble, mapterhorn, proceduralElevation, proceduralImagery,
} from './providers';
export type { ElevationProvider, ImageryProvider } from './providers';
export { ProceduralTerrain, DEFAULT_PROCEDURAL_PARAMS } from './procedural';
export type { ProceduralParams, ProceduralPlateau } from './procedural';
export { decodeTerrarium, decodeTerrariumPng, encodeTerrarium, encodeTerrariumPng } from './terrarium';
export { RUNWAY_FEATHER_M, RUNWAY_SHOULDER_M, applyRunwayFlattening, flattenedHeightAt, runwayFlatteningFromRunway } from './runways';
export type { RunwayFlatteningSpec } from './runways';
export { createTerrainSharedUniforms } from './materials';
export type { TerrainSharedUniforms } from './materials';
export type { FetchFn } from './tileFetch';
