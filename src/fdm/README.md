# Flight dynamics model (`src/fdm`)

Six-degree-of-freedom rigid-body flight model for a Cessna 172S, implementing the
`FlightModel` contract in `src/core/types.ts`. No Three.js; runs in Node for tests.
Specification and sources: `docs/research/02-flight-dynamics-model.md`.

## API

```ts
import { Fdm, C172S } from './fdm';
const fdm = new Fdm(C172S, { seed: 1 });          // seed drives the turbulence PRNG
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
| `atmosphere.ts` | ISA 0–20 km with ΔT and QNH, CAS/TAS/EAS, indicated altitude, 172S airspeed calibration |
| `aircraft/c172.ts` | The complete `AircraftConfig`: geometry in body axes from JSBSim's structural frame, mass, every aero table, engine, propeller, gear, controls, limits |
| `aero.ts` | Coefficient build-up (JSBSim c172p form): α table with stall hysteresis, flaps, ground effect, rate and control derivatives, α̇ terms on q̄ of the u–w plane, elevator/rudder in the slipstream, spiralling-slipstream yaw, high-α fades, flat-plate blend beyond 0.36 rad |
| `propulsion.ts` | Throttle-orifice manifold (MAP is a state), airflow-based power with mixture efficiency, Coulomb + viscous friction and pumping losses, starter, NACA-640 propeller with J² extrapolation, slipstream, P-factor, reaction torque, gyroscopic momentum |
| `gear.ts` | Spring/damper struts with compression-rate clamp, Pacejka side force, rolling and brake friction, nose-wheel steering, brake anchors (static friction), structure points and crash detection (leg collapse above 3 W, propeller strike at the bottom of the disc) |
| `turbulence.ts` | MIL-F-8785C Dryden (discrete form), seeded serialisable PRNG |
| `massProps.ts` | Composite mass, CG and inertia from empty airframe, stations and tanks (every step) |
| `fdm.ts` | State vector, RK4, actuators (lags, rate limits, flap motor, trim tab), input sanitising, wind/turbulence sampling, fuel burn, engine temperatures, trim (Newton with the throttle stops as an active set), ground settling, rebase, serialisation, AircraftState outputs and warnings |
| `grid.ts` | Allocation-free bilinear table used in the hot path |
| `electrical.ts` | C172S 28 V system: 24 V 12.75 Ah battery (open-circuit voltage from charge, ohmic + polarisation sag), 60 A alternator (field excitation needs BAT, output falls below ~1700 rpm), split master BAT/ALT, avionics master, switched loads, LOW VOLTS below 24.5 V. The starter cranks only as hard as the battery terminal voltage allows (a flat battery will not start the engine; the master must be on). `AircraftState.electrical` publishes it; `ControlInputs.masterBattery / masterAlternator / avionicsMaster / fuelPump` drive it (undefined = on, on, on, off) |

Conventions: SI, NED world frame, FRD body frame, JSBSim control signs (see `docs/DESIGN.md`).
The integrated attitude is the body→NED quaternion; `AircraftState.qNB` is its conjugate.

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

## Known limitations

- Single-engine piston only (`turbofan` specs are rejected); the jet archetype in the research
  is not implemented yet.
- No icing, carburettor heat or engine damage; a propeller strike or leg collapse only sets the
  crash flag.
- Gyroscopic and P-factor effects use the CG airspeed (rates at the hub are ignored).
- Nose-wheel castering beyond the steering range is not modelled.
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

`aircraft/c172.ts`: `aero.CL.table` (CLmax), `aero.Cm.alpha` (pitch stability), `aero.Cn.dr`
(rudder authority), propulsion `VE`/`ISFC`/`frictionA` (power and idle), throttle areas
(MAP response), gear `k`/`cComp`/`cRebound` (ground feel and touchdown loads), `ALPHA_WARN` in
`fdm.ts` (stall-warning margin), `controls.trim.elevatorFraction`
(trim authority), `propeller.pFactorM` and `aero.Cn.slipstream` (left-turning tendencies).
