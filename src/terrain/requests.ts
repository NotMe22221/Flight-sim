/**
 * Builds worker `LoadRequest`s on the main thread: the elevation fallback chain (provider
 * tile → ancestor tiles' sub-square → procedural), the imagery chain, the per-level mesh
 * resolution and skirt depth, and only the runways that touch the tile. Pure, no Three.js.
 */
import type { LocalFrameInfo } from '../core/types';
import { tileToLonLat } from '../geo/mercator';
import { planImagery } from './imagery';
import type { ProceduralParams } from './procedural';
import type { ElevationSource, LoadRequest } from './protocol';
import type { ElevationProvider, ImageryProvider } from './providers';
import { tileTouchesRunways, type RunwayFlatteningSpec } from './runways';
import { skirtDepthFor } from './tileMesh';
import { FULL_HEIGHTS_MIN_ZOOM } from './tilePipeline';

export interface RequestConfig {
  /** network elevation providers tried in order (the procedural provider is always appended last) */
  elevation: readonly ElevationProvider[];
  /** imagery providers tried in order (a provider with format 'none' generates colours) */
  imagery: readonly ImageryProvider[];
  /** ancestor levels tried per network provider when its own tile fails (0 disables the parent fallback) */
  parentFallbackLevels: number;
  /** grid size of procedurally generated heights (smaller = faster; the mesh resamples it) */
  proceduralTileSize: number;
  /** quads per side by level (index 0 = finest zoom); levels past the end use the last entry. Powers of two. */
  quadsPerLevel: readonly number[];
  /** zoom of level 0 */
  finestZoom: number;
  procedural: ProceduralParams;
}

/** §3.3 table: N = 128 for the innermost level, 64 for the next four, 32 beyond. */
export const DEFAULT_QUADS_PER_LEVEL: readonly number[] = [128, 64, 64, 64, 64, 32, 32, 32, 32];

/** Quads per side for tile zoom z. */
export function quadsForZoom(cfg: Pick<RequestConfig, 'quadsPerLevel' | 'finestZoom'>, z: number): number {
  const t = cfg.quadsPerLevel;
  const level = Math.max(0, cfg.finestZoom - z);
  return t[Math.min(level, t.length - 1)];
}

/** Elevation sources for tile (z, x, y), in the order the job tries them. */
export function elevationSources(cfg: RequestConfig, z: number, x: number, y: number): ElevationSource[] {
  const out: ElevationSource[] = [];
  for (const p of cfg.elevation) {
    if (p.format === 'none') continue;
    const format = p.format === 'webp' ? 'webp' : 'png';
    // Zooms finer than the provider serves are taken from its finest ancestor tile.
    const zTop = Math.min(z, p.maxZoom);
    const levels = (zTop === z ? cfg.parentFallbackLevels : 0) + 1;
    for (let k = 0; k < levels; k++) {
      const za = zTop - k;
      if (za < p.minZoom) break;
      const depth = z - za;
      const mask = (1 << depth) - 1;
      const src: ElevationSource = { providerId: p.id, url: p.url(za, x >> depth, y >> depth), format, tileSize: p.tileSize, zoom: za };
      if (depth > 0) src.sub = { depth, x: x & mask, y: y & mask };
      out.push(src);
    }
  }
  out.push({ providerId: 'procedural', url: null, format: 'none', tileSize: cfg.proceduralTileSize, zoom: z });
  return out;
}

/** Runways whose feathered footprint touches tile (z, x, y). */
export function runwaysForTile(z: number, x: number, y: number, runways: readonly RunwayFlatteningSpec[]): RunwayFlatteningSpec[] {
  const out: RunwayFlatteningSpec[] = [];
  for (const r of runways) if (tileTouchesRunways(z, x, y, [r])) out.push(r);
  return out;
}

/** Complete load request for tile (z, x, y) built in `frame`. `reqKey` identifies this attempt. */
export function buildLoadRequest(
  reqKey: string, z: number, x: number, y: number,
  frame: LocalFrameInfo, cfg: RequestConfig, runways: readonly RunwayFlatteningSpec[],
): LoadRequest {
  const latC = tileToLonLat(x + 0.5, y + 0.5, z).lat;
  return {
    type: 'load',
    key: reqKey,
    z, x, y,
    elevation: elevationSources(cfg, z, x, y),
    imagery: planImagery(z, x, y, cfg.imagery),
    frame: { lat0: frame.lat0, lon0: frame.lon0, alt0: frame.alt0 },
    quads: quadsForZoom(cfg, z),
    skirt: skirtDepthFor(z, latC),
    runways: runwaysForTile(z, x, y, runways),
    procedural: cfg.procedural,
    fullHeights: z >= FULL_HEIGHTS_MIN_ZOOM,
    water: true,
  };
}
