# src/ui — menus, World Map, settings, activities, in-flight toolbar

MSFS-style user interface in plain DOM + CSS (no framework, no dependencies): loading splash,
main menu, World Map flight planner, aircraft / weather / settings / credits screens, Activities
(landing challenges), and the in-flight toolbar with draggable panels, status bar, flight info
strip, ATC subtitles, pause menu, keyboard help and landing report.

The UI talks to the simulator **only** through `UiHost` (`UiHost.ts`) and the event bus it
exposes. The single exception is the pure landing-challenge table (`src/activities/landingChallenges.ts`,
types-only dependency on core), read in one adapter (`activities.ts`).

## Integrating

```ts
import { UiManager } from './ui';          // the barrel also imports ui.css

const ui = new UiManager(container, host); // host implements UiHost; shows the boot splash
ui.onStart(() => audio.resume());          // first click/key ("click to start") — audio unlock
// every frame (cheap: only the visible screen/widgets, DOM written only on change)
ui.update(snapshot, dt);
// discrete actions (keyboard, gamepad) — return true when the UI consumed it
sim.plugins.ui = { update: (s, dt) => ui.update(s, dt), handleAction: (a) => ui.handleAction(a) };
ui.show('main');                           // optional: skip the splash
ui.dispose();                              // removes the DOM, listeners and subscriptions
```

| Member | Purpose |
|---|---|
| `new UiManager(container, host)` | Builds `.fs-ui` (layers: hud z10 · flight z20 · screens z30 · modal z40), loads settings from `localStorage` and **pushes them to the host** (`setGraphics/setAudio/setUnits/setAssists`), subscribes to events, shows `loading`. |
| `show(screen)` | `'loading' \| 'main' \| 'worldmap' \| 'aircraft' \| 'weather' \| 'settings' \| 'credits' \| 'activities' \| 'flight'`. |
| `update(snapshot, dt)` | Per-frame. Menus: only the visible screen. Flight: status bar, info strip, and only the *open* panels (each throttled). |
| `handleAction(a)` | `toggleMenu` (Esc / gamepad Menu) → back / pause menu; `toggleMap`, `toggleCheckList`, `toggleAtc`, `toggleWeatherPanel`, `toggleHelp` → panels. `toggleHud` and the three assist toggles are observed but **not** consumed (the simulator acts on them too). |
| `onStart(cb)` | Called once on the first user gesture (boot screen click/key, or any pointer/key if a flight started first). |
| `inFlight` / `current` | A flight has been spawned / the visible route. |
| `coversView` | An opaque menu or loading screen hides the 3D view: the integrator may skip/throttle rendering. |

### UiHost (required + optional members)

Required: `events`, `nav`, `snapshot()`, `aircraftList()`, `currentAircraft()`, `dispatch()`,
`spawn()`, `setWeatherPreset()`, `setCustomWeather()`, `requestLiveWeather()`, `setTime()`,
`setTimeScale()`, `setPaused()`, `setCamera()`, `setAssists()`, `setGraphics()`, `setAudio()`,
`setUnits()`, `bindings()`, `rebind()`, `resetBindings()`, `dataCredits()`, `captureInput()`.

`setWeatherPreset(id, { immediate: true })` / `setCustomWeather(w, { immediate: true })` are sent
when a new flight starts (no blend from the previous flight's weather); without the option the
host may transition gradually in flight. A host that ignores the option still works.

Optional (feature-detected, UI hides/disables the feature when absent):
`addWaypoint(wp)` (World Map "Set as arrival", VFR map "Direct to"), `clearPlan()` (Nav log),
`startChallenge(id)` (Activities "Start"), `comRadio()` (COM1 frequency in the ATC panel header;
otherwise the header shows the last transmission's frequency), `setInfoStrip(visible)` (the
"Flight info strip" setting, for a host whose own HUD replaces the UI's strip).

Events consumed: `ui:toast`, `terrain:progress` (flight loading bar), `landing:scored` (report +
challenge best score; `landingReportModel.ts` maps the scorer's `centre/smooth/zone/stop` percentages,
`centrelineOffsetM`, `verticalSpeedFpm`, `touchdownFromThresholdM`, `stopDistanceM`, `peakG`,
`crabDeg`, `bounces`, `grade`, and also accepts 0..1 fractions or other spellings), `atc:message`, `atc:options`, `aircraft:crash` (pause menu titled
"Crashed" after 1.5 s), `autopilot:changed` ("AP OFF" toast), `flight:reset` (fresh panels; a
flight started outside the UI, e.g. by automation, switches to the flight view).

## How it works

- **Routing** (`routing.ts`, pure): `ScreenRouter` keeps a history stack. `loading`, `main` and
  `flight` are roots; other screens push; navigating to a screen already in the stack unwinds to
  it. Esc = back in menus; back from `main` resumes a loaded flight.
- **Esc and keyboard capture.** The input module ignores keys while captured or in text fields,
  so the UI listens for Esc itself. When the keyboard was *not* captured the input module also
  reports the press as `toggleMenu` a frame later: `EscapeDeduper` swallows exactly that echo
  (a gamepad Menu button has no keydown and still works). `host.captureInput(true)` whenever a
  menu screen is visible, an in-flight overlay (pause, help, landing report) is open, or a text
  field has focus (`shouldCaptureInput`). Entering flight blurs any focused UI field.
- **Pause menu.** Esc in flight closes the topmost overlay, else toggles the pause menu, which
  pauses the sim and restores the previous pause state on resume. World map / Settings / Main
  menu from the pause menu keep the sim paused; coming back to the flight with Esc/back re-opens
  the menu, while the main menu's "Resume flight" resumes directly.
- **Starting a flight** (`fly()`): weather (immediate) + time from the selection → `host.spawn(...)` with
  the loading screen (progress from `terrain:progress`) → live weather (needs the new position) →
  arrival waypoint (the planner is cleared at spawn) → flight view. Failures toast and return
  to the previous menu. Challenges use `host.startChallenge(id)` the same way.
- **Settings** (`settingsStore.ts`, `settingsModel.ts`): `flightsim.settings.v1` holds graphics,
  audio, units, assists and interface (UI scale, ATC subtitles, info strip), sanitized field by
  field. Every edit goes through the pure `settingsReducer`, which reports which groups changed;
  only those are saved and pushed to the host. Assist presets overwrite every item and the
  General tab always shows each item's **effective** ON/OFF state (MSFS gotcha, doc 01 §1.2);
  in flight the live `snapshot.assists` (hotkey toggles) is adopted before Settings opens.
- **World Map** (`screens/WorldMap.ts` + `screens/worldmap/*`): debounced search
  (`searchDebounce.ts`; empty box = airports near the map centre), airport card (elevation,
  frequencies, runways with length × width / surface / ILS, both ends with heading and
  head/tailwind, "into wind" badge, Parking cold & dark, Set as departure / arrival), canvas map
  (equirectangular `mapProjection.ts`; drag to pan, wheel zooms about the cursor, double-click,
  arrows / + / −; graticule; airport dots sized by type and filtered by zoom; labels by zoom;
  departure runway drawn with a take-off chevron; great-circle route to the arrival; scale bar
  in the user's unit). Airports come from `nav.nearestAirports` around the view centre,
  re-queried only after a > 25 % pan/zoom and at most every 250 ms; zoomed in, `nav.loadRegion`
  fetches small-airport shards. Flight conditions: 9 presets + Live + Custom, time Now / Dawn /
  Noon / Dusk / Night / custom slider with the sun-elevation hint (`timeOfDay.ts`, `solar.ts`).
- **Activities** (`screens/Activities.ts`, `activities.ts`): category tabs (All / Famous / Epic /
  Strong Wind), cards with best score, briefing (approach, weather, wind, time), Start.
  `ChallengeSession` attributes `landing:scored` to the running challenge (kept across
  "Restart", dropped when a different flight spawns); best scores in `flightsim.activities.best.v1`.
- **In flight** (`flight/FlightUi.ts`, `flight/FlightPanels.ts`): toolbar revealed at the top edge
  (Camera · ATC · Checklist · Nav log · VFR map · Weather · Controls · Menu), draggable /
  resizable panels with persisted positions (`flightsim.ui.layout.v1`), status bar, info strip,
  ATC subtitles, toasts (also in menus). The Weather panel highlights the preset the simulator is
  actually flying (a challenge sets its own); the pause menu's "Restart flight" respawns at the
  same position (runway, parking or challenge final).

Keyboard ownership in flight: a slider, dropdown, switch or button used with the pointer in the
toolbar or a panel gives the focus back right away (`releasesFocusAfter` in `routing.ts`), because
the input module ignores every key aimed at an INPUT/SELECT and a focused button re-fires on
Space/Enter. Hidden menu screens are `inert` + `visibility: hidden`, so Tab in flight reaches the
toolbar (which then shows itself) and never an invisible menu. A touch-and-go is reported as a toast:
the modal landing report (which takes the keyboard) is kept for full-stop landings. Leaving
Settings › Controls while a rebind waits for a key cancels it (`host.cancelRebind`, or the
documented Esc when the host lacks it), so the next key in flight is not silently bound.

Headings: the Nav log shows magnetic bearings (variation from the aircraft's true and magnetic
headings); the World Map shows runway headings magnetic when the host implements
`magneticVariationDeg`, otherwise marked true ('298°T'). The World Map uses Web Mercator (conformal:
runways cross at their real angles). Weather summaries and the custom editor follow the unit
settings (inHg/hPa, °C/°F, nm/km, ft/m, kt/km/h/mph).

Phones (≤ 720 px wide): one scrolling column per screen, World Map order search → map → airport →
conditions with the departure summary and FLY pinned at the bottom; icon-only toolbar opened from a
tab at the top edge on touch screens; pinch-zoom on the World Map; text fields are not auto-focused
on touch screens (no on-screen keyboard popping up).

Per-frame cost: `Txt`/`Cls` write the DOM only on change; closed panels cost nothing; ATC
station lookup 1 Hz; VFR map ≤ 10 Hz (its size is read only when it draws); checklist auto-check
4 Hz; weather summary 2 Hz; the info strip formats a value only when its displayed (quantised)
value changes; no allocations in the menu update path. The World Map draws on demand via `requestAnimationFrame`, never per sim frame.

## Adding a screen

1. Add the id to `ScreenId` in `screens/Screen.ts`.
2. `class MyScreen extends Screen` — build `this.el` in the constructor (use `screenHeader(ctx, …)`
   for the back button), override `onShow/onHide/update/onKey/focus/dispose` as needed.
3. Register it in `UiManager`'s `screens` record and link to it with `ctx.navigate('my-screen')`.
4. Never touch `document`/`window`/`localStorage` at module top level (import safety test).

## Tests (Node, `npx vitest run src/ui`)

Pure modules only: routing + Esc de-duplication + capture rules, landing report adapter (the real
TouchdownDetector payload: percent components, raw measurements, touch-and-go), debounced search (fake timers,
stale async results), settings reducer (changed groups, presets vs. per-item, sanitizing,
resets), bindings view model (groups, conflicts, filters), activities (filters, briefing text,
best scores, challenge session), World Map model (zoom filtering, dot sizes, query radius,
refetch throttling incl. antimeridian, hit-testing, scale bar, runway line), time-of-day
mapping and sun hint, plus the pre-existing format, projection, solar, runways, weather presets,
assist presets and checklist tests. `importSafety.test.ts` imports every module (including all
DOM classes and the CSS-importing barrel) in Node to prove nothing touches the DOM at load.

## Known limitations

- No coastline/imagery layer on the World Map canvas (graticule + airports only); dots of
  large airports outline continents at world zoom.
- The local clock is longitude-based (no timezone database).
- "Set as arrival" adds a direct GPS leg only (no SID/STAR/approach selection).
- Binding conflicts are detected per device by identical labels from `host.bindings()`.
- DOM classes are not unit-tested (no DOM in the test environment); they are covered by
  import-safety tests and manual/browser checks.
- Graphics › Shadows and Terrain detail are only as effective as the host's `setGraphics`
  (the current SimUiHost applies quality, render scale, FOV, imagery and clouds).
- Runway idents are shown as the nav data spells them ('1R/19L' for OurAirports' KSFO data).
- Without `host.cancelRebind` a pending rebind is ended by a synthesized Esc (works with the
  bundled input module, which cancels a capture on Esc).
- In flight the Weather panel's time-of-day buttons show the planned selection; a challenge's own
  time of day (e.g. dusk) is not reflected there (its weather preset is).
- Settings › Controls and the help sheet list SimActions only: keyboard flight-control axes
  (pitch/roll/rudder/throttle keys) are not reported by `host.bindings()`.

## Tuning knobs

| Where | Knob |
|---|---|
| `worldMapModel.ts` | `ZOOM_LARGE_ONLY` (6 px/°), `ZOOM_MEDIUM` (40), `ZOOM_LOAD_REGION` (60), `ZOOM_RUNWAYS` (500), `AIRPORT_DOT_PX`, label zooms, `MAX_QUERY_NM` |
| `screens/worldmap/MapCanvas.ts` | `FETCH_INTERVAL_MS` (250), `DRAG_THRESHOLD_PX` (4), `MAX_REGION_NM` (250), wheel sensitivity |
| `searchDebounce.ts` / `AirportSearch.ts` | debounce 180 ms, min query length 2, 30 results, 15 nearby within 150 nm |
| `routing.ts` | `EscapeDeduper` window (600 ms) |
| `flight/FlightUi.ts` | crash menu delay 1.5 s, AP toast grace after spawn 1.5 s, subtitle duration (≥ 4 s, 70 ms/char) |
| `settingsStore.ts` | defaults, graphics quality presets, `UI_SCALE_MIN/MAX` |
| `ui.css` | tokens on `.fs-ui` (`--accent #4cc3ff`, `--ui-bg`, `--radius`, `--ui-scale`) |
