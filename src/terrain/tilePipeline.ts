/**
 * The per-tile CPU pipeline, pure so it runs identically in the worker and in Node tests:
 * decoded heights → pavement flattening → runway flattening → terrain mesh → ocean patch → the DEM grid (full for
 * fine tiles, 4× box-downsampled for coarse ones). Collision samples the mesh's own vertex
 * lattice (TileMeshBuffers.height), not this grid, so it matches the drawn triangles.
 */
import type { LocalFrameInfo } from '../core/types';
import { applyPavementFlattening, type PavementFlatteningSpec } from './pavement';
import { applyRunwayFlattening, type RunwayFlatteningSpec } from './runways';
import { downsampleGrid } from './sampling';
import { buildTileMesh, buildWaterPatch, type TileMeshBuffers, type WaterPatchBuffers } from './tileMesh';

export interface PipelineInput {
  z: number;
  x: number;
  y: number;
  /** decoded DEM grid, `width`², row 0 north (modified in place by flattening) */
  heights: Float32Array;
  width: number;
  frame: LocalFrameInfo;
  quads: number;
  skirt: number;
  runways: readonly RunwayFlatteningSpec[];
  /** airport pavement flattened before the runways (a runway strip wins where both apply) */
  pavement?: readonly PavementFlatteningSpec[];
  fullHeights: boolean;
  water: boolean;
}

export interface PipelineOutput {
  mesh: TileMeshBuffers;
  water: WaterPatchBuffers | null;
  /** the flattened DEM grid (full or downsampled); collision uses the mesh vertex lattice instead */
  heights: Float32Array;
  heightsWidth: number;
  waterFraction: number;
  flattenedPixels: number;
}

/** Sea detection threshold per §6.5 (SRTM-era coastlines sit at exactly 0). */
export const SEA_LEVEL_THRESHOLD = 0.5;
/** Minimum fraction of sea-level cells for a tile to get an ocean patch (≈130 of 65 536 pixels). */
export const MIN_WATER_FRACTION = 0.002;
/** Tiles coarser than this keep only a 4× downsampled grid for collision (§3.5). */
export const FULL_HEIGHTS_MIN_ZOOM = 11;

export function runTilePipeline(input: PipelineInput): PipelineOutput {
  const { z, x, y, heights, width } = input;
  const pavedPixels = input.pavement && input.pavement.length > 0 ? applyPavementFlattening(heights, width, z, x, y, input.pavement) : 0;
  const flattenedPixels = pavedPixels + applyRunwayFlattening(heights, width, z, x, y, input.runways);
  const mesh = buildTileMesh(z, x, y, heights, width, input.frame, input.quads, input.skirt);
  let sea = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] <= SEA_LEVEL_THRESHOLD) sea++;
  const waterFraction = sea / heights.length;
  const water = input.water && waterFraction >= MIN_WATER_FRACTION
    ? buildWaterPatch(z, x, y, heights, width, input.frame, input.quads, mesh.centerEcef)
    : null;
  let outHeights = heights, outWidth = width;
  if (!input.fullHeights && width % 4 === 0 && width >= 16) {
    outHeights = downsampleGrid(heights, width, 4);
    outWidth = width / 4;
  }
  return { mesh, water, heights: outHeights, heightsWidth: outWidth, waterFraction, flattenedPixels };
}
