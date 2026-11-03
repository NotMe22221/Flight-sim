# src/ui — menus, World Map, settings, activities, in-flight toolbar

MSFS-style user interface in plain DOM + CSS (no framework, no dependencies): loading splash,
main menu, World Map flight planner, aircraft / weather / settings / credits screens, Activities
(landing challenges, Flight Training lessons, bush trips), and the in-flight toolbar with draggable
panels (including the activity objectives), status bar, flight info strip, ATC and instructor
subtitles, pause menu, keyboard help, landing report and activity debrief.

The UI talks to the simulator **only** through `UiHost` (`UiHost.ts`) and the event bus it
exposes. The exceptions are pure activity data from `src/activities`, imported directly: the
landing-challenge table (read in `activities.ts`), `LESSONS` and `BUSH_TRIPS` with the pure
bush-trip helpers `navLog` / `legRouteNm` / `legDistanceNm` and `gradeFor` (read in
`activityModels.ts` and the Activities tabs). The runner and the progress store reach the UI only
through the host (`host.activityRunner`, `host.activityProgress`, typed as the read-only views
`ActivityRunnerView` / `ActivityProgressView` in `UiHost.ts`).

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
`resetBindings(profile)` takes the input module's layouts: `'default'` (out of the box: MSFS numpad
layout + laptop layer merged; Settings › Controls offers it first as the recommended reset),
`'msfs'` and `'laptop'` (each layer alone), `'gamepad-xbox'`, `'joystick-generic'`.

`setWeatherPreset(id, { immediate: true })` / `setCustomWeather(w, { immediate: true })` are sent
when a new flight starts (no blend from the previous flight's weather); without the option the
host may transition gradually in flight. A host that ignores the option still works.

Optional (feature-detected, UI hides/disables the feature when absent):
`addWaypoint(wp)` (World Map "Set as arrival", VFR map "Direct to"), `clearPlan()` (Nav log),
`startChallenge(id)` (Activities "Start"), `comRadio()` (COM1 frequency in the ATC panel header;
otherwise the header shows the last transmission's frequency), `setInfoStrip(visible)` (the
"Flight info strip" setting, for a host whose own HUD replaces the UI's strip),
`magneticVariationDeg(lat, lon)` (runway headings and nav-log bearings in °M; without it the
World Map shows true headings marked 'T').

Activities (src/activities, all optional; the bundled `SimUiHost` implements them):
`startLesson(id)` / `startBushLeg(tripId, legIndex)` (Activities "Start", "Resume", debrief "Next
leg"; without them Start is disabled), `restartActivity()` (debrief "Retry", pause menu "Restart
activity"; otherwise the pause menu's restart is the plain `resetFlight`, which the runner also
treats as a restart at its start point), `restartActivityStep()` and `abortActivity()` (pause menu
"Restart step" / "Abort activity", hidden when absent), `activityRunner` (polled: `phase` gates the
Start buttons while `'starting'`, `objectives`/`stepIndex` feed the live progress bars, `liveHint`
the "what to correct now" line, `result` the debrief) and `activityProgress` (completed badges, best
scores, unlocked legs, Resume, Reset trip; without it every leg is open and nothing shows as
completed).

Events consumed: `ui:toast`, `terrain:progress` (flight loading bar), `activity:started` (objectives
panel shown, toolbar button on), `activity:instruction` (instructor subtitle), `activity:progress`
(objective rows of the current step; the runner's extra `step` / `optional` / `progress` fields are
read when present), `activity:finished` (debrief, or a toast), `landing:scored` (report +
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
  field. Blob version 2: default FOV 70° (MSFS cockpit default; a version-1 blob still holding the
  old 75° default is migrated), and assists added after a blob was saved (anti-stall protection)
  take the value of the preset the saved assists match ('All assists' players get it on). Every edit goes through the pure `settingsReducer`, which reports which groups changed;
  only those are saved and pushed to the host. Assist presets overwrite every item and the
  General tab always shows each item's **effective** ON/OFF state (MSFS gotcha, doc 01 §1.2);
  in flight the live `snapshot.assists` (hotkey toggles) is adopted before Settings opens.
- **World Map** (`screens/WorldMap.ts` + `screens/worldmap/*`): debounced search
  (`searchDebounce.ts`; empty box = airports near the map centre), airport card (elevation,
  frequencies, runways with length × width / surface / ILS, both ends with heading and
  head/tailwind, "into wind" badge, Parking cold & dark, Set as departure / arrival), canvas map
  (Web-Mercator `mapProjection.ts`; drag to pan, wheel zooms about the cursor, double-click,
  arrows / + / −; graticule; airport dots sized by type and filtered by zoom; labels by zoom;
  departure runway drawn with a take-off chevron; great-circle route to the arrival; scale bar
  in the user's unit). Airports come from `nav.nearestAirports` around the view centre,
  re-queried only after a > 25 % pan/zoom and at most every 250 ms; zoomed in, `nav.loadRegion`
  fetches small-airport shards. Flight conditions: 9 presets + Live + Custom, time Now / Dawn /
  Noon / Dusk / Night / custom slider with the sun-elevation hint (`timeOfDay.ts`, `solar.ts`).
- **Activities** (`screens/Activities.ts` + `screens/activities/*`, tab remembered in
  `flightsim.ui.activitiesTab.v1`): three tabs.
  - *Landing challenges* (`ChallengesTab.ts`, `activities.ts`): category filter (All / Famous / Epic /
    Strong Wind), cards with best score, briefing (approach, weather, wind, time), Start.
    `ChallengeSession` attributes `landing:scored` to the running challenge (kept across
    "Restart", dropped when a different flight spawns); best scores in `flightsim.activities.best.v1`.
  - *Flight training* (`TrainingTab.ts`): a card per lesson (`LESSONS`) with the step count, start,
    weather and time, the completed badge and best score / attempts from `activityProgress.lesson(id)`;
    the detail card has the briefing (start in the user's units, weather, time, aircraft, duration
    and level when a lesson carries `durationMin` / `difficulty`), the lesson plan (step titles) and
    Start. The first lesson not yet completed is preselected.
  - *Bush trips* (`BushTripsTab.ts`): a card per trip (`BUSH_TRIPS`) with its legs-completed bar; with
    a single trip it opens directly. An opened trip lists its legs: from → to with the airport names,
    distance through the landmarks (`legRouteNm`), cruise altitude, highest terrain (`leg.terrain`)
    and landmarks; completed legs ticked with the best score, the next leg highlighted, locked legs
    greyed (`activityProgress.isLegUnlocked`). The leg card shows the briefing, the flight plan and a
    nav log (`navLog`: courses magnetic with `host.magneticVariationDeg`, else marked T, distances in
    the user's unit) and Start (disabled and locked-labelled until the previous leg is flown).
    "Resume · leg N" starts `nextLeg` ("Fly again" from leg 1 once the trip is done); "Reset trip"
    asks for an inline confirmation before `activityProgress.resetTrip`.
  - The view models are pure (`activityModels.ts`); every Start (challenges too) is disabled while
    `activityRunner.phase === 'starting'` (`StartGate`, polled in `update`, DOM written on change).
    Lessons and legs start like challenges (`FlightLauncher.startActivity`): loading screen, the host
    call, then the flight view; a failure toasts and returns to Activities. A free flight or a
    challenge started while an activity runs ends it quietly first (`endActivity`).
- **Activities in flight** (`flight/ObjectivesPanel.ts`, `flight/InstructorSubtitle.ts`,
  `flight/DebriefCard.ts`, wired in `FlightUi`): `activity:started` opens the *Objectives* panel (top
  left, a FloatingPanel whose toolbar button exists only while there is an activity): activity title,
  "Step 2 of 7 · Climb 500 ft", the current step's objectives with status icons (optional ones
  dimmed and tagged), a thin progress bar each, "Next: …", and the live hint
  (`activityRunner.liveHint`, held 1 s after it clears so it does not flicker). Rows are rebuilt only
  on `activity:progress`; between events the panel reads the runner's live objective views at most
  10 Hz and writes a bar only when its whole percent changes. Instructor lines
  (`activity:instruction`) show at the bottom centre, just above the instruments HUD's controls
  strip (its height is mirrored in CSS from the HUD's scale formula): ~6 s, 9 s when important,
  60 ms per character for long lines, at most 25 s; bursts are queued (`subtitleQueue.ts`: each line
  readable ≥ 2.5 s, paused time and time off the flight view not counted, so the first instruction is
  still there after the loading screen). Toasts move above the subtitle while it shows.
  `activity:finished` shows the *debrief* 1.8 s later (after the closing line): outcome, score /100
  and grade, the reason when failed, summary, time, landing score, every step with its objectives
  and notes ('Missed' optional ones dimmed, 'Not reached'), and Retry (`restartActivity`), Next leg
  (bush trips, when the next leg exists and is unlocked), Landing report (re-opens the full report
  of the activity's landing) and Close. During an activity a full-stop landing is a toast (the pilot
  may still have to stop; the debrief carries the score). After a crash the debrief replaces the
  crash menu; closing it opens the menu ('Crashed'). An abort from the pause menu, or a flight
  changed under the activity, is a toast; a replaced activity (Retry, another Start) shows nothing.
- **Pause menu during an activity**: a line with the activity and step, "Restart step"
  (`restartActivityStep`, resumes), "Restart activity" (instead of "Restart flight") and "Abort
  activity" (stays paused, noted "Activity aborted · you are in free flight").
- **In flight** (`flight/FlightUi.ts`, `flight/FlightPanels.ts`): toolbar revealed at the top edge
  (Camera · Objectives (during an activity) · ATC · Checklist · Nav log · VFR map · Weather · Controls · Menu), draggable /
  resizable panels with persisted positions (`flightsim.ui.layout.v1`), status bar, info strip,
  ATC subtitles, toasts (also in menus). The Weather panel highlights the preset the simulator is
  actually flying (a challenge sets its own) and its time card follows the simulator clock at the
  aircraft (`flightTimeMode` in `timeOfDay.ts`: 'Dusk' for a dusk challenge, nothing highlighted
  once the clock has moved away from every preset); the pause menu's "Restart flight" respawns at
  the same position (runway, parking or challenge final).
- **Autopilot annunciations** (`apAnnunciator.ts`, info strip): GFC 700 style lateral · AP ·
  vertical, active modes green and armed modes white, `LVL` in both fields during LVL recovery, a
  flashing `AP` for 5 s after a disconnect (`disconnectT` changed: red with the reason, e.g.
  `AP OFF · STALL`, when the autopilot dropped out; amber for the pilot's own disconnect;
  re-engaging cancels it) and the altitude alerter on the ALT cell (`altAlert`: the key turns into
  the selected altitude, black on cyan while approaching it, amber on a deviation, flashing 5 s).
  A disconnect also toasts with the reason in every view. The disconnect tone is the audio
  module's (it watches `autopilot:changed`); the UI has no audio hook and does not double it.

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

Phones (≤ 720 px wide): one scrolling column per screen (Activities: short tab labels Challenges ·
Training · Bush trips sharing the width, leg rows stacked, the briefing scrolled into view on select), World Map order search → map → airport →
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
best scores, challenge session), activity view models (`activityModels.test.ts`: lesson cards with
completed / attempted / new states, units and optional metadata, trip cards and resume, the leg list
locked / next / completed with a real in-memory `ProgressStore`, no store = all open, leg briefing
and nav log incl. magnetic courses and km/m, objective rows and step filtering, subtitle timing,
debrief content incl. the next-leg rule, finish presentation; compile-time check that the real
`ActivityRunner` / `ProgressStore` satisfy the UI's views), the subtitle queue (bursts, minimum
reading time, pause, gaps, repeats, overflow), World Map model (zoom filtering, dot sizes, query radius,
refetch throttling incl. antimeridian, hit-testing, scale bar, runway line), time-of-day
mapping, sun hint and the in-flight clock choice, autopilot annunciator (LVL, disconnect flash
baseline/rebase, alerter), settings version-2 migrations (FOV, anti-stall), plus the pre-existing format, projection, solar, runways, weather presets,
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
- Graphics settings are only as effective as the host's `setGraphics` (the current SimUiHost
  applies everything except Terrain detail).
- Runway idents are shown as the nav data spells them ('1R/19L' for OurAirports' KSFO data).
- Without `host.cancelRebind` a pending rebind is ended by a synthesized Esc (works with the
  bundled input module, which cancels a capture on Esc).
- The info strip (with the AP annunciator) is the UI's own; the bundled host hides it while the
  instruments HUD plugin draws its flight strip, so there the annunciations come from that HUD
  and the cockpit PFD, and the UI adds only the disconnect toast.
- Settings › Controls and the help sheet list SimActions only: keyboard flight-control axes
  (pitch/roll/rudder/throttle keys) are not reported by `host.bindings()`.
- Activities: the Objectives panel has no hotkey (there is no SimAction for it; toolbar only). The
  instructor subtitle lives in the HUD layer, so an open floating panel (e.g. the VFR map at its
  default bottom-right place on narrow windows) can cover part of it. In the cockpit view it sits
  over the upper edge of the instrument panel (the HUD controls strip it clears is drawn in the
  external views). The UI speaks nothing: TTS of instructor lines is the host's (`speakInstructor`).
  Lesson cards show duration / level only when the lesson data carries them (the bundled lessons do
  not).

## Tuning knobs

| Where | Knob |
|---|---|
| `worldMapModel.ts` | `ZOOM_LARGE_ONLY` (6 px/°), `ZOOM_MEDIUM` (40), `ZOOM_LOAD_REGION` (60), `ZOOM_RUNWAYS` (500), `AIRPORT_DOT_PX`, label zooms, `MAX_QUERY_NM` |
| `screens/worldmap/MapCanvas.ts` | `FETCH_INTERVAL_MS` (250), `DRAG_THRESHOLD_PX` (4), `MAX_REGION_NM` (250), wheel sensitivity |
| `searchDebounce.ts` / `AirportSearch.ts` | debounce 180 ms, min query length 2, 30 results, 15 nearby within 150 nm |
| `routing.ts` | `EscapeDeduper` window (600 ms) |
| `flight/FlightUi.ts` | crash menu delay 1.5 s, AP toast grace after spawn 1.5 s, ATC subtitle duration (≥ 4 s, 70 ms/char), `DEBRIEF_DELAY_MS` 1.8 s |
| `activityModels.ts` / `subtitleQueue.ts` | instructor subtitle `SUBTITLE_MIN_MS` 6 s, `SUBTITLE_IMPORTANT_MS` 9 s, 60 ms/char, max 25 s; queue minimum reading time 2.5 s, 3 waiting lines, frame gaps > 250 ms not counted |
| `flight/ObjectivesPanel.ts` | live progress at most 10 Hz (`LIVE_INTERVAL_MS`), hint hold 1 s (`HINT_HOLD_MS`) |
| `settingsStore.ts` | defaults, graphics quality presets, `UI_SCALE_MIN/MAX` |
| `ui.css` | tokens on `.fs-ui` (`--accent #4cc3ff`, `--ui-bg`, `--radius`, `--ui-scale`) |
