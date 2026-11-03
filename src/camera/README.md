# camera — MSFS-style camera system

One `THREE.PerspectiveCamera` driven by a `CameraController` that dispatches to a handler per
`CameraMode` (`cockpit`, `chase`, `external-orbit`, `drone`, `tower`, `flyby`, `wing`). All
smoothing is exact or exponential in `dt` (frame-rate independent), and updates allocate nothing.

Frames: everything here is in the Three.js render frame (x = East, y = Up, z = South). The
aircraft pose comes from `aircraft3d/frames.ts` (`nedToThreeVec`, `bodyQuatToThree`); compass
yaw is clockwise from north (north = −Z, east = +X).

## API

```ts
const cam = new CameraController(width / height, { aircraftLengthM: cfg.geometry.lengthM });
cam.update(dtReal, state, posThree, quatThree, inputSnapshot, model.eyePointLocal);
renderer.render(scene, cam.camera);
```

| Member | Purpose |
|---|---|
| `camera` | the `PerspectiveCamera` (far 600 km; near 0.05 m cockpit/wing, 0.5 m outside) |
| `state: CameraState` | mode, cockpit look offsets, orbit yaw/pitch/distance, FOV, drone pose (NED). Mutable; persist it if you like |
| `update(dt, aircraft, posThree, quatThree, input, eyePointLocal)` | one render frame; `dt` real seconds (NaN/negative → 0, capped 0.25 s) |
| `setMode(mode)`, `cycleMode(step)`, `mode`, `isCockpit` | switching starts the new mode from the current camera pose |
| `handleAction(action)` | `cameraCockpit/Chase/External/Drone/Tower/Next/Reset`, `zoomIn/Out`; called automatically for `input.actions` unless `consumeActions: false` |
| `zoomIn()`, `zoomOut()`, `setFov(deg)`, `fovDeg` | one zoom step = FOV ∓5° (cockpit/drone/wing) or distance ÷/× 1.1 (chase/orbit) |
| `recentre()` | smooth return of cockpit free-look to straight ahead (also `cameraReset`) |
| `setTowerPosition(p)` | fixed tower point (render frame); unset, it seeds 300 m left / 20 m up of the aircraft |
| `setDroneFollow(on)`, `droneFollow`, `setDroneSpeed(ms)` | drone formation mode; speed at full deflection |
| `shiftOrigin(delta)` | **call on every floating-origin rebase** with the render-frame shift (`new = old + delta`): moves tower, fly-by point, drone and look-at springs so nothing swings |
| `snapToAircraft()` | **call after a teleport / flight reset**: re-seeds the tower and jumps the active mode to its steady pose |
| `handleResize(aspect)` | ignored unless finite and > 0 |
| `positionThree()` | live camera position (for audio, LOD, terrain queries) |

`CameraOptions` (all optional) and `resolveCameraOptions` list every tuning knob (below).

## Input contract

| Input | Effect |
|---|---|
| `pointerDx/Dy` (px) | free-look / orbit / drone yaw-pitch, 0.0025 rad/px; mouse right = look right, down = look down |
| `axes.lookYaw/lookPitch` | same at 2 rad/s full deflection |
| `axes.cameraZoom` | **held rate axis**, −1..1, + = zoom in: FOV 40°/s or distance e-folding 1.2 /s while held |
| `zoomIn` / `zoomOut` actions | one step each (send one per wheel notch) |
| drone: `axes.pitch` | stick forward (pitch −1, docs/research/06) flies forward along the view (`forwardSign −1`) |
| drone: `axes.roll` | + strafes right |
| drone: `axes.throttle` | up/down relative to its value **when the drone was entered** (full speed at ±0.5 travel) |

The aircraft keeps flying in drone mode: the integrator should freeze or hand off the flight
controls while the drone uses the stick and throttle (the camera only reads the snapshot).

## Modes

- **cockpit**: eye point from the config, free-look yaw ±160°, pitch −60°/+80°; head orientation
  lags the airframe (τ 0.08 s); head displacement = 2nd-order spring (ωn 6 rad/s, ζ 0.7) per axis
  driven by the body specific force at 2 cm/g, each axis clamped ±5 cm (sinks under +g, swings
  aft on the take-off roll, sways against side force). Rolls with the aircraft.
- **chase**: behind and above (15°) along the horizontal velocity at 3 × aircraft length;
  critically damped springs on the offset (τ 0.35 s) and the look-at point (τ 0.15 s,
  velocity-led so steady flight is centred); 30 % roll follow; kept above the ground if
  `groundHeightThree` is given.
- **external-orbit**: drag to orbit relative to the smoothed heading, exponential inertia
  (τ 0.4 s, exact integral), pitch −10°..85°, distance 8–200 m.
- **drone**: free camera, see the input contract; follow mode keeps the offset in the aircraft
  heading frame and turns the view with the heading.
- **tower**: fixed point, look-at spring τ 0.3 s, auto-FOV so the aircraft's length is 4 % of the
  frame height (inside the 2–6 % target), clamped 2°–60°, smoothed τ 0.4 s.
- **flyby**: a point 400 m ahead and 50 m to the side of the track (alternating), re-seeded once
  the aircraft is 150 m past; mild auto-zoom.
- **wing**: fixed above the left wing looking at the cabin, fully attitude-locked.

## Tests

`npx vitest run src/camera`

- `smoothing.test.ts`: exponential smoothing and both springs are step-size independent; the
  critically damped spring trails a ramp by τ; ζ 0.7 overshoots by e^(−πζ/√(1−ζ²)); coast
  integral totals r₀τ at any frame rate; shortest-arc angle blend.
- `CameraController.test.ts`: yaw/pitch → quaternion mapping; cockpit view along the nose at
  heading 090 / pitch 10°, free-look to the right wing, roll banks the view; chase converges
  behind and above within 2 s, identical at 30 and 144 Hz, 30 % roll follow; orbit distance
  clamps (axis and actions), ×1.1 per step, frame-rate-independent inertia; drone axis
  directions, throttle neutral at entry, pointer yaw/pitch, follow mode; tower FOV monotonic in
  distance, 2–6 % framing, aims at the aircraft; origin shift without swing for every
  world-anchored mode; teleport re-seed; NaN dt / bad aspect; head model gain, clamp and
  overshoot; recentre.

## Known limitations

- No camera collision with terrain unless `groundHeightThree` is supplied (and none with buildings).
- Tower auto-FOV uses the aircraft length, not its projected size from the current aspect.
- Quickviews, instrument views, custom saved cameras, smart camera, and depth of field
  (docs/research/01 §6) are not implemented.
- The cockpit view always rolls with the aircraft (no horizon-lock option yet).

## Tuning knobs (`CameraOptions`, defaults)

`defaultFovDeg` 70, `minFovDeg` 30, `maxFovDeg` 90, `fovStepDeg` 5, `distanceStep` 1.1,
`fovRateDegS` 40, `distanceRatePerS` 1.2, `farM` 600 000, `nearCockpitM` 0.05,
`nearExternalM` 0.5, `pointerSensitivity` 0.0025, `lookRateRadS` 2, `recentreTauS` 0.12,
`cockpitYawLimitRad` 160°, `cockpitPitchMinRad` −60°, `cockpitPitchMaxRad` 80°,
`headLagTauS` 0.08, `gBobMPerG` 0.02, `gBobMaxM` 0.05, `headSpringOmega` 6,
`headSpringZeta` 0.7, `chaseDistanceM` 3 × length, `chaseElevationRad` 15°,
`chasePosTauS` 0.35, `chaseLookTauS` 0.15, `chaseRollFollow` 0.3, `orbitMinM` 8,
`orbitMaxM` 200, `orbitInertiaTauS` 0.4, `droneBaseSpeedMs` 20, `droneAxes`
(`forwardSign` −1, `verticalCentre` 'entry', `verticalRange` 0.5, `verticalDeadband` 0.03),
`towerFrameFraction` 0.04, `towerMinFovDeg` 2, `towerMaxFovDeg` 60, `towerFovTauS` 0.4,
`flybyAheadM` 400, `flybySideM` 50, `groundHeightThree`, `groundClearanceM` 1.5,
`consumeActions` true, `onModeChange`.
