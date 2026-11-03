# Flight Sim

A browser flight simulator in the spirit of Microsoft Flight Simulator, built with Three.js and
TypeScript. It streams real-world terrain, flies a Cessna 172S (steam gauges or G1000) and a Piper
PA-18-150 Super Cub tail-dragger on a six-degree-of-freedom flight model validated against their
handbooks, and renders a physically based sky with weather, time of day, clouds and night lighting.
Everything runs client-side as a static site.

> Status: active development. Everything below is integrated and flying in the browser; the
> remaining work is polish (lighting calibration, more aircraft, more content).

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

- **Aircraft.** Pick one in the Aircraft screen (its fuel, payload and specs), switching rebuilds
  the flight model, 3D model, panel, assists tuning and engine sound:

  | Aircraft | Gear | Panel | Autopilot |
  |---|---|---|---|
  | Cessna 172S Skyhawk | tricycle | steam six-pack, two NAV/COMs, transponder | KAP 140-style (GFC 700 modes) |
  | Cessna 172S Skyhawk G1000 | tricycle | G1000 NXi PFD + MFD | GFC 700 |
  | Piper PA-18-150 Super Cub | tail-wheel | basic VFR: airspeed, altimeter, VSI, turn coordinator, tachometer, oil, voltmeter, fuel, wet compass, one NAV/COM + transponder, magneto key, master/radio, primer, carb heat | none |

  Lessons and landing challenges fly the 172; the Pacific Coast bush trip flies the Super Cub.
- **Flight model.** RK4 rigid body at 120 Hz with JSBSim-derived aerodynamics, stall hysteresis,
  flaps, ground effect, slipstream over the tail, P-factor, torque and gyroscopic effects, an
  IO-360 engine with manifold dynamics and mixture, spring-damper gear with tyre friction and
  brakes, Dryden turbulence, fuel burn and CG shift, factory rigging for hands-off cruise, and the
  C172S 28 V electrical system (battery, alternator, master and avionics switches, LOW VOLTS: a flat
  battery will not start the engine). Climb, cruise, take-off and stall match the POH within a few
  percent; the dynamic modes, energy conservation and turbulence statistics are verified by tests
  (see `src/fdm/README.md`).
- **World.** AWS Terrain Tiles elevation streamed with CDLOD quadtree LOD and earth curvature,
  Sentinel-2 cloudless imagery (a procedural land-cover fallback offline), a floating origin that
  rebases every 20 km, 5,280 airports with marked, lit runways (edge, threshold, PAPI, REIL,
  approach lights and rabbits), and **OpenStreetMap autogen**: buildings with lit windows at
  night, aprons and taxiways with markings and edge lights, trees and street lighting streamed from
  OpenFreeMap vector tiles. "Parking" spawns put you at a real gate or apron stand.
- **Sky and weather.** Sun and moon from the real date and position, a physically based sky with
  modelled aerial-perspective haze, stars, cloud layers that cast shadows on the ground, night
  glow, nine MSFS weather presets, METAR parsing, live weather from Open-Meteo, rain and snow,
  winds aloft and gusts.
- **Cockpit and avionics.** A Cessna 172 cockpit with a steam-gauge six-pack (clickable knobs and
  hover tooltips), the Super Cub's tandem cockpit with its own clickable panel (14 V system: LOW
  VOLTS on the battery, dark radios with the radio switch off), or an **interactive G1000 NXi**: softkeys, dual knobs on the mouse wheel,
  Direct-To any airport or navaid, an editable flight plan, nearest airports, and ILS approach
  loading. NAV/COM radios with VOR, ILS and auto-course, WMM2025 magnetic variation.
- **Autopilot and assists.** GFC 700-style autopilot (HDG, NAV, APR with glideslope, ALT, VS, FLC
  and the LVL recovery mode) with flight director, verified on the real flight model; MSFS-style
  assists (auto-rudder, assisted take-off, anti-stall protection, landing path gates, auto
  mixture, crash and stress damage).
- **ATC.** Scripted, menu-driven ATC with ATIS, ground, tower and flight following, readbacks,
  traffic pattern work and spoken transmissions.
- **Activities.** Nine landing challenges scored like MSFS, three instructor-led lessons (basic
  flight, take-off, landing), an eight-leg Pacific Coast bush trip in the Super Cub with saved progress, a
  five-minute replay, slew mode and screenshots (`F12`).
- **Interface.** MSFS-style main menu, World Map flight planner, aircraft and weather screens,
  settings (graphics, controls with rebinding and gamepad profiles, audio, assists), in-flight
  toolbar panels (VFR map, ATC, checklists, nav log, weather), a HUD for external views and
  procedural engine, environment and warning sounds.

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
| Elevator trim nose down / up | `[` / `]` | `Num 7` / `Num 1` |
| Engine auto-start / shutdown | `Ctrl+E` / `Ctrl+Shift+E` | |
| Master switch / avionics master / fuel pump | `Shift+B` / `Shift+V` / `Shift+U` | same |
| Cameras: next / chase / drone | `C` / `S` / `Insert` | `End` |
| Autopilot master / HDG / ALT | `Z` / `Ctrl+H` / `Shift+T` | `Z` / `Ctrl+H` / `Ctrl+T` |
| Pause / sim rate | `P` / `Ctrl+=` `Ctrl+-` | `Pause` / `Ctrl+Num +` `Ctrl+Num -` |
| Slew mode (reposition) | `Y` | `Y` |
| Menu | `Esc` | |

**Super Cub.** The same keys fly it, with these differences: the rudder pedals (`Q` / `E`, `Num 0` /
`Num Enter`) also steer the tail wheel, and a hard pedal with one heel brake (`Num *` / `Num -`
for left / right) unlocks it to swivel for tight turns; the flap keys step through its three
positions (up, 25°, 50°); `H` pulls the carburettor heat, `M` / `Shift+M` turn the magneto key;
the autopilot keys do nothing (no autopilot) and there is no heading bug. Technique: stick back
while taxiing, S-turns to see past the nose, forward stick at about 30 KIAS to raise the tail, lift
off at about 40 KIAS, climb at 61 (Vy), approach at 55–60 with full flaps and land three-point.
Without rudder it swings left and ground-loops (the assisted take-off and auto-rudder assists work
on it too).

**Slew mode** (`Y`) freezes the flight model and moves the aircraft directly, as in MSFS: stick
forward and back to move, stick left and right to turn, rudder to slide sideways, throttle above or
below 50 % to climb or descend. Speeds grow with height above the ground. Press `Y` again to fly on
from the new position: the aircraft is trimmed for level flight, or set down on its wheels when it
is within 10 m of the ground.

The full tables are in `src/input/README.md`.

**Scenery data.** Buildings and airport surfaces come from OpenFreeMap by default. To use another
OpenMapTiles-schema source (or local test tiles), pass a URL template:
`http://localhost:5173/?osm=http://127.0.0.1:9000/{z}/{x}/{y}.pbf`.

## Architecture

```
src/core        shared contracts (types.ts), math, units, events
src/geo         WGS84/ENU frames, Web Mercator tiles, sun/moon, WMM magnetic variation
src/fdm         flight dynamics model (Cessna 172S, Piper PA-18-150 Super Cub)
src/terrain     terrain streaming, LOD, worker decode, imagery, water
src/world       floating origin, airports layer, flight-model environment
src/sky         sky, lighting, clouds, precipitation, weather, METAR, live weather
src/aircraft3d  procedural Cessna 172 and Super Cub models with animated surfaces and lights
src/camera      cockpit, chase, orbit, drone, tower, fly-by and wing cameras
src/instruments steam gauges, G1000 PFD/MFD, HUD (canvas textures)
src/nav         airport/navaid database, VOR/ILS/GPS geometry, flight plans
src/autopilot   GFC-700-style autopilot and flight director
src/input       keyboard, mouse yoke, gamepad, touch, rebindable profiles
src/audio       procedural engine and environment sound, warnings, speech
src/atc         scripted, menu-driven ATC
src/ui          MSFS-style menus, world map, settings, in-flight panels
src/scenery     OpenStreetMap autogen: buildings, airport surfaces, vegetation, night lights
src/activities  landing challenges and scoring, lessons, bush trips, replay
src/app         simulator main loop, integration, automation hooks
```

Design decisions and conventions are in `docs/DESIGN.md`; the research behind them is in
`docs/research/`.

## Data and credits

Terrain, imagery, airport and magnetic-model data come from open sources that require
attribution. See `docs/CREDITS.md`; the same list appears in the app under Credits.

## License

MIT for the code (`LICENSE`). Third-party data keeps its own license (`docs/CREDITS.md`).
