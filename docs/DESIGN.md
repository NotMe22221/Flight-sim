# Flight Sim — Design

A browser flight simulator in the spirit of Microsoft Flight Simulator: realistic 6-DOF
flight dynamics, streamed real-world terrain, a physically based sky with weather, steam and
glass cockpits, and MSFS-style cameras, menus and assists. Static site, no backend.

Research backing every decision lives in `docs/research/` (01 features, 02 flight model,
03 terrain, 04 sky/weather, 05 avionics, 06 audio/input, 07 architecture, 08 critique,
09 design brief). This document is the short, decisive version.

## Stack

| Choice | Decision | Why |
|---|---|---|
| Renderer | Three.js 0.187 `WebGLRenderer` (reversed depth buffer if `EXT_clip_control`, else logarithmic depth) | Broadest compatibility; WebGPU path can come later |
| Language / build | TypeScript strict, Vite 7, Vitest, Playwright smoke test | Fast iteration, testable physics |
| Deploy | GitHub Actions → GitHub Pages (`VITE_BASE=/<repo>/`) | Zero-cost hosting |
| Elevation | AWS Terrain Tiles (Terrarium PNG, z0–15) — public domain / CC-BY sources | Verified CORS `*`, no key |
| Imagery | EOX Sentinel-2 cloudless (CC BY 4.0 for the 2016 mosaic), NASA GIBS Blue Marble for low zoom, procedural fallback | No key, open license |
| Airports | OurAirports (public domain) baked to `public/data/airports.json` by `scripts/build-airports.mjs` | 17 MB CSV must not be fetched at runtime |
| Default airport | KSFO runway 28R (37.613538, −122.35716, 4 m, 298° T) | Great 10 m DEM, sea, hills, city within 30 km |

## Conventions (non-negotiable)

- **Units**: SI internally (m, kg, s, rad, N, Pa, K). Convert only in UI/instruments.
- **Physics frame**: local **NED** tangent plane at a floating origin (`LocalFrame`, float64).
  Rebase when the aircraft is > 20 km from the origin (`FlightModel.rebase`).
- **Body frame**: FRD (x forward, y right, z down). Rates p,q,r. Attitude quaternion `qNB`
  (NED→body, scalar-first). Euler = [roll, pitch, yaw].
- **Render frame** (Three.js): x = East, y = Up, z = South. `(x3,y3,z3) = (E, −D, −N)`.
  Aircraft models are authored nose **−Z**, up **+Y**, right wing **+X**.
  Object quaternion from `q_bn = conj(qNB) = (w, qN, qE, qD)` is `(x: qE, y: −qD, z: −qN, w)`.
- **Aero signs** (JSBSim): δe>0 TE down (nose down, Cmδe<0); δa>0 left aileron TE down
  (roll right, Clδa>0); δr>0 TE left (nose left, Cnδr<0).
- **Time step**: physics at fixed **120 Hz**, RK4 over the full state, accumulator with
  render interpolation (slerp attitude, lerp position). Clamp frame dt to 0.25 s.
- **Determinism**: seeded RNG for turbulence/procedural terrain; same inputs → identical state.
- **No Three.js in** `src/core`, `src/fdm`, `src/geo`, `src/nav`, `src/autopilot` (unit-testable in Node).

## Module map

```
src/core        types.ts (all cross-module contracts), math.ts, units.ts, events.ts, clock
src/geo         wgs84.ts (ECEF/ENU/LocalFrame), mercator.ts (tiles), solar.ts, magvar.ts
src/fdm         atmosphere, aero, propulsion, gear, turbulence, rigidbody, fdm.ts, trim, aircraft/c172.ts
src/terrain     providers, quadtree/LOD, worker decode, heightfield, Three.js tile meshes, imagery, water, procedural
src/sky         sky dome, sun/moon/stars, clouds, fog/aerial perspective, precipitation, weather presets
src/aircraft3d  procedural C172 mesh with animated surfaces/prop/gear, lights
src/camera      cockpit/chase/orbit/drone/tower, smoothing, free-look
src/instruments steam six-pack + engine gauges, G1000 PFD/MFD (canvas textures), HUD
src/nav         airports DB, navaids, VOR/ILS/GPS math, flight plan
src/autopilot   HDG/NAV/APR/ALT/VS/FLC/LVL, flight director
src/audio       Web Audio engine synth, wind, warnings, UI sounds, speech
src/input       keyboard/mouse-yoke/gamepad/touch, rebindable actions
src/ui          MSFS-style menus: world map, aircraft select, weather, settings, toolbar, ATC, checklist
src/world       World: owns LocalFrame, terrain, airports geometry, Environment for the FDM, rebasing
src/app         Simulator: main loop, wiring, snapshot
```

Data flow per frame: `Input → ControlInputs → (Autopilot.apply) → FlightModel.step ×N →
AircraftState → World/Camera/Sky/Instruments/Audio/UI read the SimSnapshot`.

## Main loop

```ts
const DT = 1 / 120; let acc = 0;
function frame(nowMs) {
  const real = Math.min((nowMs - last) / 1000, 0.25) * time.timeScale;
  acc += real;
  input.poll(); autopilot.update(); const u = autopilot.apply(input.controls);
  while (acc >= DT) { prev.copy(fdm.state); fdm.step(DT, u, world.env); acc -= DT; }
  const alpha = acc / DT; snapshot.interpolate(prev, fdm.state, alpha);
  world.update(snapshot); sky.update(snapshot); camera.update(snapshot); instruments.update(snapshot);
  audio.update(snapshot); ui.update(snapshot); renderer.render(scene, camera);
}
```

## Definition of done for v1

Spawn on KSFO 28R in a C172 with real terrain and imagery streaming in; start the engine
(Ctrl+E or checklist), taxi, take off, fly around the Bay with correct feel (trim, stall
buffet and break, torque/P-factor, ground effect), return and land with PAPI/ILS help; switch
cameras (cockpit/chase/drone/tower), change weather presets and time of day, use the
autopilot (HDG/ALT/VS/NAV/APR), read working steam gauges and a G1000 PFD, hear a procedural
engine and wind; the world map lets you pick any airport and runway; settings/bindings persist;
runs ≥ 60 fps on a laptop GPU.
