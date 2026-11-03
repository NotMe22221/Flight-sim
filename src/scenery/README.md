# OSM autogen scenery (`src/scenery`)

MSFS-style "autogen" built at runtime from OpenStreetMap vector tiles: extruded buildings
with window facades and pitched roofs, airport aprons and taxiways draped on the terrain with
yellow centre lines, blue/green taxiway lights and apron floodlights, forests and park trees,
and warm streetlights at night. The simulator loads it through `createScenery()`
(`src/app/plugins.ts`) and drives it through the `SceneryLike` contract (`src/app/Simulator.ts`).

## Data source and licence

- **Tiles**: [OpenFreeMap](https://openfreemap.org) — free, no API key, CORS enabled, the
  [OpenMapTiles](https://openmaptiles.org/schema/) 3.x schema. The TileJSON at
  `https://tiles.openfreemap.org/planet` is fetched **once per page** and its `tiles[0]`
  template (a versioned path) is used; `maxzoom` is 14, so the scenery always works on z14
  tiles (≈ 1.9 km at 38° N) and overzooms them.
- **Override**: `SceneryHostOptions.tileUrl` (the page's `?osm=` parameter) is a full
  `{z}/{x}/{y}` template and skips the TileJSON, e.g. a local fixture server.
- **Licence / attribution**: map data © OpenStreetMap contributors (ODbL), schema and tiles
  © OpenMapTiles, hosting OpenFreeMap. `attribution()` returns
  `'© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap'`; show it wherever the scenery
  is visible.
- **Layers and fields used**: `building` (`render_height`, `render_min_height`, `colour`,
  `hide_3d`), `aeroway` (`class` apron / taxiway / taxilane / runway / helipad polygons,
  taxiway / runway centre lines with optional `width`, `gate` and `parking_position` points
  with `ref`), `landcover` (`wood`, `grass` subclasses park / garden / golf_course …),
  `park`, `landuse` (residential → garden trees, cemetery), `transportation` (`class`,
  `brunnel`, `ramp`), `water` (keeps trees out of lakes).

## Architecture

```
TileSource ─ TileJSON once (or ?osm= template)
SceneryManager.update(dt, camPos, camera, sunEl)          (main thread, ≤ ~2 ms)
  ├─ select: z14 tiles within the quality radius, nearest first (every 0.5 s / 150 m)
  ├─ issue: up to maxInFlight requests ─► SceneryLoader
  │        module Worker (worker.ts) or the same job in-thread (tests / fallback)
  │        workerCore: fetch → (gunzip) → mvt.decodeTile → features.extractFeatures
  │                    → builder.buildTile → typed arrays, ArrayBuffers transferred
  ├─ arrivals: ≤ 1 TileObject per frame (meshes over the worker's arrays, placed in the frame)
  ├─ ground: time-sliced terrain sampling (first passes nearest first, then re-sampling)
  ├─ LOD: small buildings beyond ~3 km, trees within ~2.5 km (thinned), lights within ~8 km
  └─ evict: LRU beyond maxResidentTiles, full dispose (geometries, instanced meshes)
```

| Module | Role |
|---|---|
| `mvt.ts` | dependency-free Mapbox Vector Tile 2.1 decoder: varints (incl. 10-byte negative int64), zigzag, packed fields, fixed32/64, MoveTo/LineTo/ClosePath, ring classification by winding, key/value tables; malformed features are skipped and counted |
| `tileMath.ts` | tiles around a point, tile-local ENU projection (exact via ECEF), URL templates, deterministic hashes |
| `features.ts` | OpenMapTiles layers → primitives in tile-local metres, clipped to the exact tile square (no double drawing in the tile buffer), OSM colour parsing |
| `buildings.ts` | walls (outward normals, window UVs scaled to 3 m storeys / 3.2 m bays), flat roofs, hip / gable roofs for small houses (< 12 m), floors under elevated parts, walls on tile edges skipped, buildings ordered big-first for draw-range LOD, triangle cap |
| `drape.ts` | polygons triangulated (THREE.ShapeUtils, holes) and clipped to a grid with shared vertices (crack-free), mitred ribbons for taxiway centre lines, decals |
| `vegetation.ts` | jittered-grid tree scatter, hash-seeded per tile, occupancy raster (buildings, roads, pavement, water), per-tile cap, shuffled for distance thinning |
| `lights.ts` | streetlights by road class (spacing, side offset, height, brightness, sodium / warm white), taxiway edge (blue) and centre-line (green) lights, apron floodlight masts |
| `parkingLocal.ts` / `parking.ts` | gates (with `ref`) and apron stands facing the nearest taxiway; selection across tiles |
| `builder.ts` / `workerCore.ts` / `worker.ts` / `loader.ts` / `protocol.ts` | the tile job, its worker transport with in-thread fallback and the message contract |
| `grounding.ts` / `layers.ts` | placement of tile groups in the current frame, ground sampling, ground layers (buildings, draped vertices, lights, trees) |
| `tileObject.ts` | Three.js objects of one tile, LOD, disposal |
| `materials.ts` / `textures.ts` | shared materials, procedural textures made in code (facade + lit windows, cladding, roof, pavement, light sprite, floodlight pool) |
| `manager.ts` / `index.ts` | streaming, budgets, stats, parking, `createScenery` |
| `dev/` | **dev only, never imported by the app**: MVT encoder, synthetic KSFO world, fixture generator, CORS file server |

### Frames

Every tile is built in its own tile-local ENU frame (origin at the tile centre on the
ellipsoid, x = East, y = Up, z = South). On the main thread the tile group is a rigid object:
position = `frame.ecefToThree(tileCentre)`, rotation = the tile tangent axes expressed in the
current frame's axes (meridian convergence and tangent-plane tilt). `setFrame()` (new flight,
20 km rebase) only rewrites each group's matrix; geometry and ground heights stay valid.

### Ground

`host.groundUp(n, e)` is sampled per building (centroid, plus four inner box corners for
footprints longer than 18 m; the base is the lowest sample and walls reach 2 m below it),
per draped vertex, per light and per tree, and converted back to tile-local y along the
tile's own vertical (one fixed-point step from the previous value). Buildings stay collapsed
(zero-area triangles) until their ground exists; draped meshes, lights and trees appear when
their first pass is done. Sampling continues forever at a reduced share of the budget (30 %):
half of it goes to the tile under the camera, the rest round-robin over all resident tiles, and
inside a tile the layers take turns (one full pass each: buildings, pavement, markings, light
pools, lights, trees), so everything follows terrain refinements, not only buildings. GPU
uploads use one persistent update range per attribute (no per-frame allocations).

### Airport surfaces

Aprons (0.20 m), taxiway areas (0.22 m) and taxiway ribbons (0.24 m, 18 m wide or the OSM
`width`) sit above the terrain in that order so overlaps never z-fight; yellow centre lines
are 0.03 m above the ribbons. Within the runway zone (OSM runway centre line ± half width
(30 m default) + 12 m, or runway polygons + 12 m) every vertex drops to 0.03–0.05 m, i.e.
**under** the runway slab that `src/world/AirportsLayer` draws 0.12 m up, and markings /
taxiway lights stop. Draped materials carry a small relative depth bias (0.25 % of the view
distance, injected after three's `project_vertex`, so both the logarithmic and the reversed
depth buffer work) that wins over the coarser terrain mesh; it is zero next to runways.

The aircraft stands on the terrain itself (`groundUp`), so a 0.2 m apron would swallow the
lower half of its tyres. The surface materials therefore lower the non-runway tiers by up to
0.14 m near the camera (full within 40 m, none beyond 400 m, computed in the vertex shader
after `begin_vertex`): aprons, taxiway areas, ribbons and centre lines are 0.06 / 0.08 / 0.10 /
0.13 m up around the aircraft and keep their full lift further out. The manager scales the
drop with the camera's height above the ground (full below 20 m, none above 60 m), so views
from the air keep the full lift.
Taxiway light sprites stand 0.30 m (centre line) and 0.35 m (edge) above the ground, above
the draped layers, and the airport light points get the same relative depth bias as the
pavement (seen from 300 m up the bias is worth ~0.75 m of height, which would otherwise hide
every light standing on pavement).

### Lighting

Diffuse scenery materials are `MeshStandardMaterial` / `MeshLambertMaterial` lit by the sky
module's sun, hemisphere, ambient and fog. Two deliberate choices keep them consistent with
the terrain shader: image-based lighting is off (`envMapIntensity` 0, 0.03 for glass) because
the sky's PMREM is several times brighter than its sun light, and the hemisphere/ambient
irradiance is desaturated to 35 % (`patchMaterial`). Night: windows are emissive (about a
quarter lit, warm tones, deterministic per window), streetlights / airport lights are additive
point sprites (not tone-mapped so blue stays blue, a minimum pixel size so distant lights stay
visible) and apron floodlight pools are additive decals; all fade with the sun from +3° to −4°.

## Quality knobs (`config.ts`)

| | low | medium | high | ultra |
|---|---|---|---|---|
| radius (m) | 4000 | 5500 | 7000 | 8000 |
| resident tiles | 40 | 70 | 110 | 150 |
| concurrent requests | 3 | 4 | 4 | 6 |
| building triangles / tile | 40 k | 80 k | 140 k | 220 k |
| min building area (m²) | 40 | 25 | 15 | 10 |
| pitched roofs | – | ✓ | ✓ | ✓ |
| trees / tile, spacing (m) | 1200, 16 | 3000, 13 | 6000, 11 | 10 000, 9 |
| small buildings to / trees to (m) | 1800 / 1500 | 2500 / 2000 | 3000 / 2500 | 3500 / 2800 |
| lights to (m) | 4000 | 5500 | 7000 | 8000 |
| ground samples / frame, budget (ms) | 300, 1.2 | 450, 1.6 | 600, 2 | 800, 2 |

`setQuality(q)` switches profiles at runtime (new tiles use the new build settings);
`setStreamOverrides({...})` overrides individual streaming knobs.

## Runtime API

`createScenery(options: SceneryHostOptions): SceneryLike` returns a `SceneryManager`:
`update`, `setFrame`, `setQuality`, `setVisible`, `parkingSpots(lat, lon, radiusM)` (gates and
apron stands, nearest first; loads missing tiles on demand, parking data only), `attribution`,
`stats` (`tilesLoaded`, `tilesPending`, `tilesFailed`, `tilesEmpty`, `buildings`, `trees`,
`lights`, `triangles` drawn, `buildingsWaiting`, `inFlight`, `workerMode`, `updateMs`,
`groundSamples`, `groundUsPerSample`) and `dispose`. For automation it is also exposed as
`window.__scenery`, with `debugView({ lat, lon, alt, headingDeg, pitchDeg, fovDeg })` to force
the render camera to a geodetic pose for screenshots (`null` releases it).

Robustness: 204 / 404 / empty tiles are "empty" (not retried); network / CORS errors and
5xx / 429 are retried three times with backoff, then skipped; corrupt tiles are skipped; a
failed TileJSON leaves the scenery empty and is retried with a long backoff. Each kind of
failure is logged once. Nothing throws into the render loop.

## Offline fixtures (synthetic KSFO)

The container this was built in cannot reach OpenFreeMap, so everything is testable offline:

```sh
# 1. write synthetic z14 tiles around KSFO (aprons, terminal + piers + gates, hangars, parallel
#    taxiways with connectors, a city grid with houses / apartments / towers / warehouses,
#    roads of every class, a motorway, parks, residential landuse, woods on the hills, a lake)
node --experimental-transform-types --import ./src/scenery/dev/register.mjs \
     src/scenery/dev/generateFixtures.ts /tmp/osm-fixtures
# 2. serve them with CORS (also /planet as a TileJSON and 204 for /empty/...)
node src/scenery/dev/serve.mjs /tmp/osm-fixtures 8790
# 3. run the app against them
npm run dev  # then open http://localhost:5173/?osm=http://127.0.0.1:8790/{z}/{x}/{y}.pbf
```

Runway coordinates come from `public/data/airports.json`. Tests build the same world in memory
(`testUtil.ts`).

## Tests

`npx vitest run src/scenery` — decoder (varints, zigzag, packed, commands, rings, typed
properties, several layers, malformed input), tile maths (selection, ENU round trips, seams
between neighbouring tiles, placement through a rotated frame), triangulation with holes and
clipping, extrusion (outward normals, winding, UV scale, courtyards, elevated parts, hip and
gable roofs, LOD order, caps), draping (crack-free grids, mitres), synthetic tiles (runway
exclusion, markings / lights off runways and aprons, gates and stands, determinism, tree
placement, clipping), ground sampling and re-sampling (buildings collapsed until grounded,
following a terrain change), the worker protocol on the sync path (transfer lists, failure
kinds, gzip, failover, cancellation), the manager (grounding through `groundUp`, `setFrame`
re-expression to the centimetre, LRU eviction and dispose, TileJSON success / failure,
404 / network retries, parking on demand, night fade and LOD), the tile object (every ground
layer follows a terrain change, layers take turns in re-sampling) and the material patches
(depth bias, near-camera drop and point size, with the logdepthbuf chunks kept).

## Integration (app side)

`src/app/plugins.ts` already creates the plugin (`createScenery` with `parent`, `frame`,
`groundUp`, `heightAt`, `depthMode`, `quality`, `tileUrl` from `?osm=`) and `Simulator` calls
`update` after the terrain and `setFrame` on a new flight / rebase. Still to wire in the app:

- **Credits**: `SimUiHost.dataCredits()` (`src/app/uiHost.ts`) should append
  `this.sim.plugins.scenery?.attribution?.() ?? []` (ODbL / OpenMapTiles attribution).
- **Quality**: `SimUiHost.setGraphics(g)` should call
  `this.sim.plugins.scenery?.setQuality?.(g.quality)` (same `'low' | 'medium' | 'high' |
  'ultra'` names).
- Optional: a graphics toggle calling `setVisible(on)`, and a "spawn at gate" option using
  `parkingSpots(lat, lon, radiusM)` (gates first, then apron stands, each with `headingDeg`
  facing the nearest taxiway).

## Known limitations

- OpenMapTiles has no building type: houses are recognised by size and height only, and
  facade variety is one window texture (tinted per building) plus plain cladding.
- Buildings cut by a tile edge are split; on slopes the two halves may sit at different bases.
- Taxiway widths default to 18 m (OpenMapTiles carries no `width`); runway zones assume
  60 m wide runways unless OSM provides a polygon or width, so taxiways stay lowered slightly
  further from narrow runways than needed (still under or beside the slab, never above it).
- Ground heights follow `groundUp` (the finest loaded terrain); where the rendered terrain LOD
  is coarser than that (concave ground in the distance), the 0.2 m lift and the depth bias hide
  small differences only. Flattening the terrain mesh under aprons and taxiways, as the
  terrain module already does for runways (`TerrainSystem.setRunways`), would remove both
  this and the remaining tyre sinking; the scenery has the polygons (`TileFeatures.aprons`,
  `taxiwayPolys`, taxiway lines) if the lead wants to feed them to the terrain.
- Near the camera aprons are only 0.06 m above the sampled ground (see Airport surfaces), so
  rough terrain between two drape vertices (16 m grid on high) can show through right next to
  the aircraft, and wheels still sink 0.06–0.13 m into aprons / taxiways.
- No shadows from autogen; trees are instanced low-poly meshes without impostors.
- The headless visual check ran in SwiftShader at a few fps with procedural terrain and
  imagery (no network), not representative of performance on a GPU.
