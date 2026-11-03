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

## Public API (`TerrainSystem`)

| Member | Purpose |
|---|---|
| `group: THREE.Group` | Add to the scene. One mesh per resident tile, ocean patches as child meshes. |
| `constructor(frame: LocalFrame, options?)` | Options below. Starts module workers in the browser, in-thread loading in Node / with an injected `fetch`. |
| `update(cameraPosThree, camera, dtS)` | CDLOD selection every 100 ms or after a 5 % range0 move, prioritised requests, ≤ `uploadsPerFrame` GPU uploads, coverage plan, LRU eviction. Never throws. |
| `heightAt(latDeg, lonDeg)` | DEM height (m) from the finest loaded tile, runway-flattened; `null` if nothing covers the point. |
| `heightAtLocalNED(north, east)` | Local up (−D) of the ground under a NED point in the current frame, on the curved surface the meshes draw; `null` if not loaded. |
| `groundNormalNED(north, east, out)` | Unit ground normal in NED (`[0,0,−1]` on flat ground at the origin); `null` if not loaded. |
| `readyFraction(cameraPosThree?)` | 0…1 of selected tiles within 5 km beyond the nearest selected tile that have data (works at altitude). A moved camera position re-runs the selection, so it also drives loading on a loading screen. |
| `prefetch(lat, lon, radiusM = 1500)` | Requests the two finest zooms around a point (+ coverage anchors) and resolves when the finest tile under it has data or failed. Works without `update()`; never rejects. |
| `whenIdle()` | Resolves when no request is outstanding (tests, loading screens). |
| `setFrame(frame)` | Rebase: every tile object is re-placed from its float64 ECEF centre plus the rotation between its build frame and the new frame. No vertex is rebuilt. |
| `setRunways(segments)` | `{ a, b: Geodetic (alt = threshold elevation), widthM }[]` — tiles touching added/removed runways reload; old data stays drawn meanwhile. Unchanged input is a no-op. |
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
                        runway flattening → curved mesh + skirts + ocean patch (tilePipeline.ts)
                              ▼ transferables
         ◄─ onTile: heights → HeightField immediately (collision, prefetch); mesh → upload queue
         ─► upload ≤ N/frame: BufferGeometry from the transferred buffers, shared Morton index,
            per-tile ShaderMaterial, refcounted imagery texture, placeTile() from float64 ECEF
         ─► DrawPlanner: every selected node → own tile | 4 ready children | nearest ready ancestor
            sub-square → geometry groups (index ranges) on the tile meshes; others hidden
         ─► LRU eviction above maxResidentTiles (never drawn/wanted/pinned/loading tiles)
```

* **Curvature for free** (§4.3): every vertex is tile fraction → lon/lat → bilinear DEM height →
  ECEF → local frame in float64, stored float32 relative to the tile centre. The object matrix
  carries the large translation; three composes `modelViewMatrix` in doubles.
* **Rebasing** (§4.4): tiles keep their build frame; `placeTile` sets position = frame.ecefToThree(centre)
  and the build→current axis rotation (0.18° at 20 km — it matters for 250 km tiles).
* **Never holes** (§3.2): CDLOD parent patches and stand-ins are sub-squares of a tile. The index
  buffer is in Morton order, so any aligned sub-square is one contiguous range plus its edge-skirt
  segments; ranges are merged per tile and written as `geometry.groups` (materials are a
  one-element array). Coverage anchors (ancestor `anchorLevels` up, down to `minZoom − anchorLevels`)
  give every node a coarse stand-in while finer tiles load.
* **Fallbacks**: HTTP 4xx is definitive (try the next source). Network errors, 15 s timeouts and 5xx
  are transient: the job skips that provider's remaining ancestors (same host), falls back, and flags
  the response; the tile is reloaded with backoff (10 s, 20 s, 40 s, 80 s) so a blip does not leave a
  permanent procedural patch. A module worker that fails to start switches the loader to in-thread.
* **Materials** (`materials.ts`): ShaderMaterial, sRGB imagery, sun + hemisphere-ish ambient with low
  slope contrast (`uSlopeContrast` 0.4, imagery has baked shading), local vertical from the earth
  centre, the sky module's exponential height fog (`β(y) = β0·exp(−(y − groundY)·falloff)`, closed-form
  optical depth, sun-glow lobe), tone mapping and colour-space chunks. Includes `<logdepthbuf_*>`
  chunks, so it is correct with a logarithmic depth buffer; with a reversed depth buffer three
  supplies projection and depth function. Ocean: same grid at h = 0 on the ellipsoid for tiles with
  sea cells, depth-tinted, four animated wave trains (faded with distance), Fresnel sky reflection,
  normalized Blinn-Phong sun glint.

## Files

| File | Role |
|---|---|
| `TerrainSystem.ts` | Facade: selection, requests, uploads, draw plan, eviction, queries, configuration. |
| `tileLoader.ts`, `workerPool.ts`, `inThreadWorker.ts`, `terrain.worker.ts` | Transport: Vite module workers or in-thread, priorities, cancellation, failover. |
| `tileJob.ts`, `tileFetch.ts`, `tilePipeline.ts`, `requests.ts`, `protocol.ts` | The per-tile load job and its inputs/outputs. |
| `tileGpu.ts`, `textureCache.ts`, `materials.ts`, `tileRecord.ts` | Three.js objects, shared uniforms, per-tile bookkeeping. |
| `drawPlan.ts`, `gridIndex.ts`, `quadtree.ts` | CDLOD selection, coverage planning, Morton index ranges. |
| `heightfield.ts`, `groundQueries.ts`, `sampling.ts` | Collision heights, NED ground queries, bilinear sampling, parent sub-grid extraction. |
| `tileMesh.ts`, `terrarium.ts`, `procedural.ts`, `noise.ts`, `runways.ts`, `imagery.ts`, `providers.ts` | Pure geometry, decoding, synthetic terrain, flattening, provider catalogue. |

## Tests (`npx vitest run src/terrain`, Node)

* `TerrainSystem.test.ts` — in-thread loading with an injected fetch serving the fixture PNGs (404
  otherwise): tiles become resident; `heightAt` at the KSFO 28R threshold ≈ 3.96 m; ocean patch on
  the bay tile; `heightAtLocalNED(0,0) ≈ 3.96 − alt0`; `readyFraction` 0 → 1; no holes, including right
  after a 2.5 km move before new tiles load (ancestor stand-ins); `setFrame` moves tile objects rigidly
  (centre and a vertex land on the same ECEF point, < 1 cm) and leaves heights unchanged; runway
  flattening reloads tiles; `prefetch` without `update()`; rejecting fetch → procedural, no throw;
  outage then recovery → degraded tiles reload with real data; LRU eviction disposes evicted GPU
  objects; `dispose` frees every geometry, material and texture; shared uniforms.
* `tileJob.test.ts` — request building (fallback chain, sub-square offsets, per-level quads, runway
  filtering), job outputs: bit-exact decode, parent fallback agrees with the z12 ancestor, procedural
  fallback, abort, timeout of a hanging server, 404 vs transient classification.
* `drawPlan.test.ts`, `groundQueries.test.ts`, `materials.test.ts` (shader includes resolve against
  three's `ShaderChunk`, log-depth chunks present, declared uniforms exist), `sampling.test.ts`, plus
  the earlier pure-module tests (quadtree, tileMesh, gridIndex, heightfield, terrarium, procedural,
  providers, imagery, tilePipeline).
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

* **Patch seams**: a sub-square drawn from a parent/ancestor has skirts only on the tile's outer
  edges, not on its interior borders, so where a coarse patch is higher than the adjacent finer tile a
  sub-pixel crack can show at CDLOD ring boundaries. Fix: interior skirt lines at multiples of N/8.
* **No geomorphing** (§3.3 v2): LOD transitions pop at ring boundaries.
* **Mesh vs collision**: the mesh samples the DEM every 2–4 px (N = 128 at z15 → 7.6 m spacing); the
  collision samples the full grid, so wheels can sit a few cm off the visual surface on rough ground
  (runways are flattened, so not there).
* **Water**: only the sea (DEM ≤ 0.5 m) gets an ocean patch; lakes and rivers need OSM water polygons
  (§6.5). Wave pattern is in render-frame x/z, so it shifts at a rebase.
* **Fog** treats render-frame y as height (as the sky module does), which over-thickens haze for very
  distant terrain below the tangent plane; at those distances the terrain is fully hazed anyway.
* **No terrain shadows**, no detail textures (§6.3), no night lights.
* **Datum**: Terrarium heights are orthometric (≈ MSL) and treated as ellipsoidal (§8.1).
* **Providers**: EOX and GIBS endpoints are unverified from the build container ([verify] in §0).
  Mapterhorn (WebP) is catalogued but not in the default chain (WebP decode needs `createImageBitmap`).
* **In-thread fallback** runs decode and meshing on the main thread (hitches); it exists for Node
  tests and broken worker environments.
* Uploads are throttled by count, not bytes; the selection uses a fixed range0 rather than adapting
  to FOV/viewport.
