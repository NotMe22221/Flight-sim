# Flight Sim

A browser flight simulator in the spirit of Microsoft Flight Simulator, built with Three.js and
TypeScript. It streams real-world terrain, flies a Cessna 172S on a six-degree-of-freedom flight
model validated against the pilot's operating handbook, and renders a physically based sky with
weather, time of day, clouds and night lighting. Everything runs client-side as a static site.

> Status: active development. The flight model, terrain, sky, weather, aircraft model, cameras,
> steam-gauge cockpit, navigation radios, airports, landing scoring and replay are integrated and
> flying. The MSFS-style menus, G1000 glass cockpit, HUD, procedural audio and ATC are being
> finished and attach automatically when present.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit and acceptance tests (Vitest)
npm run build      # typecheck + production build into dist/
node scripts/smoke.mjs --out screenshots   # headless flight + screenshots (needs Playwright)
```

Requires Node 20.19+ and a WebGL2 browser. Chrome, Edge and Safari 18+ use a reversed-Z depth
buffer; Firefox falls back to a logarithmic depth buffer.

## What you get

- **Flight model.** RK4 rigid body at 120 Hz with JSBSim-derived aerodynamics, stall hysteresis,
  flaps, ground effect, slipstream over the tail, P-factor, torque and gyroscopic effects, an
  IO-360 engine with manifold dynamics and mixture, spring-damper gear with tyre friction and
  brakes, Dryden turbulence, fuel burn and CG shift. Climb, cruise and take-off match the POH
  within a few percent (see `src/fdm/README.md`).
- **World.** AWS Terrain Tiles elevation streamed with CDLOD quadtree LOD and earth curvature,
  Sentinel-2 cloudless imagery (procedural fallback offline), runway flattening, water, a
  floating origin that rebases every 20 km, and 5,280 airports with procedurally marked runways,
  edge lights and PAPI.
- **Sky and weather.** Sun and moon from the real date and position, Preetham sky, stars, height
  fog matched to the sky, nine MSFS weather presets, METAR parsing, live weather from Open-Meteo,
  rain and snow, winds aloft and gusts.
- **Cockpit and avionics.** Steam-gauge six-pack with realistic lags, engine gauges, NAV radios
  with VOR and ILS deviation, WMM2025 magnetic variation, autopilot with HDG/NAV/APR/ALT/VS/FLC.
- **Activities.** Landing challenges scored on centreline, touchdown rate, aim point and stopping
  distance; a five-minute replay recorder.

## Default controls

Both the MSFS numpad layout and a laptop layout are active at once. Every binding can be changed
in Settings → Controls (gamepads and joysticks are detected automatically).

| Action | Laptop | MSFS / numpad |
|---|---|---|
| Pitch / roll | `↑` `↓` / `←` `→` | `Num 8` `Num 2` / `Num 4` `Num 6` |
| Rudder | `Q` / `E` | `Num 0` / `Num Enter` |
| Throttle cut / − / + / full | `F1` / `F2` / `F3` / `F4` | same |
| Flaps up / down | `F6` / `F7` | same |
| Brakes / parking brake | `.` / `Ctrl+.` | `Num Del` / `Ctrl+Num Del` |
| Elevator trim nose down / up | | `Num 7` / `Num 1` |
| Engine auto-start / shutdown | `Ctrl+E` / `Ctrl+Shift+E` | |
| Cameras: next / chase / drone | `C` / `S` / `Insert` | `End` |
| Autopilot master / HDG / ALT | `Z` / `Ctrl+H` / `Shift+T` | `Z` / `Ctrl+H` / `Ctrl+T` |
| Pause / sim rate | `Pause` / `Ctrl+Num ±` | |
| Menu | `Esc` | |

The full tables are in `src/input/README.md`.

## Architecture

```
src/core        shared contracts (types.ts), math, units, events
src/geo         WGS84/ENU frames, Web Mercator tiles, sun/moon, WMM magnetic variation
src/fdm         flight dynamics model (Cessna 172S)
src/terrain     terrain streaming, LOD, worker decode, imagery, water
src/world       floating origin, airports layer, flight-model environment
src/sky         sky, lighting, clouds, precipitation, weather, METAR, live weather
src/aircraft3d  procedural Cessna 172 model with animated surfaces and lights
src/camera      cockpit, chase, orbit, drone, tower, fly-by and wing cameras
src/instruments steam gauges, G1000 PFD/MFD, HUD (canvas textures)
src/nav         airport/navaid database, VOR/ILS/GPS geometry, flight plans
src/autopilot   GFC-700-style autopilot and flight director
src/input       keyboard, mouse yoke, gamepad, touch, rebindable profiles
src/audio       procedural engine and environment sound, warnings, speech
src/atc         scripted, menu-driven ATC
src/ui          MSFS-style menus, world map, settings, in-flight panels
src/activities  touchdown detection, landing scoring, challenges, replay
src/app         simulator main loop, integration, automation hooks
```

Design decisions and conventions are in `docs/DESIGN.md`; the research behind them is in
`docs/research/`.

## Data and credits

Terrain, imagery, airport and magnetic-model data come from open sources that require
attribution. See `docs/CREDITS.md`; the same list appears in the app under Credits.

## License

MIT for the code (`LICENSE`). Third-party data keeps its own license (`docs/CREDITS.md`).
