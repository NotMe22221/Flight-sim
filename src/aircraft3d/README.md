# aircraft3d — procedural Cessna 172 for the render scene

Low-poly, fully procedural C172 (no asset files) with animated control surfaces, propeller,
gear and lights, a cockpit interior with moving controls and an instrument-panel plane for the
instruments module. Also home of the FDM ↔ Three.js frame conversions (`frames.ts`).

## Frames (docs/DESIGN.md, non-negotiable)

| Frame | Axes |
|---|---|
| Physics world | NED (north, east, down) |
| Body | FRD (x forward, y right, z down); `qNB` rotates NED → body, scalar-first |
| Render world | x = East, y = Up, z = South: `(x3, y3, z3) = (E, −D, −N)` |
| Model local | nose −Z, up +Y, right wing +X, origin at the empty CG |

`bodyQuatToThree(qNB)` = `(x: −qNB.y, y: qNB.z, z: qNB.x, w: qNB.w)`, the DESIGN.md mapping
`(x: qE, y: −qD, z: −qN, w)` of `q_bn = conj(qNB)`. Body and NED vectors map to Three.js with
the same permutation `(a, b, c) → (b, −c, −a)`, a proper rotation (det +1).

## API

```ts
import { AircraftModel, bodyQuatToThree, nedToThreeVec } from './aircraft3d';

const model = new AircraftModel(fdm.config /* or c172ModelConfig() */, { registration: 'N172FS' });
scene.add(model.root);
model.panelMesh.material.map = panelCanvasTexture;       // from the instruments module

// every render frame, after interpolating the FDM state:
nedToThreeVec(state.posNED, pos); bodyQuatToThree(state.qNB, quat);
model.setPose(pos, quat);
model.update(state, controlInputs, dtReal, camera.isCockpit);
model.setSunElevation(sun.elevationRad);                 // spotlights in the cockpit view at night
camera.update(dtReal, state, pos, quat, input, model.eyePointLocal);
```

| Member | Purpose |
|---|---|
| `root` | add to the scene; driven by `setPose(posThree, qThree)` |
| `exterior`, `interior`, `cabinShell` | groups; the cabin skin + exterior glass hide in the cockpit view, the interior shows |
| `panelMesh` / `panelMeshG1000` | `Mesh<PlaneGeometry, MeshBasicMaterial>`: steam 1.0 × 0.45 m, G1000 1.0 × 0.36 m. Assign the instruments texture to `material.map`: the colour is white and a dark placeholder map is bound from the start, so no `needsUpdate` is required. `setPanelVariant('steam' \| 'g1000')` picks which is visible |
| `eyePointLocal` | pilot eye in model coordinates (from `config.geometry.eyePoint`); pass it to `CameraController.update` |
| `update(state, inputs, dt, cameraIsCockpit)` | surfaces, prop, gear, lights, yoke/pedals/knobs, cockpit/exterior switch; allocation-free |
| `setVisibility(exterior, interior)` | master switches (e.g. hide the airframe for a "no aircraft" view) |
| `setSunElevation(rad)` | below `nightSunElevationRad` (−3°) the spotlights also light the cockpit view |
| `surfaces`, `propeller`, `gear`, `lights`, `cockpit`, `materials`, `layout` | sub-assemblies (read-only use) |
| `dispose()` | geometries, materials, textures, light shadows; idempotent; removes `root` from its parent |
| `frames.ts` | `bodyQuatToThree`, `threeQuatToBody`, `bodyVecToThreeLocal`, `threeLocalToBodyVec`, `nedToThreeVec`, `threeVecToNed` (all write into `out`) |
| `c172ModelConfig()` | stand-alone config (also the test fixture); `resolveC172Layout(cfg)` gives every placement |

## How it works

- **Geometry**: the fuselage is a superellipse loft through stations (`loft.ts`; cowl, cabin,
  tailcone); window glass and the cockpit lining are patches of the same surface offset along
  the normal, so they always hug the skin. Wings, stabiliser, fin and prop blades loft a
  NACA 4-digit polygon through span sections (`airfoil.ts`); the left side is the mirrored right.
- **Control surfaces** (`hinge.ts`): each surface is built at zero deflection, then wrapped in
  a `mount` (on the hinge line, local X — or Y for the rudder — along the hinge) and a `pivot`
  child. `update` writes one Euler component on the pivot, so deflection is about the real,
  swept/dihedral hinge line. Signs: elevator `+δe` TE down; each aileron `+` TE down
  (`aileronLeftRad`/`aileronRightRad` per surface); flaps `+deg` down; rudder `+δr` TE left.
- **Propeller**: blades spin at the true rate (`sense +1` = clockwise from behind) below
  ~450 rpm; a translucent radial-blur disc fades in over 330–520 rpm.
- **Gear**: the nose strut telescopes by `compressionM` and steers with `steerRad` (+ = right);
  the spring-steel main legs shorten along their axis so the axle rises by `compressionM`;
  wheels turn by `wheelSpeedMs / tyreRadius`. Gear layouts are matched to `state.gear[i]` by
  the index in `config.gear` (structure contacts are skipped).
- **Lights**: nav red left / green right / white tail; beacon 1 Hz (0.12 s on); strobes double
  flash every 1.5 s. Landing/taxi `SpotLight`s: the cockpit switch sets `visible`, the
  "allowed" gate (external view or night) sets `intensity`, so camera switches never change
  the scene's light count (which would rebuild every lit material's program).
- **Cockpit**: yokes slide 7 cm fore/aft with `pitch` and turn ±75° with `roll` (clockwise
  for roll right); pedals ±6 cm with `yaw`; throttle/mixture knobs push in with the lever.
- **Livery**: a 1024 × 512 `CanvasTexture` (cheat line, cowl anti-glare panel, registration
  on both sides, mirrored correctly for each side). In Node (tests) it is `null` and the
  fuselage falls back to plain paint.
- **Materials**: built-in three.js materials only (Standard/Physical/Basic/Sprite), so the
  logarithmic-depth fallback works without custom shader chunks.

## C172 numbers (docs/research/02 §2.1, §4.7, §5.1, §6)

Span 11.0 m, S 16.2 m², MAC 1.49 m, length 8.28 m, height 2.72 m, dihedral 1.7°; prop 76 in
(1.93 m), hub 1.98 m ahead of and 0.07 m below the CG; nose gear FS −6.8 in and mains FS 58.2 in
relative to CG FS 41 (wheelbase 65 in = 1.65 m), real 172S track 100 in (2.54 m); tyres 0.18 /
0.22 m; eye in the left seat just ahead of the FS 36 pilot station. When the FDM's
`AircraftConfig` is passed, eye point, prop hub/diameter/blades/sense, gear contacts, tyre radii
and span come from it, so model and physics agree.

## Tests

`npx vitest run src/aircraft3d`

- `frames.test.ts`: identity; pitch up ⇒ nose +y; roll right ⇒ right wing −y; heading 090 ⇒
  nose +x; heading 180; equivalence with rotating body axes by `q_bn`; round trips.
- `c172Layout.test.ts`: fixture numbers against the spec (above); FRD → model mapping; nav
  light sides; dihedral and flap/aileron spans.
- `AircraftModel.test.ts`: scene graph and panel planes (white colour + bound placeholder map);
  overall extents; surface sign conventions; every hinge rotates about its own hinge line;
  prop blades/disc and spin direction; gear compression, steering and wheel spin; NaN samples
  do not poison accumulators; light timing and spotlight gating; cockpit/exterior switching;
  cockpit controls follow inputs; pose and idempotent dispose (shared sprite geometry kept).

## Known limitations

- The fuselage, wing and tail shapes are fixed C172 geometry; only the config-driven parts move.
- Counter-rotating props (`sense −1`) spin the right way but the blade twist is not mirrored.
- Light halos are world-sized sprites (0.3–0.9 m), so nav lights fade out beyond a few km at
  night; a screen-space minimum size would need a custom shader.
- The spring-steel main legs shorten along their axis instead of bending outward.
- No damage states, doors, or reflections on the glass (no transmission pass).

## Tuning knobs

`AircraftModelOptions`: `registration`, `shadows`, `landingLightIntensity` (4000 cd),
`taxiLightIntensity` (2500 cd), `spotShadows` (false; a shadow pass whenever the switch is on),
`nightSunElevationRad` (−3°). In code: `c172Layout.ts` (stations, windows, wing/tail planforms,
light positions), `materials.ts` (colours, roughness, glass opacity), `propeller.ts`
(330–520 rpm blur ramp, 450 rpm blade cut-off), `lights.ts` (flash timing).
