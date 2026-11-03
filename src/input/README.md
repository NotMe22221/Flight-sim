# src/input — keyboard, mouse, gamepad and touch input

Turns every input device into one allocation-free `InputSnapshot` per frame and owns the
pilot's `ControlInputs` (contracts in `src/core/types.ts`). Bindings are data (JSON), rebindable
at runtime and persisted in `localStorage['flightsim.bindings.v1']`.
Spec: `docs/research/06-audio-and-input.md` Part B, `docs/research/01-msfs-feature-inventory.md` §15.

## API

```ts
import { InputManager } from './input';

const input = new InputManager(canvas, { flapDetents: aircraft.controls.flaps.detentsDeg.length });
// main loop (first thing in the frame)
const snap = input.poll(dt);           // same object every frame; actions/held refilled
const u = autopilot.apply(input.controls);
for (const a of snap.actions) sim.handle(a);   // camera, pause, AP, time, ATC … (controls already applied)
```

| Member | Purpose |
|---|---|
| `new InputManager(target, options?)` | `target` = canvas: the mouse listens **only** there (UI keeps its clicks); keyboard listens on `window`. Options: `window/document/navigator/storage` (injectable, `null` disables), `keyboardProfile` (`'default'`), `flapDetents` (4), `controls`, `rates`, `repeat`, `mouse`, `gamepad`, `touch`, `leverHoldoff` (2 s). |
| `poll(dt): InputSnapshot` | Samples all devices, arbitrates axes, applies actions to `controls`, returns the reused snapshot. `dt` clamped to 0..0.25 s. |
| `readonly controls: ControlInputs` | Pilot controls owned by the manager: pitch/roll/yaw (ramped, arbitrated), throttle/mixture/propeller levers, brakes (axes ∪ brakesHold ramp), flapsIndex (clamped to detents), gear, parking brake, lights, magnetos (wrap 0..3), starter (held), trims, heats, speedbrake. Discrete fields change only on actions, so the simulator may also write them (e.g. an auto-start sequence driving `starter`, `mixture`, `magnetos`). |
| `applyAction(action)` | Same code path as a key press (for UI buttons / `UiHost.dispatch`): controls change immediately, the SimAction is reported in the next snapshot. |
| `setCaptured(flag)` | A menu owns the keyboard: keys ignored (held keys released), gamepad actions other than `toggleMenu`/`pause` dropped, pointer deltas zeroed. |
| `setFlapDetents(n)` | Aircraft flap detent count; clamps `flapsIndex` to `0..n−1`. |
| `startListening(action, {device?, timeoutMs?})` | Rebinding: resolves with `{action, label, device, group, binding, displaced}` for the next chord / pad button / pad axis push, or `null` (Esc, timeout 8 s, another listen, dispose). Replaces that action's binding on that device and displaces the previous owner of the input. Persists. |
| `startListeningAxis(axis, dir?, opts?)` | Same for an axis (keys/buttons push towards `dir`; a pad axis moved the "positive" way is bound non-inverted; lever axes become unipolar). |
| `cancelListening()` | Resolves a pending listen with `null`. |
| `getBindingLabel(action, device?)` / `getBindingLabels` | `'Ctrl+E'`, `'Num 7'`, `'Pad A'`, `'Joy 3'`, `'Mouse Middle'`; prefers the last active device. `''` when unbound. |
| `bindingsList(): BindingRow[]` | One row per `SimAction`: `{action, title, group, label, labels, device}` — assignable to the UI's `BindingInfo`. |
| `controlsList(): ControlRow[]` | Axis directions (`axis:pitch:-1` …) and input-local actions with labels, for the help sheet. |
| `setProfile(id \| profile, deviceKey?)` / `resetProfile(id?)` | `'default'` (MSFS + laptop), `'msfs'`, `'laptop'`, `'gamepad-xbox'`, `'joystick-generic'` or a custom `BindingProfile`. `resetProfile()` with no id clears storage. |
| `conflicts()` | Inputs bound to two different targets in the active profiles. |
| `onDeviceChange(cb) → unsubscribe` | `{kind: 'connected' \| 'disconnected' \| 'active', device: 'keyboard' \| 'mouse' \| 'gamepad' \| 'touch', pad?}`. |
| `setMouseYoke(on)`, `mouseYoke`, `yokeIndicator` | Mouse yoke; the indicator (`enabled, engaged, x, y, offsetX/Y, centerX/Y, deadzonePx, radiusPx`) is for the HUD crosshair and deadzone box. |
| `setFreeLook(on)` | Pointer-lock free-look (no button held). |
| `setDpadMode('profile' \| 'look' \| 'trim')` | Gamepad D-pad / joystick hat as profile says, free-look, or trim. |
| `enableTouch(container?)` / `disableTouch()` | Creates / removes the touch overlay. |
| `rumble(strong, weak, ms)` | Dual-rumble on the active pad (feature-detected; false if unsupported). |
| `gamepads`, `lastActiveDevice`, `keyboardProfile`, `gamepadProfile(i?)`, `loadErrors` | Introspection. |
| `dispose()` | Removes every listener and DOM node; idempotent. |

Wiring to `UiHost` (src/ui/UiHost.ts): `bindings: () => input.bindingsList()`,
`rebind: (a) => input.startListening(a)`, `resetBindings: (p) => input.resetProfile(p)`,
`captureInput: (c) => input.setCaptured(c)`, `dispatch: (a) => input.applyAction(a)`.

Lower-level pieces are exported too (`index.ts`): `KeyAxis`, `HoldTracker`, `shapeAxis`/`shapeStick`/`unipolarFromRaw`,
`parseGamepadId`/`decodeHat`/`resolvePreset`, profile helpers (`mergeProfiles`, `rebind`, `findConflicts`, `serializeProfile`, `parseProfile`).

## Files

| File | Role |
|---|---|
| `InputManager.ts` | orchestrator: poll, arbitration, controls ownership, profiles, labels, rebinding API |
| `keyboard.ts` / `mouse.ts` / `gamepad.ts` / `touch.ts` | device sources |
| `keyAxis.ts` | `KeyAxis` ramps and `HoldTracker` (edges, repeat, held levels) |
| `controlsMapper.ts` | discrete actions → `ControlInputs` (`applyControlAction`, `ControlRates`) |
| `bindings.ts` | binding model, trigger identity, conflicts, merge/override, rebind, JSON (de)serialisation |
| `profiles.ts` | built-in profiles (`msfs`, `laptop`, `default`, `gamepad-xbox`, `joystick-generic`) |
| `profileManager.ts` / `bindingStore.ts` | active profiles per device + localStorage persistence |
| `profileSchema.ts` | `BINDING_PROFILE_JSON_SCHEMA` (draft 2020-12) for import/export tooling |
| `gamepadId.ts` / `gamepadCompile.ts` | id parsing, presets, hat decoding; compiled per-pad bindings, D-pad modes |
| `shaping.ts` | deadzone / saturation / curve / unipolar / deadzone box |
| `chord.ts` / `bindingRows.ts` / `actions.ts` | chords and labels; UI rows; action metadata and local actions |
| `rebinding.ts` | capture of the next chord / button / axis for `startListening` |
| `testing/dom.ts` | fake EventTarget / DOM / window / navigator.getGamepads / storage for Node tests |

## How it works

- **Sources** (`keyboard.ts`, `mouse.ts`, `gamepad.ts`, `touch.ts`) collect raw input between polls; `poll(dt)` drains
  them in a fixed order. Discrete inputs go through a `HoldTracker` per device: an **edge** when an action becomes held,
  **auto-repeat** generated from poll time (default 10 Hz after 300 ms; "knob" actions — trims, AP/radio knobs — double to
  20 Hz after 1 s held), and **held levels** (`snapshot.held`). OS key repeat is ignored. A press and release between two
  polls still yields the edge and one frame of "held".
- **Keyboard**: tracked by `KeyboardEvent.code`; chords match modifiers **exactly** and are captured at key-down (releasing
  Ctrl first does not leak into plain E). An axis key pressed with unbound modifiers falls back to its plain binding
  (Shift+↑ still pitches) unless that chord is an action. `preventDefault` only for bound chords; Meta-chords, text fields
  (`input/textarea/select/contenteditable`) and captured mode are ignored; `blur`/`visibilitychange` release everything.
- **Keyboard axes** (`keyAxis.ts`): a virtual stick per axis, linear ramp centre→full in 0.6 s, release auto-centres in
  0.3 s (reversals pass centre at the faster rate), last-pressed direction wins. Brakes keys 0.25 s / 0.17 s.
- **Arbitration** (§B1): for every centring axis the source that changed it most recently wins (gamepad > touch > mouse
  yoke > keys on ties); the keyboard stays "active" while its ramp is still returning to centre. Gamepad axes count as
  moved when the shaped value changes by > 0.02 since the last registered change (slow sweeps are caught), and the first
  reading after connecting only primes (a resting slider never yanks the throttle).
- **Levers** (throttle / mixture / propeller) are state in `controls`. An analog lever (slider, touch throttle) that moves
  takes over and is followed continuously; keyboard/button steps (`throttleInc` = 5 %, `F1` cut, `F4` full) are ignored
  until it has been idle for `leverHoldoff` (2 s), after which they apply and the lever stops following the device until it
  moves again.
- **Brakes**: `brakesHold` ramps 0→1 in 0.25 s (release 0.15 s) and is merged as `max()` with the `brakeLeft/Right` axes.
- **Mouse**: right-button drag → `pointerDx/Dy` (pointer capture, or pointer lock with `lockOnDrag`); `freeLookToggle`
  (F) locks the pointer for button-less look until Esc. The wheel drives `axes.cameraZoom` as a sticky level −1..1
  (0.1 per notch; `cameraReset` returns it to 0) and also emits `zoomIn`/`zoomOut` per notch. Context menu suppressed on
  the canvas only.
- **Mouse yoke** (§B4.2, Alt+M): absolute mode maps the cursor offset from the canvas centre through a square deadzone box
  (12 px) to full deflection at 250 px ÷ sensitivity, then the response curve; cursor below centre = pull back = nose up.
  It engages only once the cursor has passed through the centre box (no jerk when enabling). Relative mode integrates
  movement deltas under pointer lock.
- **Gamepads**: polled each frame; a preset is chosen from the id (VID:PID table: Xbox, DualShock 4, DualSense, Extreme 3D
  Pro, T.16000M, T.Flight HOTAS X; else standard-mapping → Xbox layout, other HID → generic joystick). Joystick axis order
  follows Chromium's HID-usage indices (Linux joydev order on Linux, UNVERIFIED). Shaping = deadzone → rescale →
  saturation → cubic blend → gain (§B5.5); sliders use the unipolar mapping `(1 − a)/2` when inverted, with 3 % end
  deadzones (§B5.6). Hats reported as an axis are decoded with Chromium's ranges (diagonals set two directions). Buttons may
  carry a `modifierButton` (shift layer). Overrides are stored per device key (`standard`, `hid:vvvv:pppp`).
- **Touch**: dynamic virtual stick (appears under the left thumb, 120 px radius, radial deadzone 0.08, curve 0.3; thumb
  down = nose up), sticky throttle slider (top = full), buttons FLAPS −/+, GEAR, BRAKE (hold), VIEW, MENU. Pointer Events,
  `touch-action: none`, one pointer per control.
- **Persistence**: `{version: 1, keyboard?: BindingProfile, gamepads: {deviceKey: BindingProfile}}`; every storage access
  is guarded; corrupt data and unknown actions are skipped and reported in `loadErrors`.

## Binding model and profile JSON

```jsonc
{ "version": 1, "id": "custom", "name": "My keys", "device": "keyboard",   // or "gamepad"
  "bindings": [
    { "device": "keyboard", "code": "KeyE", "ctrl": true, "action": "engineAutoStart" },
    { "device": "keyboard", "code": "ArrowUp", "axis": "pitch", "dir": -1, "sensitivity": 1.5 },
    { "device": "mouse", "button": 1, "action": "cameraReset" },
    { "device": "mouse", "wheel": true, "axis": "cameraZoom" },
    { "device": "gamepad", "button": 0, "modifierButton": 4, "action": "gearToggle" },
    { "device": "gamepad", "axisIndex": 1, "axis": "pitch", "deadzone": 0.12, "curve": 0.3, "invert": false },
    { "device": "gamepad", "axisIndex": 6, "axis": "throttle", "unipolar": true, "invert": true },
    { "device": "gamepad", "button": 7, "axis": "yaw", "dir": 1 },
    { "device": "gamepad", "axisIndex": 9, "hat": "up", "axis": "lookPitch", "dir": 1 },
    { "device": "gamepad", "axisIndex": 4, "axisDir": -1, "action": "trimNoseDown" } ] }
```

A binding has exactly one target (`action` — any `SimAction` or input-local action — or `axis` + `dir` for keys/buttons)
and one input (`code`+modifiers, mouse `button`/`wheel`, pad `button` [+`modifierButton`], `axisIndex` [+`hat` | `axisDir`]).
Shaping fields: `invert`, `deadzone` (0..0.5), `saturation` (0.5..1), `curve` (0..1), `sensitivity` (gain for analog axes,
ramp-rate multiplier for keys, step multiplier for the wheel). `mergeProfiles` lets later profiles override earlier ones on
the same input; `rebind` = one input per action per device; `findConflicts` reports one input bound to two targets.

Input-local actions (handled inside the module, never in `snapshot.actions`): `mouseYokeToggle`, `freeLookToggle`,
`centerControls`, `propellerLow/Dec/Inc/High`, `spoilersToggle`.

## Default bindings

The out-of-the-box keyboard set is `default` = `msfs` merged with `laptop`, so numpad **and** arrow keys work.
Tables are generated from `profiles.ts`. Labels as shown by `getBindingLabel`.

### Keyboard layer `msfs` (MSFS 2020 "Keyboard Transversal" + numpad; also carries the mouse bindings)

| Group | Action / axis | Input |
|---|---|---|
| ATC | ATC window (`toggleAtc`) | `Scroll Lock` |
| ATC | ATC menu options 1–9, 0 (`atcOption1` … `atcOption0`) | `1` … `9`, `0` |
| Autopilot | Autopilot master (`apToggle`) | `Z` |
| Autopilot | HDG mode (`apHdg`) | `Ctrl+H` |
| Autopilot | ALT hold (`apAlt`) | `Ctrl+T` |
| Autopilot | NAV mode (`apNav`) | `Ctrl+N` |
| Autopilot | APR mode (`apApr`) | `Ctrl+A` |
| Autopilot | VS mode (`apVs`) | `Ctrl+V` |
| Autopilot | FLC mode (`apFlc`) | `Alt+R` |
| Autopilot | Flight director (`fdToggle`) | `Ctrl+F` |
| Autopilot | AP altitude + (`apAltInc`) | `Ctrl+PgUp` |
| Autopilot | AP altitude − (`apAltDec`) | `Ctrl+PgDn` |
| Autopilot | AP vertical speed + (`apVsInc`) | `Ctrl+Home` |
| Autopilot | AP vertical speed − (`apVsDec`) | `Ctrl+End` |
| Camera | Next view (`cameraNext`) | `End` |
| Camera | Drone camera (`cameraDrone`) | `Insert` |
| Camera | Reset view (`cameraReset`) | `Ctrl+Space` / `Mouse Middle` |
| Camera | Chase view (`cameraChase`) | `S` |
| Camera | Camera zoom (`cameraZoom`) | `Mouse Wheel` |
| Engine | Throttle cut (`throttleCut`) | `F1` |
| Engine | Throttle decrease (`throttleDec`) | `F2` |
| Engine | Throttle increase (`throttleInc`) | `F3` |
| Engine | Throttle full (`throttleFull`) | `F4` |
| Engine | Propeller low RPM (`propellerLow`) | `Ctrl+F1` |
| Engine | Propeller decrease (`propellerDec`) | `Ctrl+F2` |
| Engine | Propeller increase (`propellerInc`) | `Ctrl+F3` |
| Engine | Propeller high RPM (`propellerHigh`) | `Ctrl+F4` |
| Engine | Mixture idle cut-off (`mixtureLean`) | `Ctrl+Shift+F1` |
| Engine | Mixture leaner (`mixtureDec`) | `Ctrl+Shift+F2` |
| Engine | Mixture richer (`mixtureInc`) | `Ctrl+Shift+F3` |
| Engine | Mixture full rich (`mixtureRich`) | `Ctrl+Shift+F4` |
| Engine | Engine auto-start (`engineAutoStart`) | `Ctrl+E` |
| Engine | Engine auto-shutdown (`engineShutdown`) | `Ctrl+Shift+E` |
| Engine | Magnetos next (`magnetosNext`) | `M` |
| Engine | Magnetos previous (`magnetosPrev`) | `Shift+M` |
| Engine | Starter (hold) (`starter`) | `Shift+Alt+G` |
| Engine | Carburettor heat (`carbHeat`) | `H` |
| Engine | Pitot heat (`pitotHeat`) | `Shift+H` |
| Flaps, gear & brakes | Flaps retract (`flapsRetract`) | `F5` |
| Flaps, gear & brakes | Flaps up one notch (`flapsUp`) | `F6` |
| Flaps, gear & brakes | Flaps down one notch (`flapsDown`) | `F7` |
| Flaps, gear & brakes | Flaps full (`flapsFull`) | `F8` |
| Flaps, gear & brakes | Gear toggle (`gearToggle`) | `G` |
| Flaps, gear & brakes | Spoilers toggle (`spoilersToggle`) | `Num /` / `/` |
| Flaps, gear & brakes | Brakes (hold) (`brakesHold`) | `Num Del` |
| Flaps, gear & brakes | Parking brake (`parkingBrakeToggle`) | `Ctrl+Num Del` |
| Flight controls | Elevator − (`pitch` −) | `Num 8` |
| Flight controls | Elevator + (`pitch` +) | `Num 2` |
| Flight controls | Ailerons − (`roll` −) | `Num 4` |
| Flight controls | Ailerons + (`roll` +) | `Num 6` |
| Flight controls | Rudder − (`yaw` −) | `Num 0` |
| Flight controls | Rudder + (`yaw` +) | `Num Enter` |
| Flight controls | Centre ailerons & rudder (`centerControls`) | `Num 5` |
| Flight controls | Left brake + (`brakeLeft` +) | `Num *` |
| Flight controls | Right brake + (`brakeRight` +) | `Num -` |
| Flight controls | Mouse yoke on/off (`mouseYokeToggle`) | `Alt+M` |
| Interface | Menu (`toggleMenu`) | `Esc` |
| Interface | HUD (`toggleHud`) | `F11` |
| Interface | Screenshot (`screenshot`) | `F12` |
| Lights | All lights (`lightsAll`) | `L` |
| Lights | Landing light (`lightsLanding`) | `Ctrl+L` |
| Lights | Nav lights (`lightsNav`) | `Alt+N` |
| Lights | Beacon (`lightsBeacon`) | `Alt+H` |
| Lights | Strobes (`lightsStrobe`) | `O` |
| Lights | Taxi light (`lightsTaxi`) | `Alt+J` |
| Lights | Panel lights (`lightsPanel`) | `Ctrl+Shift+L` |
| Radios & instruments | Heading bug + (`headingBugInc`) | `Ctrl+Insert` |
| Radios & instruments | Heading bug − (`headingBugDec`) | `Ctrl+Del` |
| Radios & instruments | Altimeter standard / set (`altimeterStd`) | `B` |
| Simulation | Pause (`pause`) | `Pause` |
| Simulation | Slew mode (`slewToggle`) | `Y` |
| Simulation | Sim rate normal (`timeNormal`) | `R` |
| Simulation | Sim rate faster (`timeFaster`) | `Ctrl+Num +` |
| Simulation | Sim rate slower (`timeSlower`) | `Ctrl+Num -` |
| Simulation | Reset flight (`resetFlight`) | `Ctrl+;` |
| Simulation | Repair & refuel (`repairRefuel`) | `Shift+R` |
| Trim | Elevator trim nose down (`trimNoseDown`) | `Num 7` |
| Trim | Elevator trim nose up (`trimNoseUp`) | `Num 1` |
| Trim | Rudder trim left (`rudderTrimLeft`) | `Ctrl+Num 0` |
| Trim | Rudder trim right (`rudderTrimRight`) | `Ctrl+Num Enter` |
| Trim | Aileron trim left (`aileronTrimLeft`) | `Ctrl+Num 4` |
| Trim | Aileron trim right (`aileronTrimRight`) | `Ctrl+Num 6` |

### Keyboard layer `laptop` (numpad-free; merged with `msfs` into the default set)

| Group | Action / axis | Input |
|---|---|---|
| ATC | ATC window (`toggleAtc`) | `\`` |
| Autopilot | ALT hold (`apAlt`) | `Shift+T` |
| Autopilot | NAV mode (`apNav`) | `Shift+N` |
| Autopilot | AP altitude + (`apAltInc`) | `Shift+PgUp` |
| Autopilot | AP altitude − (`apAltDec`) | `Shift+PgDn` |
| Camera | Next view (`cameraNext`) | `C` |
| Camera | Reset view (`cameraReset`) | `Ctrl+Space` / `Mouse Middle` |
| Camera | Zoom in (`zoomIn`) | `=` |
| Camera | Zoom out (`zoomOut`) | `-` |
| Camera | Mouse free-look lock on/off (`freeLookToggle`) | `F` |
| Camera | Camera zoom (`cameraZoom`) | `Mouse Wheel` |
| Engine | Throttle cut (`throttleCut`) | `F1` |
| Engine | Throttle decrease (`throttleDec`) | `F2` / `PgDn` |
| Engine | Throttle increase (`throttleInc`) | `F3` / `PgUp` |
| Engine | Throttle full (`throttleFull`) | `F4` |
| Engine | Engine auto-start (`engineAutoStart`) | `Ctrl+E` |
| Engine | Engine auto-shutdown (`engineShutdown`) | `Ctrl+Shift+E` |
| Flaps, gear & brakes | Flaps retract (`flapsRetract`) | `F5` |
| Flaps, gear & brakes | Flaps up one notch (`flapsUp`) | `F6` |
| Flaps, gear & brakes | Flaps down one notch (`flapsDown`) | `F7` |
| Flaps, gear & brakes | Flaps full (`flapsFull`) | `F8` |
| Flaps, gear & brakes | Gear toggle (`gearToggle`) | `G` |
| Flaps, gear & brakes | Brakes (hold) (`brakesHold`) | `.` |
| Flaps, gear & brakes | Parking brake (`parkingBrakeToggle`) | `Ctrl+.` |
| Flight controls | Elevator − (`pitch` −) | `↑` |
| Flight controls | Elevator + (`pitch` +) | `↓` |
| Flight controls | Ailerons − (`roll` −) | `←` |
| Flight controls | Ailerons + (`roll` +) | `→` |
| Flight controls | Rudder − (`yaw` −) | `Q` |
| Flight controls | Rudder + (`yaw` +) | `E` |
| Flight controls | Mouse yoke on/off (`mouseYokeToggle`) | `Alt+M` |
| Interface | Menu (`toggleMenu`) | `Esc` |
| Interface | VFR map (`toggleMap`) | `V` |
| Interface | Help / key list (`toggleHelp`) | `Shift+/` |
| Radios & instruments | Heading bug + (`headingBugInc`) | `Shift+.` |
| Radios & instruments | Heading bug − (`headingBugDec`) | `Shift+,` |
| Simulation | Pause (`pause`) | `P` |
| Simulation | Sim rate faster (`timeFaster`) | `Ctrl+=` |
| Simulation | Sim rate slower (`timeSlower`) | `Ctrl+-` |
| Trim | Elevator trim nose down (`trimNoseDown`) | `[` |
| Trim | Elevator trim nose up (`trimNoseUp`) | `]` |
| Trim | Aileron trim left (`aileronTrimLeft`) | `Ctrl+←` |
| Trim | Aileron trim right (`aileronTrimRight`) | `Ctrl+→` |
| Trim | Rudder trim left (`rudderTrimLeft`) | `Shift+Q` |
| Trim | Rudder trim right (`rudderTrimRight`) | `Shift+E` |

### Gamepad `gamepad-xbox` (W3C standard mapping, MSFS Xbox layout)

| Group | Action / axis | Input |
|---|---|---|
| Camera | Look left/right (`lookYaw`) — dz 0.15 | `Pad RS X` |
| Camera | Look up/down (`lookPitch`) — inverted, dz 0.15 | `Pad RS Y` |
| Camera | Next view (`cameraNext`) | `Pad View` |
| Camera | Reset view (`cameraReset`) | `Pad R3` |
| Engine | Throttle increase (`throttleInc`) | `Pad A` |
| Engine | Throttle decrease (`throttleDec`) | `Pad B` |
| Flaps, gear & brakes | Brakes (hold) (`brakesHold`) | `Pad X` |
| Flaps, gear & brakes | Gear toggle (`gearToggle`) | `Pad Y` |
| Flaps, gear & brakes | Flaps up one notch (`flapsUp`) | `Pad LB` |
| Flaps, gear & brakes | Flaps down one notch (`flapsDown`) | `Pad RB` |
| Flaps, gear & brakes | Parking brake (`parkingBrakeToggle`) | `Pad L3` |
| Flight controls | Ailerons (`roll`) — dz 0.12, curve 0.3 | `Pad LS X` |
| Flight controls | Elevator (`pitch`) — dz 0.12, curve 0.3 | `Pad LS Y` |
| Flight controls | Rudder − (`yaw` −) — dz 0.02 | `Pad LT` |
| Flight controls | Rudder + (`yaw` +) — dz 0.02 | `Pad RT` |
| Interface | Menu (`toggleMenu`) | `Pad Menu` |
| Trim | Elevator trim nose down (`trimNoseDown`) | `Pad D-Up` |
| Trim | Elevator trim nose up (`trimNoseUp`) | `Pad D-Down` |
| Trim | Rudder trim left (`rudderTrimLeft`) | `Pad D-Left` |
| Trim | Rudder trim right (`rudderTrimRight`) | `Pad D-Right` |

### Joystick `joystick-generic` (Chromium Windows/macOS axis order; Linux uses X, Y, Rz=2, Throttle=3, hat as axes 4/5)

| Group | Action / axis | Input |
|---|---|---|
| Camera | Look up/down + (`lookPitch` +) | `Joy Hat up` |
| Camera | Look up/down − (`lookPitch` −) | `Joy Hat down` |
| Camera | Look left/right − (`lookYaw` −) | `Joy Hat left` |
| Camera | Look left/right + (`lookYaw` +) | `Joy Hat right` |
| Camera | Next view (`cameraNext`) | `Joy 2` |
| Camera | Reset view (`cameraReset`) | `Joy 9` |
| Camera | Cockpit view (`cameraCockpit`) | `Joy 10` |
| Flaps, gear & brakes | Brakes (hold) (`brakesHold`) | `Joy 1` |
| Flaps, gear & brakes | Flaps up one notch (`flapsUp`) | `Joy 3` |
| Flaps, gear & brakes | Flaps down one notch (`flapsDown`) | `Joy 4` |
| Flaps, gear & brakes | Gear toggle (`gearToggle`) | `Joy 5` |
| Flaps, gear & brakes | Parking brake (`parkingBrakeToggle`) | `Joy 6` |
| Flight controls | Ailerons (`roll`) — dz 0.04, curve 0.25 | `Joy Axis 0` |
| Flight controls | Elevator (`pitch`) — dz 0.04, curve 0.25 | `Joy Axis 1` |
| Flight controls | Rudder (`yaw`) — dz 0.06, curve 0.4 | `Joy Axis 5` |
| Flight controls | Throttle (`throttle`) — unipolar, inverted | `Joy Axis 6` |
| Interface | Menu (`toggleMenu`) | `Joy 12` |
| Simulation | Pause (`pause`) | `Joy 11` |
| Trim | Elevator trim nose down (`trimNoseDown`) | `Joy 7` |
| Trim | Elevator trim nose up (`trimNoseUp`) | `Joy 8` |

### Mouse (fixed behaviour + bindings in the keyboard profile)

| Input | Effect |
|---|---|
| Right-button drag on the canvas | free-look → `pointerDx/Dy` (context menu suppressed on the canvas) |
| `F` (`freeLookToggle`) | pointer-lock free-look without holding a button; Esc releases |
| Wheel | `axes.cameraZoom` level ±0.1 per notch (sticky, −1..1) + one `zoomIn`/`zoomOut` per notch |
| Middle button | `cameraReset` (also resets the zoom level) |
| `Alt+M` (`mouseYokeToggle`) | mouse yoke on/off (`snapshot.mouseYoke`) |

### Touch overlay (`enableTouch`)

| Control | Effect |
|---|---|
| Left 45 % × 60 % zone | dynamic virtual stick → roll (x) / pitch (y, thumb down = nose up), returns to centre on release |
| Right vertical slider | throttle 0..1 (top = full), sticky; follows keyboard/UI changes when not touched |
| FLAPS − / FLAPS + / GEAR / BRAKE / VIEW / MENU | `flapsUp`, `flapsDown`, `gearToggle`, `brakesHold` (held), `cameraNext`, `toggleMenu` |

## What is tested (`npx vitest run src/input`)

- `keyAxis.test.ts` — ramp reaches full in 0.6 s ± one frame (60/144/30 Hz) and auto-centres in 0.3 s; reversal; sticky
  mode; sensitivity; repeat: edge once, first repeat 300 ms after the edge, 10 Hz, knob acceleration to 20 Hz, stop on
  release, sub-frame taps, multi-input hold counting.
- `keyboard.test.ts` — edge once per press (OS repeat ignored); held levels; exact modifiers (Ctrl+E auto-start vs E
  rudder); chord captured at key-down; axis fallback for unbound modifiers; preventDefault only for bound keys; blur and
  visibilitychange release; captured flag; text-field focus; trim repeat timing; sub-frame tap; last-pressed wins; detach.
- `bindings.test.ts` — chord parsing and labels (`Ctrl+E`, `Num 7`, `Ctrl+Num Del`, `Mouse Middle`, `Pad A`, `Pad LB+A`,
  `Joy 3`, `Pad LS Y`, `Joy Hat up`); all default profiles conflict-free; merged default has numpad + arrows; conflict
  detection (chords, overlapping axis/hat); merge override; rebind displace/replace; JSON round trip of every profile;
  invalid bindings dropped with errors; storage save/load/clear incl. blocked and corrupt storage; serialised defaults
  conform to `BINDING_PROFILE_JSON_SCHEMA` (allowed keys and enums).
- `mouse.test.ts` — yoke deadzone box, linear mapping, sensitivity, pitch inversion, centre-engage guard; right-drag deltas,
  context menu; pointer-lock free-look and its loss; wheel notches (pixel and line modes) and zoom actions; middle button;
  touch pointers ignored; detach.
- `shaping.test.ts` — deadzone/curve monotonic and odd-symmetric for several settings, deadzone edge, saturation, no −0,
  NaN; radial stick deadzone; inverted and normal unipolar throttle at both ends, monotonic, complementary.
- `gamepad.test.ts` — id parsing (Chrome/Firefox/Safari/XInput); hat decoding incl. diagonals and centred values; preset
  resolution incl. Linux layout; connect/disconnect by events and by polling; standard-mapping buttons → actions (edges,
  held, repeat); sticks/triggers/right-stick look; joystick slider/twist/hat/trigger; D-pad look and trim modes; first
  reading does not steal axes; active pad; rumble; modifier-button shift layer.
- `touch.test.ts` — stick mapping/clamp, overlay create/remove incl. listeners, stick and slider via pointer events, buttons.
- `InputManager.test.ts` — keyboard pitch ramp/centre through the manager (arrows and numpad); throttle 5 % steps, clamp,
  cut/full, hold-to-ramp; Ctrl+E vs E; blur; captured; flapsDown clamps at the detent count and `setFlapDetents`; gear,
  parking brake, every light toggle and lightsAll, magnetos next/prev wrap, heats, mixture, trims, spoilers, propeller;
  starter held; brakes ramp; trim repeat; snapshot object reuse; local actions unreported; mouse yoke via Alt+M; free-look
  and wheel in the snapshot; last-mover arbitration; slider lever hold-off; device-change events; label preference by
  active device; bindingsList/controlsList; startListening (modifier-only ignored, displacement, persistence across
  instances, reset), Esc cancel, superseded listen, gamepad capture (a still-held captured button does not fire), OS
  repeat of the just-captured key ignored; joystick profile chosen without a pad applies to HID devices only; keys bound
  to a lever axis act as rates (taps included); setProfile/resetProfile; dispose.
- `controlsMapper.test.ts` — flaps clamp (incl. no-flap aircraft), magnetos wrap both ways, exact throttle steps and the
  analog-lever lock, toggles/trims, sim-level actions not treated as controls, brake ramp helper.

## Known limitations

- Browsers reserve some MSFS chords and never deliver them: Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+Tab, Ctrl+PgUp/PgDn (Chrome)
  and Ctrl+F4 (closes the tab on Windows/Linux). The laptop layer adds safe alternatives (Shift+T ALT hold, Shift+N NAV,
  Shift+PgUp/PgDn altitude); propeller high has none. F11/F12 may be taken by the browser (fullscreen/devtools).
- Joystick axis indices are per platform/browser; presets follow Chromium on Windows/macOS (HID usage order) and a
  UNVERIFIED joydev order on Linux. Firefox may differ. Use `startListeningAxis` as a calibration step; there is no
  min/max calibration wizard UI yet (only axis/direction capture).
- PlayStation pads are assumed to be exposed with the standard mapping (true for Chromium/Firefox on desktop).
- Rumble needs `vibrationActuator.playEffect` (Chromium); elsewhere `rumble()` returns false.
- Touch tilt control (DeviceOrientation), pinch zoom and two-finger look are not implemented.
- Rebinding replaces *all* bindings of the action on that device (one input per action per device), so a rebound
  action loses its second (numpad/laptop) key. Mouse buttons cannot be captured by `startListening`.
- `cameraZoom` is a sticky level; the camera module currently treats it as a rate in orbit mode (keeps zooming while ≠ 0)
  and as a level in chase/drone modes — the integrator should pick one meaning.
- `KeyB` → `altimeterStd` follows the research table, but MSFS's B is "set local QNH"; see proposed contract changes.

## Tuning knobs

| Knob | Where | Default |
|---|---|---|
| Keyboard ramp / centre time, tap step, sticky | `STICK_KEY_TUNING`, `KeyAxis.tuning` | 0.6 s / 0.3 s / 0 / auto-centre |
| Keyboard sensitivity | binding `sensitivity` on axis keys | 1 (ramp-rate multiplier) |
| Repeat delay / rate / knob acceleration | `options.repeat` (`RepeatTuning`) | 0.3 s / 10 Hz / ×2 after 1 s |
| Throttle / mixture / propeller / trim steps, brake ramp | `options.rates` (`ControlRates`) | 5 % / 5 % / 5 % / 1 % / 0.25 s |
| Lever hold-off after an analog lever moved | `options.leverHoldoff` | 2 s |
| Gamepad deadzone / saturation / curve / gain | binding fields | sticks 0.12 + curve 0.3, joysticks 0.04 + curve 0.25 (twist 0.06 + 0.4), triggers 0.02, sliders 3 % ends |
| Gamepad activity / axis-change / press thresholds | `options.gamepad` | 0.25 / 0.02 / 0.5 |
| D-pad mode | `setDpadMode` | `'profile'` |
| Mouse yoke radius / deadzone box / sensitivity / curve / invert / engage guard / mode | `options.mouse` | 250 px / 12 px / 1 / 0.2 / false / true / `'absolute'` |
| Wheel step, wheel actions, pointer lock on drag | `options.mouse` | 0.1 / true / false |
| Touch stick radius and shaping, buttons | `options.touch` | 120 px, dz 0.08 curve 0.3, six buttons |

## Proposed contract changes (src/core/types.ts)

- Add to `SimAction`: `mouseYokeToggle`, `freeLookToggle`, `centerControls`, `propellerLow`, `propellerDec`,
  `propellerInc`, `propellerHigh`, `spoilersToggle` (currently input-local `LocalAction`s), and `altimeterSync`
  (MSFS B = set local QNH; today B is bound to `altimeterStd`).
- Document `InputSnapshot.axes.cameraZoom` as a sticky level −1..1 (wheel) rather than a rate.
- Optionally add `yokeIndicator` (or a generic `hud` field) to `InputSnapshot` so the HUD can draw the mouse-yoke box
  without a reference to the InputManager.
