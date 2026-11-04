# Flight dynamics model (`src/fdm`)

Six-degree-of-freedom rigid-body flight model for a Cessna 172S (`C172S`) and a Piper PA-18-150
Super Cub tail-dragger (`PA18_150`), implementing the `FlightModel` contract in
`src/core/types.ts`. No Three.js; runs in Node for tests.
Specification and sources: `docs/research/02-flight-dynamics-model.md` (C172S) and the header and
`meta.sources` of `aircraft/cub.ts` (Super Cub).

## API

```ts
import { Fdm, C172S, PA18_150 } from './fdm';
const fdm = new Fdm(C172S, { seed: 1 });          // or new Fdm(PA18_150); seed drives the turbulence PRNG
fdm.setFuelFraction(1);                            // or setLoad(stationsKg, tanksKg)
fdm.reset(spawn, env);                             // ground spawn settles on the gear; air spawn trims
fdm.step(1 / 120, controlInputs, env);             // fixed step, RK4 inside
fdm.state;                                         // AircraftState, updated in place
fdm.trim(casMs, gammaRad, env); fdm.trimResult;    // throttle, pitchTrim, stick, alpha, elevator
fdm.rebase(rotation, translationNED);              // floating origin (see src/world/rebase.ts); state is republished at once
fdm.serialize(); fdm.deserialize(json);            // bit-exact save/restore, also into a fresh instance
fdm.setAltimeter(pa); fdm.bestPowerMixture(); fdm.clearCrash();
```

## How it works

| File | Content |
|---|---|
| `atmosphere.ts` | ISA 0–20 km with ΔT and QNH, CAS/TAS/EAS, indicated altitude, 172S airspeed calibration, table-driven `AirspeedCalibration` for other aircraft |
| `aircraft/c172.ts` | The complete `AircraftConfig`: geometry in body axes from JSBSim's structural frame, mass, every aero table, engine, propeller, gear, controls, limits |
| `aircraft/cub.ts` | `PA18_150`, the Super Cub `AircraftConfig` (see below), plus the shared airframe numbers `CUB_GEOMETRY` that `src/aircraft3d` builds to, `cubArm()` (Piper arm → body x) and `PA18_ELECTRICAL` |
| `aero.ts` | Coefficient build-up (JSBSim c172p form): α table with stall hysteresis, flaps, ground effect, rate and control derivatives, α̇ terms on q̄ of the u–w plane, elevator/rudder in the slipstream, spiralling-slipstream yaw, high-α fades, flat-plate blend beyond 0.36 rad; optional tail damping in the propeller wake (`slipstreamDamping`) |
| `propulsion.ts` | Throttle-orifice manifold (MAP is a state), airflow-based power with mixture efficiency, Coulomb + viscous friction and pumping losses, starter, NACA-640 propeller with J² extrapolation, slipstream, P-factor, reaction torque, gyroscopic momentum |
| `gear.ts` | Spring/damper struts with compression-rate clamp, Pacejka side force, rolling and brake friction (optionally torque-limited, `brakeMu`), steering (a steerable wheel behind the CG turns opposite to the pedal), full-swivel breakout and relock of a castering tail wheel (`swivel`), brake anchors (static friction), structure points and crash detection (leg collapse above 3 W, propeller strike at the bottom of the disc) |
| `turbulence.ts` | MIL-F-8785C Dryden (discrete form), seeded serialisable PRNG |
| `massProps.ts` | Composite mass, CG and inertia from empty airframe, stations and tanks (every step) |
| `fdm.ts` | State vector, RK4, actuators (lags, rate limits, flap motor, trim tab), input sanitising, wind/turbulence sampling, fuel burn, engine temperatures, trim (Newton with the throttle stops as an active set), ground settling, rebase, serialisation, AircraftState outputs and warnings |
| `grid.ts` | Allocation-free bilinear table used in the hot path |
| `electrical.ts` | Per-aircraft `ElectricalSpec` (`AircraftConfig.electrical`, default `C172S_ELECTRICAL`); a 14 V system sets `batteryNominalV: 12`, which halves the battery voltages. C172S 28 V system: 24 V 12.75 Ah battery (open-circuit voltage from charge, ohmic + polarisation sag), 60 A alternator (field excitation needs BAT, output falls below ~1700 rpm), split master BAT/ALT, avionics master, switched loads, LOW VOLTS below 24.5 V. The starter cranks only as hard as the battery terminal voltage allows (a flat battery will not start the engine; the master must be on). `AircraftState.electrical` publishes it, with `nominalVolts` (28 / 14) and `lowVoltsThresholdV` for gauge scales; `ControlInputs.masterBattery / masterAlternator / avionicsMaster / fuelPump` drive it (undefined = on, on, on, off) |

Conventions: SI, NED world frame, FRD body frame, JSBSim control signs (see `docs/DESIGN.md`).
The integrated attitude is the body→NED quaternion; `AircraftState.qNB` is its conjugate.

## Piper PA-18-150 Super Cub (`aircraft/cub.ts`)

A tandem two-seat bush tail-dragger: Lycoming O-320 (150 hp at 2,700 rpm, carburetted) on a
74 × 42 in fixed-pitch climb propeller turning clockwise from the cockpit, USA 35B-class
constant-chord strut-braced wing (16.58 m², AR 6.9), flaps up / 25° / 50° on a manual handle,
stabiliser trim modelled as elevator trim, stick. Body axes are relative to the **empty** CG
(+16.5 in aft of the wing-leading-edge datum); `CUB_GEOMETRY` holds the numbers shared with
`src/aircraft3d` (wing LE/TE x +0.42 / −1.18 at z −1.02, prop hub (1.80, 0, −0.05), mains
(0.50, ±0.92, 1.12) r 0.28, tail wheel (−4.40, 0, 0.15) r 0.08, eye (0.05, 0, −0.60)).
Empty 450 kg, gross 1,750 lb; stations front seat / rear seat (+36 in) / baggage (+50 in, 50 lb);
two 18 US gal wing-root tanks. 14 V electrical system (12 V 25 Ah battery, 40 A alternator).

**Tail-dragger ground handling**

- *Steerable tail wheel*: the pedals steer it through the rudder springs over ±25° (softened with
  ground speed as the nose wheel is); being **behind** the CG it turns opposite to the pedal (right
  pedal → wheel heading left → aircraft turns right). `GearState.steerRad` publishes the wheel's
  actual heading (+ = turned right), including while it castors.
- *Full swivel*: the steering springs carry the side force of ordinary steering, so pedal
  reversals and S-turns keep the wheel locked. It unlocks only when the tyre is dragged past the
  steering stop (its contact point moving more than ±(25 + 3)° off the aircraft's axis: a
  brake-assisted pivot, the tail swinging out in a ground loop) with a side force above
  `swivel.breakoutN` (250 N). It then castors freely, trailing its contact-point velocity with no
  side force (also while too slow to trail into line, so it never skids like a brake); it relocks
  once rolling forward within `swivel.relockDeg` (6°) of the steering angle, or when it leaves the
  ground. The lock state is serialised.
- *Mains*: soft bungee legs (40 kN/m, ζ ≈ 0.2 in compression, more on rebound) — a 300 fpm
  wheel landing bounces ≈ 0.5–0.7 m; heel brakes are torque-limited (`brakeMu` 0.4, differential
  through `brakeLeft/Right`), below the μ ≈ 0.7 that would stand a three-pointed Cub on its nose.
- The CG sits 0.7 m behind the mains: a yaw on the ground diverges unless the locked tail wheel or
  the rudder stops it. Feet off the rudder at full power, or a crosswind gust on a tail-up
  roll-out, ends in a ground loop; normal rudder work keeps it straight. Forward stick in the
  propwash lifts the tail at ≈ 25–35 KIAS; the ground spawn settles into the three-point attitude
  like the C172's nose-gear settle.
- The fin and rudder sit in the propwash: rudder authority and (with `slipstreamDamping`) yaw
  damping follow the wake, so taxi turns at low speed stay controllable and a free-castering
  Cub does not pirouette.

**Config fields added for it** (all optional; undefined keeps the C172S behaviour):
`GearSpec.brakeMu`, `GearSpec.swivel`, `aero.slipstreamDamping`, `aero.stallWarnAlphaRad`,
`aero.stalledAlphaRad`, `AircraftConfig.electrical` (`ElectricalSpec`, now in `core/types.ts`,
with `batteryNominalV`), `AircraftConfig.airspeedCalibration` (KCAS → KIAS tables; the Cub has
no published calibration, so IAS = CAS), and `ElectricalState.nominalVolts / lowVoltsThresholdV`.

**Validation** (`aircraft/cub.test.ts`, ISA sea level, 1,750 lb unless noted; published figures
from the PA-18-150 owner's handbook and TCDS 1A2):

| Check | Model | Handbook / tolerance |
|---|---|---|
| Stall power off, flaps up / 50°, 1 g (CLmax) | 42.0 / 37.5 KIAS (entry at ≈ 1 kt/s: 40.4 / 34.8) | 47 / 43 mph = 41 / 37 kt, ± 2.5 kt |
| Stall warning (vane, α 10.9°) | 4.4 / 4.6 kt above the entry | ≈ 5 kt |
| Best rate of climb, 61 KIAS, full throttle | 990 fpm at 2,475 rpm | 960 fpm, ± 12 % |
| Top speed, sea level, full throttle | 109.7 KTAS at 2,700 rpm, 14.2 gph | 130 mph = 113 kt, ± 6 % |
| 75 % cruise, sea level / 5,000 ft | 98.4 / 103.0 KTAS | 115 mph = 100 kt, ± 6 % |
| Take-off run, flaps 50°, three-point attitude | 298 ft (lift-off 39 KIAS); solo 149 ft | 200 ft; 150–330 ft (the brochure figure needs ≈ 31 kt lift-off at gross) |
| Landing roll, three-point at 36 KIAS, full flaps, heel brakes after 1 s | 306 ft; solo 250 ft | 350 ft, ± 25 % |
| Three-point attitude at rest / tail-wheel share | 10.8° / 15–16 % W | 11 ± 1.5° |
| Tail comes up under forward stick (−0.4 / −0.6), full power | 30 / 28 KIAS (solo 25 / 22) | 25–35 KIAS |
| Static stability, trim at 50 / 70 / 90 KIAS (C.G. +20.4 in) | Cm_α −0.97 / −0.52 / −0.34, static margin 22 / 11 / 7 % | converges, Cm_α < 0 |
| Taxi turn, full pedal at ≈ 10 kt | 13 m radius, tail wheel 21° the other way, no breakout; a brake pivot unlocks it, it relocks within 6 s of rolling straight | — |
| S-turns at ≈ 6 kt, half then full pedal reversals every 4 s (`cubGroundReview.test.ts`) | stays locked, ± 9–20 °/s either way | no breakout, no ground loop |
| Breakaway with the wheel left swivelled 45–80° (paved and grass, solo and gross) | rolls at 1.5 kt within 6 s at ≈ 1,300 rpm, relocks once straightened | no skid |
| 15 kt gust from the right on a tail-up wheel-landing roll-out (wings held level) | no rudder: 66° (solo 73°) off heading — a ground loop; with rudder: < 7° | ground loop possible, rudder prevents it |
| Full-power take-off roll, feet off the rudder | swerves left > 15° within 8 s, ground-loops once the tail is up | needs right rudder |
| 300 fpm arrival (three-point / wheel landing) | 2.4 / 2.2 g, 1.0 / 1.4 W per main, bounce 0 / 0.7 m | no failure, < 3 g, < 1 m |
| Glide, idle, 55 KIAS | L/D 7.9 | ≈ 8 |
| Hands-off cruise, 95 KCAS (rigged), 60 s | bank within 2° | — |

## Validation (C172S at 2,550 lb, ISA, measured by the tests' pilot models)

| Check | Model | POH / spec (docs/research/02 §10) |
|---|---|---|
| Climb at Vy, sea level, full power | 733 fpm | 730 fpm |
| Cruise, 8,000 ft, full throttle leaned | 123.6 KTAS, 2,669 rpm, 73 %, 11.7 gph | 124 KTAS at 75 % |
| Take-off ground roll, flaps 10 | 932 ft | 960 ft |
| Take-off over 50 ft (test pilot holds 8° pitch, not Vx) | 2,119 ft | 1,630 ft (short-field technique) |
| Landing ground roll, flaps 30, touchdown 48–51 KCAS, heavy braking after 1 s | 390–450 ft | 575 ft |
| Stall, flaps up / 30, quasi-static 1 g (trim + CL ratio) | 53.3 / 48.2 KCAS | 53 / 48 KCAS |
| Stall, flaps up / 30, altitude-hold entry (decelerates > 1 kt/s) | 57.7 / 51.0 KCAS | — |
| Stall warning above the 1 g stall, flaps up / 30 | 7.9 / 5.4 kt | 5–10 kt |
| Coordinated power-off stall / 60 % rudder skid | ≤ 7° bank, nose to −9° / wing drops 48–58° | benign / drops a wing |
| Right rudder: take-off roll early / at rotation / Vy climb | ≈ 20–25 % / ≈ 10 % / 14 % | "right rudder", not a fight |
| Best glide, engine off, 66 KCAS | L/D 8.1 | ≈ 9 |
| Static rpm, full throttle | 2,276 | 2,300–2,400 |
| Idle rpm | 670 at 9.3 inHg | 600–700 |
| Power at 2,700 rpm, sea level | 186 hp | 180 hp |
| Short period, 100 KCAS (elevator pulse; linearised) | T 1.30 s, ζ 0.69 (1.34 s, 0.70) | T 1–1.5 s, ζ 0.6–0.8 |
| Phugoid, 100 KCAS | T 26.5 s, ζ 0.10 | 20–30 s, lightly damped |
| Dutch roll, 100 KCAS (rudder pulse) | ωn 2.47 rad/s, ζ 0.19 | 2–3 rad/s, 0.1–0.25 |
| Roll mode, 100 / 70 KCAS | τ 0.14 / 0.20 s | 0.1–0.2 s |
| Spiral, 100 / 70 KCAS (linearised) | T₂ ≈ 330 s / ≈ 20 s | neutral to slowly divergent, T₂ > 20 s |
| Touchdown, 54 KCAS flaps 30, stick at approach trim: 200 / 600 fpm | 2.0 g / 5.3 g at the CG; 0.5 / 1.3 W per main (was 2.9 W), nose leg 1.8 W as it slams down | limit gear load ≈ 3 W shared by the mains at 516 fpm (FAR 23) |
| Gear collapse / propeller strike | ≈ 1,000–1,100 fpm (nose leg) / ≈ 900 fpm nose first | — |
| Dryden σ (30–300 m AGL, W20 30 kt; 3,000 m moderate) | within 3 % of MIL-F-8785C | ±20 % |
| Rigid body, 20 s torque-free tumble with Ixz and rotor H | energy and inertial angular momentum to < 1e-8 | conserved |
| Trim, 55–140 KCAS × γ ±5° × flaps 0/30 × 0–3,000 m | residual < 1e-5 wherever the throttle is inside its range; power-limited points fail at the stop | — |

Mode values come from Prony fits of pulse responses (`dynamics.test.ts`) and agree with
eigenvalues of the linearised discrete step to a few per cent.

Tests (`npx vitest run src/fdm`): atmosphere, config integrity, every aero sign and damping
derivative, finite coefficients over the full α/β sphere and at zero airspeed, engine points,
trim and 60 s hands-off hold, control signs, left-turning tendencies, stall, climb, cruise,
glide, parking without creep (engine off and idling), a full take-off, 120 s of random inputs
from inverted/vertical attitudes, determinism with turbulence, serialise/restore, rebase,
and performance (100 s of flight in well under 5 s). `dynamics.test.ts` checks the physics
against closed-form answers (energy and angular-momentum conservation, free fall, gyroscopic
and ARP-transfer moments, the wind→body force transform, propeller formulas, units and signs,
Dryden statistics, tyre-force signs, brake anchors), the five dynamic modes and the handling
qualities above. `review.test.ts` pins defects found in review: trim convergence and failure
reporting, touchdown loads and crash detection, rebase (published state, brake anchors),
restoring into a fresh instance, non-finite inputs and time steps, and the stall-warning margin.
`aircraft/cub.test.ts` covers the Super Cub: config and C.G. envelope, engine, trim and Cm_α,
stalls, climb, top speed and cruise, take-off and landing rolls, the three-point attitude at rest,
tail lift, taxi turns and brake pivots (swivel breakout and relock), ground loops, touchdown loads,
the 14 V system and engine start, and save/restore while the tail wheel castors. Its pilots are the
shared ones in `testing.ts` (`SpeedHold`, `levelWings` with a lighter yaw gain, the cascaded
`AltitudeHold`, and `touchdownArrival`, which sets up a steady 1 g arrival in a given attitude and
sink rate) plus rudder/brake pilots for the ground. `aircraft/cubGroundReview.test.ts` adds S-turns
that must not unlock the tail wheel and a breakaway with the wheel left swivelled after a pivot (it
must not skid).

## Known limitations

- Single-engine piston only (`turbofan` specs are rejected); the jet archetype in the research
  is not implemented yet.
- No icing, carburettor heat or engine damage; a propeller strike or leg collapse only sets the
  crash flag.
- Gyroscopic and P-factor effects use the CG airspeed (rates at the hub are ignored).
- Nose-wheel castering beyond the steering range is not modelled for the C172 (its nose wheel has no
  `swivel`). The Cub's tail-wheel steering is rigid up to the breakout force (the spring compliance is
  folded into its cornering stiffness), a castering wheel aligns instantly (no swivel dynamics or
  shimmy), and tyres have no scrub torque, so a brake pivot under power keeps accelerating until the
  pilot stops it with the brakes.
- Super Cub: the take-off run at 1,750 lb is ≈ 1.5 × the handbook's 200 ft (the airframe lifts off
  near its three-point-attitude 1 g speed, ≈ 38 kt); solo it is ≈ 150 ft. The fuel metering is the
  servo-injector law shared with the C172 (a float carburettor enriches less with altitude). The
  bungee legs are linear springs (no preload).
- The drag polar is JSBSim's, so best glide L/D is slightly below the POH figure.
- `trim()` trims pitch only (α, elevator, throttle) at the current flap angle; ailerons and rudder
  sit at their rigged neutral. The config's `aileron.rigNorm` / `rudder.rigNorm` model the
  ground-adjusted tabs: the C172S is rigged for hands-off flight at 105 KCAS (wings level, ball
  centred; `rigging.test.ts`). Climb power still needs right rudder and idle a little left.
  Call `snapControls(inputs)` after `reset()` to put the flaps at their detent before `trim()`.
- The spiral mode is divergent at low speed (T₂ ≈ 20 s at 70 KCAS, faster to the right) because
  the reference data's Clr grows with α; it is neutral in cruise.
- Full brake uses the tyre's static friction (JSBSim's anti-skid assumption), so the landing roll
  is ≈ 25 % shorter than the POH, whose figure reflects torque-limited brakes.
- The main-gear spring rate is JSBSim's (78.8 kN/m per leg), so a 600 fpm arrival peaks at
  ≈ 4.6–5.3 g at the CG (≈ 1.3 W per main, close to the FAR 23 limit landing load, plus the nose leg
  slamming down if the stick is not held back). Anything that treats > 3.8 g as a crash flags
  arrivals above ≈ 400–500 fpm. The legs have no bump stop: struts compress linearly until the
  collapse limits (0.4 m or 3 W).
- The local frame is flat: a rebase 20 km out tilts gravity and the ground by ≈ 3 mrad, so a
  parked aircraft re-settles by a few millimetres.
- Hot path: no closures, tuples or literals per step, and `Math.hypot` (which allocates in V8) is
  avoided. V8's sampling heap profiler on a bundled build shows ≈ 0 B per step. Under vitest's
  module loader V8 does not inline across modules, so heap deltas there are not meaningful.

## Tuning knobs

`aircraft/cub.ts`: `CL_NORMAL` (CLmax and its α relative to the three-point attitude), `Cm.Cm0` /
`Cm.alpha` (trim and stability), `CD.CD0` / `K_INDUCED` and the propeller `Ct` (climb, top speed),
`slipstreamImmersion` (tail lift on the take-off roll, rudder power at taxi speeds), gear `k` /
`cRebound` (bounce), `brakeMu` (landing roll vs nose-over), `swivel` (breakout and relock),
`Cn.slipstream` (left-turning tendency), `controls.*.rigNorm` (hands-off cruise).

`aircraft/c172.ts`: `aero.CL.table` (CLmax), `aero.Cm.alpha` (pitch stability), `aero.Cn.dr`
(rudder authority), propulsion `VE`/`ISFC`/`frictionA` (power and idle), throttle areas
(MAP response), gear `k`/`cComp`/`cRebound` (ground feel and touchdown loads), `ALPHA_WARN` in
`fdm.ts` (stall-warning margin), `controls.trim.elevatorFraction`
(trim authority), `propeller.pFactorM` and `aero.Cn.slipstream` (left-turning tendencies).
