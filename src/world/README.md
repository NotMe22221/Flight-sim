# src/world — the world around the aircraft

`World` owns the floating-origin `LocalFrame`, the streamed terrain (`src/terrain`), the 3D
airports (`AirportsLayer`: runway slabs, markings, lights, PAPI) and the `Environment` the flight
model samples (ground height and normal, surface type, wind). It rebases everything together past
20 km (`maybeRebase`) and feeds terrain flattening: runway strips from the navigation database and
airport pavement (aprons, taxiways) from the OSM scenery.

## Integration

```ts
const world = new World(terrain, nav, weather, lat0, lon0);
world.setPavementSource(() => scenery);         // anything with pavementRevision() / pavementAreas()
scene.add(world.group);

// spawn: new origin, spawn airport, then flattening input before the terrain prefetch
world.setOrigin(lat, lon, elevationM);
world.airports.ensureAirport(airport);
world.syncRunways();
world.syncPavement(true);                       // aprons / taxiways known near the spawn
await terrain.prefetch(lat, lon, 2500);

// every physics step, before Fdm.step: a reloaded tile under a standing aircraft moves it along
const shift = world.groundShift(n, e);          // m, up positive; 0 when nothing changed
if (shift !== 0 && state.onGround) fdm.rebase([1, 0, 0, 0], [0, 0, shift]);

// every frame (runways and pavement are re-synced every 2 s)
world.update(dt, cameraPosThree, camera, aircraftGeo, aircraftPosThree, sunElevationRad);
```

## Files

| File | Role |
|---|---|
| `World.ts` | Frame, rebasing, `Environment` sources (`groundHeight` clamped to the sea surface except on runways, `surfaceAt`: paved on runways and on the flattened aprons / taxiways), runway + pavement sync to the terrain, `groundShift`. |
| `AirportsLayer.ts`, `runwayGeometry.ts`, `runwayIdents.ts` | Runway slabs (0.12 m up, curved along their length), markings, edge / threshold / approach lights, REIL, PAPI; airports built within 45 nm (max 14). `flatteningSegments()` and `builtAirports()` feed the terrain. |
| `pavement.ts` | Scenery pavement → terrain flattening specs: `PavementArea` (the scenery's published pieces), `PavementSource`, `airportPavementPlane`, `PavementRegistry`, `PavementIndex` (point-on-pavement lookup for tyre friction). |
| `environment.ts`, `rebase.ts`, `LandingGuide.ts` | Environment object with fallbacks, rebase transform, landing path hints. |

## Airport pavement (`pavement.ts`)

The scenery publishes the aprons, taxiway areas, helipads and taxiway centre lines (with width) of
every z14 tile it has, including tiles loaded only for parking, in lon/lat and clipped to their
tile (`SceneryLike.pavementAreas()`, versioned by `pavementRevision()`). `PavementRegistry.sync`,
run every 2 s from `World.update` and on every spawn:

* **Bounded to the current airports**: a piece belongs to the nearest built airport whose runways
  pass within 2.5 km of its centre; others are ignored. At most 6000 areas / 250 000 points.
* **Deduplicated**: the spec key is `ICAO:<geometry hash>`, so the same piece published by two
  tiles (a line on a tile border, a rebuilt tile) is flattened once. Pieces of one apron split
  across tiles are separate areas with the same plane; the terrain takes the distance to their
  union, so they join without a seam.
* **Sticky**: accepted areas stay while their airport is built, even after the scenery evicts the
  tile, so the terrain never un-flattens behind the aircraft. They go with their airport.
* **Target plane, one per airport, cached by ICAO**: least squares through the elevations of every
  runway threshold (both ends), anchored at the airport reference point; level across a single
  runway (minimum-norm slope); flat at the field elevation without runways; slopes clamped to 2 %.

Why this target (measured with the real KSFO DEM fixtures, z12 Terrarium, under the synthetic
apron / taxiway layout of `src/scenery/dev`; `airports.json` thresholds):

| | runway-threshold plane | plane fitted to the DEM per area | procedural fallback DEM |
|---|---|---|---|
| fit at the 8 KSFO thresholds | ≤ 0.30 m | — | — |
| terminal apron (689 points) | mean 0.00, rms 0.69 m, −4.6 … +1.6 | rms 0.66 m | rms 20.9 m, −13 … +43 m |
| parallel taxiways (315 points) | mean −0.46, rms 0.63 m | rms 0.40 m | rms 16.4 m, −20 … +47 m |

The threshold plane is as close to the real DEM under the pavement as a per-area DEM fit, joins
the runway strips by construction (a DEM fit left the GA apron 3.9 m off the runway plane, which
the taxiways would have to ramp), needs no terrain data (it is known before any tile loads, so a
spawn pushes it before the prefetch), never changes as the terrain refines and is deterministic.
On the offline procedural terrain no plane fits (±45 m); the terrain's feather (up to 160 m,
≤ 25 % bank) turns that into embankments around a flat airport.

## Ground shift (`groundShift`)

Terrain tiles reload while the aircraft sits on them: pavement arriving from the scenery, a finer
LOD, the first real tile after the spawn fallback. `groundShift(n, e)` re-samples the ground at the
previous call's point whenever `TerrainSystem.revision()` changed and returns the difference
(0 otherwise, or after a jump of more than 5 m — slew, replay, respawn). `Simulator.physicsStep`
moves an aircraft standing on the ground by that much (`Fdm.rebase` with a pure vertical
translation) before stepping, so a reload never launches it, collapses the gear or registers a
crash (gear collapse at > 0.4 m compression). The frame changes (`setOrigin`, `maybeRebase`)
reset the reference.

## Tests

`npx vitest run src/world` — `World.test.ts` (sea clamp, water, paved runways, below-sea runways,
fallback ground, rebase), `pavement.test.ts` (KSFO plane within 0.35 m of every threshold, a single
runway contained exactly and level across, flat without runways, slope clamp; registry: duplicates
across tiles collapse, areas far from every airport are ignored, one plane object per airport,
no-op on unchanged input, accepted areas survive the scenery dropping them, go with their airport,
caps; `PavementIndex` inside an apron but not its hole, within half width of a centre line),
`pavementWorld.test.ts` (in-thread terrain on the KSFO fixtures: pavement pushed before the
prefetch → the first ground under the stand is the plane < 1 cm; the near-camera pavement of every
tier is 0–1 cm above the collision ground on the apron, also between the 16 m drape vertices
(< 2 mm); `groundShift` reports a reload under a standing aircraft once and ignores teleports),
plus runway geometry, landing guide, rebase and environment tests. `src/app/groundShift.test.ts`
runs the C172 flight model on a World whose terrain jumps ±0.5 m under it: with the re-seat a
parked and a taxiing aircraft keep their gear compression (no crash, |vz| < 0.2 m/s); without it
the same reload collapses the gear or drops the aircraft.

## Known limitations

* The runway slabs are drawn 0.12 m above the flattened strip (they must win against coarse LODs
  that resolve the strip only partly), so tyres on a runway still sink 0.12 m; taxiways near a
  runway sit a few millimetres up, under the slab.
* One plane per airport: see the terrain README (Known limitations, Pavement flattening).
