/**
 * Tile data providers: URL templates, zoom ranges, licences and attribution strings.
 *
 * All providers are Web-Mercator (EPSG:3857) slippy-map pyramids. Elevation tiles use the
 * Terrarium RGB encoding (`terrarium.ts`). Imagery comes from WMTS endpoints whose REST
 * path order is `{z}/{y}/{x}` (TileMatrix/TileRow/TileCol) — note the swapped y/x.
 *
 * Only AWS Terrain Tiles were reachable from the research container; EOX, GIBS and
 * Mapterhorn are marked "[verify]" in docs/research/03-terrain-and-world.md and must be
 * checked once in a real browser.
 */

export type ElevationEncoding = 'terrarium' | 'procedural';
export type TileImageFormat = 'png' | 'webp' | 'jpg' | 'none';

export interface ElevationProvider {
  /** stable id used in cache keys and attribution dedupe */
  readonly id: 'aws-terrarium' | 'mapterhorn' | 'procedural';
  readonly tileSize: 256 | 512;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** URL for a tile, or a `procedural://` pseudo-URL for the synthetic provider */
  url(z: number, x: number, y: number): string;
  readonly decode: ElevationEncoding;
  readonly format: TileImageFormat;
  readonly attribution: readonly string[];
  readonly license: string;
}

export interface ImageryProvider {
  readonly id: string;
  readonly tileSize: 256;
  readonly minZoom: number;
  readonly maxZoom: number;
  url(z: number, x: number, y: number): string;
  readonly format: TileImageFormat;
  readonly attribution: readonly string[];
  readonly license: string;
}

/** Required per-source credits for Tilezen Terrain Tiles (joerd attribution.md). */
export const TERRAIN_TILES_ATTRIBUTION: readonly string[] = [
  'Terrain Tiles by Mapzen/Tilezen on AWS Open Data',
  'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey',
  'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
  'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers',
  'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich',
  'Canada terrain data contains information licensed under the Open Government Licence – Canada',
  'Norway terrain data © Kartverket',
  'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017',
  'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)',
  'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved',
  'Mexico terrain data source: INEGI, Continental relief, 2016',
  'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736',
];

/** Primary elevation source: AWS Terrain Tiles, Terrarium PNG, z0–15, 256 px. CORS `*`, no key. */
export const awsTerrarium: ElevationProvider = {
  id: 'aws-terrarium',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 15,
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  decode: 'terrarium',
  format: 'png',
  attribution: TERRAIN_TILES_ATTRIBUTION,
  license: 'Public domain / CC BY / OGL per source (https://github.com/tilezen/joerd/blob/master/docs/attribution.md)',
};

/** Fallback elevation: Mapterhorn, Terrarium WebP, 512 px, global to z12 (z13–15 only regionally). [verify] */
export const mapterhorn: ElevationProvider = {
  id: 'mapterhorn',
  tileSize: 512,
  minZoom: 0,
  maxZoom: 12,
  url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
  decode: 'terrarium',
  format: 'webp',
  attribution: [
    '© Mapterhorn',
    'Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.',
  ],
  license: 'CC BY or less restrictive per source (https://mapterhorn.com/attribution)',
};

/** Synthetic elevation (offline / outside coverage). Heights come from `procedural.ts`. */
export const proceduralElevation: ElevationProvider = {
  id: 'procedural',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 15,
  url: (z, x, y) => `procedural://elevation/${z}/${x}/${y}`,
  decode: 'procedural',
  format: 'none',
  attribution: ['Procedural terrain (synthetic, no real-world data)'],
  license: 'Generated at runtime',
};

const EOX_BASE = 'https://tiles.maps.eox.at/wmts/1.0.0';

/** EOX Sentinel-2 cloudless 2016 mosaic — CC BY 4.0, the default imagery layer. z0–14. [verify] */
export const eoxS2Cloudless2016: ImageryProvider = {
  id: 'eox-s2cloudless-2016',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 14,
  url: (z, x, y) => `${EOX_BASE}/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`,
  format: 'jpg',
  attribution: ['Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)'],
  license: 'CC BY 4.0',
};

/** EOX Sentinel-2 cloudless 2023 mosaic — CC BY-NC-SA 4.0, opt-in only. z0–14. [verify] */
export const eoxS2Cloudless2023: ImageryProvider = {
  id: 'eox-s2cloudless-2023',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 14,
  url: (z, x, y) => `${EOX_BASE}/s2cloudless-2023_3857/default/g/${z}/${y}/${x}.jpg`,
  format: 'jpg',
  attribution: ['Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023)'],
  license: 'CC BY-NC-SA 4.0',
};

/**
 * NASA GIBS Blue Marble (shaded relief + bathymetry), public domain, ≈500 m. Usable for
 * z1–8 (GoogleMapsCompatible_Level8); z0 returns a blank tile in EPSG:3857. Static layer:
 * the `{Time}` path segment is omitted. [verify]
 */
export const gibsBlueMarble: ImageryProvider = {
  id: 'gibs-bluemarble',
  tileSize: 256,
  minZoom: 1,
  maxZoom: 8,
  url: (z, x, y) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpg`,
  format: 'jpg',
  attribution: ['NASA Global Imagery Browse Services (GIBS), EOSDIS'],
  license: 'Public domain (NASA)',
};

/** Synthetic biome colouring derived from the tile's own heights (`procedural.ts`). Always succeeds. */
export const proceduralImagery: ImageryProvider = {
  id: 'procedural',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 15,
  url: (z, x, y) => `procedural://imagery/${z}/${x}/${y}`,
  format: 'none',
  attribution: ['Procedural ground colours (synthetic)'],
  license: 'Generated at runtime',
};

/** Default fallback chain for imagery: EOX (CC BY) → GIBS (z ≤ 8) → procedural. */
export const DEFAULT_IMAGERY_CHAIN: readonly ImageryProvider[] = [eoxS2Cloudless2016, gibsBlueMarble, proceduralImagery];
/** Default fallback chain for elevation: AWS → Mapterhorn → procedural. */
export const DEFAULT_ELEVATION_CHAIN: readonly ElevationProvider[] = [awsTerrarium, mapterhorn, proceduralElevation];

/** Deduplicated attribution lines for a set of providers, in order of first appearance. */
export function collectAttribution(providers: readonly { attribution: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of providers) {
    for (const line of p.attribution) {
      if (!seen.has(line)) { seen.add(line); out.push(line); }
    }
  }
  return out;
}
