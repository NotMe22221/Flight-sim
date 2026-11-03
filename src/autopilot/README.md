# Autopilot, flight director and piloting assists (`src/autopilot`)

A GFC-700-style, attitude-based autopilot and flight director for the C172 plus MSFS-style piloting
assists (auto-rudder with assisted take-off, anti-stall pitch limiter, LVL emergency level). Pure
TypeScript, no Three.js and no DOM; SI units and radians inside, aviation units only in the config
comments and in this file. Specification: `docs/research/05-cockpit-avionics-navigation.md` §5;
C172 numbers from `docs/research/02-flight-dynamics-model.md` §9–10.

| File | Content |
|---|---|
| `Autopilot.ts` | `GfcAutopilot` (implements the `Autopilot` contract of `src/core/types.ts`): mode state machine, outer loops, inner loops, servos, auto-trim, yaw damper, protections, LVL |
| `assists.ts` | `FlightAssists`: auto-rudder (air: β coordination; ground: take-off heading hold), anti-stall, LVL emergency |
| `config.ts` | Every limit, gain and protection with its default (`defaultAutopilotConfig`), `mergeConfig` for overrides |
| `pid.ts` | Discrete PID: derivative on measurement, conditional integration + back-calculation anti-windup, integral clamp, bumpless `resetToOutput`, gain scheduling |
| `filters.ts` | Exactly discretised low-pass, washout, differentiator, rate limiter (frame-rate independent) |
| `lateral.ts`, `vertical.ts`, `level.ts` | Pure control laws: HDG/GPS/VOR/LOC intercepts, ALT/ALTS/GS/level-pitch, LVL load-factor and α limits |
| `index.ts` | Barrel (everything above; not the test plants) |
| `testPlant.ts`, `testSim.ts`, `testGroundRoll.ts` | Test-only plants: linearised C172 point mass + attitude, the closed-loop harness wired like the simulator, a kinematic take-off roll |
| `*.test.ts` | Acceptance tests on the test plant, and `realFdm.test.ts` on the real C172 flight model (`src/fdm`) |

## Frame call order

Per frame (or per physics step), with `dt` the **simulated** time that frame advances (0 while
paused; `dt × timeScale` under time compression — a display `dt` under ×8 compression makes the
loops eight times too slow relative to the aircraft and HDG then overshoots by ~7°):

```ts
// 1. pilot controls → a per-frame copy (the assists add to what they get, never feed them the persistent object)
Object.assign(effective, input.controls); effective.lights = input.controls.lights;
// 2. outer + inner loops on the latest flight-model state
autopilot.update(dt, fdm.state, { nav1, nav2, plan });
// 3. merge: pitch/roll replaced while engaged, yaw-damper rudder added; returns a private copy (no allocation)
const o = autopilot.apply(effective);
if (o !== effective) Object.assign(effective, o);
if (autopilot.state.engaged) input.controls.pitchTrim = autopilot.state.trimCommand; // keep the auto-trim on disconnect
// 4. assists on what the flight model will fly (auto-rudder then sees the autopilot's aileron);
//    `flags` is a reused object — the simulator's AssistanceOptions qualifies (antiStall optional)
assists.apply(effective, fdm.state, dt, flags);
// 5. flight model
fdm.step(h, effective, env);
```

`update` must precede `apply` (apply reads the pilot's stick for the override detector and merges
the servo outputs computed by update). Both are allocation-free. The loops were verified from 7.5 to
120 Hz update rate on the C172 flight model as long as `dt` is the simulated time.

## API

### `GfcAutopilot`

```ts
const ap = new GfcAutopilot({ events, config: { limits: { bankRad: 22 * DEG } } }); // both optional
ap.update(dt, aircraftState, { nav1, nav2, plan });  // every frame, before apply
const u = ap.apply(effectiveControls);               // every frame; returns the controls to fly
```

| Call | Effect |
|---|---|
| `engage(on)` / `disconnect(reason)` | AP servos on/off. Engaging with no modes selects ROL + PIT; engage is bumpless (servos start at the pilot's stick, commands at the current attitude). A disconnect keeps the modes while the FD is on |
| `setFlightDirector(on)`, `setYawDamper(on)` | FD (outer loops + bars without servos), yaw damper (independent of the AP) |
| `setLateral(mode)`, `setVertical(mode)` | Contract modes. Selecting a mode with AP and FD off turns the FD on (GFC 700). `NAV`/`APR` arm until capture; `APR` arms `GS` on a localizer |
| `setHeadingBug(deg)`, `setAltitudeTarget(m)`, `setVerticalSpeedTarget(ms)`, `setIasTarget(ms)`, `setPitchTarget(rad)` | Targets (heading bug magnetic) |
| `press(button)` | Panel semantics: `AP FD YD HDG NAV APR ALT VS FLC LVL NOSE_UP NOSE_DN HDG_SYNC ALT_SYNC` (an active mode's key reverts to ROL/PIT; ALT/VS/FLC sync their target to the current value; UP/DN step pitch 0.5°, VS 100 fpm or IAS 1 kt) |
| `level()` | LVL: AP on at any attitude, wings level, zero VS, everything disarmed (see below) |
| `setNavSource('auto' \| 'gps' \| 'nav1' \| 'nav2')` | What NAV follows (`auto`: the flight plan when it has waypoints, else NAV1). LOC/APR/GS always use the selected radio (NAV1 unless `nav2`) |
| `reset()` | Power-on state (new flight) |
| `onDisconnect(cb)`, `onModeChange(cb)` | Callbacks (return an unsubscribe function); with `events` given, `autopilot:changed` is emitted too |
| `rollCommandRad`, `pitchCommandRad`, `vsCommandMs` | Diagnostics: the commands fed to the inner loops |

`state` (`GfcAutopilotState` ⊃ the contract's `AutopilotState`) adds `disconnectReason`
(`pilot | override | stall | bank | overspeed | crash`), `disconnectT` and `modeChangeT` (autopilot
clock, for the red "AP" flash / tone and the 10 s annunciator flash), `t`, `altAlert`
(`none | approach | deviation`: 1 000 ft before the selected altitude, ±200 ft off a held one) and
`lvl`. The contract has no LVL mode, so while `lvl` is set `lateral` reads `ROL` and `vertical`
reads `VS` (target 0); annunciators should show "LVL" in both fields. `fdRollRad`/`fdPitchRad`
are exactly the commands fed to the inner loops (smooth the bar drawing in the UI if wanted).

### `FlightAssists`

```ts
const assists = new FlightAssists({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
assists.apply(effective, fdm.state, dt, flags); // flags: { autoRudder, assistedTakeoff, antiStall? }, reused; mutates effective
assists.emergencyLevel(ap);   // LVL emergency = ap.level()
assists.reset();              // new flight / respawn
```

`apply` runs auto-rudder (when `autoRudder` or `assistedTakeoff`) and then the anti-stall limiter
(when `antiStall`). Diagnostics: `rudderAssist` (rudder added this frame), `antiStallFactor`
(nose-up authority left, 1 = untouched), `antiStallPush` (≤ 0), `takeoffHeadingRad` (heading held
on the runway, NaN when none), `releaseHeadingRad` (heading captured at the last brake release).
`stallAlphaFromConfig(config)` reads the stall α (largest CL of the flaps-up column) from an
`AircraftConfig`: 0.280 rad (16.0°) for the C172S, which is also the default.

## How it flies

```
lateral mode ─► bank command φc (±25°, ±22° on a localizer, ≤ standard-rate bank, slewed 6°/s)
               ─► roll PID on φ (+ φ̇ damping, + slew feed-forward) ─► aileron servo (±0.5, 1.0/s)
vertical mode ─► VS command ḣc ─► VS→pitch PI ─► pitch command θc (+20°/−15°, slewed 2°/s)
               (PIT and FLC command θc directly)
               ─► pitch PID on θ (+ θ̇ damping, + slew feed-forward) ─► elevator servo (±0.5, 1.0/s)
auto-trim: |elevator servo| > 0.03 for 2 s → trim at 0.02/s until |servo| < 0.01
yaw damper: rudder = −0.8 · washout(r, 2 s), ±0.3 (steady turn rate passes; independent of the AP)
```

* **HDG**: φc = 1.0 · wrap(ψbug − ψmag), limited. **ROL**: φ at engage (wings level below 6°).
* **NAV (GPS)**: desired track − clamp(60°/nm · cross-track, ±44°), flown as a *track* error (wind
  corrected). **VOR**: course + 45° · CDI (gain scaled down inside 10 nm). **LOC/APR**: course +
  15°/dot · (distance / 6 nm, clamped 0.3–1.5) + integral 0.05°/s per dot (±5°), capped ±30°.
  Armed NAV/LOC captures at |deviation| ≤ 1 dot or when the deviation will reach zero within 8 s;
  selecting NAV/APR from ROL captures at once and flies the intercept law (MSFS behaviour,
  `behaviour.autoInterceptFromRol`); from HDG it stays armed (GFC 700).
* **ALT**: ḣc = 8 fpm/ft · error, ±800 fpm. **ALTS** (armed whenever PIT/VS/FLC fly toward the
  selected altitude): captures at max(50 ft, 1.3 · ḣ² / (2 · 0.03 g)) with a gain that makes the
  command continuous at capture (an exponential level-off with no snatch), then becomes ALT within
  15 m. **VS**: ±1 500 fpm, 100 fpm steps. **FLC**: θc from a PID on IAS (fast → nose up), never
  pitching below level flight while the target is above (and vice versa). **GS**: ḣc = −GS·tan 3° +
  350 fpm/dot · (distance / 3 nm, 0.4–1.3) + integral, [−1 500, +200] fpm; captures within 0.5 dot
  once the localizer is captured. Every VS-based mode drives the same VS→pitch PI, which is re-seeded
  at the current pitch command whenever the vertical mode family changes (bumpless).
* **Gain scheduling**: inner-loop kp/kd × (100 kt / IAS)¹ clamped 0.5–2. The spec suggests the
  square (dynamic pressure); the C172's attitude-rate response to a surface grows ≈ ∝ V, and the
  square made the loops sluggish at 70 kt and twitchy at 150 kt (`gains.qbarScheduleExponent`).
* **Protections** (MSFS-like, `protections.*`): pilot stick > 0.5 for 0.5 s (`override`), the
  flight model's stall warning (`stall`), |φ| > 60° (`bank`), overspeed warning (`overspeed`), crash.
* **LVL** (`level()`, or `press('LVL')`): engages at any attitude, φc = 0 and ḣc = 0, all modes
  disarmed, the selected altitude untouched. While active the bank/overspeed/stall-warning
  disconnects are suspended and the roll command slews at 20°/s. *Unload, roll, then pull*: while
  |φ| > 30° the elevator does not hold θ (an Euler-pitch loop reverses beyond 90° of bank and needs
  1/cos φ g in a steep bank) but flies a load-factor law toward 1 g (blending to 0 g inverted) with
  body pitch-rate damping and a push above the α ceiling; below 30° the θ loop takes over bumplessly
  and the pitch command slews at (1.8 − 1)·g/V (a 1.8 g pull-up), never above θ − α + 10° (α
  ceiling under the C172's 10.3° stall warning). UP/DN turns LVL into plain VS; any mode selection
  or a disconnect ends it.

Mode rules (spec §5.4): pressing an active mode's key reverts to ROL / PIT; HDG from a captured nav
mode drops it; ALT key holds the current altitude rounded to 10 ft; a lost source (invalid radio,
empty plan) reverts NAV/LOC/APR to wings-level ROL and GS to PIT after a 2 s grace; GS needs APR;
modes exist exactly while the AP or FD is on (also when `state.flightDirector` is written directly).

### Assists

* **Auto-rudder, air**: rudder += fade(IAS 35→45 kt) · clamp(3 · β + ∫2 · β + 0.3 · aileron, ±0.6).
  The integral (±0.3) trims out a steady slip such as climb-power P-factor and freezes while the
  pilot's own pedal exceeds 0.05, so deliberate slips stay possible. β > 0 (wind from the right) →
  right rudder.
* **Assisted take-off** (ground, `assistedTakeoff`): the heading is captured when the brakes come
  off; the hold engages when take-off power (throttle ≥ 0.6) is set below 15 m/s and steers that
  heading — or the current one when the aircraft has moved > 30 m since the release (taxi then
  rolling take-off). Pedal = clamp(s · (4 · ψerr − 1.5 · r) + ∫1.5 · ψerr, ±0.8) with
  s = 15 m/s ÷ ground speed (0.3–3: steering power grows with speed). Taxiing below take-off power
  is never steered. It lets go when the brakes are set, when the throttle is closed (< 0.2) below
  15 kt, and blends into the airborne coordination over 3 s after lift-off. The pilot's pedal adds.
* **Anti-stall**: nose-up stick × (1 − smoothstep(α_stall − 5°, α_stall − 1.5°, α + 0.3 s · α̇));
  beyond α_stall − 1.5° a push of 4 per rad of excess (≤ 0.3) is added. Nose-down input is never
  reduced; inactive on the ground and below 25 kt. After the autopilot's `apply` it also limits the
  autopilot's nose-up elevator (the AP normally disconnects on the stall warning first).
* **LVL emergency**: `emergencyLevel(ap)` is `ap.level()` — the autopilot's own loops do the work.

## Gain table (defaults in `config.ts`)

| Loop | Value | Why |
|---|---|---|
| Roll PID (φ → aileron) | kp 0.025/°, ki 0.004/°/s, kd 0.010 per °/s, out ±0.5, iLim 0.15 | Spec §5.2: full servo authority at 20° error, τ ≈ 1.5–2 s; kd damps the roll mode |
| Pitch PID (θ → elevator) | kp 0.045/°, ki 0.010/°/s, kd 0.020 per °/s, out ±0.5, iLim 0.20 | Spec §5.2: ~5 s pitch capture without overshoot |
| Slew feed-forward | roll 0.6 per rad/s, pitch 1.5 per rad/s | ≈ 1 / full-surface rate, so the loops track the slewed commands without lag |
| Airspeed schedule | kp, kd × (100 kt / IAS)¹, 0.5–2 | see "How it flies" |
| Bank limits | 25° (22° LOC/APR), standard rate 3°/s, command slew 6°/s | GFC 700 22–25°; the standard-rate cap gives ≈ 16° at 100 kt |
| Pitch limits | +20° / −15°, command slew 2°/s | GFC 700 |
| HDG | 1.0° bank per ° of error | Spec: 20° off → 20° bank |
| ALT | 8 fpm/ft, ±800 fpm | Spec Kh; 800 fpm limit (acceptance) |
| ALTS | capture at max(50 ft, 1.3·ḣ²/(2·0.03 g)); gain = |ḣ|/|err| (8–32 fpm/ft) | 0.03 g ≈ 350 fpm/s: 1 000 fpm captures ~185 ft out, no snatch |
| VS → pitch PI | 0.008°/fpm, 0.0012°/fpm/s | Raised from the spec's 0.006 / 0.0008; 500 fpm error → 4° |
| FLC PID | 1.0°/kt, 0.15°/kt/s, 0.5° per kt/s (τ 0.5 s) | ±1.5 kt in full-power climbs and idle descents 75–100 kt on both plants; the earlier 0.6 / 0.06 (spec 0.4 / 0.02) let the speed run 3–4 kt off for 20 s after FLC + full power |
| GPS intercept | 60°/nm, cap 44° | Spec 60°/nm en route, cap 45° minus room for the heading overshoot |
| VOR intercept | 45° × CDI, ≥ 0.3 scale inside 10 nm | Cone of confusion |
| LOC | 15°/dot × (d/6 nm, 0.3–1.5), ±30°, ki 0.05°/s/dot (±5°) | Spec 12°/dot + integral; distance schedule instead of a 2 nm step |
| GS | 350 fpm/dot × (d/3 nm, 0.4–1.3), ki 8 fpm/s/dot (±200 fpm), [−1 500, +200] fpm | Spec Kgs |
| Servos | ±0.5 authority, 1.0/s slew | Spec; the pilot can always out-muscle the servo |
| Auto-trim | 0.03 deadband for 2 s, 0.02/s, stop at 0.01 | Spec §5.3 (+ hysteresis so the servo ends centred) |
| Yaw damper | 0.8 rudder per rad/s of washed-out r (2 s), ±0.3 | Washes out in a steady turn |
| Override | |stick| > 0.5 for 0.5 s | Spec CWS-like (0.6) |
| LVL | roll slew 20°/s, wings first above 30°, unload 0.15 elevator/g, 1.8 g pull-up, α ≤ 10° | Recovery without overstress or stall |
| Auto-rudder | 3 per rad β, 2 per rad·s (±0.3), 0.3 × aileron, ±0.6, fade 35–45 kt | Peak roll-in slip −60 % on the C172, P-factor slip trimmed to 0 |
| Take-off hold | 4 per rad ψ, 1.5 per rad/s r, 1.5 per rad·s (±0.3), ±0.8, × 15 m/s ÷ GS (0.3–3) | ≤ 2° heading error, ≤ 2 m off the centreline on the C172 (calm and 10 kt crosswind) |
| Anti-stall | fade from α_stall − 5° to α_stall − 1.5°, lead 0.3 s, push 4/rad ≤ 0.3 | C172: α never above 13.6° with full aft stick at idle (stall 16°) |

Tuning notes: tune the inner loops first (ROL hold with a bank step, PIT hold with a pitch step;
watch `rollCommandRad`/`pitchCommandRad` against the attitude), then HDG, VS, ALT/ALTS, FLC, the nav
intercepts last. Every gain is per normalised surface at 100 kt; the airspeed schedule handles the
rest. `npx vitest run src/autopilot` runs every scenario below in about 10 s.

## Verification

Acceptance on the test plant at 120 Hz (`Autopilot.test.ts`, `pid.test.ts`, `level.test.ts`,
`assists.test.ts`) and the same scenarios on the C172S flight model (`realFdm.test.ts`):

| Requirement | Test plant | C172S FDM |
|---|---|---|
| HDG 000→090 at 100 kt: capture < 60 s, overshoot < 3°, bank ≤ 25.5° | ±2° at 36.7 s, 0.00°, 16.0° | ±2° at 44.9 s (103° turn: magvar 13°), 0.00°, 16.4° |
| ALT 3000→3500 ft: capture < 120 s, VS ≤ 800 fpm, overshoot < 40 ft, error < 10 ft | 46 s, 749 fpm, 14.8 ft, 0.7 ft | 44 s, 795 fpm, 12.0 ft, 1.8 ft |
| VS ±500 fpm within ±50 fpm | 33 / 11 fpm | 15 / 7 fpm |
| FLC 90 kt within ±3 kt while climbing | 0.99 kt (≥ 593 fpm) | 0.59 kt (≥ 745 fpm) |
| NAV from 2 nm right: < 0.1 nm, intercept ≤ 45° | 134 s, 44.0° | 127 s, 44.4° |
| APR/GS from 1 dot low at 6 nm: capture, track within 0.2 dot | capture 14.9 s, 0.16 dot | capture 14.7 s, 0.16 dot, CDI < 0.03 |
| LOC capture from a 30° intercept, bank ≤ 22.5° | tested | — |
| Disconnect on override (0.5 s), stall warning, bank > 60°, overspeed | tested | — |
| Bumpless engage: elevator jump < 0.05 | 0.029 (pilot holding −0.22) | 0.008 |
| FD bars equal the commands | exact (`toBeCloseTo(…, 12)`) | — |
| Yaw damper washes out in a steady turn | 0.05 peak → 3·10⁻⁴ after 16 s at 3.6°/s | — |
| PID anti-windup, back-calculation, bumpless reset, derivative on measurement | `pid.test.ts` | — |
| 60 Hz vs 120 Hz within 5 % | 0.01 % (HDG), 0.02 % (ALT) | 7.5–120 Hz identical within 0.2 ft / 0.01° |
| Auto-rudder | roll-in slip −70 %+, steady 2° slip trimmed to < 0.05° | peak 6.6° → 2.5°, final 0.0° |
| Assisted take-off holds the brake-release heading | < 3°, < 2 m (calm, 10 kt crosswind); taxi never steered | < 2.3°, < 2 m (calm, 10 kt crosswind); 159° swing without it |
| Anti-stall | no stall at full aft stick, factor → 0 | α ≤ 13.6° (stall 16°) |
| LVL from unusual attitudes | 70° nose-low spiral, nose-high slow, FLC climb: wings < 10 s, < 2 g, zero VS | 143° rolling dive: ≤ 0.8 g inverted, ≤ 1.8 g, wings level 7 s |

## Limitations

* Two-axis GFC 700 subset: no BC, VNAV/GP, GA, CWS button, ALTV, PTRM warnings or engage-speed
  limits; LOC course and GS path are whatever the receiver reports (no false-glideslope logic).
* The contract's `AutopilotState` has no LVL mode (`lateral` reads `ROL`, `vertical` `VS` while
  `state.lvl`), no FLC/PIT annunciation of the selected value, and `ALTS` is used both as the armed
  pre-select and the capture phase.
* Gains are fixed for the C172 (no per-aircraft table); the airspeed schedule assumes control
  power ∝ V. Heavier or faster types need their own `config` override.
* Auto-trim moves `pitchTrim` in normalised units at 0.02/s; with a different trim authority in
  another aircraft the rate in elevator degrees changes accordingly.
* The FD bars are the raw commands (spec §5.5 suggests a 0.5 s low-pass for drawing: do it in the UI).
* LVL limits the pull-up to 1.8 g, so from an inverted, steep dive it trades altitude and speed
  for load (143° / −14° at 128 kt: 2 300 ft and 212 kt); it cannot save an upset close to the ground.
* Anti-stall acts on α only (no speed-based protection, no stick pusher on the ground); the
  assisted take-off steers heading, not the runway centreline (it holds the line it started on).
* The test plant is a linearised model valid for |φ| < 90°; inverted LVL behaviour is checked on
  the flight model only.
