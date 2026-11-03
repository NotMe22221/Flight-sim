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
fdm.rebase(rotation, translationNED);              // floating origin (see src/world/rebase.ts)
fdm.serialize(); fdm.deserialize(json);            // bit-exact save/restore
fdm.setAltimeter(pa); fdm.bestPowerMixture(); fdm.clearCrash();
```

## How it works

| File | Content |
|---|---|
| `atmosphere.ts` | ISA 0–20 km with ΔT and QNH, CAS/TAS/EAS, indicated altitude, 172S airspeed calibration |
| `aircraft/c172.ts` | The complete `AircraftConfig`: geometry in body axes from JSBSim's structural frame, mass, every aero table, engine, propeller, gear, controls, limits |
| `aero.ts` | Coefficient build-up (JSBSim c172p form): α table with stall hysteresis, flaps, ground effect, rate and control derivatives, α̇ terms on q̄ of the u–w plane, elevator/rudder in the slipstream, spiralling-slipstream yaw, high-α fades, flat-plate blend beyond 0.36 rad |
| `propulsion.ts` | Throttle-orifice manifold (MAP is a state), airflow-based power with mixture efficiency, Coulomb + viscous friction and pumping losses, starter, NACA-640 propeller with J² extrapolation, slipstream, P-factor, reaction torque, gyroscopic momentum |
| `gear.ts` | Spring/damper struts with compression-rate clamp, Pacejka side force, rolling and brake friction, nose-wheel steering, brake anchors (static friction), structure points and crash detection |
| `turbulence.ts` | MIL-F-8785C Dryden (discrete form), seeded serialisable PRNG |
| `massProps.ts` | Composite mass, CG and inertia from empty airframe, stations and tanks (every step) |
| `fdm.ts` | State vector, RK4, actuators (lags, rate limits, flap motor, trim tab), wind/turbulence sampling, fuel burn, engine temperatures, trim (Newton), ground settling, rebase, serialisation, AircraftState outputs and warnings |

Conventions: SI, NED world frame, FRD body frame, JSBSim control signs (see `docs/DESIGN.md`).
The integrated attitude is the body→NED quaternion; `AircraftState.qNB` is its conjugate.

## Validation (C172S at 2,550 lb, ISA, measured by the tests' pilot models)

| Check | Model | POH |
|---|---|---|
| Climb at Vy, sea level, full power | 733 fpm | 730 fpm |
| Cruise, 8,000 ft, full throttle leaned | 123.6 KTAS, 2,669 rpm, 73 %, 11.7 gph | 124 KTAS at 75 % |
| Take-off ground roll, flaps 10 | 932 ft | 960 ft |
| Stall, flaps up / 30 (altitude-hold entry) | 57.7 / 51.0 KCAS | 53 / 48 KCAS |
| Best glide, engine off, 66 KCAS | L/D 8.1 | ≈ 9 |
| Static rpm, full throttle | 2,276 | 2,300–2,400 |
| Idle rpm | 670 at 9.3 inHg | 600–700 |
| Power at 2,700 rpm, sea level | 186 hp | 180 hp |

The stall entries in the tests decelerate slightly faster than 1 kt/s, so they read a few
knots above the steady 1 g value (≈ 54 KCAS computed from CLmax 1.57 and the trim elevator).

Tests (`npx vitest run src/fdm`): atmosphere, config integrity, every aero sign and damping
derivative, finite coefficients over the full α/β sphere and at zero airspeed, engine points,
trim and 60 s hands-off hold, control signs, left-turning tendencies, stall, climb, cruise,
glide, parking without creep (engine off and idling), a full take-off, 120 s of random inputs
from inverted/vertical attitudes, determinism with turbulence, serialise/restore, rebase,
and performance (100 s of flight in well under 5 s).

## Known limitations

- Single-engine piston only (`turbofan` specs are rejected); the jet archetype in the research
  is not implemented yet.
- No icing, carburettor heat, engine damage or prop strike modelling beyond a crash flag.
- Gyroscopic and P-factor effects use the CG airspeed (rates at the hub are ignored).
- Nose-wheel castering beyond the steering range is not modelled.
- The drag polar is JSBSim's, so best glide L/D is slightly below the POH figure.

## Tuning knobs

`aircraft/c172.ts`: `aero.CL.table` (CLmax), `aero.Cm.alpha` (pitch stability), `aero.Cn.dr`
(rudder authority), propulsion `VE`/`ISFC`/`frictionA` (power and idle), throttle areas
(MAP response), gear `k`/`cComp`/`cRebound` (ground feel), `controls.trim.elevatorFraction`
(trim authority), `propeller.pFactorM` and `aero.Cn.slipstream` (left-turning tendencies).
