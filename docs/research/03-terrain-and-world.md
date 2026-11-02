# 03 — Terrain and World: streaming real-world terrain in Three.js with no backend

Status: research deliverable, 2026-11-02. Audience: architect + terrain/world module owner.
Stack assumptions: Three.js r0.187 (verified against `node_modules/three`), TypeScript, Vite 7, static hosting (GitHub Pages or similar), laptop-class GPU, no server of our own. All data is fetched by the browser directly from public tile servers at runtime.

Research caveat: this container's egress proxy allowed `s3.amazonaws.com`, `raw.githubusercontent.com`, `github.com` and web search, but blocked `tiles.maps.eox.at`, `server.arcgisonline.com`, `gibs.earthdata.nasa.gov`, `tile.openstreetmap.org`, `tiles.mapterhorn.com`, `tiles.openfreemap.org`, `overpass-api.de`, `davidmegginson.github.io`, MDN and most vendor docs. Everything marked **[verified]** was fetched live from here (headers and bytes inspected). Everything marked **[verify]** comes from web-search summaries, GitHub mirrors of the docs, or prior knowledge and must be checked once in a browser before the architecture is frozen. Items marked **[memory]** are prior knowledge only.

---

## 0. Decisions in one page

| Topic | Recommendation | Why |
|---|---|---|
| Elevation source | **AWS Terrain Tiles (Tilezen "Joerd") Terrarium PNG**, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, zoom 0–15, 256 px | **[verified]** CORS `*`, no key, no documented rate limit, 10 m (US 3DEP / Austria / Norway / NZ / UK 2 m) to 30 m (SRTM/EU-DEM) data, bathymetry in the ocean. Decoded heights at 10 runway thresholds matched OurAirports published elevations within 0.1–3 m (section 1.5). Fallback: Mapterhorn `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` (512 px Terrarium WebP, global to z12, z15 in CH/NO/…) **[verify]**. |
| Imagery source | **EOX Sentinel-2 cloudless** WMTS, `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg` (note `{z}/{y}/{x}` = TileMatrix/TileRow/TileCol), ~10 m, z ≤ 14 **[verify]**; license CC BY-NC-SA 4.0 for 2018+ mosaics, **CC BY 4.0 for the 2016 mosaic** (`s2cloudless_3857`). Low zooms (z ≤ 8) and offline splash: NASA GIBS Blue Marble (public domain). Esri World Imagery only as a user-enabled option with the user's own ArcGIS key. | The only no-key, CORS-friendly, global satellite mosaic with an explicit open license. OSM raster tiles are explicitly not for apps. |
| LOD | **Quadtree of Web-Mercator tiles (one node = one z/x/y tile), CDLOD-style distance ranges that double per level (z15 → z7 = 9 levels), shared 64×64-quad grid mesh, CPU-built vertex buffers in a worker pool, skirts for cracks (v1) + per-vertex geomorph (v2).** | Tile-aligned nodes make data fetching trivial (one DEM + one imagery tile per node); CDLOD ranges give uniform screen-triangle density; clipmaps fit a single huge heightmap, not a multi-source tile pyramid. |
| Coordinates | **ECEF → local ENU (East, Up, South in Three.js Y-up), computed in float64 per vertex in the worker, stored float32 relative to the tile centre; floating origin rebased when the aircraft is > 20 km from the origin (a rigid transform applied to tile matrices, not to vertices). Earth curvature falls out of ECEF→ENU for free** (785 m drop at 100 km). | Removes float32 jitter without custom shaders; horizon dip, curved sea and GPS/ADF geometry are all consistent. |
| Depth | `new WebGLRenderer({ reversedDepthBuffer: true })` (needs `EXT_clip_control`, present in r187 **[verified]**); fallback `logarithmicDepthBuffer: true`; last resort two-camera near/far split. near = 0.3 m, far = 600 km. | Reversed-Z float depth gives ~10⁻⁷ relative precision over the whole range without the early-Z loss of log depth. |
| Water | Ocean = **same tile grid at h = 0 on the ellipsoid** (not a flat plane), drawn only for tiles whose min height ≤ 0; lakes via OSM `water` polygons (OpenFreeMap vector tiles) or elevation plateaus. | Terrarium ocean cells are negative (bathymetry: SF Bay −3.2 m, offshore −310 m **[verified]**), inland lakes sit at their surface elevation (Lake Tahoe 1897.6 m **[verified]**), so `h ≤ 0` alone only finds the sea. |
| 3D content | **OpenFreeMap vector tiles** (`https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf`, no key, "no limits") for buildings (`building.render_height`), woods (`landcover.class=wood`), water, `aeroway` runways/taxiways; extrude + `BatchedMesh`/`InstancedMesh`. Overpass API only as a dev-time tool. | Overpass is 2 slots/IP, 10k req/day, and now returns 406 to some browser origins; vector tiles are static files on a CDN. |
| Home airport | **KSFO** (San Francisco), spawn runway 28R threshold 37.613538, −122.35716, 13 ft, 298 °T (≈ 285 °M). Showcase alternates: **LOWI** Innsbruck 08/26, **KSEA/KBFI** Seattle, **KHAF** Half Moon Bay, **KTRK** Truckee. | 10 m 3DEP + 1/9″ NED topobathy around SF Bay in Terrain Tiles **[verified via `x-amz-meta-x-imagery-sources`]**, flat runway for beginners, hills/sea/city within 30 km, both EOX and Esri imagery are good there. |

---

## 1. Elevation tiles

### 1.1 AWS Terrain Tiles (Tilezen Joerd) — primary

* Registry entry: [registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/) (YAML source: [awslabs/open-data-registry `terrain-tiles.yaml`](https://raw.githubusercontent.com/awslabs/open-data-registry/main/datasets/terrain-tiles.yaml) **[verified]**): bucket `arn:aws:s3:::elevation-tiles-prod` (us-east-1), EU replica `elevation-tiles-prod-eu` (eu-central-1), "ManagedBy: Mapzen, a Linux Foundation project", `License: https://github.com/tilezen/joerd/blob/master/docs/attribution.md`.
* URL templates **[verified 200 OK with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`, `Access-Control-Max-Age: 3000`]**:
  * `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (also virtual-host style `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`)
  * `https://s3.amazonaws.com/elevation-tiles-prod/normal/{z}/{x}/{y}.png` (RGB = surface normal, A = quantised elevation; not needed, we compute normals)
  * `https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif` (512 px GeoTIFF, not browser friendly)
  * `https://s3.amazonaws.com/elevation-tiles-prod/skadi/N37/N37W123.hgt.gz` (1°×1° SRTM-style HGT; useful for a Node preprocessing script, not at runtime)
  * EU replica (unverified URL form): `https://elevation-tiles-prod-eu.s3.eu-central-1.amazonaws.com/terrarium/{z}/{x}/{y}.png` **[verify]**
* Zoom range: **z0 … z15**. z0, z12, z14, z15 returned 200 for both San Francisco and Innsbruck; **z16 returns 404** (with CORS headers, so the browser sees a clean 404) **[verified]**. The sourcing tables in [joerd `data-sources.md`](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md) also stop at z15.
* Tile: 256×256, 8-bit RGB PNG (mode RGB, no alpha) **[verified]**, 87–114 KB per tile in dense terrain (SF, Innsbruck) **[verified]**; budget ~80 KB average.
* Data vintage: `Last-Modified: Sat, 11 Nov 2017` on every tile fetched **[verified]**. Do not expect post-2017 LiDAR.
* Decode ([joerd `formats.md`](https://github.com/tilezen/joerd/blob/master/docs/formats.md)):

  ```
  elevation_m = (R * 256 + G + B / 256) - 32768
  ```
  Range −11 000 … 8 900 m, 1/256 m (3.9 mm) steps. Any decoded value < −11 000 or > 9 000 should be treated as no-data (we never saw one; SRTM voids are filled upstream).
* Source per zoom (from `data-sources.md`): z0–3 ETOPO1; z4–6 GMTED land + ETOPO1 ocean; z7–8 SRTM (NRCan in Canada, GMTED > 60°N); z9 adds EU-DEM in Europe; z10–15 3DEP/NED (US), data.gv.at (Austria, 10 m), data.gov.uk (2 m), Kartverket (Norway, 10 m), LINZ (NZ, 8 m), ArcticDEM (> 60°N, 5 m), INEGI (Mexico), SRTM elsewhere; ocean stays ETOPO1 except **NED Topobathy in California from z10** (confirmed: the SF tiles carry `x-amz-meta-x-imagery-sources: ned_topobathy/ned19_n38x00_w122x50_ca_sanfrancisco_topobathy_2010.tif, …` **[verified]**; this header is CORS-exposed, so the app can display per-tile provenance).
* Effective resolution: at z15 a pixel is 4.78 m at the equator, 3.79 m at 37.6°, 3.24 m at 47.3° (table in section 4), i.e. z15 oversamples the 10 m sources ~2.6×. z14 (7.6 m at SF) is the last zoom that adds real information in 10 m regions; z15 only adds smoother interpolation. Use z15 for the innermost ring anyway (cheaper than special-casing) or stop at z14 to halve the near-field fetches.
* License / attribution ([joerd `attribution.md`](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)): per-source. Required strings (each ≤ 125 chars):
  * "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736"
  * "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017"
  * "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich"
  * "Canada terrain data contains information licensed under the Open Government Licence – Canada"
  * "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers"
  * "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration"
  * "Mexico terrain data source: INEGI, Continental relief, 2016"
  * "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)"
  * "Norway terrain data © Kartverket"
  * "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved"
  * "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey"
  Put the full list in an "About / Data credits" dialog and a short "Terrain: Mapzen/Tilezen Terrain Tiles (USGS, NOAA, Copernicus, …)" line on the HUD or splash. All sources are public domain / CC BY / OGL — **compatible with an open-source hobby project, including commercial use**.
* No published rate limit. It is a public S3 bucket paid for by the AWS Open Data program; be polite: cache aggressively (section 3.6), never prefetch more than the selection + one ring.

### 1.2 Mapterhorn — fallback / regional high-res

* [github.com/mapterhorn/mapterhorn](https://github.com/mapterhorn/mapterhorn) README **[verified]**: drop-in replacement for the AWS tiles, `"tiles": ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"], "encoding": "terrarium", "tileSize": 512`. Code BSD-3; data "various open-data sources", list at `https://mapterhorn.com/attribution`.
* Coverage ([valhalla issue #6049](https://github.com/valhalla/valhalla/issues/6049), [orbat-mapper #757](https://github.com/orbat-mapper/orbat-mapper/issues/757)): **global to z12** from Copernicus GLO-30 (a *surface* model: tree canopy and buildings are in the heights; seams smoothed with a ~100 m Gaussian), **z13–z15 only where national data exist** (Switzerland swissALTI3D 0.5 m, Norway, …); elsewhere **z13+ returns 404**, and `tilejson.json` sets no `maxzoom`. Implement parent-tile fallback on 404.
* Hosting: Cloudflare R2 + CDN "with CORS headers enabled", single-tile `z/x/y` endpoint; ~100 M requests/month served; **no published usage policy** (one integrator notes "Mapterhorn publishes no usage policy") **[verify]**. Source licences "all CC BY or the equivalent or less restrictive", never NC/SA.
* Attribution: "© Mapterhorn" plus the Copernicus notice for GLO-30-derived data: "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved." **[verify exact wording against the Copernicus DEM licence]**.
* Decoding is identical (Terrarium) but tiles are lossless WebP, 512 px (so a z12 Mapterhorn tile has the pixel density of a z13 AWS tile). `createImageBitmap` decodes WebP in all current browsers.

### 1.3 Other elevation sources (rejected or special purpose)

| Source | Access | Verdict |
|---|---|---|
| Nextzen (Mapzen successor) `https://tile.nextzen.org/tilezen/terrain/v1/{256,512}/terrarium/{z}/{x}/{y}.png?api_key=…` | API key, rate limited ([OSM wiki Nextzen](https://wiki.openstreetmap.org/wiki/Nextzen)) | Same data as AWS; no benefit. |
| MapTiler `terrain-rgb-v2` | API key; free tier exists (figure not verified; commonly quoted 100k tile requests/month **[memory]**) | Mapbox-RGB encoding (`-10000 + (R*65536+G*256+B)*0.1`), 512 px, z ≤ 12. Optional "bring your own key" provider. |
| Copernicus GLO-30 on AWS `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N37_00_W123_00_DEM/Copernicus_DSM_COG_10_N37_00_W123_00_DEM.tif` | **[verified 200]**, 20.06 MB per 1°×1° COG, **no `Access-Control-Allow-Origin` header in the response** → not fetchable from a browser | Use only in a build-time Node script (e.g. to bake a procedural-fallback heightmap). License: free for all with the DLR/Airbus notice ([Copernicus Data Space](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)). |
| OpenTopography | API key for the global DEM API; the S3 mirror `opentopography.s3.sdsc.edu` was blocked here | Offline tooling only. |
| Esri `WorldElevation3D/Terrain3D` ImageServer (LERC tiles) | Esri terms (section 2.2) | Not without an ArcGIS key. |

### 1.4 Recommended provider abstraction

```ts
export interface ElevationProvider {
  id: string;                       // 'aws-terrarium' | 'mapterhorn' | 'procedural'
  tileSize: 256 | 512;
  minZoom: number; maxZoom: number; // aws: 0..15, mapterhorn: 0..12 (+ regional)
  url(z: number, x: number, y: number): string;
  decode: 'terrarium' | 'mapbox-rgb';
  attribution: string[];
}
```
Selection order at runtime: `aws-terrarium` → on network error or 404 for z ≤ 15 try the parent tile (upsample) → `mapterhorn` → `procedural` (section 5). Never mix providers *within* a ring (visible seams); switch per session.

### 1.5 Validation performed (Terrarium decode vs published runway elevations)

Decoded with the formula above from the z15 tile containing each threshold (pixel = fractional tile coordinate × 256, no interpolation) **[verified]**:

| Runway end | z15 tile x/y (px) | Decoded Terrarium | OurAirports `*_elevation_ft` → m | Δ |
|---|---|---|---|---|
| KSFO 28R | 5246/12684 (199,20) | 3.96 m | 13 ft = 3.96 m | 0.0 |
| KSFO 10L | 5243/12682 (122,85) | 1.66 m | 5 ft = 1.52 m | +0.1 |
| LOWI 08 | 17415/11490 (93,189) | 581.39 m | 1907 ft = 581.25 m | +0.1 |
| LOWI 26 | 17417/11490 (189,93) | 577.20 m | 1894 ft = 577.29 m | −0.1 |
| KSEA 16L | 5251/11463 (65,49) | 131.52 m | 432 ft = 131.67 m | −0.2 |
| KBFI 14R | 5250/11452 (242,218) | 5.05 m | 17 ft = 5.18 m | −0.1 |
| KHAF 12 | 5233/12694 (35,254) | 20.31 m | 59 ft = 17.98 m | +2.3 |
| KTRK 11 | 5447/12485 (104,30) | 1795.58 m | 5897 ft = 1797.41 m | −1.8 |
| KASE 15 | 6656/12496 (41,1) | 2339.77 m | 7680 ft = 2340.86 m | −1.1 |
| LSGS 07 | 17049/11629 (201,38) | 476.96 m | 1575 ft = 480.06 m | −3.1 |

Conclusions: (a) the decode formula and the tile math are right; (b) 10 m sources (US, Austria) agree to < 0.3 m, 30 m sources (Switzerland = EU-DEM) to ~3 m; (c) runways must still be **flattened** in the mesh to the published threshold elevations (section 8.3) or wheels will sink/float by metres on 30 m terrain.

---

## 2. Imagery tiles

### 2.1 Comparison

| Provider | URL template (Web Mercator, 256 px) | Max zoom / resolution | License | Key | CORS | Verdict |
|---|---|---|---|---|---|---|
| **EOX Sentinel-2 cloudless** ([s2maps.eu](https://s2maps.eu/), [2024 release post](https://eox.at/2025/03/sentinel-2-cloudless-2024/)) | `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg` — also `s2cloudless-2024_3857`, `s2cloudless-2022_3857`, `s2cloudless-2020_3857`, `s2cloudless-2018_3857`, and `s2cloudless_3857` (2016). Matrix set `g` = GoogleMapsCompatible. KVP form: `https://tiles.maps.eox.at/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=s2cloudless-2023_3857&STYLE=default&TILEMATRIXSET=g&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg` | z14 ≈ 10 m source (EOX product docs give "zoom 0–14 for EPSG:3857" for the same mosaic) **[verify in `WMTSCapabilities.xml`]** | **2016: CC BY 4.0**; 2018–2024: **CC BY-NC-SA 4.0**; commercial use of 2018+ needs the "EOX Commercial Attribution-RestrictedUse 1.1" licence | none | used cross-origin by many OpenLayers/Leaflet sites → enabled **[verify]** | **Default.** Ship with the 2016 layer if we want a pure CC BY stack; otherwise 2023/2024 with the NC-SA notice (fine for a non-commercial hobby project). |
| **NASA GIBS** ([access basics, GitHub source](https://raw.githubusercontent.com/nasa-gibs/gibs-api-docs/main/docs/access-basics.md) **[verified]**) | REST pattern `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{Layer}/default/{Time}/{TileMatrixSet}/{z}/{y}/{x}.{jpg|png}`; e.g. `…/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg` (static layers omit `{Time}` or use `default` **[verify]**), `…/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2025-07-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg` (daily, `YYYY-MM-DD`) | Blue Marble: Level8 (≈ 500 m); MODIS/VIIRS: Level9 (250 m). **z0 returns a blank tile in EPSG:3857** (documented GIBS bug) | NASA imagery: public domain; credit "NASA Global Imagery Browse Services (GIBS), EOSDIS" | none | Worldview (a browser app on another host) consumes it → enabled **[verify]** | Far-field (z ≤ 8) imagery, low-zoom splash globe, and the "live weather day" MODIS novelty. |
| **Esri World Imagery** | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` (row before column!) | 24 levels (0–23) advertised; 0.3 m in cities (z19) | Esri Master Agreement. The [esri-leaflet README](https://raw.githubusercontent.com/Esri/esri-leaflet/master/README.md) **[verified]**: "If you're using Esri content and services, you'll need to license your usage with an API key or an ArcGIS identity"; attribution "Esri, Vantor, Earthstar Geographics, and the GIS User Community" + "Powered by Esri" | key/identity required by the terms (the endpoint answers without one) | enabled **[memory]** | **Optional provider behind a settings toggle where the user pastes their own ArcGIS Location Platform key** (basemap styles service). Do not ship it as default. |
| OpenStreetMap raster | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | z19 | [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/): heavy use / distributing an app that hits `tile.openstreetmap.org` requires prior permission; bulk download forbidden; identifying User-Agent/Referer required | none | enabled | **Do not use** except on `localhost` during development. Also not photographic. |
| Stadia Maps (Stamen Terrain/Toner/Watercolor) | `https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png?api_key=…` | z18 | Free 200 000 credits/month, non-commercial only, domain auth or key ([Stadia pricing](https://stadiamaps.com/products/maps/)) | key or registered domain | enabled | Cartographic, not photo; skip. |
| OpenTopoMap | `https://a.tile.opentopomap.org/{z}/{x}/{y}.png` | z17 | CC BY-SA; volunteer servers, "fair use" | none | enabled | Nice "VFR chart" overlay for the moving map, not for the ground texture. |
| EOX::Maps other layers | `https://tiles.maps.eox.at/wmts/1.0.0/{terrain-light_3857|terrain_3857|bluemarble_3857|blackmarble_3857|osm_3857}/default/g/{z}/{y}/{x}.jpg` **[memory]** | varies | mostly CC BY (OSM-derived layers ODbL) | none | as above | `bluemarble_3857` is a convenient low-zoom fallback from the same host. |

Attribution strings to render (EOX requires them verbatim):
* 2024: `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)`
* 2023: `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023)`
* 2016: `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)` **[verify wording]**

### 2.2 Imagery/terrain zoom coupling

* Same Web-Mercator scheme → a terrain tile at zoom `zT` uses imagery tile `(zI, x >> (zT−zI), y >> (zT−zI))` with UV offset `((x & m)/2^k, (y & m)/2^k)` and scale `1/2^k`, where `k = zT − zI`, `m = 2^k − 1`. With EOX (max 14) the z15 terrain ring shares each imagery tile among 4 terrain tiles (good: fewer texture uploads).
* With a higher-res provider (Esri) load imagery at `zT + bias` (bias 1–2 for the two innermost rings) into a 512² or 1024² texture per terrain tile composed from 4/16 sub-tiles in the worker (OffscreenCanvas `drawImage` → `transferToImageBitmap`).
* Imagery texture settings: `colorSpace = SRGBColorSpace`, `generateMipmaps = true`, `anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())`, `minFilter = LinearMipmapLinearFilter`, `wrapS/T = ClampToEdge`. JPEG → RGBA8 in GPU memory: 256² tile ≈ 350 KB with mips; 230 tiles ≈ 80 MB.

### 2.3 Where imagery stops: far field and oceans

Beyond EOX z14 the texture is magnified; add a detail texture (section 6.3). Below z ~6 Blue Marble is both prettier and far lighter than Sentinel for 200 km+ distances. Ocean colour should come from the water shader, not the imagery (Sentinel ocean tiles have sun glint and cloud residue), so mask imagery with the water mask (section 6.5).

---

## 3. LOD strategy

### 3.1 Options

| Approach | Pros | Cons for us |
|---|---|---|
| **Quadtree of map tiles** (one node = one z/x/y tile, Google Earth / Cesium / MapLibre style) | Node = fetch unit = cache unit; trivially matches the DEM + imagery pyramids; per-tile textures; easy to stream. | LOD transitions pop unless morphed; cracks between levels (skirts/stitching). |
| **Geometry clipmaps** ([Losasso & Hoppe 2004](https://hhoppe.com/geomclipmap.pdf), [GPU Gems 2 ch. 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry)) | Constant vertex count, elegant toroidal updates, no popping. | Needs a single continuous heightmap in one projection and a texture per ring that must be re-assembled from many tiles as the camera moves; imagery handling is awkward; Mercator scale distortion vs metric rings; harder with curvature. |
| **CDLOD** ([Strugar 2009/2010, paper PDF in fstrugar/CDLOD](https://github.com/fstrugar/CDLOD/blob/master/cdlod_paper_latest.pdf) **[verified text]**) | Quadtree + LOD ranges that double per level + per-vertex morph in the vertex shader: "smooth transitions with no seams or T-junctions", "no need for stitching meshes". Morph region = "last 15%–30% of every LOD range". | Designed for one heightmap; with a multi-zoom tile pyramid the parent-level height at a shared edge is not exactly the child's downsampled height → tiny cracks remain → keep skirts. |

**Recommendation: tile quadtree + CDLOD range selection + skirts (v1) + CDLOD per-vertex morph (v2).** This is what MapLibre-GL's 3D terrain and most web globes converge on.

### 3.2 Node selection (CDLOD ranges)

Level index `l = 0` is the finest (z15), `l = L−1` the coarsest (z7, L = 9). Ranges: `range[l] = range0 · 2^l`. Choose `range0` from a screen-space-error target:

```
vertexSpacing(z) = tileWidthMeters(z, lat) / quadsPerTile          // 64 quads
sse_px = geometricError · viewportHeight / (2 · d · tan(fovY/2))   // standard pinhole SSE
→ d_split(z) = vertexSpacing(z) · viewportHeight / (2 · τ · tan(fovY/2))
```
With 1080 px, fovY = 60°, τ = 4 px: `d_split = 467.7/4 · spacing ≈ 117 · spacing`; z15 at 37.6° has spacing 969 m / 64 = 15.1 m → `range0 ≈ 1.8 km`. Pick **`range0 = 3.5 km` (τ ≈ 2 px) on desktop, 1.8 km on low-end**, and because ranges double, z7 covers `3.5 · 2^8 = 896 km`, past the horizon even at FL350 (357 km, section 4.5). Cesium's equivalents: `Globe.maximumScreenSpaceError` default 2, `Cesium3DTileset` default 16 ([Cesium Globe docs](https://cesium.com/docs/cesiumjs-ref-doc/Globe.html)).

Tile budget at lat 37.6° (disc radius = range of that level, 3D distance so altitude removes the fine rings):

| Level | Zoom | Tile width | Range | Tiles in annulus (all-around) | After frustum cull (~35%) |
|---|---|---|---|---|---|
| 0 | 15 | 0.97 km | 3.5 km | ≈ 41 | 14 |
| 1 | 14 | 1.94 km | 7 km | ≈ 31 | 11 |
| 2–8 | 13 → 7 | 3.9 → 248 km | 14 → 896 km | ≈ 31 each | 11 each |
| total | | | | ≈ 290 (≈ 2.4 M tris) | ≈ 100 (≈ 0.8 M tris) |

Keep all-around tiles *resident* (cheap turns) but *draw* only frustum-visible ones. Hysteresis: split at `range[l]`, merge at `1.15 · range[l]`.

```ts
// Runs on the main thread each frame (or every 100 ms); nodes are cheap objects.
function select(node: Node, l: number, cam: Camera, out: Node[]): boolean {
  // node.aabb is in current local (ENU) frame, includes min/max height (from the tile's heights or parent's)
  if (!node.aabb.intersectsSphere(cam.position, ranges[l])) return false;   // parent will cover us
  if (!frustum.intersectsBox(node.aabb)) return true;                        // handled, draw nothing
  if (l === 0 || !node.aabb.intersectsSphere(cam.position, ranges[l - 1])) {
    out.push(node); return true;                                            // this node is in its range
  }
  for (const c of node.children(/* lazily created z+1 nodes */)) {
    if (!select(c, l - 1, cam, out)) out.push(c.asParentPatch(node));       // child out of its range → draw parent's area for that quadrant
  }
  return true;
}
```
`asParentPatch` = draw the parent's mesh restricted to one quadrant (CDLOD does exactly this; with a shared grid mesh it is a draw with `uvOffset/scale` uniforms and an index range covering 32×32 quads). If a selected node's data is not loaded yet, draw the nearest loaded ancestor with UV offset/scale instead (never leave holes).

### 3.3 Tile mesh

* Shared `BufferGeometry` for all tiles: grid of **N = 64 quads (65×65 = 4 225 vertices, 8 192 triangles)** plus a skirt ring (4 × 64 quads = 512 more triangles). r187 has no problem with ~300 draw calls of 8.7 k triangles.
* Per tile we build in a worker: `position` (Float32, local to tile centre, ENU-curved, section 4.3), `normal` (Int8 normalized ×3 or Int16), `uv` (Float32 ×2 or Uint16 normalized). Heights are also kept as a `Float32Array(257*257)` or the raw 256² decoded grid for collision queries (section 8).
* Vertex spacing vs DEM pixels: a 256-px tile sampled at 65 vertices means every 4th pixel. Sample with bilinear interpolation at the vertex position rather than nearest pixel, and for the **innermost level (z15 or z14) use N = 128** when the aircraft is below 300 m AGL (taxi/landing need the smoother ground). Make N a per-level constant table: `[128, 64, 64, 64, 64, 32, 32, 32, 32]`.
* Skirts: duplicate the 4 edge rows pushed down by `skirt = clamp(0.05 · tileWidth, 10 m, 400 m)` along the local down vector; skirt vertices get the edge normal and edge UV (stretch is invisible). Index them after the main grid so that a `drawRange` can drop them when morphing is enabled.
* v2 geomorph (from the paper, HLSL → GLSL): each vertex also carries the parent-grid height `hParent` (sampled from the same tile's heights at the even grid position, bilinear) so that the morphed vertex lands where the parent's mesh would be:

```glsl
uniform vec2  uGridDim;      // (64,64)
uniform vec2  uTileSize;     // whole tile extent in metres (east, south); fracPart is in normalized grid units
uniform vec3  uCamPosLocal;  // camera in tile-local space
uniform float uMorphStart, uMorphEnd;   // range[l]*0.7, range[l] (morph area = last 30%)
attribute float aHeight, aHeightParent;
attribute vec2  aGrid;      // normalized [0,1] grid position
void main() {
  vec3 p = position;                           // CPU-built, includes curvature
  float d = distance(p, uCamPosLocal);         // approx. is fine as long as it is consistent across tiles
  float k = clamp((d - uMorphStart) / (uMorphEnd - uMorphStart), 0.0, 1.0);
  vec2 fracPart = fract(aGrid * uGridDim * 0.5) * 2.0 / uGridDim;   // Strugar, listing lines 10–11
  p.xz -= fracPart * uTileSize * k;            // slide odd vertices onto the parent grid (x = east, z = south)
  p.y   = mix(aHeight, aHeightParent, k);      // and their heights
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
```
The paper's rule "the vertices on the node's grid mesh edges must remain exactly the same as the ones on the neighbouring nodes" holds for x/z automatically; for height it holds only if neighbours sample the *same* heightmap, hence skirts stay on in v2 as insurance (or snap edge heights to the parent tile's decoded values when both are loaded).

### 3.4 Fetch + decode pipeline (Web Workers)

```
main thread                      worker pool (navigator.hardwareConcurrency - 2, min 2, max 4)
────────────────────────────     ─────────────────────────────────────────────────────────────
select() → wanted tiles          onmessage {z,x,y, provider, originEcef, lat/lon bounds}
 - priority = SSE desc, then      1. cache = await caches.open('terrain-v1'); hit? else fetch(url, {signal})
   distance asc                   2. blob → createImageBitmap(blob, {premultiplyAlpha:'none', colorSpaceConversion:'none'})
 - max in-flight per worker 4     3. OffscreenCanvas(256,256).getContext('2d',{willReadFrequently:true}).drawImage → getImageData
 - AbortController per tile       4. decode: h[i] = (r*256 + g + b/256) - 32768           (Float32Array 65536)
postMessage({cmd:'load', ...})    5. (optional) runway flattening (section 8.3)
                                  6. build positions/normals/uvs (float64 math → Float32Array), skirt, AABB
onmessage → new BufferGeometry    7. postMessage({...}, [position.buffer, normal.buffer, heights.buffer])
 from transferred buffers;        8. imagery: fetch jpg → createImageBitmap(blob, {imageOrientation:'flipY'}) → transfer the ImageBitmap
 new Texture(imageBitmap)
```
Notes:
* Three's own `ImageBitmapLoader` already uses `premultiplyAlpha:'none'` and forces `colorSpaceConversion:'none'` (`src/loaders/ImageBitmapLoader.js` **[verified]**); we need the same two options for exact Terrarium bytes. Tiles are opaque, so `getImageData` is bit-exact in Chromium/Firefox/WebKit; add a **unit test that decodes the KSFO z15 tile 5246/12684 and asserts pixel (199,20) ≈ 3.96 ± 0.05 m** to catch a browser that colour-manages the canvas.
* Pure-JS PNG decoding (`fast-png`, MIT, ~20 KB) is an alternative that avoids canvas entirely and works in Node for tests; WebP (Mapterhorn) still needs `createImageBitmap`.
* Vite worker syntax: `new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })` ([Vite features: Web Workers](https://vite.dev/guide/features#web-workers)).
* Imagery decode on a worker thread with `imageOrientation: 'flipY'` and transfer the `ImageBitmap`; on the main thread `texture = new Texture(bitmap); texture.flipY = false; texture.colorSpace = SRGBColorSpace; texture.needsUpdate = true`.
* Cancel: when a tile leaves the selection before it loads, `controller.abort()`; keep a 2 s grace so turns do not thrash.

### 3.5 Resident data model

```ts
interface TerrainTile {
  key: string;                 // `${z}/${x}/${y}`
  z: number; x: number; y: number;
  heights: Float32Array;       // 256*256 decoded metres (kept for z >= 11 only; coarser tiles keep a 64x64 downsample)
  minH: number; maxH: number;
  mesh?: Mesh;                 // shared material, per-tile uniforms via onBeforeRender or a tiny ShaderMaterial clone
  imagery?: Texture; imageryZ: number; uvOffset: Vector2; uvScale: number;
  centerEcef: [number, number, number];   // float64, for rebasing
  state: 'queued' | 'loading' | 'ready' | 'failed';
  lastUsed: number;
}
```
Memory: heights 256 KB/tile × ~120 fine tiles = 31 MB; geometry (65² × (12+6+8) B ≈ 110 KB) × 300 = 33 MB; imagery ≈ 80 MB GPU. Evict with LRU when > 500 resident tiles or `performance.memory` pressure.

### 3.6 Persistent caching

* **Cache API** (`caches.open('terrain-v1')`) storing the raw tile `Response` keyed by URL (works in workers; `Response.clone()` before reading). PNG ≈ 80 KB, JPG ≈ 25 KB → 10 000 tiles ≈ 1 GB. Cap by count (e.g. 6 000 entries) with an LRU index in IndexedDB or just `cache.keys()` + delete oldest 10 % when over cap.
* Do **not** persist decoded Float32 heights (256 KB vs 80 KB PNG; decode is ~2–4 ms).
* Quotas ([MDN storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [web.dev persistent storage](https://web.dev/articles/persistent-storage)): best-effort storage, evicted LRU-by-origin under pressure; Chromium allows a large fraction of free disk per origin (60–80 % quoted; verify with `navigator.storage.estimate()`), Firefox computes from disk size, Safari ~1 GB-class and stricter on iOS. Call `navigator.storage.persist()` after the user has flown once (Chrome grants silently with engagement, Firefox prompts).
* Respect server caching: tiles are immutable in practice (`ETag` present on S3 **[verified]**); set our own TTL of 90 days.
* Offline: if `navigator.onLine === false` or the first fetch fails, use whatever is in the Cache; outside cached coverage switch to the procedural provider (section 5) — and tell the user.

### 3.7 Existing Three.js libraries worth reading (not adopting wholesale)

* [sxguojf/three-tile](https://github.com/sxguojf/three-tile) — lightweight tile map for Three.js; uses loaders.gl skirt helper and Mapbox **Martini** RTIN meshing; good reference for tile/provider plumbing.
* [whidrubeld/three-map-terrain](https://github.com/whidrubeld/three-map-terrain) — rings-of-tiles LOD ("no quadtree in the core"), OSM buildings/roads/water/trees from tiles; good reference for OSM extrusion.
* [@interverse/three-terrain-lod](https://www.npmjs.com/package/@interverse/three-terrain-lod) — quadtree + skirts + hysteresis, not tile-streaming.
* [mapbox/martini](https://github.com/mapbox/martini) (ISC) — RTIN adaptive triangulation of a (2^k+1)² grid, `new Martini(257).createTile(heights).getMesh(maxErrorMetres)`; an option for far tiles (fewer triangles on flat ocean) but it breaks the shared-grid CDLOD morph, so keep it as an experiment.
* [NASA-AMMOS 3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) — if we ever add Google Photorealistic 3D Tiles (needs a key) for cities.

---

## 4. Coordinate systems

### 4.1 Web Mercator tile math (EPSG:3857, [OSM "Slippy map tilenames"](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames))

```ts
export const R_MERC = 6378137;                       // WGS84 semi-major axis used by EPSG:3857
export const MERC_MAX = Math.PI * R_MERC;            // 20037508.342789244 m
export function lonLatToTile(lonDeg: number, latDeg: number, z: number) {   // fractional tile coords
  const n = 2 ** z, lat = latDeg * Math.PI / 180;
  return { x: (lonDeg + 180) / 360 * n,
           y: (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n };
}
export function tileToLonLat(x: number, y: number, z: number) {             // NW corner of tile (x,y); pass x+0.5,y+0.5 for the centre
  const n = 2 ** z;
  return { lon: x / n * 360 - 180,
           lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI };
}
export function metersPerPixel(latDeg: number, z: number, tileSize = 256) {
  return 2 * Math.PI * R_MERC * Math.cos(latDeg * Math.PI / 180) / (tileSize * 2 ** z);   // 156543.03 m at z0, equator
}
export function tileWidthMeters(latDeg: number, z: number) { return metersPerPixel(latDeg, z) * 256; }
```
Reference values **[verified by script]**: m/px at z12/z14/z15 — equator 38.22/9.55/4.78; lat 37.6° 30.28/7.57/3.79; lat 47.3° 25.92/6.48/3.24. Tile width at 37.6°: z12 = 7.75 km, z15 = 0.969 km. Latitude limit ±85.0511°; `y` must be clamped to `[0, n)`, `x` wrapped modulo `n`.

Mercator metres are *not* ground metres (scale factor `1/cos(lat)`, 1.262 at SF, and it changes ~1.2 % over 100 km north–south at 37°). Never place vertices by scaling Mercator coordinates; convert each vertex's lon/lat to ENU (4.3).

### 4.2 Local frame: ENU on the WGS84 ellipsoid

Three.js is Y-up right-handed. Define the sim frame as **X = East, Y = Up, Z = South** (so `East × Up = South` keeps it right-handed). Heading (true) of a velocity `v` is `atan2(v.x, -v.z)`.

WGS84 constants: `a = 6378137`, `f = 1/298.257223563`, `e² = f(2−f) = 6.69437999014e−3`.

```ts
export type Ecef = [number, number, number];
export function geodeticToEcef(latDeg: number, lonDeg: number, h: number): Ecef {
  const lat = latDeg * D2R, lon = lonDeg * D2R, s = Math.sin(lat), c = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lon), (N + h) * c * Math.sin(lon), (N * (1 - E2) + h) * s];
}
/** Rotation ECEF → ENU at (lat0, lon0); rows are the E, N, U unit vectors in ECEF. */
export function enuRotation(lat0Deg: number, lon0Deg: number) {
  const la = lat0Deg * D2R, lo = lon0Deg * D2R, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return [ [-so,        co,       0 ],       // East
           [-sl * co,  -sl * so,  cl],       // North
           [ cl * co,   cl * so,  sl] ];     // Up
}
export class LocalFrame {                     // float64 everywhere; one instance = one floating origin
  constructor(public lat0: number, public lon0: number, public h0: number) {
    this.o = geodeticToEcef(lat0, lon0, h0); this.R = enuRotation(lat0, lon0);
  }
  toLocal(p: Ecef): [number, number, number] {           // → Three.js (x=E, y=U, z=S)
    const d = [p[0] - this.o[0], p[1] - this.o[1], p[2] - this.o[2]];
    const e = dot(this.R[0], d), n = dot(this.R[1], d), u = dot(this.R[2], d);
    return [e, u, -n];
  }
  fromLocal(x: number, y: number, z: number): Ecef {     // inverse (R is orthonormal → transpose)
    const e = x, u = y, n = -z;
    return [ this.o[0] + this.R[0][0]*e + this.R[1][0]*n + this.R[2][0]*u,
             this.o[1] + this.R[0][1]*e + this.R[1][1]*n + this.R[2][1]*u,
             this.o[2] + this.R[0][2]*e + this.R[1][2]*n + this.R[2][2]*u ];
  }
}
```
ECEF → geodetic (for the GPS/altimeter) use Bowring's or the closed-form Vermeille method; precision is irrelevant here, 2 iterations of the standard `lat = atan2(z + e²·N·sinlat, p)` loop suffice.

### 4.3 Tile heights → local frame (and curvature for free)

For tile vertex `(i, j)` of an N-quad grid: `x_tile = x + i/N`, `y_tile = y + j/N` → `tileToLonLat` → `h = bilinear(heights, i·256/N, j·256/N)` → `geodeticToEcef(lat, lon, h)` → `frame.toLocal()` (float64) → subtract the tile centre's local position → store float32. The result is a **genuinely curved** patch: a point 100 km from the origin sits `d²/(2R) ≈ 785 m` below the tangent plane **[verified by script: 7.8 m at 10 km, 196 m at 50 km, 785 m at 100 km, 1 766 m at 150 km]**. Because `position` is small (|p| < tile half-width) and the tile's `matrixWorld` translation is set from float64 in JS, GPU float32 is only ever applied to small numbers.

Three.js detail that makes this work: `object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld)` runs in JS doubles (`WebGLRenderer.js` **[verified]**) and only the final matrix is uploaded as float32, so a tile 300 km away gets a 300 000 m translation in the uploaded matrix (float32 resolution there ≈ 0.03 m — invisible at that distance), while the tile under the aircraft has a translation of a few hundred metres (resolution ≈ 3·10⁻⁵ m).

Normals: compute in ENU from the height grid before curvature (central differences, section 6.1), then rotate by the local up at the tile centre (tiny angle); or simply compute from the final curved positions by cross products of neighbouring vertices in the worker — simplest and exact.

### 4.4 Floating origin / rebasing

* Keep `LocalFrame` as the single source of truth; aircraft state (position, velocity, orientation) is stored in that frame in float64 (JS numbers), physics runs there.
* When `|aircraft.xz| > 20 km` (or 10 km on a low-end preset), create `frameB` at the aircraft's geodetic position (h0 = 0), compute the **rigid transform** `T_AB = frameB.worldFromEcef · frameA.ecefFromWorld` (4×4, float64), and apply it to: every tile's `matrixWorld` (`tile.matrix.premultiply(T_AB)`; no vertex rewrites), the aircraft and all scene objects, camera, water patches, and the sky's "up". Rotation angle is `d/R ≈ 0.18°` at 20 km; nobody will see the frame change. Do it between physics steps; latency ≈ 300 tiles × 1 matrix multiply = sub-millisecond.
* Gravity/"down" for the FDM: `down = -normalize(ecefPos)` expressed in the local frame (the geodetic normal differs from the geocentric one by ≤ 0.19°, fine), or just `−Y` if the rebase radius is ≤ 20 km (max tilt error 0.18°, which is below instrument resolution). Recommend the exact vector; it is 3 lines.
* Alternative considered and rejected: flat plane plus a fake `y −= d²/(2R)` in the vertex shader. It is cheap but makes the physics plane, the sea plane, the horizon and nav geometry inconsistent with one another.

### 4.5 Horizon, curvature and visibility numbers **[verified by script, R = 6 371 km]**

| Eye height | Geometric horizon | With standard refraction (×7/6) | Horizon dip |
|---|---|---|---|
| 10 m | 11.3 km | 12.2 km | 0.10° |
| 100 m | 35.7 km | 38.6 km | 0.32° |
| 500 m | 79.8 km | 86.2 km | 0.72° |
| 1 000 m | 112.9 km | 121.9 km | 1.01° |
| 3 000 m | 195.5 km | 211.2 km | 1.76° |
| 10 000 m | 357.0 km | 385.6 km | 3.21° |

`d_horizon = sqrt(2·R·h)`, `dip = acos(R/(R+h))`. So "100 km visibility" is an atmospheric statement; the *geometry* must extend ~400 km for airliner altitudes, which the z7 ring (248 km tiles) does. The sky dome's horizon line must sit at `−dip`, not at local horizontal (section 10).

---

## 5. Procedural fallback (offline / outside coverage)

Goal: plausible, flyable terrain that keys off the same `ElevationProvider` interface, so everything downstream is unchanged. Generate heights for a requested z/x/y in the worker from a deterministic noise function of (lon, lat) so that neighbouring tiles agree exactly.

* Noise: 2-D simplex (e.g. [jwagner/simplex-noise](https://github.com/jwagner/simplex-noise), MIT, 4.x, seeded via `alea`) or an in-house implementation (~80 lines). Evaluate in ground metres: `p = (east_m, north_m)` from an equirectangular projection around the tile centre (`east = R·cos(lat)·Δlon`, `north = R·Δlat`).
* Height model (metres):

```ts
function fbm(p: Vec2, oct = 6, lac = 2.0, gain = 0.5): number {   // returns ~[-1,1]
  let a = 1, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(p[0] * f, p[1] * f); norm += a; a *= gain; f *= lac; }
  return s / norm;
}
function ridged(p: Vec2, oct = 5): number { let a = 1, f = 1, s = 0; for (let i = 0; i < oct; i++) { s += a * (1 - Math.abs(noise2(p[0]*f, p[1]*f))) ** 2; a *= 0.5; f *= 2.1; } return s; }
export function proceduralHeight(east: number, north: number, seed: Seed): number {
  const warp = 600 * fbm([east / 9000 + 7.1, north / 9000 - 3.3], 3);          // domain warp for less "blobby" coasts
  const q: Vec2 = [(east + warp) / 25000, (north - warp) / 25000];
  const continent = fbm(q, 4);                                                  // ±1 over ~50 km features
  const mountains = ridged([q[0] * 3.1, q[1] * 3.1], 5) * smoothstep(0.15, 0.6, continent);
  const hills = fbm([east / 2500, north / 2500], 5) * 80;
  let h = continent * 350 + mountains * 1400 + hills;
  h = h < 0 ? h * 0.25 - 15 : h;                                                // shallow seas; sea level at 0
  return h;
}
```
Tune so that ~35 % of the area is sea, peaks reach ~2 500 m, and slopes stay flyable near the spawn airport (force a 4 km radius plateau at the published airport elevation using `mix(h, apElev, smoothstep(5000, 3000, dist))`).
* Biomes for texturing (fragment shader, from height + slope + a low-frequency "humidity" noise): sand `h < 4 m`; grass `h < 900 m, slope < 25°`; forest `300 < h < 1 800 m, humidity > 0.3`; rock `slope > 35°` or `h > 2 100 m`; snow `h > 2 400 m − 600·latitudeFactor, slope < 45°`.
* Splat shader (also usable over real imagery as the "detail" layer):

```glsl
uniform sampler2D uGrass, uRock, uSnow, uSand;   // 1024², tiling, sRGB
varying vec3 vWorldPos; varying vec3 vNormal; varying float vHeight;
vec4 triplanar(sampler2D t, vec3 p, vec3 n, float scale) {        // for steep rock only; 3 taps
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture(t, p.yz * scale) * w.x + texture(t, p.xz * scale) * w.y + texture(t, p.xy * scale) * w.z;
}
void main() {
  float slope = 1.0 - vNormal.y;                                  // 0 flat … 1 vertical
  float wSnow = smoothstep(2300.0, 2600.0, vHeight) * (1.0 - smoothstep(0.55, 0.75, slope));
  float wRock = smoothstep(0.35, 0.6, slope);
  float wSand = 1.0 - smoothstep(2.0, 6.0, vHeight);
  float wGrass = max(0.0, 1.0 - wSnow - wRock - wSand);
  vec3 col = texture(uGrass, vWorldPos.xz / 12.0).rgb * wGrass
           + triplanar(uRock, vWorldPos, vNormal, 1.0 / 9.0).rgb * wRock
           + texture(uSnow, vWorldPos.xz / 15.0).rgb * wSnow
           + texture(uSand, vWorldPos.xz / 8.0).rgb * wSand;
  gl_FragColor = vec4(col, 1.0);
}
```
Textures: 4 × 1024² (or 512²) tiling albedos, ~1–2 MB as KTX2/Basis (`KTX2Loader` is in r187) or ~4 MB as JPEG; use public-domain/CC0 sets (Poly Haven, ambientCG).

---

## 6. Terrain shading

### 6.1 Normals from heights
Central differences on the decoded grid (in the worker), spacing `sx = metersPerPixel(lat, z)` (east–west) and `sy ≈ sx` (Mercator is conformal, so pixels are square in ground metres at a given latitude):
```
n = normalize( (h[x-1,y] - h[x+1,y]) / (2 sx),  1,  (h[x,y-1] - h[x,y+1]) / (2 sy) )    // Y-up; z = south = +y in image space
```
At tile edges fetch the neighbour tile's edge row if loaded, else clamp (skirts hide the 1-pixel lighting seam). Alternative for far tiles: the AWS `normal` tiles (RGB-encoded normals), but then two fetches per tile; not worth it.

### 6.2 Lighting model
`MeshStandardMaterial`-equivalent is overkill; terrain is diffuse. Use a custom `ShaderMaterial` (or `onBeforeCompile` on `MeshLambertMaterial`): Lambert with sun direction + hemisphere ambient (sky colour above, ground colour below) + optional 3-cascade CSM for 0–2 km (`three/examples/jsm/csm/CSM.js` in r187 **[verified present]**) — shadows matter for parked aircraft and hangars, not for the terrain itself at altitude. Imagery already contains baked sun shading (Sentinel mosaics are ~10:30 local time), so keep terrain N·L contrast low (`0.6 + 0.4·max(N·L,0)`) and let the sky/haze do the mood.

### 6.3 Detail textures
Below ~1 500 m slant range the imagery (7.6 m/px) is blurry. Multiply the imagery by a tiling greyscale detail (1024², 8 m repeat) with mid-grey mean, fading out between 1 and 3 km (`mix(1.0, detail, 1.0 − smoothstep(1000, 3000, dist))`); add a second 50 m-repeat macro noise to hide tiling. For slope > 40° blend toward the triplanar rock texture (section 5) to kill the "stretched satellite pixels" look on cliffs.

### 6.4 Fog and haze
* Base: height fog `density(h) = ρ0 · exp(−h / Hs)` with `Hs ≈ 1 200 m`, integrated analytically along the view ray (Quílez's formula), fog colour = sky colour sampled toward the horizon in the view direction (pass a small 32×8 sky LUT or 2 colours: sun-side/anti-sun). Visibility setting `V` (km) → `ρ0 = 3.912 / V` (Koschmieder, 2 % contrast).
* Aerial perspective tint: `col = mix(col, fogCol, 1 − exp(−τ))` with `τ = ρ0 · Hs · (exp(−h_cam/Hs) − exp(−h_pt/Hs)) / (|Δh|/d)` (falls back to `ρ0·d` when the ray is horizontal).
* Three's `FogExp2` is a reasonable v0 (`density = 1/(V·0.3)`), but it is camera-centred and ignores altitude; above 3 000 m the mountains must poke out of the haze layer, so switch to the custom version early.
* Keep the haze/sky doc (04) in charge of the colours; this doc only needs the hooks `uFogColorHorizonSun`, `uFogColorHorizonAnti`, `uRho0`, `uHs`.

### 6.5 Water: detection and rendering
Detection, per tile, from data we already have:
1. **Sea:** Terrarium `h ≤ 0` (ocean has ETOPO1/topobathy bathymetry: SF Bay −3.2 m, Pacific −310 m **[verified]**). SRTM-era coastlines are at 0.0 exactly in places; use `h ≤ 0.5` and also flag cells whose 3×3 neighbourhood is perfectly flat.
2. **Lakes/rivers:** not negative (Tahoe = 1 897.6 m **[verified]**). Use the `water` layer of OSM vector tiles (section 7) rasterised into the tile's mask in the worker (polygon fill, 256² Uint8), or, without vector tiles, imagery colour test: `b > r·1.15 && b > g·1.05 && luma < 0.45` on the EOX tile (Sentinel water is dark blue/black) ANDed with "flat heights in 5×5". Rasterised OSM is far more reliable; the colour test is the fallback.
3. Store the mask as a `R8` `DataTexture` per tile (64 KB) → in the fragment shader `mix(terrainColor, waterShade, mask)` and in the vertex shader clamp `h = max(h, 0)` where mask = sea (removes bathymetry bumps under the water).

Rendering: because the terrain is curved, the **ocean must be curved too**: for every selected tile with `minH ≤ 0`, draw a second instance of the grid mesh with `h = 0` on the ellipsoid (built once per tile in the worker, 4 225 verts, no skirt) using a water `ShaderMaterial`: two scrolling normal maps (512², 1/40 m and 1/7 m UV scales, ~0.03 m/s), Fresnel (`F0 = 0.02`), Blinn-Phong sun specular (shininess ~400, boosted at low sun), `waterColor = mix(deepBlue, shallowGreen, exp(−depth/8 m))` using the (negative) Terrarium depth, sky reflection = analytic sky colour toward the reflected ray (no reflection render target — `three/examples/jsm/objects/Water.js` renders the scene twice, which we cannot afford with 300 tiles). Lakes use the same material on a flat patch at the lake surface elevation (median height under the polygon).

---

## 7. 3D content: buildings, trees, airports

### 7.1 Source: OpenFreeMap vector tiles (OSM, no key)
[hyperknot/openfreemap README](https://raw.githubusercontent.com/hyperknot/openfreemap/main/README.md) **[verified]**: tiles `https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf`, TileJSON `https://tiles.openfreemap.org/planet/latest`, "no registration, no user database, no API keys", "no limits on the number of map views or requests"; built with Planetiler in the **OpenMapTiles schema** (max zoom 14 in the planet build **[verify]**), tiles cacheable 1 day, TileJSON 1 hour. Attribution required: "© OpenMapTiles © OpenStreetMap contributors" (+ optional OpenFreeMap). Data licence ODbL (attribution; share-alike applies to *derived databases*, not to rendering). CORS: designed for MapLibre in browsers → must be enabled **[verify]**.

Decode with [`pbf`](https://github.com/mapbox/pbf) + [`@mapbox/vector-tile`](https://github.com/mapbox/vector-tile-js) (BSD-3, ~10 KB together) in the worker:
```ts
import Pbf from 'pbf'; import { VectorTile } from '@mapbox/vector-tile';
const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
const buildings = vt.layers['building'];          // props: render_height, render_min_height (metres)
const landcover = vt.layers['landcover'];         // class: wood | grass | farmland | ice | wetland | sand | …
const water = vt.layers['water'];                 // class: ocean | lake | river | …
const aeroway = vt.layers['aeroway'];             // class: runway | taxiway | apron | aerodrome | helipad
for (let i = 0; i < buildings.length; i++) { const f = buildings.feature(i); const rings = f.loadGeometry(); /* tile-local 0..4096 */ }
```
Layer names/attributes per the [OpenMapTiles schema](https://openmaptiles.org/schema/) **[memory]**. The `aeroway` runway/taxiway/apron polygons at z14 are also the cheapest way to paint **runway and taxiway markings** on the ground texture (render them into the tile's imagery texture in the worker with OffscreenCanvas) — far better than relying on Sentinel pixels.

### 7.2 Overpass API (dev tooling only)
Public instance limits ([Overpass docs](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [rate-limit notes](https://overspan.dev/blog/overpass-429-rate-limits)): 2 concurrent slots per IP (hard), ~10 000 queries/day (soft), default `[timeout:180]`, `[maxsize:536870912]`; 429 when slots are busy. A 2025–26 integrator reports `overpass-api.de` now answers browser requests from private-LAN origins with **HTTP 406 and no `Access-Control-Allow-Origin`** ([ha-bosch-ebike release notes](https://github.com/Xunil99/ha-bosch-ebike/releases/tag/v1.8.4)); from a public HTTPS origin it may still work **[verify]**. Verdict: use Overpass in `scripts/` to bake airport-area detail (e.g. hangar footprints with `building=hangar`, `aeroway=*` lines) into static JSON shipped with the app, not at runtime.

### 7.3 Building instancing
* Extrude footprints (`ShapeUtils.triangulateShape` — earcut is built into Three) to `render_height` (default 8 m when absent, `levels × 3.2` if `building:levels`), flat roofs; per z14 tile batch everything into **one `BatchedMesh`** (`perObjectFrustumCulled = true`, `sortObjects = true` in r187 **[verified]**) with a 4-colour palette by area/height and a 512² façade atlas. Budget: ≤ 40 k buildings resident (two z14 rings around the aircraft, ≈ 20 km), ≤ 400 k triangles. Load only when below 3 000 m AGL; fade in by alpha over 1 s.
* Ground clamping: sample the height grid (section 8) at the footprint centroid; extend the base 3 m below.

### 7.4 Trees
* Scatter inside `landcover.class = wood` polygons (and, as a cheap biome fallback where vector tiles are missing, where imagery is "dark green": `g > r·1.1 && g > b·1.3 && luma < 0.35`) with a Poisson/jittered grid at 1 tree per 25–40 m (≈ 400–600 per km² visually enough), `InstancedMesh` of a 2-plane crossed billboard (8 triangles) with 4 species in an atlas; height 8–25 m by `fbm`. Budget 150 k instances within 8 km, 1 draw call per z14 tile (≤ 16 k instances each). Beyond 8 km fake trees with a darker, bump-mapped detail texture on the `wood` mask.
* Conifers above 1 200 m and north of 50°, broadleaf otherwise (silhouette matters more than species).

### 7.5 Airports
Runway/taxiway geometry comes from OurAirports (section 11) + OSM `aeroway`; paint markings (threshold bars, numbers, centreline, aiming points per ICAO Annex 14 dimensions) procedurally into a 2048×512 texture per runway laid on a thin quad 0.05 m above the flattened terrain (`polygonOffset` to avoid z-fight). Lights (PAPI, edge, approach) as an `InstancedMesh` of additive sprites.

---

## 8. Accurate height queries (ground collision)

### 8.1 Query
```ts
export class HeightField {
  constructor(private tiles: Map<string, TerrainTile>, private maxZ = 15) {}
  /** returns height (m, ellipsoid-relative, same datum as Terrarium ≈ EGM96/orthometric) and whether it came from a fine tile */
  sample(lonDeg: number, latDeg: number): { h: number; z: number } | null {
    for (let z = this.maxZ; z >= 0; z--) {
      const t = lonLatToTile(lonDeg, latDeg, z); const tile = this.tiles.get(`${z}/${t.x|0}/${t.y|0}`);
      if (!tile || tile.state !== 'ready') continue;
      const fx = (t.x % 1) * 256 - 0.5, fy = (t.y % 1) * 256 - 0.5;        // pixel centres at +0.5
      const x0 = clamp(Math.floor(fx), 0, 254), y0 = clamp(Math.floor(fy), 0, 254);
      const tx = clamp(fx - x0, 0, 1), ty = clamp(fy - y0, 0, 1), H = tile.heights, W = 256;
      const h00 = H[y0*W+x0], h10 = H[y0*W+x0+1], h01 = H[(y0+1)*W+x0], h11 = H[(y0+1)*W+x0+1];
      return { h: lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), ty), z };
    }
    return null;
  }
}
```
* Call it with the aircraft's geodetic position (from `frame.fromLocal` → ECEF → geodetic) for each gear contact point (3–4 samples/step at 120 Hz is trivial). Also return the local normal (from the same 4 heights) for taxiing on slopes.
* Mismatch warning: the mesh samples heights at 65 points, the collision at 256 — a wheel can be up to a few cm "inside" the visual mesh between vertices. Either sample collision from the same 65² lattice (bilinear on the mesh grid) or accept it (N = 128 near the ground makes it negligible).
* Datum: Terrarium sources are orthometric (EGM96-ish); we treat them as ellipsoid heights. The geoid undulation is −32 m at SF, +47 m at Innsbruck **[memory]**, which only matters if we display GPS altitude vs barometric altitude; the whole world is shifted consistently so nothing collides wrong. Flag for the avionics doc.

### 8.2 Before tiles load
* Spawn is always at a known runway end (OurAirports `le_/he_elevation_ft`) → place the aircraft at that elevation + gear height and **freeze physics until the z14/z15 tile under the aircraft is `ready`** (show "Loading terrain…"; typical cold start: 1 PNG + 1 JPG ≈ 110 KB, < 1 s). Prefetch the full selection before unfreezing (≈ 100 tiles, 8–10 MB on first run; ~1–3 s on 50 Mbit/s; zero on a warm Cache).
* In flight the aircraft should never reach unloaded ground (the ring selection is in 3D distance, so the fine ring is always under the aircraft); if `sample()` returns null, fall back to the coarsest loaded tile, and if none, to the last known height.

### 8.3 Runway flattening (required)
Terrain under a runway is not flat in any DEM (section 1.5: −3.1 m at Sion, +2.3 m at Half Moon Bay). In the worker, when a tile intersects an airport, override heights inside the runway polygon (threshold-to-threshold centreline from OurAirports, half-width `width_ft/2 + 30 m`) with the linear interpolation between the two threshold elevations, and feather to the DEM over the next 150 m (`smoothstep`). Apply the same override in `HeightField.sample()` (or just let the sampled heights be the modified grid — they are). For aprons/taxiways use the airport's `elevation_ft` where OSM `aeroway=apron|taxiway` polygons exist.

---

## 9. Performance budgets (laptop GPU: Intel Iris Xe / Apple M1 / GTX 1650-class)

| Budget | Target | Notes |
|---|---|---|
| Terrain triangles / frame | ≤ 1.0 M (0.8 M typical after frustum culling) | 100 drawn tiles × 8.7 k; N = 128 for the innermost ring adds ≤ 0.3 M. |
| Terrain draw calls | ≤ 120 (+ ≤ 40 water patches) | One shared geometry, one shared material, per-draw uniforms (imagery texture, uv offset/scale, morph range, tile centre). |
| Buildings + trees | ≤ 0.5 M tris, ≤ 30 draw calls | `BatchedMesh`/`InstancedMesh` per z14 tile. |
| GPU texture memory | ≤ 350 MB total; terrain imagery ≤ 120 MB | 300 × 256² RGBA8 + mips = 105 MB; detail/splat/water ≈ 15 MB. |
| CPU per frame (main thread) | selection ≤ 0.5 ms, uploads ≤ 2 ms (≤ 4 geometry + 4 texture uploads per frame) | Throttle `needsUpdate` uploads to avoid 30 ms hitches; `texture.image` from an `ImageBitmap` uploads fast. |
| Worker time per tile | decode 3 ms + mesh 4 ms (65²) / 12 ms (129²) | Measured orders of magnitude for 256² PNG in Chromium **[memory]**. |
| Network | cold start ≤ 10 MB, cruise ≤ 1.5 MB/min at 120 kt | A z15 ring moves 1 tile every ~16 s at 120 kt; ~4 new z15 + 2 z14 + … ≈ 8 tiles/16 s ≈ 50 KB/s. |
| Frame time | 16.7 ms at 1080p on the desktop preset; 1 440×810 internal resolution on the laptop preset (`renderer.setPixelRatio(0.75)`) | The sky/clouds pass (doc 04) will dominate, keep terrain ≤ 5 ms. |

Depth precision for 0.3 m (cockpit) … 600 km (far ring):
* **Preferred: reversed-Z.** r187 `WebGLRenderer({ reversedDepthBuffer: true })` sets `capabilities.reversedDepthBuffer` only if `EXT_clip_control` is present, else warns and falls back (`WebGLCapabilities.js` **[verified]**); `logarithmicDepthBuffer` is ignored when reversed depth is active. Extension availability ([web3dsurvey EXT_clip_control](https://web3dsurvey.com/webgl/extensions/EXT_clip_control)): Chromium and Safari ≈ 95–98 % of reports, **Firefox ≈ 1 %** (open [Mozilla bug 1908745](https://bugzilla.mozilla.org/show_bug.cgi?id=1908745)). Custom `ShaderMaterial`s must not hard-code depth comparisons; use Three's `depthFunc` defaults and `camera.reversedDepth` handling (r187 sets this automatically for the active camera).
* **Fallback 1: `logarithmicDepthBuffer: true`.** Works everywhere (`EXT_frag_depth` is core in WebGL2) but writes `gl_FragDepth`, disabling early-Z (costly for the overdraw-heavy sky/cloud pass), and shows line aliasing. Decide at start-up by probing `canvas.getContext('webgl2').getExtension('EXT_clip_control')` on a throwaway context, because the renderer option cannot be changed after construction.
* **Fallback 2 (also needed for the cockpit regardless):** two cameras — world camera near 2 m / far 600 km, cockpit camera near 0.05 m / far 50 m rendered after `renderer.clearDepth()`. With reversed-Z a single camera at near 0.3 m is fine for both (float24/32 reversed depth has ~1e−7 relative error across 2·10⁶ ratio).
* Near plane is what matters for precision; never set it below what the cockpit needs.

---

## 10. Sun/sky horizon integration and haze (hooks for doc 04)

* r187 ships `three/examples/jsm/objects/Sky.js` (Preetham analytic sky; uniforms `turbidity` (2), `rayleigh` (1), `mieCoefficient` (0.005), `mieDirectionalG` (0.8), `sunPosition` **[verified]**). It draws the horizon at the local `up` plane. With a curved ENU world the true horizon is `dip` below (section 4.5): either (a) rotate/scale the sky mesh so its horizon is at `−dip` (ugly at FL350), or (b) rely on the **haze**: terrain/ocean extend past the geometric horizon and the fog colour equals the sky colour at the horizon, so the band between `0` and `−dip` is filled with terrain/sea that has converged to fog colour. (b) is what MSFS effectively does; adopt it, and make sure the far ring (z7) reaches ≥ 400 km.
* Fog colour sampling: evaluate the same analytic sky function on the CPU for 16 azimuths at elevation −0.5°…+2° and upload as a 16×1 RGB texture each frame; the terrain fragment shader fetches it by view azimuth. Sun-side haze is brighter and warmer; anti-sun side bluer (Rayleigh) — this single trick gives most of the "MSFS atmosphere".
* Haze density preset mapping (doc 01 weather presets → visibility `V`): Clear 80–120 km, Few/Scattered 50 km, Broken 25 km, Overcast 12 km, Rain 6 km, Storm 3 km, Fog 0.5 km (`ρ0 = 3.912/V`).
* Sun direction = `SunCalc`-style algorithm (doc 04) → ECEF → local frame via `frame.R`; recompute at every rebase.
* Night: imagery goes to `0.02 × albedo`, add city-light emissive from the `building` density mask (cheap "Black Marble" look); optionally EOX `blackmarble_3857` tiles.

---

## 11. Home airport and candidates (OurAirports data)

### 11.1 Data source: OurAirports
* Files (daily dumps): `https://davidmegginson.github.io/ourairports-data/airports.csv` (12.76 MB) and `runways.csv` (3.97 MB) ([repo README](https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/README.md) **[verified]**; the raw GitHub URL `https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv` returned `access-control-allow-origin: *` **[verified]**; GitHub Pages also sends `*` **[memory]**). Docs: `https://ourairports.com/data/`. License: **public domain** ("all data is released into the Public Domain", [Megginson 2008](https://lahso.megginson.com/2008/02/02/data-wants-to-be-free/index.html)).
* `runways.csv` columns **[verified]**: `id, airport_ref, airport_ident, length_ft, width_ft, surface, lighted, closed, le_ident, le_latitude_deg, le_longitude_deg, le_elevation_ft, le_heading_degT, le_displaced_threshold_ft, he_ident, he_latitude_deg, he_longitude_deg, he_elevation_ft, he_heading_degT, he_displaced_threshold_ft`. Headings are **true**. Some rows have blank coordinates/headings (e.g. the KSEA "lower/high" dummy row, grass strips) — filter `closed = 0`, non-empty lat/lon for both ends, `length_ft ≥ 1500`.
* `airports.csv` columns **[verified]**: `id, ident, type, name, latitude_deg, longitude_deg, elevation_ft, continent, iso_country, iso_region, municipality, scheduled_service, icao_code, iata_code, gps_code, local_code, home_link, wikipedia_link, keywords`.
* Do **not** fetch the CSVs at runtime (17 MB). Add `scripts/build-airports.mjs` (Node 22, `fetch` + a tiny CSV parser) that emits `public/data/airports.json` with `large_airport|medium_airport` + runways (~5 000 airports, ~1.5 MB, ~350 KB gzipped) and a per-10°-cell shard for `small_airport` loaded on demand. Re-run monthly in CI.
* Quality: community-maintained; thresholds agree with the DEM to a few metres (section 1.5) and the designators match `heading_degT − magnetic variation` (KSFO 28R: 298 °T − 13 °E ≈ 285 °M → "28"). Cross-check the 5 showcase airports against FAA ADIP/NASR and the Austrian AIP before baking markings **[verify]**.

### 11.2 Recommended default: **KSFO, San Francisco International**, spawn on 28R
Reasons: 10 m 3DEP plus 1/9-arc-second NED topobathy in Terrain Tiles for the whole Bay (**[verified]** via `x-amz-meta-x-imagery-sources`), dramatic but forgiving geography (sea level runway, 780 m Mt Tamalpais 25 km NW, 1 170 m Mt Diablo 45 km NE, the Golden Gate 20 km NNW, Pacific coast 10 km W), heavy OSM coverage for buildings, excellent Sentinel and Esri imagery, four runways in two intersecting pairs for landing-challenge variety, and KHAF/KSQL/KPAO/KOAK within 25 km for short hops. Magnetic variation ≈ 13.0 °E (2025) **[memory, compute with WMM at runtime]**.

### 11.3 Candidate table (from `runways.csv`, 2026-11-02 dump **[verified]**; `ft`, `°T`)

| Airport | Rwy | Threshold lat, lon | Elev | Hdg °T | Displ. thr | Length×width ft | Opposite end (lat, lon, elev, hdg) |
|---|---|---|---|---|---|---|---|
| **KSFO** San Francisco Intl (ARP 37.619806, −122.374821, 13 ft) | 28R | 37.613538, −122.35716 | 13 | 298 | 300 | 11 870 × 200 ASP | 10L: 37.628742, −122.39341, 5 ft, 118° |
| | 28L | 37.61172, −122.358367 | 13 | 298 | 300 | 11 381 × 200 | 10R: 37.626298, −122.393124, 6 ft, 118° |
| | 1R | 37.606333, −122.381061 | 12 | 28 | 560 | 8 660 × 200 | 19L: 37.627346, −122.367124, 10 ft, 208° |
| | 1L | 37.607898, −122.38295 | 10 | 28 | 645 | 7 650 × 200 | 19R: 37.626476, −122.37063, 9 ft, 208° |
| **LOWI** Innsbruck (47.260201, 11.344, 1 907 ft) | 08 | 47.2588005, 11.3309002 | 1 907 | 81 | 339 | 6 562 × 148 ASP | 26: 47.2616005, 11.3570004, 1 894 ft, 261° |
| **KSEA** Seattle–Tacoma (47.447943, −122.310276, 433 ft) | 16L | 47.463799, −122.307999 | 432 | 180 | — | 11 901 × 150 PEM | 34R: 47.431198, −122.307999, 347 ft, 360° |
| | 16C | 47.463799, −122.310997 | 430 | 180 | — | 9 426 × 150 | 34C: 47.438, −122.310997, 363 ft, 360° |
| | 16R | 47.463799, −122.318001 | 430 | 180 | — | 8 500 × 150 | 34L: 47.440498, −122.318001, 363 ft, 360° |
| **KBFI** Boeing Field (47.527042, −122.29995, 21 ft) | 14R | 47.540549, −122.311372 | 17 | 140 | — | 10 007 × 200 ASP | 32L: 47.516745, −122.291252, 21 ft, 320°, displ. 887 |
| | 14L | 47.538025, −122.30748 | 21 | 140 | 250 | 3 709 × 100 | 32R: 47.5292, −122.30002, 21 ft, 320°, displ. 375 |
| **KHAF** Half Moon Bay (37.513401, −122.500999, 66 ft) | 12 | 37.5185013, −122.5070038 | 59 | 137 | 763 | 5 000 × 150 ASP | 30: 37.5084, −122.4950027, 36 ft, 317°, displ. 763 |
| **KTRK** Truckee Tahoe (39.318628, −120.140562, 5 900 ft) | 11 | 39.3247986, −120.1529999 | 5 897 | 120.1 | — | 7 001 × 100 ASP | 29: 39.3152008, −120.1309967, 5 889 ft, 300.1° |
| | 02 | 39.3144989, −120.1399994 | 5 886 | 29.9 | — | 4 650 × 75 | 20: 39.3255997, −120.1320038, 5 891 ft, 209.9°, displ. 115 |
| KASE Aspen (39.223202, −106.869003, 7 820 ft) | 15 | 39.2322, −106.8732 | 7 680 | 160 | — | 8 006 × 100 ASP | 33: 39.2116, −106.8633, 7 820 ft, 340°, displ. 1 000 |
| KOAK Oakland (37.720085, −122.221184, 9 ft) | 30 | 37.7014999, −122.2139969 | 9 | 310 | — | 10 520 × 150 ASP | 12: 37.719101, −122.2409973, 8 ft, 130° |
| LSZH Zürich (47.458056, 8.548056, 1 417 ft) | 14 | 47.483101, 8.53473 | 1 402 | 137 | 492 | 10 827 × 197 CON | 32: 47.4613, 8.56446, 1 402 ft, 317° |
| LSGS Sion (46.219166, 7.326944, 1 582 ft) | 25 | 46.221981, 7.339386 | 1 582 | 253 | 164 | 6 562 × 131 ASPH | 07: 46.216698, 7.314575, 1 575 ft, 73°, displ. 164 |

Showcase roles: KSFO = default/tutorial; LOWI = "the approach" (Alps, 10 m Austrian DGM in Terrain Tiles z10+, S2 imagery is superb there; note 26 has a 1 % down-slope west → east per the thresholds: 1 907 → 1 894 ft over 2 000 m); KSEA/KBFI = Rainier/Puget Sound, airliner ops; KHAF = coastal GA, fog; KTRK = high-altitude density-altitude lesson (1 797 m field elevation, Lake Tahoe 12 km south).

---

## 12. Open questions, risks, and what to verify in a browser first

1. **CORS/availability from a real browser** for `tiles.maps.eox.at`, `gibs.earthdata.nasa.gov`, `tiles.mapterhorn.com`, `tiles.openfreemap.org` (all blocked from this container). A 10-line HTML probe page should be the first thing built. AWS Terrain Tiles are confirmed.
2. EOX maximum zoom for the `_3857` layers (expected 14) and the exact 2016 layer identifier (`s2cloudless_3857`), plus whether `s2cloudless-2024_3857` exists (capabilities listed 2024 only for 4326 in one search summary).
3. EOX license choice: CC BY 4.0 (2016 imagery) vs CC BY-NC-SA 4.0 (2023/2024). NC-SA is fine for an open-source hobby project but blocks any later monetisation; ship both with a toggle and default to 2016 if the repo is MIT/Apache.
4. GIBS REST path for non-temporal layers (`/default/default/…` vs omitting the time segment) and that `BlueMarble_ShadedRelief_Bathymetry` really is `GoogleMapsCompatible_Level8`.
5. Esri World Imagery: terms require a key; only ship as BYO-key. Confirm the Location Platform free tier before documenting it for users.
6. Mapterhorn has no usage policy and is donation-funded; it is a fallback, not a primary dependency. Also GLO-30 is a *surface* model (canopy/buildings) — expect 10–30 m "fuzz" in forests/cities vs the bare-earth Terrain Tiles.
7. Terrain Tiles data vintage is 2017; no fix. The `x-amz-meta-x-imagery-sources` header lets us show provenance per tile and could drive per-source attribution dynamically.
8. Reversed-Z is unavailable on Firefox today; test the log-depth fallback path in CI (Playwright with Firefox).
9. Exact-pixel `getImageData` decoding: add the KSFO tile unit test; if a browser fails it, switch that browser to `fast-png`.
10. Geoid vs ellipsoid datum (±30–50 m) — irrelevant for rendering, relevant for GPS-vs-baro altitude display; coordinate with the avionics doc.
11. Runway flattening polygons and OSM `aeroway` polygons must agree (OSM is often more precise than OurAirports thresholds); decide the master (recommend OSM polygon for shape, OurAirports elevations for height).
12. Vector-tile buildings exist only at z13/z14; for cities we will load ~16 pbf tiles (each 50–500 KB) per 20 km ring — budget ~5 MB per city, fine with caching.

---

## Appendix A — Attribution block to ship (initial)

```
Terrain: Terrain Tiles by Mapzen/Tilezen on AWS Open Data — 3DEP, GMTED2010 and SRTM data courtesy of the U.S. Geological Survey;
ETOPO1 © U.S. NOAA; EU-DEM produced using Copernicus data and information funded by the European Union; © offene Daten Österreichs – DGM;
Contains information licensed under the Open Government Licence – Canada; © Kartverket; © Commonwealth of Australia (Geoscience Australia) 2017;
Copyright 2011 Crown copyright (c) Land Information New Zealand; © Environment Agency copyright and/or database right 2015; INEGI, Continental relief, 2016;
ArcticDEM created from DigitalGlobe imagery, NSF awards 1043681, 1559691, 1542736.
Imagery: Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023); NASA Global Imagery Browse Services (GIBS), EOSDIS.
Map data: © OpenMapTiles © OpenStreetMap contributors (ODbL). Airports: OurAirports (public domain).
```

## Appendix B — Worker decode (TypeScript, complete)

```ts
// terrain.worker.ts
self.onmessage = async (e: MessageEvent<LoadMsg>) => {
  const { key, url, z, x, y, signal } = e.data;
  const cache = await caches.open('terrain-v1');
  let res = await cache.match(url);
  if (!res) { res = await fetch(url, { mode: 'cors' }); if (res.ok) await cache.put(url, res.clone()); }
  if (!res.ok) { postMessage({ key, error: res.status }); return; }
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cvs = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cvs.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0); bmp.close();
  const { data } = ctx.getImageData(0, 0, cvs.width, cvs.height);
  const n = cvs.width * cvs.height, heights = new Float32Array(n);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const h = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    heights[i] = h; if (h < minH) minH = h; if (h > maxH) maxH = h;
  }
  const mesh = buildTileMesh(z, x, y, heights, cvs.width, e.data.frame, e.data.quads);   // positions/normals/uv/aabb, float64 → float32
  (postMessage as any)({ key, heights, minH, maxH, ...mesh }, [heights.buffer, mesh.position.buffer, mesh.normal.buffer, mesh.uv.buffer]);
};
```

## Appendix C — Unit-test fixtures (from this research)

| Fixture | Expectation |
|---|---|
| `lonLatToTile(-122.35716, 37.613538, 15)` | `x = 5246.78…, y = 12684.08…` (tile 5246/12684, pixel ≈ (199, 20)) |
| `metersPerPixel(37.6, 15)` | `3.79 ± 0.01` |
| Decode `terrarium/15/5246/12684.png` pixel (199,20) | `3.96 ± 0.05 m` |
| Decode `terrarium/15/17415/11490.png` pixel (93,189) | `581.4 ± 0.1 m` (LOWI 08) |
| Decode `terrarium/12/655/1585.png` at SF Bay (37.60, −122.30) | `≈ −3.2 m` (negative = water) |
| ENU round trip `frame.fromLocal(frame.toLocal(p)) ≈ p` | `< 1e-6 m` for p within 500 km |
| Curvature: point 100 km east of origin at h=0 | `local.y ≈ −785 ± 5 m` |
| Horizon: `Math.sqrt(2 * 6371000 * 1000)` | `112.9 km` |
