# aircraft3d — procedural aircraft for the render scene

Low-poly, fully procedural airframes (no asset files) with animated control surfaces,
propeller, gear and lights, a cockpit interior with moving controls and an instrument-panel
plane for the instruments module. Also home of the FDM ↔ Three.js frame conversions
(`frames.ts`).

| `AircraftConfig.airframe` | Airframe | Layout | Builders |
|---|---|---|---|
| `'c172'` (default, also when absent) | Cessna 172S, tricycle gear, side-by-side cockpit (steam or G1000 panel) | `c172Layout.ts` | `fuselage.ts`, `wings.ts`, `tail.ts`, `gear.ts`, `interior.ts` |
| `'cub'` | Piper PA-18-150 Super Cub class tail-dragger, tandem cockpit flown from the front seat (`'cub-steam'` panel) | `cubLayout.ts` | `fuselage.ts`, `cubWings.ts`, `cubTail.ts`, `cubGear.ts`, `cubInterior.ts` |

Both share the loft / skin / airfoil / hinge builders, `Propeller`, `AircraftLights` and the
materials; `layoutTypes.ts` holds the shared layout types and `toModelConfig`.

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

const model = new AircraftModel(fdm.config /* or c172ModelConfig() / cubModelConfig() */, { registration: 'N172FS' });
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
| `airframe` | `'c172'` or `'cub'` (from `config.airframe`) |
| `root` | add to the scene; driven by `setPose(posThree, qThree)` |
| `exterior`, `interior`, `cabinShell` | groups; the cabin skin + exterior glass hide in the cockpit view, the interior shows |
| `panelMesh` / `panelMeshG1000` | `Mesh<PlaneGeometry, MeshBasicMaterial>`: steam 0.96 × 0.48 m (C172) or 0.60 × 0.30 m (Cub), both 2:1 like the 1024 × 512 texture, G1000 0.96 × 0.35 m. Assign the instruments texture to `material.map`: a dark placeholder map is bound from the start, so no `needsUpdate` is required. The material colour is the light on the gauges (white by day, see *Cockpit*); never set it to a dark tint. `setPanelVariant('steam' \| 'g1000')` picks which is visible; the Cub has no glass cockpit, so it keeps its panel and `panelMeshG1000` stays a hidden stand-in |
| `eyePointLocal` | pilot eye in model coordinates (from `config.geometry.eyePoint`); pass it to `CameraController.update` |
| `update(state, inputs, dt, cameraIsCockpit)` | surfaces, prop, gear, lights, yoke/pedals/knobs, cockpit/exterior switch; allocation-free |
| `setVisibility(exterior, interior)` | master switches (e.g. hide the airframe for a "no aircraft" view) |
| `setSunElevation(rad)` | below `nightSunElevationRad` (−3°) the spotlights also light the cockpit view; the cabin bounce light and the instrument lighting follow the daylight (sun −6° … +15°) |
| `surfaces`, `propeller`, `gear`, `lights`, `cockpit`, `materials`, `layout` | sub-assemblies (read-only use). `gear` is a `GearAssembly` (`noseRoot` / `tailRoot` steering pivots, `carrierFor(i)`, `wheelFor(i)`), `cockpit` a `CockpitAssembly` (`yokeGroups`: the C172's yokes or the Cub's front and rear sticks), `layout` a `C172Layout \| CubLayout` (narrow with `layout.airframe`) |
| `dispose()` | geometries, materials, textures, light shadows; idempotent; removes `root` from its parent |
| `frames.ts` | `bodyQuatToThree`, `threeQuatToBody`, `bodyVecToThreeLocal`, `threeLocalToBodyVec`, `nedToThreeVec`, `threeVecToNed` (all write into `out`) |
| `c172ModelConfig()` / `cubModelConfig()` | stand-alone configs (also the test fixtures); `resolveC172Layout(cfg)` / `resolveCubLayout(cfg)` give every placement |

## How it works

- **Fuselage** (`fuselage.ts`, `loft.ts`, `skin.ts`): one superellipse loft from the spinner to
  the tail, split into three regions of the same surface so they shade seamlessly: the cowl
  (always visible, also over the glareshield), the cabin shell (hidden in the cockpit view) and
  the tailcone. Windows and door seams are rounded convex outlines in the side view (z, y),
  turned into signed distance fields; `buildSkin` keeps the grid cells outside every window and
  clips cells along the zero level set by bisection, so window edges are smooth curves. Glass,
  rubber gaskets and door seams are patches of the same surface offset along the analytic
  normal. A dark inner face of the cabin skin makes the windows read as tinted glass over a dark
  cabin from outside. The nose bowl is sampled finely (its radius doubles within 8 cm) and
  carries the two cooling-air inlets beside the spinner (a skin patch clipped by a front-view
  field); an exhaust stack under the cowl and a raked COM whip on the tailcone complete the
  silhouette (`layout.details`).
- **Cockpit** (`interior.ts`): a lining that follows the fuselage profile 3 cm inside the skin
  with the same window cut-outs (reveals face into each opening), fabric door panels, a padded
  glareshield hood whose lip covers the top of the panel planes, the panel board 1.5 cm behind
  the planes (its top edge stays under the lip, so the cowl shows over the glareshield), floor,
  firewall, seats, yokes, pedals, throttle and mixture. Yokes slide 7 cm fore/aft with `pitch`
  and turn with `roll` (clockwise for roll right); their shafts enter the panel below the
  six-pack. Pedals ±6 cm with `yaw`; the knobs push in with the levers. The interior casts but
  does not receive the sun's shadow map (its texels are ~0.2 m: blotches); a warm emissive
  "bounce" term scaled with daylight stands in for light bounced around the cabin.
- **Panel placement**: centred on the aircraft centreline 0.65 m ahead of the eye, top edge
  ≈ 0.19 m below the eye just under the glareshield lip, tilted back 8°. The six-pack is the left
  47 % of the steam texture, so it lands straight ahead of the left-seat eye; from the seat the
  instruments fill the bottom ~35 % of a 65–75° view with the cowl top visible over the
  glareshield.
- **Instrument lighting**: the panel planes are unlit, so `material.color` is the light on the
  gauges: max(daylight, warm post lights at `ControlInputs.lights.panel`) with a dim floor
  (≈ 35 % perceived) so a night spawn with the panel lights off stays readable; the G1000
  screens are emissive and only dim to 55 %.
- **Control surfaces** (`hinge.ts`): each surface is built at zero deflection, then wrapped in
  a `mount` (on the hinge line, local X — or Y for the rudder — along the hinge) and a `pivot`
  child. `update` writes one Euler component on the pivot, so deflection is about the real,
  swept/dihedral hinge line. Signs: elevator `+δe` TE down; each aileron `+` TE down
  (`aileronLeftRad`/`aileronRightRad` per surface); flaps `+deg` down; rudder `+δr` TE left.
- **Propeller**: blades spin at the true rate (`sense +1` = clockwise from behind) below
  ~450 rpm; a translucent radial-blur disc fades in over 330–520 rpm (fainter from the cockpit).
- **Gear**: the nose strut telescopes by `compressionM` and steers with `steerRad` (+ = right);
  the white spring-steel main legs shorten along their axis so the axle rises by
  `compressionM`; wheels turn by `wheelSpeedMs / tyreRadius`. Teardrop wheel pants cover the
  upper part of each tyre. Gear layouts are matched to `state.gear[i]` by the index in
  `config.gear` (structure contacts are skipped).
- **Lathe parts** (spinner, wheel pants): `LatheGeometry` faces outward only when the profile
  runs with increasing y; a profile listed top-to-bottom is built inside-out (back faces
  culled: the spinner reads as a flat disc and the pants vanish).
- **Lights**: nav red left / green right / white tail; beacon 1 Hz (0.12 s on); strobes double
  flash every 1.5 s. Landing/taxi `SpotLight`s: the cockpit switch sets `visible`, the
  "allowed" gate (external view or night) sets `intensity`, so camera switches never change
  the scene's light count (which would rebuild every lit material's program).
- **Livery** (`textures.ts`): a 2048 × 1024 `CanvasTexture` on the fuselage UVs (u along the
  length, v around the section), so the blue cheat line with its red pinstripe follows a
  constant fraction of the section height and sweeps up the tailcone; registration on both
  sides at the right proportions. In Node (tests) it is `null` and the fuselage falls back to
  plain paint.
- **Materials**: built-in three.js materials only (Standard/Physical/Basic/Sprite), so the
  logarithmic-depth fallback works without custom shader chunks.

## Super Cub (`airframe: 'cub'`)

- **Fuselage**: the same loft/skin machinery as the C172 (`buildFuselage` takes any
  `FuselageLayout`): a blunt nose bowl with two round cooling inlets above the small spinner and
  an almost flat cowl top (it shows over the deck from the front seat), a tall narrow boxy cabin
  (superellipse n 5, 0.76 m wide, roof on the wing chord plane) and a turtle-deck tail cone to
  the tail post. Windows: the windshield, the **skylight** (a top-view outline,
  `SkinOutline.view: 'top'` with `minY` so the belly is never cut), the right **split door**
  (one big upper window, upper/lower door seams, handle on the lower half) with a small window
  behind it, the left front and rear windows. The carburettor air box under the nose
  (`details.carbScoop`), the exhaust stack under the cowl and a whip antenna on the turtle deck.
- **Wing** (`cubWings.ts`): constant 1.60 m chord flat-bottomed USA 35B-like section
  (`USA35B`: NACA 4-digit thickness with 5.5 % camber at 30 %) sitting on the cabin roof with the
  root ribs at ±0.26 m (the skylight between them), 1° dihedral, elliptical **tip bows** whose
  outermost point sits at ≈ 40 % chord; plain flaps inboard and ailerons out to the bow, hinged at
  76 % chord. **V lift struts**: front- and rear-spar struts converge on the lower longeron and
  spread to the spars at 55 % semi-span (streamlined tubes), with jury struts and a diagonal.
  Fuel caps over the wing-root tanks, pitot tube under the left wing.
- **Tail** (`cubTail.ts`): stabiliser and elevator are one planform with rounded tips, so the
  halves meet flush at the hinge (`aftPart`: the elevator is the aft part of a virtual section);
  the elevator's inboard trailing corners are cut away so the rudder can swing ±25° between them.
  A small fin and the tall rounded rudder on the tail post (the rudder is the aft 70 % of a thin
  symmetric section, thickest at the post), flying wires two above to the fin and two below to the
  tail-post bottom.
- **Gear** (`cubGear.ts`): per side a V of two legs (front leg under the bungee shock-cord
  fairing) meeting at a knuckle inboard of the fat 8.00-6 tyre, and the split axle hinged under
  the belly. `compressionM` lifts the axle; every member is re-aimed at it each frame
  (allocation-free), the fairing stays on the fuselage. The tail wheel hangs on a leaf spring:
  the fork steers about the swivel axis with 4 cm caster trail (`steerRad`, + = right, not
  clamped: the FDM's full-swivel castering angle is shown as is) and the spring flexes so the
  wheel rises by `compressionM`. Lathe-turned tyres (`buildTyreGeometry`).
- **Propeller**: the shared `Propeller` with `PropLayout.spinner` / `bladeZ`: blades in the hub
  plane, a small dark-red spinner from 8 cm behind it to its tip 12 cm ahead (x +1.92).
- **Cockpit** (`cubInterior.ts`, tandem, flown from the front seat): lining with the same
  cut-outs as the skin (fabric above the sill, upholstery below, dark window channels), the
  steel-tube frame (upper longerons, spar carry-throughs, door / window posts), a 0.60 × 0.30 m
  panel plane 0.70 m ahead of the eye with its top 0.17 m below it (2:1 like the 1024 × 512
  `cub-steam` texture; the instruments module draws into it exactly as for the C172), a padded
  lip, a short deck up to the windshield with the compass, front and rear sticks (pivot on the
  floor, ±0.2 rad with `pitch` / `roll`: the grip moves aft for nose up, right for roll right),
  rudder pedals (±5 cm), throttle (black), mixture (red) and carb heat (grey) levers on the left
  wall, the elevator trim crank (three turns over `pitchTrim` −1…+1) and the flap handle (up with
  `state.surfaces.flapDeg` / 50°) on the left, the wing-root fuel gauges overhead left and right
  (`state.fuelKg[i]` / tank capacity from `config.mass.tanks`), front sling seat and rear bench.
  Seat and stick follow the configured eye point; the panel, deck and windows are fixed airframe.
  Over the nose: the deck edge is ≈ 9° below the eye and the cowl top ≈ 6.5°, so in the
  three-point attitude (≈ 11°) the cowl hides the horizon; in flight it sits well below it.
- **Livery**: our own scheme (`CUB_PAINT`): cream-yellow fabric, a straight dark-red cheat line
  and pinstripe sweeping gently up to the tail (`LiveryScheme.lines`: heights in metres converted
  per texel column with the loft section, so the line stays straight across the cowl / cabin step),
  dark-red registration N18FS on the aft fuselage and spinner.
- **Lights**: nav lights on the tip bows' leading edges, strobes at the tips, white tail light at
  the tail-post bottom, beacon on the fin top, landing light in the left wing leading edge and the
  taxi light in the right one.

## Super Cub numbers (shared with src/fdm/aircraft/cub.ts; PA-18-150 owner's handbook / TCDS)

Body FRD relative to the empty CG: span 10.73 m (35 ft 2.5 in), S 16.58 m² (178.5 ft²), chord
1.60 m (63 in), wing LE x +0.42 / TE −1.18, chord plane z −1.02, dihedral 1°; length 6.88 m
(spinner tip +1.92, rudder TE −4.96); prop 74 in (1.88 m), hub (1.80, 0, −0.05), 2 blades,
clockwise from the cockpit; mains (0.50, ±0.92, 1.12) r 0.28 (8.00-6), tail wheel
(−4.40, 0, 0.15) r 0.08 (three-point attitude 11.2°, CG 1.0 m above the ground); eye
(0.05, 0, −0.60); tanks 2 × 18 US gal at (−0.20, ±0.80, −1.00). The V-strut fuselage fittings sit
together on the lower longeron at x +0.06 / −0.12 (a V, as on the real airframe). With the
quoted chord plane and the 11.7 % thick wing the three-point height is ≈ 2.27 m to the wing-tip
top (the handbook's 6 ft 8.5 in is lower).

## C172 numbers (docs/research/02 §2.1, §4.7, §5.1, §6)

Span 11.0 m, S 16.2 m², MAC 1.49 m, length 8.28 m, height 2.72 m, dihedral 1.7°; prop 76 in
(1.93 m), hub 1.98 m ahead of and 0.07 m below the CG; nose gear FS −6.8 in and mains FS 58.2 in
relative to CG FS 41 (wheelbase 65 in = 1.65 m), real 172S track 100 in (2.54 m); tyres 0.18 /
0.22 m; eye in the left seat just ahead of the FS 36 pilot station. When the FDM's
`AircraftConfig` is passed, eye point, prop hub/diameter/blades/sense, gear contacts, tyre radii
and span come from it, so model and physics agree.

## Tests

`npx vitest run src/aircraft3d`

- `cubLayout.test.ts`: the shared PA-18-150 numbers; FRD → model mapping; length 6.88 m from the
  spinner tip to the rudder TE; constant-chord wing on the roof with 1° dihedral and the tip bow at
  the configured span; V struts converge on the longeron; elevator cut-out clears the rudder at 25°;
  three-point attitude ≈ 11° with the CG ≈ 1 m up; eye inside the cabin behind the 2:1 panel;
  over-the-nose angle below the three-point pitch; lights; gear placement; every number finite;
  the eye and gear follow the config while the airframe stays put.
- `cubModel.test.ts`: both airframes build and update without NaN (and the FDM's own Cub config
  when it is in the tree); overall extents (span, length, three-point height and CG height);
  tyres on the configured contacts, leg members reach the moving axle under compression, tail
  spring follows; tail-wheel steering and wheel spin; surface signs and hinge lines; propeller
  from the config with the spinner tip at x +1.92; ray casts from the eye: the whole panel is
  visible, the view ahead is clear in level flight, the cowl hides the horizon in the three-point
  attitude, the sky through the skylight; no G1000; sticks / pedals / flap handle / trim crank /
  fuel gauges follow; lights; dispose frees every geometry and material.

- `frames.test.ts`: identity; pitch up ⇒ nose +y; roll right ⇒ right wing −y; heading 090 ⇒
  nose +x; heading 180; equivalence with rotating body axes by `q_bn`; round trips.
- `c172Layout.test.ts`: fixture numbers against the spec (above); FRD → model mapping; nav
  light sides; slim A-pillar and window tops under the wing root; nose inlets on the nose-bowl
  face clear of the spinner; dihedral and flap/aileron spans.
- `skin.test.ts`: window distance fields (sign, rounded corners, short edges, sides); every
  window centre lies on the skin; no skin triangle inside a window; skin + glass area equals
  the uncut skin; outward winding.
- `AircraftModel.test.ts`: scene graph, panel placement relative to the eye and glareshield
  (six-pack ahead of the left seat), panel planes (white colour + bound placeholder map);
  instrument lighting by day / night / panel lights; overall extents against the real 172
  (precise boxes: span, length 8.1–8.45 m, gear height); surface sign conventions; every hinge
  rotates about its own hinge line;
  prop blades/disc and spin direction; gear compression, steering and wheel spin; NaN samples
  do not poison accumulators; light timing and spotlight gating; cockpit/exterior switching;
  cockpit controls follow inputs; pose and idempotent dispose (shared sprite geometry kept).

## Known limitations

- The fuselage, wing and tail shapes are fixed C172 / Cub geometry; only the config-driven parts
  move (eye, prop, gear contacts and tyres, span, tank capacities).
- Cub: the fabric shows no rib-stitching; the door does not open; the trimmable stabiliser is not
  animated (the trim crank turns); the prop has no painted tips; tail-wheel steering springs to the
  rudder horns are not modelled; the instrument texture is drawn by the instruments module.
- Counter-rotating props (`sense −1`) spin the right way but the blade twist is not mirrored.
- Light halos are world-sized sprites (0.3–0.9 m), so nav lights fade out beyond a few km at
  night; a screen-space minimum size would need a custom shader.
- The spring-steel main legs shorten along their axis instead of bending outward.
- No damage states, doors, or reflections on the glass (no transmission pass).
- The panel texture is one unlit plane: the radio displays dim with the gauges at night (they
  are not separately self-lit), and there is no flood-light pooling on the panel.
- The cockpit has no magnetic compass, sun visors or headliner details; the cabin cross-section
  is a superellipse, so the door-window tops sit where the side wall turns into the roof.

## Tuning knobs

`AircraftModelOptions`: `registration` (default N172FS / N18FS), `shadows`, `landingLightIntensity` (4000 cd),
`taxiLightIntensity` (2500 cd), `spotShadows` (false; a shadow pass whenever the switch is on),
`nightSunElevationRad` (−3°). In code: `c172Layout.ts` / `cubLayout.ts` (stations, windows,
wing/tail planforms, light positions, cockpit placements, `CUB_PAINT`), `materials.ts` (colours,
roughness, glass opacity; `PaintScheme`), `textures.ts` (`LiveryScheme`), `propeller.ts`
(330–520 rpm blur ramp, 450 rpm blade cut-off), `lights.ts` (flash timing).
