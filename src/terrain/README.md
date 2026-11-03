# src/terrain — streamed real-world terrain

Real elevation and imagery streamed from public tile servers, drawn as a genuinely curved
WGS84 surface around a floating origin, with ground queries for the flight model that match
what is drawn. The design rationale is in `docs/research/03-terrain-and-world.md`; section
numbers (§) below refer to it.

## Integration

```ts
import { TerrainSystem } from './terrain';

const terrain = new TerrainSystem(world.frame, {
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
  depthMode: renderer.capabilities.reversedDepthBuffer ? 'reversed' : 'logarithmic',
});
scene.add(terrain.group);
terrain.setRunways(airports.flatteningSegments());       // before prefetch, so the spawn tiles load flattened
terrain.setPavement(world.pavement.specs());              // airport aprons / taxiways (src/world/pavement.ts), likewise
await terrain.prefetch(spawn.lat, spawn.lon, 1500);      // spawn tile ready (real, parent-derived or procedural)

// Environment for the FDM (src/world/environment.ts EnvironmentSources)
const sources = {
  groundHeight: (n: number, e: number) => terrain.heightAtLocalNED(n, e),
  groundNormal: (n: number, e: number, out: Vec3) => terrain.groundNormalNED(n, e, out),
};

// every frame
terrain.setSun(lighting.sunDirThree, lighting.sunColor, lighting.sunIntensity, ambientIrradiance);
terrain.setFog(lighting.fogColor, lighting.fogDensity, lighting.fogHeightFalloff, lighting.sunGlowColor);
terrain.update(camera.position, camera, dt);

// floating-origin rebase
terrain.setFrame(newFrame);
```

`ambientIrradiance` is the colour × intensity you would give three's `AmbientLight` /
`HemisphereLight` sky colour. Lighting follows three's physically based scale (radiance =
albedo/π · irradiance), so terrain matches `MeshStandardMaterial` objects under the same lights.
Every tile material also references the sky's shared uniforms (`src/sky/skyUniforms.ts`, default the
process-wide `SKY_UNIFORMS` that `SkySystem` publishes into; option `skyUniforms` to isolate): once a sky
has published (`uSkyLinked`), its `uSkyIrradiance` (exactly the built-in materials' hemisphere + ambient
floor) replaces `setSun`'s `ambient`, the ocean reflects its zenith/horizon colours, and terrain and ocean
receive its cloud shadows. Nothing to wire.

## Public API (`TerrainSystem`)

| Member | Purpose |
|---|---|
| `group: THREE.Group` | Add to the scene. One mesh per resident tile, ocean patches as child meshes. |
| `constructor(frame: LocalFrame, options?)` | Options below. Starts module workers in the browser, in-thread loading in Node / with an injected `fetch`. |
| `update(cameraPosThree, camera, dtS)` | CDLOD selection every 100 ms or after a 5 % range0 move, prioritised requests, ≤ `uploadsPerFrame` GPU uploads, coverage plan, LRU eviction. Never throws. |
| `heightAt(latDeg, lonDeg)` | Height (m) of the drawn surface of the finest loaded tile (its mesh triangles), runway-flattened; `null` if nothing covers the point. |
| `heightAtLocalNED(north, east)` | Local up (−D) of the ground under a NED point in the current frame, on the curved triangles the meshes draw (checked by raycasting the mesh: < 1 cm); `null` if not loaded. |
| `groundNormalNED(north, east, out)` | Unit normal (NED) of the drawn triangle under the point (`[0,0,−1]` on flat ground at the origin); `null` if not loaded. |
| `readyFraction(cameraPosThree?)` | 0…1 of selected tiles within 5 km beyond the nearest selected tile that have data (works at altitude). A moved camera position re-runs the selection, so it also drives loading on a loading screen. |
| `prefetch(lat, lon, radiusM = 1500)` | Requests the two finest zooms around a point (+ coverage anchors) and resolves when nothing more is outstanding for the finest tile under it: current data (a resident tile made stale by `setRunways` is reloaded first, so a respawn never starts on unflattened ground), or a failure. Works without `update()`; never rejects. Only tiles with a request in flight are pinned. |
| `whenIdle()` | Resolves when no request is outstanding (tests, loading screens). |
| `setFrame(frame)` | Rebase: every tile object is re-placed from its float64 ECEF centre plus the rotation between its build frame and the new frame. No vertex is rebuilt. |
| `setRunways(segments)` | `{ a, b: Geodetic (alt = threshold elevation), widthM }[]` — tiles touching added/removed runways reload; old data stays drawn meanwhile. Unchanged input is a no-op. The first reload after such a change ignores a retry backoff (data from before it is wrong, not merely coarse; offline stand-ins wait 10 s … 120 s between retries). |
| `setPavement(specs)` | Airport pavement flattening (`PavementFlatteningSpec[]`, see below): aprons / taxiway areas (polygons with holes) and taxiway centre lines buffered to their width, each with its target plane. Diffed by `key` (a key names immutable content): tiles touching added/removed areas reload (the first reload ignores a retry backoff, as for `setRunways`), old data stays drawn meanwhile, a pending `prefetch` waits for the new version. `pavementCount` = areas in use. |
| `revision()` / `changesSince(rev)` | Change signal of the collision heights: `revision()` is bumped whenever a tile's heights arrive, are replaced by a reload with different heights, or are evicted (a reload over identical heights — imagery switch, offline stand-in retry — is no change); `changesSince(rev)` lists the tiles `{ z, x, y }` changed after `rev` (oldest first, last 512 changes), or null when `rev` is older than that (treat everything as changed). The scenery re-grounds exactly the tiles under changed terrain with it; `World.groundShift` uses `revision()` to move a standing aircraft with a reloaded tile. |
| `setImagery('satellite' \| 'procedural')` | Switch the imagery chain; resident tiles reload in the background. |
| `setSun(dir, color, intensity, ambient)` / `setFog(color, density, heightFalloff, sunGlow?)` | Shared uniforms of every terrain/ocean material. |
| `attribution()` | Credit lines for the providers whose data is on screen. |
| `stats()` | `{ resident, drawn, inflight, failed }`. |
| `dispose()` | Terminates workers, disposes every geometry, material and texture, removes `group` from its parent. |
| debug: `loaderMode`, `uniforms`, `selectedNodes`, `drawItems`, `holes` | Introspection for tests and overlays. |

The barrel (`index.ts`) also exports the pure building blocks: `HeightField`, `GroundQueries`,
`Quadtree`, `DrawPlanner`, providers, `ProceduralTerrain`, Terrarium codec, runway flattening.

## How it works

```
update() ─► Quadtree.select (CDLOD, all-around, horizon-culled)          quadtree.ts
         ─► want: node tile (or its parent for a patch) + anchor 3 levels up
         ─► TileLoader ─► TerrainWorkerPool (priority queue, 4/worker, 2 s cancel grace)
                              │  module worker: terrain.worker.ts → tileJob.ts
                              │  (Node / injected fetch / worker failure: InThreadWorker → tileJob.ts)
                              ▼
               tileJob: elevation  AWS z/x/y → AWS ancestors z−1…z−3 (sub-square upsampled) → procedural
                        imagery    EOX S2 2016 → GIBS (z ≤ 8) → procedural colours   (fetched concurrently)
                        pavement + runway flattening → curved mesh + skirts + ocean patch (tilePipeline.ts)
                              ▼ transferables
         ◄─ onTile: mesh vertex lattice → HeightField immediately (collision, prefetch); mesh → upload queue
         ─► upload ≤ N/frame: BufferGeometry from the transferred buffers, shared Morton index,
            per-tile ShaderMaterial, refcounted imagery texture, placeTile() from float64 ECEF
         ─► DrawPlanner: every selected node → own tile | 4 ready children | nearest ready ancestor
            sub-square → geometry groups (index ranges) on the tile meshes; others hidden
         ─► LRU eviction above maxResidentTiles (never drawn/wanted/pinned/loading tiles)
```

* **Curvature for free** (§4.3): every vertex is tile fraction → lon/lat → bilinear DEM height →
  ECEF → local frame in float64, stored float32 relative to the tile centre. The object matrix
  carries the large translation; three composes `modelViewMatrix` in doubles. Within the last half
  pixel of a tile the edge cell is extrapolated, so a tile's edge vertices take the surface value at
  the edge (not the edge pixel's centre value half a pixel inside): neighbours agree on their shared
  edge to first order instead of stepping by one pixel of slope (2 m on a 30° slope at z15, 17 m at z12).
* **Pavement flattening** (`pavement.ts`): aprons, taxiway areas, helipads (polygons, holes kept
  open) and taxiway / taxilane centre lines buffered to their width are flattened in the worker on
  the DEM grid, *before* the runway strips (a runway wins where a taxiway reaches onto it, and its
  150 m feather blends into the flattened pavement, so taxiways join the strips without a step).
  Inside the flat zone (outline + 15 m shoulder: a z15 triangle touching the pavement and its
  vertices' bilinear footprint lie entirely inside it) the height is the area's target plane in
  geodetic height, `h0 + dhdE·east + dhdN·north` around an anchor: an analytic function of
  (lon, lat), so neighbouring tiles, every LOD, the mesh and the HeightField agree exactly and the
  surface never changes as tiles refine. Outside, the override feathers back into the DEM over
  80 m for small differences, widening with the height difference up to 160 m so the bank stays
  ≤ 25 % (`1.5·|Δ| / width`): a deep cut or fill on rough ground becomes an embankment, not a
  cliff (the procedural fallback around KSFO differs from the airport by up to ±45 m).
  Implementation: per area, a scanline even-odd fill marks the interior; every edge and centre
  line is split into ≤ 64 m pieces, bucketed into 8×8-pixel blocks within its reach, and each
  pixel takes the nearest piece (candidates sorted per block by a bounding-box lower bound, the
  search stops at the first that cannot win); per pixel the nearest area wins, so pieces of one
  apron clipped to neighbouring scenery tiles join without a seam (distance to a union = minimum
  distance). A dense synthetic airport tile (350 areas, 4000 edge pieces in 2 km²) takes
  0.4–0.7 s on this heavily loaded build machine, the synthetic KSFO tiles a few ms.
  Tiles coarser than z11 skip it (pavement is sub-pixel there). The planes come from
  `src/world/pavement.ts` (one per airport, through its runway thresholds).
* **Collision = drawn surface** (§8.1): the HeightField stores each tile's mesh vertex lattice
  (`mesh.height`, (N+1)²) and interpolates it on the mesh's own triangles (NE–SW diagonals, as in
  `gridIndex.ts`); the normal is the face normal. A bilinear sample of the 256² DEM differs from the
  drawn triangles by up to 0.8 m at N = 128 (z15) and ~10 m at N = 64 on hilly z12 tiles; z < 11 tiles
  used to answer from a 4× box-downsampled grid. The lattice is also 4–16× smaller than the DEM grid.
* **Rebasing** (§4.4): tiles keep their build frame; `placeTile` sets position = frame.ecefToThree(centre)
  and the build→current axis rotation (0.18° at 20 km — it matters for 250 km tiles).
* **Never holes** (§3.2): CDLOD parent patches and stand-ins are sub-squares of a tile. The index
  buffer is in Morton order, so any aligned sub-square is one contiguous range plus the skirt
  segments on its border; ranges are merged per tile and written as `geometry.groups` (materials are
  a one-element array). Coverage anchors (ancestor `anchorLevels` up, down to `minZoom − anchorLevels`)
  give every node a coarse stand-in while finer tiles load.
* **Skirts** (§3.3): the four tile edges plus both midlines, each midline in both facings, so a
  parent patch (a quadrant of the parent mesh) has outward-facing skirts on all four sides and no
  crack opens where the coarse patch lies above the finer neighbour's edge (0.3–1.7 m on the fixtures).
* **Fallbacks**: HTTP 4xx is definitive (try the next source). Network errors, 15 s timeouts and 5xx
  are transient: the job skips that provider's remaining ancestors (same host) and flags the response.
  Synthetic (procedural) heights never replace real data: when the tile already has real data or a real
  ancestor is resident, the request says `proceduralOnTransient: false` and the job answers a transient
  error, so the real data (the tile's own, or the ancestor drawn in its place) stays on screen and under
  the wheels while the tile retries with backoff (2 s … 60 s). Only where no real data exists at all
  (offline cold start) do procedural stand-ins appear; they are retried without limit (10 s … 120 s)
  and dropped the moment real data covers them. A stand-in may be replaced by a new stand-in: a
  runway or pavement change reloads it at once (ignoring the backoff) with the new flattening. A cached response that fails to decode is evicted from
  the Cache API. A module worker that fails to start switches the loader to in-thread; a worker reply
  that cannot be posted becomes an `error`, so no request waits forever.
* **Materials** (`materials.ts`): ShaderMaterial, sRGB imagery, sun + the sky's ambient irradiance with
  low slope contrast (`uSlopeContrast` 0.4, imagery has baked shading), local vertical from the earth
  centre, cloud shadows along the sun ray (`skyCloudShadow`, same noise field as the cloud planes), the
  sky module's exponential height fog (`β(y) = β0·exp(−(y − groundY)·falloff)`, closed-form optical
  depth; `groundY` is the sky's `uSkyGroundY` once a sky is linked — the reference of the built-in
  materials' and cloud planes' fog — else the ground under the camera) toward its haze colour with the
  Henyey–Greenstein sun-ward lobe (`hazeSunLobe`), tone mapping and colour-space chunks. Real imagery is sampled unmodified (only lit, shadowed and fogged); procedural
  fallback tiles (`uProcedural`) add a ground-fixed detail texture (value noise at 4 / 32 / 128 / 512 m,
  brightness ± and lush/dry tint, fine octaves faded with distance; `uDetailOffset` follows rebases mod
  8192 m so it never jumps). Includes `<logdepthbuf_*>` chunks, so it is correct with a logarithmic depth
  buffer; with a reversed depth buffer three supplies projection and depth function. Ocean: same grid at
  h = 0 on the ellipsoid for tiles with sea cells; dark blue-green body (greener over < 4 m of water),
  four animated wave trains faded by the pixel footprint (distance / grazing incidence, no moiré),
  Schlick Fresnel capped at 0.6 (rough water) reflecting the sky from the horizon (no brighter than the
  haze over it) to the zenith colour, normalized Blinn-Phong sun glint whose lobe widens with distance
  (glitter path), cloud shadows on sun terms. The wave clock `uTime` wraps at `WAVE_TIME_PERIOD_S`
  (1000π s, a whole number of periods of every wave train; the former 3600 s wrap jumped the ripples
  by a quarter period once an hour).
* **Procedural fallback colours** (`procedural.ts`, offline only): land cover from the tile's heights and
  ground-fixed noise — dark blue-green water by depth, wet sand and beaches in the 0–1.8 m band, lowland
  field patchwork (warped ≈ 260 × 190 m parcels, crop/pasture/fallow tones, faded to the average where a
  pixel is coarser than a field), grass drifting lush ↔ dry by region, forest by humidity (conifers above
  ≈ 1 km), scrub on dry slopes, alpine meadow, rock by slope and altitude, snow above a noisy ≈ 2 550 m line.

## Files

| File | Role |
|---|---|
| `TerrainSystem.ts` | Facade: selection, requests, uploads, draw plan, eviction, queries, configuration. |
| `tileLoader.ts`, `workerPool.ts`, `inThreadWorker.ts`, `terrain.worker.ts` | Transport: Vite module workers or in-thread, priorities, cancellation, failover. |
| `tileJob.ts`, `tileFetch.ts`, `tilePipeline.ts`, `requests.ts`, `protocol.ts` | The per-tile load job and its inputs/outputs. |
| `tileGpu.ts`, `textureCache.ts`, `materials.ts`, `tileRecord.ts` | Three.js objects, shared uniforms, per-tile bookkeeping. |
| `drawPlan.ts`, `gridIndex.ts`, `quadtree.ts` | CDLOD selection, coverage planning, Morton index ranges. |
| `heightfield.ts`, `groundQueries.ts`, `sampling.ts` | Collision heights (mesh lattice on its triangles), NED ground queries, bilinear/triangle sampling, parent sub-grid extraction. |
| `tileMesh.ts`, `terrarium.ts`, `procedural.ts`, `noise.ts`, `runways.ts`, `pavement.ts`, `imagery.ts`, `providers.ts` | Pure geometry, decoding, synthetic terrain, runway and pavement flattening, provider catalogue. |

## Tests (`npx vitest run src/terrain`, Node)

* `TerrainSystem.test.ts` — in-thread loading with an injected fetch serving the fixture PNGs (404
  otherwise): tiles become resident; `heightAt` at the KSFO 28R threshold ≈ 3.96 m; ocean patch on
  the bay tile; `heightAtLocalNED(0,0) ≈ 3.96 − alt0`; `readyFraction` 0 → 1; no holes, including right
  after a 2.5 km move before new tiles load (ancestor stand-ins); `setFrame` moves tile objects rigidly
  (centre and a vertex land on the same ECEF point, < 1 cm) and leaves heights unchanged; runway
  flattening reloads tiles; `prefetch` without `update()`; rejecting fetch → procedural, no throw;
  outage then recovery → degraded tiles reload with real data; LRU eviction disposes evicted GPU
  objects; `dispose` frees every geometry, material and texture; shared uniforms. Review additions:
  `heightAtLocalNED`/`groundNormalNED` against a three `Raycaster` on the drawn mesh (< 1 cm, < 1e-3);
  an outage over a real z12 ancestor keeps the real ground (no synthetic patch) and recovers; `prefetch`
  after `setRunways` on resident tiles (and with runways changing mid-load) resolves on flattened
  ground; `prefetch` over resident tiles pins nothing (they are still evicted).
* `pavement.test.ts` — pavement flattening on a bumpy synthetic DEM: an apron (with a 200 m hole) is
  the plane inside and within the 15 m shoulder (Euclidean), the hole centre and everything beyond
  the reach keep the DEM bit for bit; the feather has no step and stays below the bank limit; a
  taxiway centre line is flat within half width + shoulder; two adjacent tiles' mesh lattices agree
  on their shared edge inside an area (< 1 mm) and equal the plane; a runway strip wins over
  pavement in the pipeline; coarse and far tiles are skipped; an apron split in two pieces gives the
  same heights as the whole. `pavementSystem.test.ts` — `setPavement` reloads the touched tiles and
  `heightAt` on the apron is the plane (< 1 cm), unchanged input is a no-op, removing it restores the
  DEM, `prefetch` after `setPavement` (resident or cold) resolves on flattened ground, also offline
  (procedural stand-ins inside their retry backoff reload at once, re-flattened), `revision` /
  `changesSince` report the reloaded tiles (null once the log is too short) but not a reload over
  identical heights (imagery switch).
* `tileMesh.test.ts` — also: neighbouring tiles agree on a sloped shared edge (< 1 mm); every
  sub-square down to depth 2 has outward-facing skirts, and a quadrant gets all four sides.
* `sampling.test.ts` — `triangleSample` equals barycentric interpolation on the `gridIndex`
  triangles; its gradient is the face slope. `heightfield.test.ts` — mesh-lattice layout.
* `quadtree.test.ts` — also: root tiles visited once (`coarsestZoom: 0`, 89.9° N) and bounded loops.
* `tileJob.test.ts` — request building (fallback chain, sub-square offsets, per-level quads, runway
  filtering), job outputs: bit-exact decode, parent fallback agrees with the z12 ancestor, procedural
  fallback, abort, timeout of a hanging server, 404 vs transient classification,
  `proceduralOnTransient: false` → transient error, a poisoned Cache API entry is evicted and refetched.
* `lookReview.test.ts` (review regressions) — the ocean clock wraps seamlessly (`TerrainSystem.update`
  across the wrap, wave frequencies in the shader = the ones the period was chosen for), terrain and
  ocean fog take the sky's ground reference once linked.
* `drawPlan.test.ts`, `groundQueries.test.ts`, `materials.test.ts` (shader includes resolve against
  three's `ShaderChunk`, log-depth chunks present, declared uniforms exist incl. arrays, sky uniforms shared
  by reference, detail only behind the procedural flag), `procedural.test.ts` (land-cover classes: beach,
  vegetation, rock, snow, dark water; variation; determinism), `TerrainSystem.test.ts` (detail offset
  follows a rebase), `sampling.test.ts`, plus
  the earlier pure-module tests (quadtree, tileMesh, gridIndex, heightfield, terrarium, procedural,
  providers, imagery, tilePipeline).
* Pavement flattening checked in the real app at the synthetic KSFO fixtures (procedural terrain
  offline): 54 areas flattened after a parking spawn, the ground under the stand is the KSFO plane
  (2.52–2.55 m over 25 m instead of 1.73–3.16 m of procedural bumps) and no terrain shows through
  the apron from the stand, from 60 m, 300 m or 500 m up (see the scenery README).
* Manually verified in headless Chrome (SwiftShader) with a throwaway Vite build: the module worker
  bundles and runs, spawn tile in ≈ 0.2 s with h = 3.96 m, 74 tiles resident, readyFraction 1, no holes,
  and the materials compile and render identically with logarithmic and reversed depth buffers.

## Tuning knobs

| Knob | Default | Effect |
|---|---|---|
| `range0M` | 3500 | CDLOD level-0 range; ranges double per level. 1800 for low-end. |
| `maxZoom` / `minZoom` | 15 / 7 | Finest / coarsest selected zoom (z7 reaches ≈ 900 km). |
| `quadsPerLevel` | `[128, 64, 64, 64, 64, 32, …]` | Mesh resolution per level (powers of two). |
| `maxResidentTiles` | 500 | LRU budget (tiles with data). |
| `uploadsPerFrame` | 4 | GPU object creations per `update()` (hitch control). |
| `selectIntervalMs` | 100 | Selection period (also re-runs after a 5 % range0 move). |
| `anchorLevels` | 3 | Coverage ancestors kept per selected tile (0 disables). |
| `parentFallbackLevels` | 3 | Ancestor tiles tried when a provider tile is missing. |
| `proceduralTileSize` | 128 | Grid of synthetic heights/colours. |
| `horizonCull` | true | Skip tiles hidden below the horizon. |
| `workers` | hc − 2 (2…4) | Module workers. |
| `imagery` | `'satellite'` | Or `'procedural'`. |
| `uniforms.uSlopeContrast` | 0.4 | 0 = flat lighting, 1 = full N·L. |
| `TILE_FETCH_TIMEOUT_MS` (tileFetch.ts) | 15 000 | Per request (headers + body). |
| `DEFAULT_QUADTREE_OPTIONS.hysteresis` | 0.15 | Merge at 1.15 × range. |

## Known limitations

* **Patch seams** are closed for CDLOD parent patches (midline skirts). Ancestor stand-ins two or
  more levels down (only while finer tiles stream in) still lack skirts on borders at N/4, 3N/4, …;
  a sub-pixel crack can show there for a moment.
* **No geomorphing** (§3.3 v2): LOD transitions pop at ring boundaries.
* **Collision follows the finest *resident* tile**, which is the drawn one wherever the camera is
  near the aircraft. With the camera far away (tower/flyby view ≳ 3.5 km) the aircraft's tile may be
  drawn from a coarser level while collision still uses the finer resident lattice, so the aircraft can
  look a metre or so off the ground from that distance. A new tile's heights apply when it arrives;
  its mesh appears with the next upload (≤ a few frames later).
* **Tile-edge continuity** is first-order: on curved ground, same-level neighbours can still differ by
  the second-order residual (≈ half the bay pair's former 0.9 m maximum); skirts hide it visually.
* **Water**: the sea is detected from heights (DEM ≤ 0.5 m, §6.5) and the ocean patch covers the
  whole tile at h = 0, so land *below* sea level is drowned: Amsterdam Schiphol (EHAM, −3 m) and the
  Dutch polders, the Dead Sea, the Caspian shore, Death Valley. A water mask (OSM water polygons, §6.5)
  is needed to fix it; `World.groundHeight` clamps the ground to sea level the same way. Lakes and
  rivers get no water patch. Wave pattern is in render-frame x/z, so it shifts at a rebase.
* **High latitudes**: the Web-Mercator pyramid ends at ±85.05°; selection and prefetch clamp there
  (no hang at the poles) and draw nothing beyond. Near the limit tiles shrink with cos(lat), so a
  fixed radius needs many more tiles.
* **Fog** treats render-frame y as height (as the sky module does), which over-thickens haze for very
  distant terrain below the tangent plane; at those distances the terrain is fully hazed anyway. Its
  ground reference is the ground under the aircraft (the sky's), so with a far tower or drone camera over
  other ground the haze near the camera is referenced to the aircraft's ground, as for every renderer.
* **No terrain self-shadows** (only cloud shadows), no night lights (city glow). The detail texture
  (§6.3) is only on procedural fallback tiles; real imagery gets none (it is shown unmodified), so it
  softens below ≈ 10 m/px at low altitude. Cloud shadows skip the cloud planes' edge erosion (slightly
  softer edges than the clouds above) and are limited to `MAX_SHADOW_LAYERS` (4) layers; a layer counts
  only where its middle is above the ground point (peaks on top of a deck are in full sun), with a hard
  switch at the layer middle.
* **Pavement flattening**: one plane per airport (through its runway thresholds) suits airfields
  whose aprons lie within a few metres of the runway plane (the real KSFO DEM: ±0.7 m rms); an apron
  terraced well above or below its runways is cut or filled to the plane with an embankment. Areas
  of different airports overlapping within their feathers take the nearest area's plane (a slope
  break where two airports' pavement nearly touch). The work is O(edges × reach²) per tile (a few
  ms for the synthetic KSFO, up to a few hundred ms for an unusually dense tile, in the worker).
* **Runway pavement vs. flattened terrain**: the flattened strip follows the curved earth at the
  interpolated threshold elevations, while `src/world` draws each runway as one flat quad between its
  corners lifted 0.12 m. On long runways the chord sags below the curve (s²/8R ≈ 0.26 m mid-runway for
  KSFO 28R/10L, 3.6 km), and coarse LODs resolve the 60 m strip only partly (measured at KSFO from the
  threshold: pavement −0.33 … +0.19 m against the terrain along the centreline), so distant
  mid-runway pavement can lose the depth test against the terrain. A pavement tessellated along its
  length (vertices from `frame.geodeticToThree`, so it curves like the terrain) removes the sag.
* **Datum**: Terrarium heights are orthometric (≈ MSL) and treated as ellipsoidal (§8.1).
* **Providers**: EOX and GIBS endpoints are unverified from the build container ([verify] in §0).
  Mapterhorn (WebP) is catalogued but not in the default chain (WebP decode needs `createImageBitmap`).
  Imagery that fails transiently falls back to procedural colours and is retried 4 times.
* **In-thread fallback** runs decode and meshing on the main thread (hitches); it exists for Node
  tests and broken worker environments.
* Uploads are throttled by count, not bytes; the selection uses a fixed range0 rather than adapting
  to FOV/viewport. Geometry keeps its CPU-side arrays after upload (≈ 0.15–0.55 MB per tile).
