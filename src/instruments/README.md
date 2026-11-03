# `src/instruments` — cockpit instruments

2D-canvas renderers for the cockpit displays. **No Three.js imports**: the integrator wraps the
canvases in `THREE.CanvasTexture`s (cockpit panels) or places them in the DOM (HUD overlay,
pop-out displays). Everything runs in Node against `testing/mockCanvas.ts`. Spec:
`docs/research/05-cockpit-avionics-navigation.md` §1–3 and §6.

| Export | What it draws | Canvas |
|---|---|---|
| `SteamPanel` | C172S six-pack, engine/system gauges, radio stack, annunciators | 1024×512 opaque |
| `G1000` | G1000 NXi-style PFD and MFD in GDU bezels, interactive (softkeys, knobs, D→, FPL, NRST, PROC) | 2 × 1344×1008 opaque (1024×768 screens; `bezel: false` → 2 × 1024×768) |
| `G1000Panel` | both GDUs side by side on one texture + UV → control mapping | 2769×1008 opaque |
| `Hud` | translucent MSFS-like overlay for the external views | viewport × dpr, transparent |
| `InstrumentModel` | instrument dynamics shared by all of the above | — |

## API

```ts
import { G1000, Hud, SteamPanel, CANVAS_TEXTURE_SETTINGS, PANEL_TEXTURE_SIZE, createCanvas } from './instruments';

// G1000 ───────────────────────────────────────────────────────────────────────────
const g1000 = new G1000({ width?, height?, createCanvas?, model?, vspeeds?, pfdHz = 30, mfdHz = 15,
                          skipUnchanged = true, maxIdleS = 1, rangeNm = 10,
                          bezel = true, nav?, planner?, onCommand? });   // see "G1000 interaction"
g1000.pfdCanvas; g1000.mfdCanvas;                 // HTMLCanvasElement | OffscreenCanvas (1344×1008 with the bezel)
g1000.screenRect;                                 // { x: 160, y: 64, w: 1024, h: 768 } inside each canvas
if (g1000.update(snapshot, dt)) {                 // true when a canvas changed
  if (g1000.changed.pfd) pfdTex.needsUpdate = true;
  if (g1000.changed.mfd) mfdTex.needsUpdate = true;
}
g1000.setNearestAirports(list);   // { icao, lat, lon, type }[] or nav-database Airport[]
g1000.setRange(nm); g1000.zoom(+1 | -1); g1000.rangeNm;       // snaps to 0.5 … 2000 nm steps
g1000.setMapOrientation('north-up' | 'track-up' | 'heading-up');
g1000.setCdiSource('GPS' | 'NAV1' | 'NAV2'); g1000.cycleCdiSource();   // CDI softkey
g1000.setBearingSource(1 | 2, 'OFF' | 'NAV1' | 'NAV2' | 'GPS');      // BRG1 = NAV1, BRG2 = GPS by default
g1000.setWindOption(1 | 2); g1000.setDmeSource('OFF' | 'NAV1' | 'NAV2');
g1000.com1.activeKHz = 118300; g1000.squawk = 7000; g1000.xpdrMode = 'ALT';  // not in SimSnapshot
g1000.startTimer(); g1000.stopTimer(); g1000.resetTimer();
g1000.reset(snapshot); g1000.invalidate(); g1000.dispose();
g1000.hsiGeometry;                // screen geometry of the last HSI draw (hit-testing, tests)

// HUD (DOM overlay above the WebGL canvas, CSS pointer-events: none) ────────────────
const hud = new Hud({ createCanvas?, uiScale = 1, hz = 30, showInCockpit = false });
document.body.appendChild(hud.canvas as HTMLCanvasElement);
hud.resize(innerWidth, innerHeight, devicePixelRatio);   // also sets the canvas CSS size
hud.update(snapshot, dt);         // redraws at most hz, only when something visible changed
hud.setVisible(sim.hudVisible);   // hidden: clears once, then draws nothing
hud.setStatus('Loading imagery…' | null);   // custom status-line hook (bottom left)
hud.values;                       // the numbers shown last frame

// Steam panel ────────────────────────────────────────────────────────────────────
const panel = new SteamPanel({ layout?, factory?, pixelRatio?, hz?, model?, vspeeds? });
if (panel.update(snapshot, dt)) steamTex.needsUpdate = true;

// Texture helpers (no Three.js types) ────────────────────────────────────────────
PANEL_TEXTURE_SIZE.g1000;  // { width: 1024, height: 768 } (screen); .g1000Bezel 1344×1008; .g1000Panel 2769×1008; .steam 1024×512
CANVAS_TEXTURE_SETTINGS;   // colorSpace srgb, generateMipmaps false, linear filters, anisotropy 8, toneMapped false
createCanvas(w, h);        // <canvas> in a browser, OffscreenCanvas in a worker, throws otherwise
```

Integrator recipe for one display:

```ts
const tex = new THREE.CanvasTexture(g1000.pfdCanvas as HTMLCanvasElement);
tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
tex.minFilter = tex.magFilter = THREE.LinearFilter;
tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
```

## G1000 interaction (G1000 NXi, docs/research/05 §2–4, §6)

```ts
const g = new G1000({ nav: sim.nav, planner: sim.planner, onCommand: (c) => applyG1000Command(c, host) });   // bezel: true; host: see Wiring
g.handleInput({ type: 'softkey', display: 'pfd', index: 4 });            // CDI
g.handleInput({ type: 'button', display: 'mfd', id: 'DIRECT' });         // D→, FPL, PROC, CLR, ENT, MENU, NRST, AFCS keys
g.handleInput({ type: 'knob', display: 'mfd', id: 'FMS', ring: 'outer', steps: +1 });
g.handleInput({ type: 'push', display: 'pfd', id: 'HDG' });              // knob push (sync, 1-2, CRSR, centre)
g.handleInput({ type: 'wheel', display: 'pfd', id: 'ALT', ring: 'inner', deltaY: -100, deltaMode: 0 });
g.handleInput({ type: 'char', char: 'K' });                              // typed ident entry ('\b' = backspace)
g.bezelHitRegions.pfd;            // HitRegion[] in canvas px: rects (softkeys, keys) and circles (knobs, rInner for dual rings)
g.hitTest('pfd', x, y);           // → { control, ring } | null      (canvas px of that display)
g.click('mfd', x, y); g.wheel('pfd', x, y, deltaY, { deltaMode, outer: e.shiftKey }); g.hover('pfd', x, y);  // tooltip + highlight
g.wantsKeyboard; g.keyboard(e.key);   // while an ident field is open: letters/digits, Backspace, Enter = ENT, Escape = CLR
g.takeCommands();                 // requests queued when no onCommand callback is set
const panel = new G1000Panel(g);  // one 2769×1008 texture: panel.compose() after g.update(); panel.click(uv.x, uv.y) …
```

**Bezel** (`bezel.ts`, drawn into each canvas around the screen at (160, 64)): left — NAV VOL,
NAV transfer key, dual NAV knob (outer MHz, inner 50 kHz, push NAV1/NAV2), HDG (push sync), AFCS
keys AP/FD, HDG/ALT, NAV/VNV, APR/BC, VS/FLC, NOSE UP/DN, dual ALT SEL (outer 1 000 ft, inner
100 ft); right — COM VOL, COM transfer key, dual COM knob (outer MHz, inner 25 kHz, push
COM1/COM2), dual CRS/BARO (inner course, outer altimeter, push centre), RANGE, D→/MENU, FPL/PROC,
CLR/ENT, dual FMS (outer page group / field, inner page / character, push cursor); 12 softkeys
under the screen (each region covers the on-screen label and the key). The unit is 4:3, so the
side-by-side panel keeps the cockpit mesh's 0.96 × 0.35 m aspect.

**Pages and windows** (`fms.ts` routes, one class per window):

| Where | What | Keys |
|---|---|---|
| MFD page groups | MAP (navigation map) · FPL (active flight plan) · NRST (airports, VOR, NDB) | FMS outer = group, inner = page (cursor off); indicator bottom right |
| D→ window (MFD popup / PFD window) | ident field with spell'n'find completion, nearest-match list (airports, VOR, NDB from `NavDb.searchIdents`), name, BRG/DIS, ACTIVATE? | inner = character, outer = cursor (or field), typing; ENT accept / ENT activate; duplicate idents → pick from the list; MENU → CANCEL DIRECT-TO NAV; prefilled from the FPL/NRST cursor |
| FPL page / PFD FPL window | waypoints with DTK (mag), DIS, ETE; active leg magenta with leg arrow (its DTK is the planner's along-track DTK, as in the nav status bar), past grey; total | push = cursor; outer = row; inner/typing = insert before the row (last row appends); CLR → REMOVE?; MENU → ACTIVATE LEG / DELETE FLIGHT PLAN / CANCEL D→; ACT LEG softkey; D→ = direct to the row |
| NRST page / PFD NRST window | 25 nearest airports: BRG, DIS, longest runway, TWR/CTAF, ILS flag; selected airport's frequencies; VOR/NDB lists | inner = row, outer = frequency list; ENT = D→ (airport) / COM1 standby (frequency) / NAV1 standby (VOR) |
| PROC window | SELECT APPROACH at the destination (else D→ airport, else nearest; re-spellable), ILS list, LOAD? / ACTIVATE? | LOAD: FFxx/RWxx fixes appended, LOC into NAV1 + course, CDI switches GPS → LOC on the final; ACTIVATE: also D→ FAF and CDI → NAV1 |
| PFD TMR/REF, ALERTS | timer START/STOP/RESET, V-speed bugs ON/OFF, BARO minimums (bug + box); active alerts | outer = field, inner = value, ENT |

PFD softkeys: INSET (inset map, RANGE knob; OFF, DCLTR), PFD (DFLTS, WIND opt 1/2/off, DME, BRG1,
BRG2, STD BARO), OBS (GPS OBS course on the CRS knob), CDI (GPS → NAV1 → NAV2), DME, XPDR (STBY,
ON, ALT, VFR, CODE digit entry, IDENT), IDENT (18 s), TMR/REF, NRST, ALERTS. MFD: MAP (orientation),
DCLTR (0–3), ACT LEG (FPL), APT/VOR/NDB (NRST). Other keys carry their NXi labels and do nothing.

**Commands** (`G1000Command`, to `onCommand` or `takeCommands()`): `navStandby`/`navActive`
{radio, kHz}, `navSwap`, `navCourse` {radio, courseDeg mag}, `comStandby` {radio, kHz} (the G1000's
own `com1/com2` already changed), `comSwap`, `cdiSource` {source, navSource: 'gps'|'nav1'|'nav2'}
(also once on the first update), `action` {SimAction, count} (AFCS keys, HDG `headingBugInc/Dec`
+ `apHdgSync`, ALT `apAltInc/Dec` ×1 / ×10, BARO `altimeterInc/Dec`, NOSE UP/DN `apVsInc/Dec` or in
FLC `apIasDec/Inc`), `baroStd`, `xpdr` {code, mode, ident}. NAV frequencies and courses are read
back from `snapshot.nav1/nav2` every update (several detents within one frame accumulate).

**Wiring** (`wiring.ts`, structural types only, no `src/app` import): `applyG1000Command(c, host)`
applies one command to a `G1000Host` and returns false when the host has nothing to apply it to:

| Host member | Simulator source | Commands |
|---|---|---|
| `navTuning` | `sim.radios.tuning` (kHz, OBS deg) | `navStandby`, `navSwap`, `navCourse` (and `navActive` without `tuneNavActive`) |
| `tuneNavActive(i, kHz)` | `sim.radios.tuneNav` (immediate station lookup, ILS auto-course) | `navActive`, `navSwap` |
| `com1` | `sim.radios.state.com1` (MHz) | `comStandby`/`comSwap` radio 1 (COM2 exists only on the G1000) |
| `setNavSource(src)` | `sim.autopilot.setNavSource` | `cdiSource` |
| `action(a)` | `sim.input.applyAction` (the steam panel's knob path, next frame) or `sim.handleAction` | `action` (repeated `count` times) |
| `setAltimeterStd()` | `sim.fdm.setAltimeter(101325)` | `baroStd` |
| `transponder(code, mode, ident)` | ATC, optional | `xpdr` |

`syncCom1(g.com1, sim.radios.state.com1)` copies the stack's COM1 (e.g. after a keyboard swap or
an ATC handoff) into the G1000's COM1 box; call it before `g.update()`. `wiring.test.ts` runs the
whole recipe against the real `RadioStack` and `GfcAutopilot`.

**Lifecycle**: `nav` / `planner` may be omitted (or bound later with `setNavDatabase` /
`setPlanner`): D→, NRST and PROC then open with empty lists and FPL shows no plan, nothing
throws. `reset(snapshot)` (new flight, panel swap) closes every window and softkey sub-menu,
returns the MFD to the MAP page and re-announces the CDI source (`cdiSource`) on the next update.

**Cockpit routing** (integrator): ray-cast the G1000 panel mesh and pass the hit UV to
`G1000Panel.hover/click/wheel`; consume the DOM event when they return true (the wheel then does
not zoom the camera). Pass `e.deltaY || e.deltaX` as the wheel delta (Chromium turns Shift+wheel
into `deltaX` on Windows/Linux) and `outer: e.shiftKey`. While `g.wantsKeyboard`, offer each key
to `g.keyboard(e.key)` before the key bindings (capture phase) and stop it when that returns true.
Wheel up = clockwise = increase; RANGE clockwise zooms out, as on the real unit.

**Flight plan**: every edit goes through the `FlightPlanner` (`insert`, `remove`,
`directToWaypoint`, `cancelDirectTo`, `activateLeg`, `setObs`, `clear`), so `snapshot.plan`, the
autopilot's GPS/NAV source and the HSI follow on the next frame. Off-route D→ keeps the stored
plan (FPL shows it with "D→ KOAK"); the map draws D→/OBS legs from `plan.legFrom`.

**Render cost**: the UI state folds into the change hash (`fms.version`, which also follows
`planner.version`, so plan edits made elsewhere redraw both displays at once), windows with live
values add the aircraft position at ~0.05 nm, the inset map at half a pixel; labels come from
`LabelCache`s and list strings are built when data changes (NRST refresh every 2 s), never per
frame. The bezel is painted once (again only on hover changes or `invalidate()`).

Sharing one `InstrumentModel` between the steam panel and the G1000: pass `model` to the G1000
and call `model.update(snapshot, dt)` yourself before `g1000.update()` (a G1000 never steps a
model it does not own, so the lags are not advanced twice).

## How it works

* **Readings** (`readings.ts`): `InstrumentModel.update(snapshot, dt)` turns `AircraftState` into
  `InstrumentReadings` (one object, mutated in place): pitot-static and Kollsman altimetry, VSI
  lag, vacuum gyros with spin-up/erection/drift, turn coordinator and ball, magnetic compass
  errors, engine-gauge lags, electrical/vacuum/fuel systems, annunciators, wind, trends, clock.
  Glass displays use the AHRS truth (`ahrs`, `heading.magDeg`) and the air-data vertical speed
  (`adcVsFpm`, τ 1 s); the steam gauges use the gyros and the steam VSI (`vsiFpm`, τ 2.5 s).
  Power comes from `AircraftState.electrical` when the flight model provides it (bus volts,
  `avionicsPowered`, `mainPowered`, LOW VOLTS, battery/alternator amps); otherwise a fallback bus
  model honours `masterBattery`/`masterAlternator`/`avionicsMaster`. DG drift, hour meters and
  annunciator hold timers stop while `snapshot.paused` (also set during replay); display lags keep
  running so needles follow a replay. Filters, gyros and the compass hold their state through a
  non-finite FDM sample instead of latching NaN.
* **Design space**: each G1000 display is drawn in a fixed 1024×768 layout
  (`g1000/palette.ts` `PFD`/`MFD`) and scaled to the backing store with `setTransform`.
* **PFD** (`g1000/pfd.ts`): full-width attitude with pitch ladder, roll scale, slip bar and
  single-cue FD; airspeed tape (bands, V-speed bugs, 6 s trend, TAS), altitude tape (selected
  altitude, baro, trend, glideslope), VSI; HSI (`hsi.ts`: rotating rose, turn-rate scale with 6 s
  trend vector → arrowhead above 4°/s, heading bug, BRG1/BRG2 pointers, course pointer + CDI +
  TO/FROM in the source colour, HDG/CRS boxes); NAV/COM boxes (`radioBoxes.ts`), navigation status
  and AFCS boxes (`afcsBox.ts`: active green / armed white, 10 s flash on mode change, red AP
  flash for 5 s after a disconnect); wind/GS/OAT/XPDR/UTC/timer/DME/BRG info and marker beacons
  (`infoBoxes.ts`); alerts window and ALERTS softkey (`alerts.ts`).
* **Nav sources** (`g1000/navData.ts`): `resolveCdi`/`resolveBearing` map `nav1`/`nav2`/`plan`
  into what the HSI shows. GPS: course = plan DTK converted to magnetic, deviation =
  −crossTrack / full scale (ENR 2.0 nm, TERM 1.0 nm within 31 nm of the first/last waypoint).
  VOR/LOC: OBS course, `cdi` as given (+ = fly right), `dmeValid` honoured when present.
* **MFD** (`g1000/mfd.ts`): GS/DTK/TRK/ETE data fields, engine strip (`eis.ts`: RPM arc, FFLOW,
  OIL PRES/TEMP, EGT, VAC, FUEL QTY L/R, ENG HRS, bus volts and battery amps with POH bands) and
  the moving map (`map.ts`: local equirectangular projection from `geo.ts`, range ring + dashed
  half ring with compass ticks, plan legs magenta/white/grey, waypoint symbols, nearest airports,
  1-minute track vector, wind arrow, north pointer, orientation and range labels).
* **Redraw policy** (`G1000.update`): instrument dynamics step every call; each display is due at
  most `pfdHz`/`mfdHz` times per second; when due, a 32-bit hash of everything it shows, quantised
  to about half a pixel (`displaySignature.ts`, `signature.ts`), is compared with the previous one
  and the draw (and the texture upload) is skipped when equal. A redraw is forced every `maxIdleS`
  so a hash collision can never freeze a display. Parked or in a steady cruise the PFD drops from
  30 Hz to about 1 Hz (the UTC clock).
* **No per-frame allocation** in the draw paths: readouts go through `LabelCache` (memoised
  number → string), fonts through `FontCache` / the memoised `gaugeFont`, scratch objects are
  owned by the renderers (G1000, HUD and the steam panel's clock, Kollsman, tach and radio stack).
* **HUD** (`Hud.ts`, `hud/`): truth values from the snapshot with short display lags (IAS 0.12 s,
  VS 0.6 s); top strip (IAS/GS, ±30° heading tape with bug, ALT/VS/AGL), AP mode line, flags
  (CRASHED, STALL flashing, OVERSPEED, OVER-G, FLAP/GEAR SPEED, LOW FUEL, PAUSED, SLEW), bottom
  controls strip (THR, MIX, FLAPS, TRIM, GEAR, BRAKE/PARK) and the terrain-loading bar while
  `snapshot.terrainReady < 1`. In the cockpit camera only flags and status are shown. The scale
  follows the viewport height (1 at 600 CSS px) but shrinks so the top strip always fits the
  width (portrait phones); the status box stacks above the controls strip when space is short.

## Tests (`npx vitest run src/instruments`)

* `readings.test.ts`, `format.test.ts`, `gauges/gauges.test.ts`: altimetry, lags, gyros, turn
  coordinator, compass, systems, formatting, every steam gauge draws, static-layer caching.
* `g1000/hsi.test.ts`: nav-source resolution (VOR, invalid NAV, GPS DTK/XTK sign and TERM/ENR
  scale, no plan, bearing pointers, localizer), HSI draw, **+cdi (fly right) puts the bar right of
  centre**, reversed course pictorial sense, heading wrap 359 → 001, trend arrowhead, red X.
* `g1000/widgets.test.ts`: every PFD widget draws without throwing and with balanced
  save/restore for the sample and edge cases (AP/FD off, NAV invalid, plan null, negative VS,
  heading wrap, ILS, engine off on the ground, extreme attitude, FLC, NaN/∞/out-of-range plan
  data); AFCS labels/reference/flashing; alert priority and softkey; wind options; NAV box;
  `dmeValid`, back course and marker beacons.
* `g1000/fms.test.ts` (real `NavDb` + `FlightPlanner`): D→ typed and knob-spelled, VOR via the
  duplicate list, NDB, off-route D→ keeps the plan, MENU cancels, snapshot plan and HSI follow;
  FPL with 11 waypoints (active magenta, past grey), DTK/DIS values on a long great-circle leg
  (active row = along-track DTK of the status bar), insert/append/remove, ACTIVATE LEG (menu and
  softkey), D→ from the cursor, DELETE FLIGHT PLAN, PFD FPL window.
* `g1000/fmsControls.test.ts`: NRST airports/VOR/NDB lists, D→ and frequency loading from the
  list (the G1000's COM1 box follows); PROC ILS ACTIVATE (fixes, NAV1 frequency + course, CDI →
  NAV1) and LOAD (auto GPS → LOC switch, fixes replaced on reload); every implemented PFD/MFD
  softkey; the CDI source re-announced after `reset`; NAV/COM tuning steps and
  focus, swaps, HDG/ALT/BARO/CRS knobs and AFCS keys as commands, MFD page groups, RANGE, queue
  without `onCommand`, keyboard routing.
* `g1000/bezel.test.ts`: every control has one region, region centres hit their control, dual
  knob rings, softkey cells, scaling and `bezel: false`; wheel detents (px/lines/pages, trackpad
  accumulation, cap) and `G1000.wheel`; clicks and hover; `G1000Panel` layout, UV mapping, gap,
  compose only on change.
* `g1000/pages.test.ts`: 20 page/dialog scenarios draw without throwing with balanced
  save/restore and show their title; stacked menus/confirms; dead bus; idle displays with a
  window open are not redrawn; a plan edit made outside the G1000 redraws the PFD FPL window at
  once; softkey menu shapes and inert keys.
* `g1000/wiring.test.ts`: `applyG1000Command` maps every command onto a host and reports missing
  targets; end to end with the real `RadioStack` + `GfcAutopilot` + `FlightPlanner`: NAV knob
  detents reach the standby frequency, COM wheel tuning, PROC ILS ACTIVATE tunes the localizer
  and switches the autopilot to NAV1, CDI softkey → NAV2 → GPS, AFCS key and HDG wheel actions.
* `g1000/G1000.test.ts`: first `update` returns true and a second within 33 ms returns false;
  ≤ 30 Hz cadence; unchanged frames skipped; forced refresh after `maxIdleS`; CDI cycling; MFD
  content (EIS, data fields, legs, airports, range); nav-database airports; zoom steps; track-up;
  shared model not stepped; backing-store scaling; dispose. Map projection orientation.
* `Hud.test.ts`: resize to CSS × dpr, update does not throw, content in external views,
  cockpit mode hides flight data but keeps flags and terrain loading, redraw cap and change
  skipping, hide/show, warnings and status hook, dispose; tape labels, flaps/gear text, scaling.

* `review.test.ts` (adversarial review): FD cue banks toward the command; pitch ladder to ±80°;
  rolling digits continue the tape (larger values above); compass acceleration error (ANDS) and
  reversed wet-compass card; Euler heading rate for the trend vector; glass vs steam VSI lag;
  NaN-sample recovery; no DG drift / hour-meter advance while paused; FDM electrical (avionics
  master off → black screens, LOW VOLTS, dead bus) and the master/avionics switch fallback;
  EIS M BATT = battery current; SteamPanel keeps 30 Hz at 40 fps.

The layout was also checked visually by rendering the PFD, MFD and HUD in headless Chrome.

## Known limitations

* FPL DTKs of all legs are converted to magnetic with the variation at the aircraft (the real unit
  uses each leg's own variation; ≤ 1–2° apart within a few hundred nm).
* GPS CDI scaling has ENR/TERM only (no DPRT/APR/LPV ramps; the `FlightPlan` contract carries no
  approach phase). No VNAV, holds, SUSP, user waypoints, airways, departures/arrivals or RNAV
  approaches: PROC offers the (synthetic) ILS of each equipped runway end with two fixes.
* Not simulated (keys labelled, inert): SYN VIS, HSI FRMT, ALT UNIT, WX/TRAFFIC/TERRAIN/NEXRAD,
  ENGINE/LEAN/SYSTEM pages, charts, checklists, VNV, BC, RANGE push (pan), the volume knobs; the
  MFD has no WPT/AUX page groups. The cursor highlight does not flash.
* The moving map has no terrain/topo shading, airspace, roads or runway-shaped airport icons
  (the nearest-airport input has no runway data), and uses an equirectangular projection
  (schematic beyond ~100 nm). Labels are not decluttered beyond a range threshold.
* COM radios, transponder code/mode and the DME source live on the `G1000` instance because the
  `SimSnapshot` has no COM/XPDR state (see proposed contract changes).
* Bearing pointers support NAV1/NAV2/GPS (no ADF). The marker annunciator is static (no keying).
* The G1000 has no failure injection beyond what `InstrumentReadings` reports (dead bus → black
  screens, AHRS invalid → red X over the full-width attitude and the HSI).
* Panel dimming (`inputs.lights.panel`) and night palettes are not applied to the glass displays.
* When the PFD and MFD are composited into one texture, use `g1000.changed.pfd/mfd` to blit only
  the display that changed.
* Fonts: the canvas uses the CSS stacks in `canvas.ts`; load "Roboto Condensed"/"Roboto Mono"
  with `document.fonts.load` before the first draw or a fallback face is used.
* Both G1000 screens are powered by the avionics bus (`avionicsPowered`). In the real 172S the
  PFD runs from the essential bus with the master switch alone; `ElectricalState` has no such bus.
* The steam panel redraws (and its texture uploads) at `SteamPanel.hz` without change detection.
* Time compression: the instruments get the frame `dt`, so DG drift and the hour meters advance
  at wall-clock rate, not at the compressed sim rate (they do stop while paused).
* The AI's erection and roll-precession errors are always to the right (the spec uses |p|); the
  GPS TERM scale switches 2 → 1 nm without the 1-nm ramp; the glideslope indicator shows NAV1's
  glideslope when the CDI source is GPS; the wet-compass float tilt (0.35 rad/g) is a tuning value.

## Tuning knobs

* Redraw: `G1000.pfdHz` (30), `mfdHz` (15), `skipUnchanged` (true), `maxIdleS` (1 s);
  `Hud.hz` (30), `SteamPanel.hz` (30). Quanta per value in `g1000/displaySignature.ts`.
* Resolution: `G1000Options.width/height` (backing store; design space stays 1024×768),
  `SteamPanel` `pixelRatio`, `Hud.uiScale` (on top of `hudScale(viewport)`).
* Layout and colours: `g1000/palette.ts` (`G`, `PFD`, `MFD`), `HSI`, `INFO`, `STATUS`, `RADIO`,
  `ALERTS_RECT`, `EIS`, `MAP` objects in their widget files; `hud/primitives.ts` `HUD_COLORS`.
* Behaviour: `GPS_CDI_SCALE_NM`, `TERMINAL_RADIUS_NM` (navData), `MODE_FLASH_S`,
  `AP_DISCONNECT_FLASH_S`, `FLASH_PERIOD_S` (afcsBox), `WIND_MIN_TAS_KT` (infoBoxes),
  `MAP.labelRangeNm`, `MAP.minTrackGsKt`, `MAP.rotatedCy` (map), `HSI.trendMaxDeg`/`arrowRateDegS`.
* Aircraft: `VSpeeds` (`c172.ts` `C172S_VSPEEDS`) for tape bands/bugs; gauge markings in `c172.ts`;
  instrument dynamics in `defaultInstrumentConfig()` (lags, gyro drift, low-fuel threshold, …).
