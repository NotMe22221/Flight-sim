# `src/app` — the simulator and its wiring

`Simulator.ts` owns every subsystem and both loops (see docs/DESIGN.md, "Integration (as built)");
`plugins.ts` attaches the optional modules (UI, G1000, HUD, audio, ATC, scenery) through their public
APIs; `uiHost.ts` implements the UI contract (src/ui/UiHost.ts); `activityHost.ts` the activities'
`ActivityHost`; `automation.ts` installs `window.__sim`; `cockpitInteraction.ts` makes the steam
panel clickable.

## Aircraft (`aircraftCatalog.ts`)

| id | aircraft | airframe / panel |
|---|---|---|
| `c172s` | Cessna 172S Skyhawk | `C172S` from src/fdm, steam six-pack |
| `c172s-g1000` | Cessna 172S Skyhawk G1000 | the same airframe and flight model (every physical sub-object shared), `panel: 'c172-g1000'` |
| `pa18-150` | Piper PA-18-150 Super Cub | `PA18_150` from src/fdm, `airframe: 'cub'`, `panel: 'cub-steam'`, no autopilot |

`aircraftById(id)` (exact id, else the first id starting with it: `'c172'`, `'pa18'`),
`sameAirframe(a, b)`, `aircraftForActivity(family, current)` (keep the current aircraft when it
belongs to the family, else the family's first entry) and `radioCallsign(config)` (N172FS
"Cessna" / N18FS "Super Cub", matching the 3D liveries).

## Switching aircraft (`Simulator`)

```ts
sim.config;                     // the catalog entry being flown (172S, 172S G1000 or the Cub)
sim.selectAircraft(id): boolean // switch without respawning (false: unknown id, nothing changes)
await sim.setAircraft(id)       // switch, then restart the flight at its last spawn (automation)
sim.useAircraftFor(family)      // what activities and landing challenges use ('c172', 'pa18-150')
sim.onAircraftChange(cb)        // plugins rebuild what depends on the aircraft (ATC callsign)
sim.panelLayout;                // the current steam panel's layout (hit-testing, automation)
sim.hasAutopilot;               // false for the Super Cub
```

A different airframe (`!sameAirframe`) rebuilds, in this order: leaves replay and slew and clears
the replay buffer (its frames belong to the old airframe), cancels an engine auto-start; a new
`Fdm` (full fuel) with fresh `prev` / `interp` states (the snapshot's `aircraft` follows them);
removes and **disposes** the old `AircraftModel` and adds the new one; disposes the old
`SteamPanel` and its `CanvasTexture`, builds the new panel from `steamLayoutFor` / `panelSpecFor`
(src/instruments/panels.ts) and binds its texture to the new cockpit; sets the input's flap
detents (the Cub has three); builds `FlightAssists` from `assistsConfigFor` (the Cub gets the
anti-stall speed floor); resets the autopilot, stress monitor and touchdown detector; tells the
audio plugin (`setAircraft`: engine, propeller, tyres, stall horn, no flap motor for the Cub). Then
`config` changes, the panel follows the catalog entry (`setPanel('g1000')` only binds the glass
texture on the 172 airframe; the Cub keeps its steam panel), and the listeners run. 172S ↔ 172S
G1000 only swaps the panel. The camera reads the new model's eye point every frame.

The flight itself is not restarted: `UiHost.spawn` calls `selectAircraft(aircraftId)` and then
spawns; an activity's `useAircraft` runs before its spawn; `startChallenge` switches a Cub pilot to
the 172 (the challenges' speeds and flap settings are written for it); `setAircraft` respawns.

**No autopilot** (Super Cub): the autopilot is neither updated nor applied (it stays reset: no AP
or FD annunciations, no altitude alerter), and `AP_ACTIONS` (every AP / FD / YD key and the
heading bug) are ignored in `handleAction`.

## Cockpit clicks (`cockpitInteraction.ts`)

Ray-cast hits on the panel mesh map into `sim.panelLayout` through `hitTestPanel` (footprints use
each gauge's aspect). `KNOBS` covers both panels; the Super Cub adds the NAV/COM (upper row COM1:
wheel steps the standby by 25 kHz via `RadioStack.stepComStandby`, click swaps; lower row NAV1),
the transponder, voltmeter and warning-light tooltips, the magneto key (wheel OFF · R · L · BOTH,
click = engine auto-start), the master / radio rockers (left / right half), carb heat and primer.

## Automation (`window.__sim`)

Added for the second aircraft: `aircraftIds()`, `aircraftId()`, `setAircraft(id)`;
`panelPoint(id)` uses the current layout; `flyScriptedTakeoff` rotates at the aircraft's Vr and, on
a tail-dragger, first raises the tail with forward stick (≈ 2° nose-up above 15 KIAS).

## Tests

* `aircraftSwitch.test.ts` — the real `Simulator` in Node with the renderer, sky and 3D model
  faked (WebGL): catalog lookups; switching to the Cub rebuilds the flight model, model, panel
  (texture bound to the new cockpit, wrapping the new canvas), flap detents, assists and audio,
  and disposes the old model, panel and texture exactly once; unknown ids change nothing; 172S ↔
  G1000 keeps the airframe (steam fallback without a G1000 plugin; the glass texture re-bound to a
  rebuilt 172); the Cub ignores AP keys and never runs the autopilot; the replay is cleared and the
  new flight model flies (three-point attitude); activities and challenges pick their aircraft.
* `cockpitInteraction.test.ts` — every Cub panel item has a control or tooltip, the 172's knobs
  still map, NAV/COM rows, magneto key, master vs radio rocker, COM standby stepping and wrap.
* `damage`, `interpolate`, `loop`, `radios`, `slew`, `groundShift` tests as before.

## Known limitations

* The 3D model is rebuilt synchronously: about 1–3 s in the browser for a switch (the UI's
  loading screen covers it); models are not cached between switches.
* Switching rebuilds the flight model with full fuel; the UI's spawn then applies the chosen fuel
  and payload, `setAircraft` respawns with full fuel.
