# src/activities — lessons, bush trips, landing challenges

MSFS-style activities (docs/research/01 §10): **Flight Training** lessons with an instructor,
a multi-leg **bush trip**, and the existing **landing challenges**. Everything here is pure
TypeScript (no DOM, no Three.js, no `Date.now`/`Math.random`): time only advances through
`update(dt)`, so the whole module is unit-tested with synthetic and scripted flights.

| File | What it is |
|---|---|
| `objectives.ts` | Objective engine: data-driven conditions and objectives, compiled once, evaluated each update without allocating |
| `activityTypes.ts` | `ActivityDef` / `StepDef` / `ActivityResult` and the **`ActivityHost`** contract the simulator implements |
| `lessons.ts` | The three lessons (Basic flight controls, Takeoff, Landing) and the verified runway specs `KSFO_28R`, `KHAF_30` |
| `bushTrips.ts` | The Pacific Coast bush trip (8 legs) and `bushLegActivity()` that turns a leg into an `ActivityDef` |
| `ActivityRunner.ts` | Runs one activity: spawn via the host, steps, cues, hints, debrief; emits the `activity:*` events |
| `progressStore.ts` | Saved progress (legs unlocked in order, lesson best scores) over an injectable storage |
| `speech.ts` | Number formatting for subtitles ("3,500 ft") and spelling for TTS ("three thousand five hundred feet") |
| `index.ts` | Public API barrel (everything except the test kit) |
| `landingChallenges.ts`, `landingScore.ts`, `TouchdownDetector.ts`, `runwayFrame.ts`, `ReplayRecorder.ts` | Landing challenges, scoring, touchdown detection, runway geometry, replay (pre-existing, APIs unchanged; `runwayFrame.aimAlongM` added) |
| `activityTestKit.ts` | **Test only** (uses `node:fs`): synthetic states, a kinematic scripted aircraft, a recording host, a public/data loader |

Units: specs are authored in aviation units with the unit in the field name (`altFt`, `iasKt`,
`minFpm`, `radiusM`, `headingDeg`) and converted to SI once when compiled; `AircraftState` is SI.
Spawn headings are **true**; heading conditions default to **magnetic** (what the heading
indicator shows), turn objectives are relative and wrap-safe at 360/000.

## Activity catalogue

### Flight Training lessons (`LESSONS`)

Written for the C172S with the POH numbers in docs/research/02 §9-10 (Vr 55, Vy 74 KIAS, final
60-65 KIAS with flaps 30°). Instructor lines carry a subtitle `text` and a TTS `speech` with every
number spelled out; tests check that no speech line contains a digit.

| id | Start | Steps (objective, tolerance) |
|---|---|---|
| `lesson-basic-flight` "Basic flight controls" | Air start 8 nm west of KHAF over the Pacific, 3,000 ft MSL, 100 KIAS, wings level, true heading chosen so the indicator reads **090** (≈103° true, WMM 2026.5), clear, morning | 1 straight and level: hold 3,000 ±100 ft, heading 090 ±10°, bank ≤10° for 20 s · 2 climb: reach 3,500 ±60 ft, 200-1,200 fpm and heading ±15° coached · 3 level off: hold 3,500 ±100 ft and ±200 fpm for 10 s · 4 standard-rate turn right 90° with 10-22° of bank, ±150 ft, roll out ±10° · 5 the same to the left · 6 descend to 3,000 ±60 ft at 200-1,000 fpm · 7 trim: hold 3,000 ±100 ft, ±150 fpm, pitch input ≤0.05 (hands off) for 10 s |
| `lesson-takeoff` "Takeoff" | Lined up on **KSFO 28R** (parking brake set), few clouds, morning; a reset at KSFO restarts it | 1 checks: parking brake released, mixture ≥0.95, flaps 0-10° · 2 roll: full power (≥0.95); within 10 m of the centreline until 20 ft AGL (fails after 5 s outside); rotate between 48 and 65 KIAS, target 55 (strict: outside fails) · 3 climb at Vy 74 ±5 KIAS to 500 ft AGL · 4 flaps up · 5 climb to 1,500 ±100 ft at 74 ±5 KIAS · 6 level at 1,500 ft (±100 ft, ±200 fpm, 10 s) |
| `lesson-landing` "Landing" | 3 nm final to **KHAF 30**, on the 3° path to the aim point (≈1,057 ft MSL), 65 KIAS, flaps 20°, few clouds, morning | 1 final: flaps 30° by 1 nm (fails otherwise), 60-65 KIAS and the 3° glidepath ±0.7° (20 ft floor) until 100 ft AGL · 2 flare and touch down on KHAF 30 inside the touchdown zone (233-683 m past the pavement threshold, i.e. from the displaced threshold) with a landing score ≥4,000 from the existing scorer |

The glidepath uses `runwayFrame.aimAlongM()` (displaced-threshold-aware aim point: 383 m for KHAF
30). Both runways are copied from public/data and verified by `lessons.test.ts`.

### Bush trip: Pacific Coast, Half Moon Bay to Santa Barbara (`PACIFIC_COAST`)

Eight legs in the C172 between small and medium airports that exist in public/data. Every leg is
15-45 nm **both direct and flown through its landmarks**; every landmark is a real feature within
12 nm of the direct course and between the two airports; the suggested cruise is at least 1,000 ft
above the highest charted terrain near the route; the departure runway has a headwind in the
leg's weather preset (all presets blow from 280°).

| Leg | From → to | Dep. rwy | Direct / route | Cruise | Landmarks | Highest terrain |
|---|---|---|---|---|---|---|
| 1 | KHAF Half Moon Bay → KRHV Reid-Hillview | 30 | 34.3 / 35.4 nm | 3,500 ft | Crystal Springs Dam, Hoover Tower | Skyline ridge ~2,400 ft |
| 2 | KRHV → KWVI Watsonville | 31R | 23.9 / 36.6 nm | 5,500 ft | Loma Prieta, Santa Cruz Beach Boardwalk | Loma Prieta 3,786 ft |
| 3 | KWVI → KMRY Monterey | 27 | 21.1 / 25.6 nm | 2,500 ft | Moss Landing stacks, Point Pinos Lighthouse | Jacks Peak 1,068 ft |
| 4 | KMRY → KKIC King City (Mesa Del Rey) | 28L | 41.0 / 41.9 nm | 5,500 ft | Laguna Seca Raceway, Mission Soledad | Sierra de Salinas ~4,500 ft |
| 5 | KKIC → KPRB Paso Robles | 29 | 41.1 / 44.0 nm | 3,500 ft | Nacimiento Dam | Santa Lucia foothills ~2,500 ft |
| 6 | KPRB → KSBP San Luis Obispo | 31 | 26.2 / 35.7 nm | 4,500 ft | Morro Rock, Bishop Peak | Santa Lucia Range ~3,000 ft |
| 7 | KSBP → KLPC Lompoc | 29 | 35.3 / 37.5 nm | 3,500 ft | Pismo Beach Pier, Point Sal | Casmalia Hills ~2,000 ft |
| 8 | KLPC → KSBA Santa Barbara | 25 | 34.2 / 44.5 nm | 3,500 ft | Point Conception Lighthouse, Gaviota State Park | Gaviota Peak 2,458 ft |

Each leg becomes an activity with two steps: **depart** (reach 500 ft AGL; quiet, except one
reminder if power is applied against a set parking brake) and **en route** (overfly each landmark
within 1.5 nm, optional; land at the destination, optional, graded by the landing scorer, landings
elsewhere ignored; **land and stop** within 2.5 km of the destination's reference point for 2 s,
required). Stopping at another field coaches "This isn't Reid-Hillview: take off and continue to
KRHV" and the leg carries on. The route (departure, landmarks at the cruise altitude, destination)
is loaded into the flight plan and cleared when the leg ends. Legs unlock in order and resume at the
first incomplete one (`ProgressStore.nextLeg`). `bushLegActivity(trip, i, { fuelFraction })` starts
a leg with the fuel left from the previous one if the UI wants MSFS-style fuel continuity (the
store records `fuelKg` at the end of each completed leg).

### Landing challenges (`LANDING_CHALLENGES`)

Unchanged: spawn on final at famous / epic / strong-wind runways, graded by `TouchdownDetector`
+ `scoreLanding` (`landing:scored`, 0-10 000). The Simulator runs them via `startChallenge(id)`.

## Objective engine (`objectives.ts`)

A **condition** is an instantaneous test with a normalised error (0 on target, 1 at the tolerance
edge) and a short live hint; an **objective** combines conditions with time. Specs are plain data;
`compileObjective(spec)` builds an evaluator once per step activation; `update(ctx)` never
allocates. Every objective exposes a live `view` (`state` pending/active/done/failed, `progress`
0..1, `hint`, `score` 0..1, debrief `note`) and supports `failIf` (deadline conditions, e.g.
"flaps 30 by 1 nm"), `timeoutS`, `failText`, `optional` and a one-shot `doneLine`.

| Condition `c` | Parameters | Live hint |
|---|---|---|
| `altitude` | `ft`, `tolFt`, `ref` indicated (default) / msl | Too low: climb to 3,000 ft / Too high: descend… |
| `altitudeBand` | `minFt?`, `maxFt?` | Climb above… / Descend below… |
| `agl` | `minFt?`, `maxFt?`, custom hints | Climb to … above the ground |
| `heading` | `deg` or `offsetDeg` (relative to activation), `tolDeg`, `ref` mag (default) / true | Turn left/right to heading 090 (shortest way, wraps at 360) |
| `airspeed` | `minKt?`, `maxKt?` (IAS), custom hints | Too slow: add power / Too fast: reduce power |
| `verticalSpeed` | `minFpm?`, `maxFpm?` | Climb a little faster… / Sinking too fast… |
| `bank`, `pitch` | `minDeg?`, `maxDeg?` (`bank` uses abs by default) | Level the wings / Too steep… |
| `parkingBrake`, `throttle`, `mixture` | `set` / `min?`, `max?` (0..1) | Release the parking brake / Full power… |
| `flaps` | `minDeg?`, `maxDeg?` (actual flap angle, ±0.5°) | Flaps down to 30° / Flaps up |
| `onGround`, `engineRunning`, `groundSpeed` | `value` / `minKt?`, `maxKt?` | Start the engine / Slow down… |
| `centreline` | `runway: RunwaySpec`, `maxM` | Left of the centreline: steer right |
| `glidepath` | `runway`, `angleDeg` (3), `tolDeg`, `minTolFt` | Below the glidepath: add power |
| `runwayDistance` | `runway`, `minNm?`, `maxNm?` (before the threshold) | — |
| `near` | `lat`, `lon`, `radiusM` | — |
| `controlsNeutral` | `maxPitch` (0.05), `maxRoll?` | Trim to relieve the control pressure |

| Objective `type` | Completes when | Score 0..1 |
|---|---|---|
| `hold` | `all` true for `forS` (excursions shorter than `graceS`, 1 s, pause the timer; longer ones reset it) | 1 − 0.6 × mean loss |
| `reach` | `all` true for `confirmS` (0.5 s); `during` conditions are coached and scored on the way; `progress` metric altitude/AGL/IAS | 1 − 0.5 × time out of `during` |
| `maintain` | `until` true; fails after `failAfterS` continuous seconds out of tolerance (if set) | 1 − mean loss |
| `turn` | heading changed by `byDeg` (+ right) with the bank in band, rolled out (|bank| ≤5° for 1 s) within `tolDeg` | 0.6 bank-in-band + 0.25 `during` + 0.15 rollout accuracy |
| `rotate` | nose up ≥`pitchDeg` (5°) on the ground or lift-off; outside `minKt..maxKt` fails when `strict` | 1 at the target, 0.5 at the band edge |
| `stopAt` | on the ground at ≤`maxKt` (1) for `stopS` (2 s) within `radiusM` of the airport, after having flown | 1 |
| `landing` | the next `landing:scored` ≥ `minScore` on `runway` / at `airport`, touchdown inside `zone`; `elsewhere: 'ignore'` skips other airports | landing score / 10 000 |
| `waypoint` | within `radiusM` (1 nm) of the point | 1 |

"Loss" uses a dead band (`scoreLoss`): flying within 40 % of the tolerance costs nothing, the loss
then ramps to 1 at the tolerance edge. Pass/fail never depends on it. A step's score is the mean
of its objectives; the activity score (0-100) is the mean over all objectives, graded Excellent ≥90,
Good ≥75, Satisfactory ≥55, else Needs practice (`Incomplete` when not passed); `passScore`
(default 0) can demand a minimum.

## Adding a lesson

1. Write an `ActivityDef` with `kind: 'lesson'` (see `lessons.ts`): a `setup` (`spawn: 'air'` with
   lat/lon, `altFt` MSL, true `headingDeg`, `iasKt`, `flapsIndex`, `gammaDeg`; or `spawn: 'runway'`
   with `icao` + landing-direction `runway`, plus an `anchor` at the field so a reset there restarts
   the lesson), optional `weather` / `time` presets, then `steps`.
2. Each step: `id`, panel `title`, an `instruction` `{ text, speech }` said once when the step
   starts, required and `optional` `objectives`, optional instructor `hints` (used in order, once
   each, when the pilot is off target), one-shot `cues` (`when` all true, e.g. "55 knots: rotate"),
   a `success` line, `hintDelayS` (default 4) and `quiet` (no coaching).
3. Spell numbers in `speech` ("one thousand five hundred feet", "runway two eight right"):
   `speech.ts` has `ftSpeech`, `ktSpeech`, `spellRunway`, `spellHeading`, `spellNumber`.
4. Runways come from public/data: copy the end tuple into a `RunwaySpec` and add it to the data test
   in `lessons.test.ts`. Prefer objectives that need an action (nothing that passes at t = 0 on the
   spawn state unless it is a check item), and give every waiting step a way out: a deadline
   (`failIf` / `timeoutS`) or a path that still completes after a go-around.
5. Append it to `LESSONS`; script it through in `lessons.test.ts` with `ScriptedAircraft` (plus at
   least one failure path).

## Adding a bush trip

Add a `BushTrip` to `BUSH_TRIPS` in `bushTrips.ts`: `airports` copied from public/data (reference
point `la`/`lo`, elevation `e`), then `legs` with `from`/`to`, a `departureRunway` that exists at
`from`, `cruiseFt`, `terrain` (highest charted terrain within ~3 nm of the route), 1-3 `waypoints`
(real landmarks, 3-6 letter idents, unique in the trip), a `briefing` `{ text, speech }`, `weather`,
`time`. `bushTrips.test.ts` then checks every airport and runway against public/data, legs 15-45 nm
direct and through the landmarks, landmarks within 12 nm of the course and in order, cruise ≥
terrain + 1,000 ft, a headwind on the departure runway, digit-free speech, and flies every leg end
to end with a scripted pilot, the runner and a real `TouchdownDetector`.

## The ActivityHost contract (`activityTypes.ts`)

The simulator side implements:

```ts
interface ActivityHost {
  spawnAtRunway(icao: string, runway: string, opts?: { coldAndDark?; fuelFraction?; payloadKg?; parkingBrake? }): void | Promise<void>;
  spawnInAir(lat: number, lon: number, altM: number /* MSL */, headingDeg: number /* true */, iasMs: number,
             opts?: { flapsIndex?; gammaRad? }): void | Promise<void>;
  setWeatherPreset(id: WeatherPresetId): void;
  setTimePreset(preset: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night'): void;
  loadRoute(waypoints: Waypoint[]): void;  // departure, landmarks (altConstraintM = cruise), destination
  clearRoute?(): void;
  speak?(text: string): void;              // TTS for instructor lines (already spelled out)
}
```

Order in `ActivityRunner.start(def)`: `setWeatherPreset` (runway choice may depend on the wind) →
await the spawn → `setTimePreset` (sunrise-relative presets need the new position) → `loadRoute` →
`activity:started` → first instruction. A spawn that rejects makes `start()` reject with the runner
idle and nothing emitted. The `flight:reset` that the spawn itself emits is ignored.

## ActivityRunner semantics

- `start(def)`, `restart()`, `abort(reason?)`, `restartStep()`, `update(dt, state, inputs)`,
  `dispose()`; read `phase` (`idle`/`starting`/`running`/`finished`), `def`, `step`, `stepIndex`,
  `objectives` (live `ObjectiveView`s for a panel), `liveHint`, `elapsedS`, `result` (`ActivityResult`).
- `update` ignores `dt ≤ 0`, NaN and ∞; time only advances through it, so nothing runs while the
  simulator is paused, in slew or in replay if it is called from the physics step.
- Events (SimEvents in src/core/types.ts):
  - `activity:started` `{ id, title, kind }` once, after the spawn.
  - `activity:instruction` `{ text, speech?, important }`: each step instruction once, each cue
    once, each objective `doneLine` once, the step `success` line, hints, and the closing debrief
    line. Instructions and cues are also spoken through `host.speak`; hints too unless
    `speakHints: false`.
  - `activity:progress` `{ id, step, objectives: [{ text, status, step, optional, progress }] }` only
    when an objective's status changes or a step begins/ends (never per frame); it lists every
    objective of every step (future steps `pending`).
  - `activity:finished` `{ id, success, score, summary }` exactly once.
- Hints: a hint is announced after `hintDelayS` (4 s) continuously off target, at most one every
  `hintIntervalS` (8 s), the same live hint not again within `hintRepeatS` (20 s); the step's
  coaching lines come first; a required objective's hint wins over an optional one's; `quiet` steps
  never coach.
- `landing:scored` feeds `landing` objectives (only landings after the objective activated count);
  `aircraft:crash` finishes the activity unsuccessfully (`Crash: <reason>`); `flight:reset` within
  `resetRadiusM` (5 km) of the activity's start (air spawn point or `setup.anchor`) restarts it at
  step 1 and reloads the route (a reset clears the flight plan), any other reset ends it
  (`Flight changed`). Starting another activity finishes the running one (`Replaced by another
  activity`); `abort()` while the spawn is pending cancels silently.
- Progress (`ProgressStore`): `recordStart` on start (attempts), `recordResult` on success (lesson
  best score; bush leg completed + best score + fuel + best landing score). Writes are best effort.

## Progress store (`progressStore.ts`)

One versioned JSON document (`flightsim.activities.progress.v1`) in an injectable
`KeyValueStorage` (default: `localStorage` when usable). Every access is in try/catch: corrupt JSON,
a wrong version or malformed records load as empty / dropped record by record (`loadedCorrupt`),
a throwing or full storage degrades to in-memory progress (`lastWriteFailed`), never a throw. API:
`isLegUnlocked`, `isLegCompleted`, `nextLeg`, `completedLegs`, `leg`, `resetTrip`, `lesson`,
`completeLesson`, `clearAll`.

## Integration (for the lead; nothing outside src/activities was changed)

1. **Host adapter** — new file `src/app/activityHost.ts`:

   ```ts
   import type { ActivityHost } from '../activities';
   import type { Simulator } from './Simulator';

   export function makeActivityHost(sim: Simulator, speak?: (text: string) => void): ActivityHost {
     return {
       async spawnAtRunway(icao, runway, opts = {}) {
         await sim.nav.load();
         const ap = sim.nav.getAirport(icao);
         if (!ap) throw new Error(`${icao} is not in the airport database`);
         await sim.nav.loadRegion(ap.position, 30);
         await sim.spawnAtRunway(ap, runway, { coldAndDark: opts.coldAndDark, fuelFraction: opts.fuelFraction, payloadKg: opts.payloadKg });
         if (opts.parkingBrake !== undefined) sim.input.controls.parkingBrake = opts.parkingBrake;
       },
       spawnInAir: (lat, lon, altM, headingDeg, iasMs, opts) => sim.spawnInAir(lat, lon, altM, headingDeg, iasMs, opts),
       setWeatherPreset: (id) => sim.setWeatherPreset(id),
       setTimePreset: (p) => sim.setTimePreset(p),
       loadRoute: (wps) => sim.planner.setWaypoints(wps),
       clearRoute: () => sim.planner.clear(),
       speak,
     };
   }
   ```

2. **Runner in the Simulator** (`src/app/Simulator.ts`): own one runner and step it with the
   touchdown detector, so a `landing:scored` emitted in a step is seen in the same step:

   ```ts
   readonly activities: ActivityRunner;          // field
   // constructor, after this.touchdown is created:
   this.activities = new ActivityRunner({ host: makeActivityHost(this, (t) => this.speakInstructor?.(t)), events: this.events, progress: new ProgressStore() });
   // physicsStep(h), right after `this.touchdown.step(h, s);`
   this.activities.update(h, s, this.input.controls);   // the pilot's raw inputs (trim / hands-off checks)
   ```

   `physicsStep` only runs when `inFlight && !paused && !replay && !slew`, which is exactly when
   activity timers should run. `speakInstructor?: (text: string) => void` is a new public field
   that main.ts sets once the audio system exists: `sim.speakInstructor = (t) => audio.speak(t, 'copilot')`
   (looked up lazily, so the runner can be built before the audio plugin is attached). Also: `setTimePreset` should re-run `applyPanelLightsForDaylight` (today
   only `beginFlight`/`startChallenge` do), otherwise a dusk leg starts with daytime panel lights.
3. **UI host** (`src/ui/UiHost.ts` + `src/app/uiHost.ts`): add
   `startLesson?(id)` → `sim.activities.start(lessonById(id)!)`,
   `startBushLeg?(tripId, legIndex)` → `sim.activities.start(bushLegActivity(tripById(tripId)!, legIndex))`,
   `abortActivity?()`, `restartActivityStep?()`, and `activityProgress?()` returning the runner's
   `ProgressStore` (or construct one `ProgressStore` in main.ts and pass it to both).
4. **Activities screen** (`src/ui/screens/Activities.ts`): tabs **Landing challenges** (as now),
   **Flight training** (cards from `LESSONS`: title, description, best score / completed badge from
   `store.lesson(id)`, Start), **Bush trips** (one card per `BUSH_TRIPS` entry with `completedLegs /
   legs.length`; a leg list from `navLog(trip, i)` and `legRouteNm` showing from → to, distance,
   cruise, landmarks, `terrain`; legs locked until `store.isLegUnlocked`, "Resume" starts
   `store.nextLeg`, "Reset trip" calls `store.resetTrip`).
5. **In-flight objectives panel** (new `src/ui/flight/ObjectivesPanel.ts`, a `FloatingPanel`):
   subscribe to `activity:started` (show, title), `activity:progress` (rebuild the list: current
   step's objectives with status icons, optional ones dimmed, progress bars from `progress`),
   `activity:instruction` (subtitle line at the bottom of the screen for ~6 s, longer when
   `important`), `activity:finished` (debrief card: success, score, `sim.activities.result.steps`
   with per-objective notes, buttons Retry → `sim.activities.restart()`, Next leg / Close). Poll
   `sim.activities.liveHint` each frame for a small "what to correct now" line. Add "Restart step"
   and "Abort activity" to the pause menu.
6. Optional: `window.__sim` automation (src/app/automation.ts) could expose `startLesson` /
   `startBushLeg` for scripted screenshots.

## Tests

`npx vitest run src/activities`: `objectives.test.ts` (every condition and objective: pass, fail,
progress, hints, wrap at 360/000, deadlines, scoring dead band), `lessons.test.ts` (runway data vs
public/data, set-up geometry, digit-free speech; each lesson flown through by a scripted aircraft
plus failure paths: crash, centreline drift, early rotation, late flaps, long landing, a go-around
that still completes), `bushTrips.test.ts` (data vs public/data and geography, all 8 legs flown end
to end with progress unlocking, wrong airport, reset restart, crash, far reset),
`ActivityRunner.test.ts` (event order, exactly-once, progress only on change, hint cadence bounds,
cues, dt guards, crash/reset/abort/restartStep, superseded and failing spawns, pass mark, fuel,
dispose), `progressStore.test.ts` (unlocking, best scores, corrupt and throwing storages),
`activities.test.ts` (runway frame, landing score, touchdown detector, replay, challenges).

## Known limitations

- The objective engine trusts the `ControlInputs` it is given: with the autopilot engaged a lesson
  can be flown by the autopilot (the runner does not see AP state). Slew mode can move the aircraft
  to a destination; the runner does not pause or flag activities during slew.
- Terrain clearance per leg uses charted spot heights rounded up, not the terrain tiles.
- A second `start()` while a spawn is still pending supersedes the first, but if the host lets the
  first spawn finish later the aircraft ends up at the first spawn: hosts should serialise spawns
  (the UI should disable Start while `phase === 'starting'`).
- `landing:scored` only fires on an identified runway, so a landing on grass or a taxiway at the
  destination completes a bush leg (stop at the field) without a landing grade.
