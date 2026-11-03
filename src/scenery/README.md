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
their first pass is done.

**Terrain change signal** (when the host passes `terrainRevision()` / `terrainChangesSince(rev)`,
which `src/app/plugins.ts` does from `TerrainSystem.revision()` / `changesSince()`): every frame
the manager asks for the terrain tiles whose heights changed since its last look and marks exactly
the resident scenery tiles under them hot (all of them when the terrain's log no longer reaches
back); the probe grids below then stay idle. Without the signal (tests, other hosts) the probes
watch the terrain as follows.

Terrain refinements are caught in two ways. Every wanted tile has an 8 × 8 probe grid (about
240 m apart) that is re-sampled round-robin over the wanted tiles, about 2000 probes per second
(32 per frame at 60 fps, more per frame when frames are slow); when a probe's
ground moves by more than 0.1 m (or ground appears where there was none), the tile becomes
**hot**: its whole grid is taken in, every layer restarts its pass (buildings first) and the tile
owes one full re-sampling cycle, which it gets before anything else (hot tiles nearest first,
with the rest of the frame's sample budget). A refinement under a tile is followed within about
a second at the shipped budget (`stats().tilesHot` counts the tiles catching up). A re-sample
that finds an already grounded item more than 0.5 m off (a change smaller than the probe
spacing) makes its tile hot as well, and a hot tile keeps its priority until a full cycle finds
no such move. Besides that,
background re-sampling continues forever at a reduced share of the budget (30 %): half of it
goes to the tile under the camera, the rest round-robin over all resident tiles, and inside a
tile the layers take turns (one full pass each: buildings, pavement, markings, light pools,
lights, trees), so changes smaller than the probe spacing are followed too, only more slowly.
GPU uploads use one persistent update range per attribute (no per-frame allocations).

### Airport surfaces

The terrain is **flattened under airport pavement** (src/terrain/pavement.ts): every tile result
carries `pavement` — its aprons, taxiway areas and helipads (with holes) and taxiway / taxilane
centre lines with their width, in lon/lat, clipped to the tile, from full and parking-only builds
alike — and the manager publishes them (`pavementAreas()`, `pavementRevision()`) for
`src/world/pavement.ts`, which flattens those near the current airports to one plane per airport.
So the ground under the pavement is exactly planar in every terrain LOD, and the drape (16 m grid)
lies on it between its vertices too.

Aprons (0.200 m), taxiway areas (0.202 m) and taxiway ribbons (0.204 m, 18 m wide or the OSM
`width`) sit above the terrain in that order so overlaps never z-fight; yellow centre lines
are 0.002 m above the ribbons. Where a taxiway or taxilane crosses an apron it is a lead-in line
painted on the concrete: no asphalt ribbon there (triangles on the apron or its outline are
dropped) and the yellow line sits 0.002 m above the apron (from one ribbon step inside the
apron edge; nearer the edge it keeps the ribbon height so it never dips under the asphalt
triangles that still reach onto the apron there). Within the runway zone (OSM runway
centre line ± half width (30 m default) + 12 m, or runway polygons + 12 m) every vertex drops
to 6–10 mm (the flattened runway strip is planar there), i.e. **under** the runway slab that
`src/world/AirportsLayer` draws 0.12 m up (12 mm near the camera),
and markings / taxiway lights stop. Draped materials carry a small relative depth bias (0.25 % of the view
distance, injected after three's `project_vertex`, so both the logarithmic and the reversed
depth buffer work) that wins over the coarser terrain mesh; it is zero next to runways.

The aircraft stands on the terrain itself (`groundUp`), so a 0.2 m apron would swallow the
lower half of its tyres. The surface materials therefore lower the non-runway tiers by 0.196 m
near the camera (full within 40 m, none beyond 400 m, computed in the vertex shader after
`begin_vertex`): aprons, taxiway areas, ribbons and centre lines are 4 / 6 / 8 / 10 mm above the
flattened ground around the aircraft (the tyres rest on the drawn pavement within 1 cm) and keep
their full lift further out, where it guards against coarser terrain LODs at pavement edges and
against pavement of airfields that are not in the navigation database (not flattened). The
manager scales the drop with the camera's height above the ground (full below 20 m, none above
60 m), so views from the air keep the full lift.
Taxiway light sprites stand 0.30 m (centre line) and 0.35 m (edge) above the ground, above
the draped layers, and the airport light points get the same relative depth bias as the
pavement (seen from 300 m up the bias is worth ~0.75 m of height, which would otherwise hide
every light standing on pavement). Apron floodlight masts follow the real apron outline only:
segments of the clipped ring that run along the tile border (the apron continues in the
neighbouring tile) carry no masts. Pavement and markings receive the sun shadow map like the
AirportsLayer runway slabs, so the aircraft keeps its shadow on taxiways and aprons (they cast
none).

### Lighting

Diffuse scenery materials are `MeshStandardMaterial` / `MeshLambertMaterial` lit by the sky
module's sun, environment map, hemisphere, ambient and fog. Two deliberate choices keep them
consistent with the terrain shader: the image-based light is the skylight and nothing more
(`ENV_DIFFUSE` 1, `ENV_SPECULAR` 0, `ENV_SPECULAR_GLASS` 0.03 on the windowed facades, applied with
the sky's `applyIblScale` — three r187 ignores `envMapIntensity` for materials lit by
`scene.environment`, so the former `envMapIntensity` 0 / 0.03 never applied), and the
hemisphere/ambient irradiance is desaturated to 35 % (`patchMaterial`). Since the sky's light
calibration the environment's diffuse light is the calibrated skylight (the hemisphere light is
≈ 0 by day), so an IBL share of 0 would leave walls facing away from the sun black at noon; only
the sky reflections (the old reason for 0) are off. Night: windows are emissive (about a
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
apron stands, nearest first; loads missing tiles on demand, parking data only),
`pavementAreas()` / `pavementRevision()` (airport pavement of the tiles it has, in lon/lat with
stable keys `<tile>/<a|t|h|l><index>`, the last 300 tiles; the array is reused until the revision
changes), `attribution`,
`stats` (`tilesLoaded`, `tilesPending`, `tilesFailed`, `tilesEmpty`, `buildings`, `trees`,
`lights`, `triangles` drawn, `buildingsWaiting`, `tilesHot`, `inFlight`, `workerMode`, `updateMs`,
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
#    to the given directory (default: $OSM_FIXTURES, else <os tmpdir>/osm-fixtures)
node --experimental-transform-types --import ./src/scenery/dev/register.mjs \
     src/scenery/dev/generateFixtures.ts /tmp/osm-fixtures
# 2. serve them with CORS (also /planet as a TileJSON and 204 for /empty/...)
node src/scenery/dev/serve.mjs /tmp/osm-fixtures 8790
# 3. run the app against them
npm run dev  # then open http://localhost:5173/?osm=http://127.0.0.1:8790/{z}/{x}/{y}.pbf
```

For screenshots, `window.__scenery.debugView({ lat, lon, alt, headingDeg, pitchDeg, fovDeg })`
pins the camera to a geodetic pose, and `window.__scenery.setStreamOverrides({
groundSamplesPerFrame: 40000, frameBudgetMs: 400 })` makes the scenery settle quickly in a
slow software renderer; wait until `stats()` reports `tilesPending === 0` and
`buildingsWaiting === 0`. `debugView` moves the render camera only: the terrain keeps refining
around the simulator's own camera (the aircraft), so close-ups far from the aircraft show a
coarse terrain LOD that the draped pavement (sampled on the finest loaded heights) does not
match. For ground-level views, move the aircraft instead (e.g.
`__sim.sim.spawnAtParking(__sim.sim.currentAirport)` parks it at the nearest apron stand, or at a
gate when the airport has no stands).

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
following a terrain change, probe grids noticing a refinement and nothing else), the worker protocol on the sync path (transfer lists, failure
kinds, gzip, failover, cancellation), the manager (grounding through `groundUp`, `setFrame`
re-expression to the centimetre, LRU eviction and dispose, TileJSON success / failure,
404 / network retries, parking on demand, night fade and LOD, a local terrain refinement
followed within ~1 s at the shipped budget, and one smaller than the probe spacing), the tile
object (every ground layer follows a terrain change, layers take turns in re-sampling even
while one layer has no ground yet, probe baselines, pavement receives shadows), extents other
than 4096, floodlights only along real apron edges, taxiways on aprons painted as lines, and
the material patches
(depth bias, near-camera drop and point size, with the logdepthbuf chunks kept).
`pavement.test.ts`: a tile's pavement (aprons with holes, taxiway centre lines with width) in
lon/lat inside the tile, identical from parking-only builds; the manager publishes the pavement of
streamed and parking-only tiles once each with a revision, and the world registry keeps it near
KSFO without duplicates. `terrainSignal.test.ts`: with the change signal the probe grids stay idle,
a changed z15 terrain tile marks exactly the scenery tile above it, whose buildings follow within
a few frames, and a log that no longer reaches back marks every tile. `iblShare.test.ts`: the
IBL shares (diffuse 1, reflections 0 / 0.03 on glass) on every lit scenery material, chained after
the scenery patches (both run, both cache keys kept).

## Integration (app side)

`src/app/plugins.ts` already creates the plugin (`createScenery` with `parent`, `frame`,
`groundUp`, `heightAt`, `depthMode`, `quality`, `tileUrl` from `?osm=`, and the terrain change
signal `terrainRevision` / `terrainChangesSince`), `Simulator` hands `pavementAreas` to the world
(`World.setPavementSource`; synced every 2 s and before every spawn's terrain prefetch) and calls
`update` after the terrain and `setFrame` on a new flight / rebase. `SimUiHost` (`src/app/uiHost.ts`)
appends `attribution()` to the data credits (ODbL / OpenMapTiles) and forwards the graphics
quality through `setQuality` (same `'low' | 'medium' | 'high' | 'ultra'` names), and
`Simulator.spawnAtParking` parks at `parkingSpots(...)[0]`. Note that `parkingSpots` sorts by
distance only (gates win ties): to prefer a gate, pick the first spot named `Gate …`.
Optional: a graphics toggle calling `setVisible(on)`.

## Known limitations

- OpenMapTiles has no building type: houses are recognised by size and height only, and
  facade variety is one window texture (tinted per building) plus plain cladding. Terminal
  and hangar buildings (plain cladding) have no lit windows at night.
- Buildings cut by a tile edge are split; on slopes the two halves may sit at different bases.
- Taxiway widths default to 18 m (OpenMapTiles carries no `width`); runway zones assume
  60 m wide runways unless OSM provides a polygon or width, so taxiways stay lowered slightly
  further from narrow runways than needed (still under or beside the slab, never above it).
- Pavement is flattened only near airports of the navigation database (src/world/pavement.ts):
  aprons and taxiways of other airfields are draped on the natural ground, where rough terrain
  between two drape vertices can show through near the camera (4–10 mm lift there).
- Until a newly arrived tile's pavement has reached the terrain (the world syncs every 2 s, then
  the touched terrain tiles reload) its pavement is draped on unflattened ground for a moment.
- Without the terrain change signal (other hosts), refinements are noticed through probe grids
  about 240 m apart (see Ground): a change confined between probe points waits until the
  background re-sampling meets one of its moved items. The signal names whole terrain tiles, so a
  reload of a coarse tile under finer resident ones re-grounds scenery that did not move.
- No shadows cast by autogen (pavement receives the aircraft's shadow, nothing casts); trees
  are instanced low-poly meshes without impostors. Apron floodlights are sprites 22 m up
  without mast geometry.
- Parking: apron stands also keep their 16 m edge clearance from the tile border where an
  apron is clipped (fewer stands along tile borders), and a gate only steps clear of the
  buildings of its own tile.
- `debugView` moves the render camera only; the terrain LOD keeps following the simulator's
  camera (see the screenshot tips above).
- The headless visual check ran in SwiftShader at a few fps with procedural terrain and
  imagery (no network), not representative of performance on a GPU. Pavement check (parked at the
  synthetic KSFO terminal apron): before the terrain flattening, terrain slivers showed through
  the apron 150–500 m from a camera at the stand (2.5 m eye height, 22° telephoto) and the drawn
  pavement under the aircraft was 2.6–6 cm above the bumpy ground (0.166–0.201 m geometry lift
  minus the old 0.14 m drop); with it the apron is clean from the stand, from 60 m (grazing), 300 m
  and 500 m up, the pavement geometry is exactly 0.200 m above the flattened ground at every sampled
  point around the aircraft (4 mm after the near-camera drop) and the tyres rest on the concrete.
