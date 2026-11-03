# src/sky — sky, atmosphere and weather (Tier A)

Physically based sky dome, sun/moon/stars, lights, tone-mapping exposure, fog/aerial perspective,
cloud layers, precipitation and the weather model (presets, METAR, Open-Meteo, wind and gusts).
Spec: `docs/research/04-sky-atmosphere-weather.md` (section numbers below refer to it).

Two halves:

| Half | Files | Three.js? |
|---|---|---|
| Renderer | `SkySystem.ts`, `clouds.ts`, `precipitation.ts`, `stars.ts`, `moon.ts`, `types.ts` | yes |
| Pure model (Node-testable) | `WeatherSystem.ts`, `presets.ts`, `metar.ts`, `liveWeather.ts`, `wind.ts`, `preetham.ts`, `lighting.ts`, `cloudMath.ts` | no |

## Wiring (integrator)

```ts
import { SkySystem, WeatherSystem, fetchOpenMeteo } from './sky';

const weather = new WeatherSystem({ airportElevationM: 4, frame: localFrame.info,
  groundHeightUp: (n, e) => terrain.heightUp(n, e) /* null when unknown */, initial: 'few' });
const sky = new SkySystem(scene, renderer);          // sets ACES tone mapping + shadows on the renderer
sky.setCloudDrifts(weather.cloudDrifts);             // FDM cloud density == rendered clouds

// Environment for the FDM (core/types Environment.windNED): wind velocity TOWARD, NED, m/s
env.windNED = (n, e, d, out) => weather.windNED(n, e, d, out);

// fixed-step loop (deterministic gusts):  weather.update(DT, { tasMs, altMslM, aglM });
// per frame:                              sky.update(snapshot, camera.position, realDt);
//   snapshot = SimSnapshot (needs time, aircraft, weather = weather.state, optional frame)
// terrain/ocean shaders read sky.lighting (SkyLighting) every frame — see "Fog" below — and reference
// SKY_UNIFORMS (ambient irradiance, sky colours, cloud-shadow layers), which every SkySystem publishes
// into by default: no wiring needed (`sharedUniforms` option / TerrainSystem `skyUniforms` to isolate).

// UI
weather.setPreset('rain', 60);                       // cross-fade over 60 s sim time
weather.applyMetar('KSFO 021856Z 28012G18KT 10SM FEW012 18/11 A3005', 4);
const live = await fetchOpenMeteo(lat, lon, { utcMs, elevationM }); if (live) weather.applyLive(live);
// then emit 'weather:changed' and show OPEN_METEO_ATTRIBUTION when live data is used.

// floating-origin rebase (RebaseTransform t = translationNED of the NEW origin in the OLD frame)
const shift = new THREE.Vector3(t[1], -t[2], -t[0]);  // render frame (x E, y U, z S)
weather.notifyRebase(shift.x, shift.z);
sky.notifyRebase(shift);
```

## Conventions

- SI internally. Wind layers store the meteorological **FROM** direction (deg true) and knots
  (`core/types WindLayer`); every vector returned (`windAt`, `windNED`, gusts) is wind **velocity**
  in NED (where the air moves **TO**): FROM 270° at 10 kt → `[0, +5.144, 0]` m/s.
- Render frame x = East, y = Up, z = South; NED → render is `(E, −D, −N)`. Sun/moon azimuths are
  clockwise from true north; `dirFromAzEl(az, el) = (cos el·sin az, sin el, −cos el·cos az)`.
- Cloud bases/tops and wind-layer altitudes are **MSL**. Render y is height above the floating
  origin, so `MSL = y + frame.alt0` (`SkySnapshot.frame` is optional; `world/rebase` frames use alt0 = 0).
  `WeatherSystem.cloudDensityAt(x, y, z)` takes render x/z and **MSL** y; `SkySystem.cloudDensityAt`
  takes a render-frame point.
- Colours in `SkyLighting` are linear and pre tone mapping. Sky colours (`skyColorZenith`, `skyColorHorizon`,
  `skyFogColor`, `sunRadiance`) are radiance in the dome's (Preetham) scale; the haze (`fogColor`,
  `sunGlowColor`) and `ambientIrradiance` are in three's light units (the scale a lit surface's radiance has,
  albedo/π · irradiance), so ground objects fade to a colour lit like themselves. `fogColorEncoded` is the
  tone-mapped + sRGB display value. Custom shaders mix fog **before**
  `#include <tonemapping_fragment>`, like the sky dome and cloud planes.
- Custom `ShaderMaterial`s here include the `logdepthbuf` chunks (clouds, precipitation) or force the
  far plane in both depth modes (sky, stars, moon), so they work with logarithmic depth (Firefox:
  no `EXT_clip_control`) and with the reversed depth buffer.

## Public API (`src/sky/index.ts`)

### `SkySystem` (renderer)
- `new SkySystem(scene, renderer, options?: SkySystemOptions)` — adds sky dome, sun/moon
  `DirectionalLight`s, `HemisphereLight`, ambient floor, `FogExp2`, stars, moon, cloud planes and
  precipitation to `scene`; sets `renderer.toneMapping` (ACES) and shadow maps; installs the built-in
  height fog (`builtinHeightFog`, default true) and publishes `sharedUniforms` (default `SKY_UNIFORMS`, `null` = none).
- `update(snapshot: SkySnapshot, cameraPosThree: Vector3, dt: number): void` — `dt` real seconds;
  weather evolution (cloud drift) uses `dt × time.timeScale`.
- `readonly lighting: SkyLighting` — per-frame values for other renderers (below).
- `readonly sun: SunState` — core contract (elevation/azimuth rad, `dirThree`, moon elevation/azimuth/phase).
- `cloudDensityAt(posThree): number`, `setCloudDrifts(drifts | null)`, `notifyRebase(originShiftThree)`,
  `setWeather(w)`, `resetAdaptation()` (snap exposure after a time jump), `bakeEnvironment()`,
  `currentExposure`, `currentWeather`, `dispose()`.
- Readonly members: `sky`, `sunLight`, `moonLight`, `hemiLight`, `ambientLight`, `fog`, `stars`,
  `moon`, `clouds`, `precipitation`, `preetham` (CPU twin of the dome), `exposureOptions`.
- `patchSkyDepth(material)` — keeps the r187 `Sky` dome at the far plane under reversed depth.
- `patchSkyDome(material)` — the dome's look patches (in-scatter knee, night glow), mirrored by `PreethamSky`.

### `SkyLighting` (from `types.ts`, mutated in place every frame)
`sunDirThree`, `sunColor` (hue, max channel 1), `sunIntensity`, `skyColorZenith`, `skyColorHorizon`,
`fogColor` (haze at 90° from the sun), `fogDensity` (β0, m⁻¹), `fogHeightFalloff` (1/H, m⁻¹), `exposure`,
`ambientIntensity`, plus `fogColorEncoded`, `fogExp2Density`, `sunRadiance`, `sunGlowColor` (haze looking
at the sun), `skyFogColor` (what objects seen against the sky fade to), `ambientIrradiance` (up-facing
surface, = hemisphere sky colour × intensity + ambient floor), `moonDirThree`, `moonIntensity`, `moonColor`,
`sunElevationDeg`, `cloudCover`, `starVisibility`, `inCloud`, `groundY`.
`HEIGHT_FOG_GLSL` provides `heightFogOpticalDepth(...)` / `heightFogFactor(origin, dir, dist, beta0, invH, groundY)`;
`HAZE_LOBE_GLSL` provides `hazeSunLobe(cosθ)` (mix `fogColor` → `sunGlowColor` by it).

### Shared uniforms (`skyUniforms.ts`) and built-in fog (`builtinFog.ts`)
- `SKY_UNIFORMS` / `createSkySharedUniforms()` / `SkySharedUniforms`: `uSkyLinked`, `uSkyIrradiance`,
  `uSkyZenith`, `uSkyHorizon`, `uSkyExposure`, cloud-shadow layers `uCloudShadowCount/A/B`,
  `uCloudShadowStrength/Floor/Norm`. Spread the objects into a material's uniforms (by reference).
  `SKY_UNIFORMS_GLSL` declares them and defines `skyCloudShadow(worldPos, sunDir)` (needs `CLOUD_OCTAVES`);
  `cloudShadowAt(u, x, y, z, sunX, sunY, sunZ)` is its CPU twin.
- `installBuiltinHeightFog()` / `setBuiltinHeightFog(...)`: see "Fog" below; `SkySystem` calls both.

### `WeatherSystem` (pure)
- `new WeatherSystem({ airportElevationM?, seed?, frame?, groundHeightUp?, z0?, initial?, gust?, defaultTransitionS? })`
- `readonly state: WeatherState` (mutated in place — safe to hold), `gusts: GustModel`,
  `transitioning`, `transitionProgress`, `target`.
- `setPreset(id, transitionS = 60)`, `setState(w, transitionS = 0)`,
  `applyMetar(raw, stationElevationM?, transitionS = 0): MetarReport`, `applyLive(w, transitionS = 30)`.
- `update(dt, air?: { tasMs, altMslM, aglM })` — transitions, gusts, cloud drift (sim seconds).
- `windAt(posNED, out?)`, `windNED(n, e, d, out)`, `windAtAltitude(altMsl, agl, out?)` — NED m/s, TO.
- `cloudDensityAt(x, yMsl, z)`, `cloudDensityAtNED(n, e, d)` — 0..1.
- `cloudDrifts`, `notifyRebase(dxEast, dzSouth)`, `setAirportElevation(m)`, `setFrame(frame)`.

### Weather sources and models (pure)
- `presets.ts`: `WEATHER_PRESETS`, `WEATHER_PRESET_IDS` (the nine MSFS presets), `weatherFromPreset(id, airportElevM)`
  (AGL table → MSL `WeatherState`), `COVERAGE` (FEW .19 / SCT .44 / BKN .75 / OVC 1), `cloneWeather`, `defaultWeather`, `presetName`.
- `metar.ts`: `parseMetar(raw, stationElevM): MetarReport` (never throws; `.weather` is the derived
  `WeatherState`, `.unparsed` lists unknown tokens), `weatherFromMetar`, `relativeHumidity` (Magnus).
- `liveWeather.ts`: `fetchOpenMeteo(lat, lon, { utcMs?, elevationM?, fetchImpl?, timeoutMs? })` → `WeatherState | null`,
  `openMeteoToWeatherState(json, utcMs, elevM?)`, `openMeteoUrl`, `nearestHourIndex`, `fetchMetarText(icao)` (best effort),
  `OPEN_METEO_ATTRIBUTION`.
- `wind.ts`: `windAt(layers, altMsl, agl, out?, z0?)`, `windVectorNED(fromDeg, speedMs, out?)`,
  `logProfileFactor(agl, z0?)`, `gustExcessAt(layers, altMsl)`, `gustEnvelope(x, rampM)`,
  `GustModel(seed, options?)` with `update(dt, relSpeed, excessMs, meanWindNED)`, `trigger(excessMs)`, `gustNED(out?)`.
- `preetham.ts`: `PreethamSky` (`setSun`, `radiance`, `transmittance`, `sunTransmittance`, `zenith`,
  `horizonAverage`, `horizonTowardSun`), `DEFAULT_PREETHAM`, `SKY_RADIANCE_SCALE`.
- `lighting.ts`: exposure/light/fog curves (`targetExposure`, `adaptExposure`, `sunLightIntensity`,
  `hemisphereIntensity`, `ambientFloor`, `moonLightIntensity`, `starVisibility`, `turbidityFromVisibility`,
  `mieFromVisibility`, `fogBetaFromVisibility`, `fogExp2DensityFromVisibility`, `hazeScaleHeight`,
  `heightFogOpticalDepth`), the haze model (`hazeColor`, `capBySky`, `hazeSunLobe`, `hgPhase`, `rayleighPhase`,
  `mieFraction`, `DEFAULT_HAZE`), the metered-free exposure (`exposureForIlluminance`, `surfaceIlluminance`,
  `DAY_ILLUMINANCE`), `NIGHT_AMBIENT_COLOR`, ACES/sRGB ports (`acesFilmic`, `linearToSrgb`, `encodeDisplayColor`), helpers.
- `cloudMath.ts`: `cloudDensityAt(layers, x, yMsl, z, drifts?)`, `cloudLayerDensityAt`, `cloudTypeParams`,
  `coverageMask`, `verticalProfile`, `fbm2`/`valueNoise2`/`hash2`, `CLOUD_NOISE_GLSL` (GPU twin).
- Renderables usable on their own: `CloudLayers`, `Precipitation`, `StarField` (+ `generateStarCatalog`,
  `equatorialToLocalMatrix`, `gmstDeg`, `blackbodyRGB`), `MoonDisc`.

## How it works

**Sun, moon, stars (§2).** `geo/solar` (NOAA/Meeus) gives the sun's azimuth/elevation at the aircraft
lat/lon and sim UTC; the apparent (refracted) elevation drives the dome and light direction, the
geometric elevation drives lighting thresholds. The moon disc is a camera-facing quad that lights a
virtual sphere with the real sun direction, so phase and terminator orientation come for free; `SkySystem`
draws it at 1.0° (`MOON_APPARENT_DIAMETER_DEG`; true 0.52°, the `MoonDisc` default) because a 60–90° screen
FOV minifies the sky against the eye and a true-size crescent was a few pixels wide.
Stars: a seeded synthetic catalogue (3000 stars, realistic magnitude slope, B−V colours), rotated by
local sidereal time (`equatorialToLocalMatrix`: Polaris sits at azimuth 0°, elevation ≈ latitude).

**Sky dome and its CPU twin (§1.2, §3.2).** The r187 `Sky` (Preetham) shader draws the dome (built-in
2-D clouds off; far plane in normal/log/reversed depth). `PreethamSky` is a line-by-line CPU port of
that shader; each frame it samples the zenith, an 8-azimuth horizon average at +1°, the horizon 90° from
the sun, the sun-ward horizon and the sun transmittance. Those samples drive the hemisphere light, the sun
colour, the haze cap, water reflections and the cloud lighting. Turbidity and Mie coefficient follow
visibility and aerosol. Two look patches (`patchSkyDome`, mirrored in the CPU twin): an in-scatter knee
`Lin · 1/(1 + lum(Lin)/25)` — Sky.js's single scattering puts the noon horizon at ≈ 16 × the zenith (real
clear skies: 2–4 ×), which turned the lower 15° of the dome and everything derived from it white; the knee
brings it to ≈ 3.5 ×, keeps the hue and barely touches the zenith and twilight skies — and a night glow
(warm light-pollution band at the horizon, airglow at the zenith, a little brighter under a moon) that fades
in through nautical twilight, so night skies have a gradient and hills silhouette against it.

**Lights and exposure (§7).** Sun `DirectionalLight`: colour = normalised Preetham transmittance (≈ 5 800 K
at the zenith, ≈ 3 000 K at 5°), intensity `3 · disc(el) · lum(T) · (1 − 0.85 cc)`, shadow camera a
±200 m box following the aircraft. `HemisphereLight`: hue = the zenith and horizon hues mixed (the whole
dome lights the ground; zenith-weighted at twilight for cool shadows, neutral grey as cloud cover closes),
`lerp(0.02, 0.9, smoothstep(−12°, 10°, el)) · (1 + 0.3 cc)`. Moon `DirectionalLight` and a night-blue ambient
floor (≈ 0.12 luminance moonless, ≈ 0.24 full moon) keep nights dark but readable after ACES's toe.
`ambientIrradiance` = hemisphere sky colour × intensity + floor — what the terrain uses, so built-in objects
and the ground get the same skylight. Exposure is metered-free partial adaptation to the light on an
up-facing surface, `day · (1.8 / E)^0.5` bounded by [day, night] (E = sun·sin el + ambient luminance): ≈ 1.0
at dawn/dusk, ≈ 0.7 under a noon overcast, the night bound at night; it adapts with a 1.5 s first-order
filter (frame-rate independent; the first frame snaps). `targetExposure` (elevation curve) remains exported.

**Fog / aerial perspective (§3).** Koschmieder β0 = 3.912 / visibility with an exponential height
profile β(h) = β0·e^(−h/H) above the ground under the aircraft; H = 300–8000 m from visibility, or the
fog-layer depth when `fogTopM > 0`, so a ground-fog layer thins out above its top and still hides the
ground from above. Inside cloud the profile flattens and β at the camera blends to `inCloudBeta`
(0.03 m⁻¹ ≈ 130 m visibility) — the fly-through fog. The haze colour is not the horizon sky: distant
ground fades to the light the haze itself scatters, `hazeColor` = ω·[ms·E☉c☉·P(θ) + (E_sky + ρ_g·E_ground)/2π]
(P = Rayleigh + Henyey–Greenstein g 0.7, weighted by the aerosol share of β; ms = 2.6 for multiple
scattering), in the same light units as the terrain's shading, capped at 0.8 × the sky behind it (the
horizon 90° from the sun for `fogColor`, the sun-ward horizon for `sunGlowColor`; at night the glow band).
`fogColor` is that colour at 90° from the sun, `sunGlowColor` looking at the sun; shaders mix between them
with `hazeSunLobe(cos θ)` (`HAZE_LOBE_GLSL`, exact HG shape). Result at noon / 40 km: a blue-grey ≈ 0.6
display value over ground at ≈ 0.25, below a ≈ 0.78 horizon — ridgelines read at 10–20 km and the horizon
line shows. Cloud planes fade to `skyFogColor` (the horizon sky, the haze under a closing deck) instead.
Custom shaders use `HEIGHT_FOG_GLSL` (closed-form optical depth, finite for any input). Built-in materials
get the identical height fog (`builtinFog.ts`: the `fog_*` chunks are patched once; three shared
`Float32Array` uniforms carry β0/falloff/ground y, the sun direction and the encoded sun-ward colour; the
Euclidean ray replaces FogExp2's exp(−(d·z)²) of view depth, which left runways nearly unfogged at 5 km
where the terrain showed 40 %). Built-in fog runs after tone mapping, so its colours are the tone-mapped,
sRGB-encoded haze (set as an sRGB `Color` because three re-encodes `fog.color` on upload); `fog.density`
(1.978/3.912·β at half the camera height) is three's plain FogExp2 fallback for programs without the values.

**Clouds (§4.2).** One 200 km plane per `CloudLayer` (≤ 4), re-centred under the camera every frame
and placed at the layer base (camera below), top (above) or camera altitude (inside: invisible,
fog takes over). The fragment shader samples 3-octave value-noise fbm in world XZ minus the
accumulated wind drift (no swimming), applies the coverage threshold and edge erosion, Beer–Lambert
opacity along the slant path, HG(0.6) sun lighting with powder, a darker underside and the same
height fog as the terrain; the skylight on a layer turns neutral grey as cover closes (an overcast base
reads grey, not blue-white). Cloud shadows: `CloudLayers.writeShadowUniforms` publishes each layer's
coverage, feature size, column optical depth, mid height and drift into the shared uniforms; terrain and
ocean evaluate `skyCloudShadow` (the same noise field at the layer middle along the sun ray, floored at the
overcast dimming and normalised by it, so gaps get the full sun and the average matches the dimmed sun).
The built-in materials share one sun light, so `cloudShadowAt` (CPU twin) scales its intensity by the
shadow over the aircraft: the aircraft, runway and buildings darken with the ground when a shadow passes. `cloudMath.ts` is the CPU twin (identical formula incl. erosion), used for
`cloudDensityAt` (FDM bumpiness, in-cloud fog). Drift is integrated by the `WeatherSystem` (shared with
the renderer via `setCloudDrifts`) or by `CloudLayers` itself; floating-origin moves shift the drift.

**Precipitation (§5).** ≤ 4 000 instanced quads in a 60 × 45 × 60 m camera-centred box; positions are
wrapped in the vertex shader from seeds + an accumulated offset (relative velocity = fall + wind −
camera), so there is no per-frame CPU work. Rain streaks stretch along the relative velocity
(7.5 m/s fall); snow flakes are round sprites falling at 1 m/s with flutter. Count ∝ rate (rain full at
15 mm/h, snow at 6 mm/h water equivalent).

**Environment map (§1.2).** A second dome instance in a private scene is baked with `PMREMGenerator`
into `scene.environment` (sun disc hidden) when the sun moved > 1° (3° at time-scale ≥ 60) or
turbidity/Mie/cloud cover changed, at most every 0.5 s.

**Weather (§4.4, §6, §9, §11).** Presets are the §4.4 table (AGL at the departure airport → MSL).
`WeatherSystem` cross-fades numeric fields (visibility in log space, wind direction through the shortest
arc, layers by index), switches discrete fields at the midpoint, integrates cloud drift and runs the
`GustModel` (MIL-F-8785C 1 − cosine bumps, d_m 30–120 m, Poisson trigger with a 40 s mean, seeded).
Mean wind: FROM-direction layers converted to TO vectors, vector-interpolated between layers, log profile
(z0 = 0.03 m, referenced to 10 m, capped ×1.3) below the lowest layer. METAR: full §9.2 grammar subset;
Open-Meteo: winds at 10 m + 850/700/500/250 hPa (geopotential heights), low/mid/high cloud placed from
the lifted condensation level, precipitation as liquid-water equivalent (snowfall cm × 10/7, showers included).

## Tests

`npx vitest run src/sky` — 15 files, all Node (no WebGL):

| File | Covers |
|---|---|
| `SkySystem.test.ts` | stub-renderer `SkySystem`: scene graph, ACES + shadows, NOAA sun placement in the render frame, sun light/shadow box, Koschmieder fog, fog colour reaching the GPU encoded once, shared cloud field + floating-origin rebase (shared and self-integrated drift), MSL = y + alt0, ground-fog layer seen from above, in-cloud fog, `patchSkyDepth` output, no cloud-fog lag, first-frame exposure |
| `haze.test.ts` | phase functions, aerosol share, noon haze between the lit ground and the horizon sky (ridge at 20 km still separable on screen), sun-ward glow, cap, exposure from illuminance, in-scatter knee (horizon ≈ 2–5 × zenith), night glow |
| `skyShared.test.ts` | shared uniforms (ambient irradiance = hemisphere + floor, cloud-shadow layers, no shadows at night, `null` publishes nothing), noon haze darker than the horizon and blue-grey on screen, night glow and ambient floor, built-in height-fog chunks + uniforms shared through `UniformsUtils.clone`, `patchSkyDome` idempotent |
| `robustness.test.ts` | one running `SkySystem` fed zero / 50 m / 10⁹ m / NaN visibility, a ground-fog layer, 80 km altitude, in-cloud and storm, at noon, dusk and midnight: every `SkyLighting` number, shared uniform, built-in fog value and the fog optical depth stays finite (a NaN visibility used to latch NaN into the adapted exposure for good) |
| `WeatherSystem.test.ts` | presets by reference, transitions (lerp, wrap through north, exact end state), `windNED`/`windAt` sign (FROM 270° 10 kt → +E 5.144 m/s), log profile, gusts, METAR/live application, cloud density + drift + rebase |
| `wind.test.ts` | FROM→TO sign, log profile, vector interpolation, gust envelope, deterministic `GustModel` |
| `lighting.test.ts` | sun colour/intensity vs elevation, exposure curve + adaptation, light curves, visibility → turbidity/β/FogExp2, height-fog optical depth vs numerical integration, ACES port |
| `preetham.test.ts` | Sky.js constants, midday/sunset/night behaviour, turbidity |
| `cloudMath.test.ts` | noise ranges, coverage mask, vertical profile, density field, CPU formula == GPU formula (incl. erosion) |
| `presets.test.ts`, `metar.test.ts`, `liveWeather.test.ts` | §4.4 table, METAR grammar cases, Open-Meteo conversion (WE snow, showers), graceful fetch failure |
| `stars.test.ts`, `moon.test.ts`, `precipitation.test.ts` | GMST, Polaris/meridian checks, catalogue; moon position/facing/phase; particle budget and streak direction |

GLSL was verified separately by bundling a probe with esbuild and rendering in headless Chrome
(SwiftShader WebGL2) with normal, logarithmic and reversed depth: every sky program compiles and links,
the PMREM bake runs, and a tower top in front of an overcast deck stays visible while the deck covers
the ground behind it in all three modes (removing the clouds' `logdepthbuf_fragment` breaks the log-depth
case, so the check is meaningful). The look-dev pass repeated it for everything it touched: the patched
dome (knee + night glow), clouds, stars, moon, precipitation and the PMREM bake, terrain (procedural and
imagery) and ocean materials with the shared sky uniforms and cloud shadows, and every fogged built-in
material (Standard, Physical, Basic, Lambert, Phong, Toon, Matcap, Normal, Shadow, Points, Line,
LineDashed, Sprite, InstancedMesh, and `fog: true` ShaderMaterials built before and after
`installBuiltinHeightFog`) under FogExp2, linear `Fog` and no fog, over 11 cases from 2 m to 80 km incl.
zero visibility, rain, dusk and night: 60 programs compile and link in each depth mode, no GL errors, and
the pixels agree across the three modes. `npm run smoke` covers the integrated app.

## Known limitations

- **Sun vs sky balance on built-in materials (interim).** The PMREM environment map is baked from
  the dome in the sky's radiance scale; at full strength its diffuse light overpowered the sun
  light on MeshStandard materials (white runway paint read light blue, asphalt navy). The
  environment intensity is set to 0.4 (`ENV_MAP_INTENSITY`) and the hemisphere light keeps 25 %
  while the map is bound, from real-app probes. A proper calibration should derive the IBL scale
  from `ambientIrradiance` (the terrain's skylight) and re-check exposure so sunlit white paint
  reads near-white and asphalt neutral grey.

- Tier A planes are 2-D slabs: weak look at the layer altitude, no cumulus towers, no earth curvature
  (≈ 0.8 km drop at the 100 km plane edge). Inside a cloud the fog is global, so rays leaving the cloud stay
  fogged. Cloud shadows skip the edge erosion (softer than the planes' edges); built-in objects get the
  shadow at the aircraft's position (one global sun light), so a far runway shares the aircraft's shadow state.
- Fog is referenced to the ground under the aircraft (`groundY`). Built-in fog mixes in display space
  (after tone mapping, three's order), the terrain in linear: identical at 0 and full fog, a few percent
  apart in between. Programs compiled before `installBuiltinHeightFog` (or ShaderMaterials with their own
  fog uniforms) keep three's FogExp2. The height-fog values and `SKY_UNIFORMS` are process-wide (one sky per
  page): another scene on the same page that uses `FogExp2` (a preview, say) gets the main sky's height fog —
  give it a linear `Fog` or none, and give a second `SkySystem` `sharedUniforms: null`.
- The haze is one colour pair (90° / sun-ward) per frame: no per-azimuth sky colour, no wavelength-dependent
  extinction (distant terrain does not redden at sunset beyond the haze colour itself).
- Preetham twilight is approximate (knee + glow on top of single scattering); the star field is synthetic
  (no BSC5, no precession); moon position from `geo/solar` is good to ≈ 1°.
- Exposure is a model, not metered. Night bound 1.5 (spec: 6–10) with a ≈ 10× brighter moonlight (0.08 vs
  0.0075·fraction) and a bright night ambient: same moonlit-surface brightness, but emissive lights stay
  coloured instead of clipping; raise `exposure.night` if the bloom/lights module wants more.
- Shadow frustum follows the aircraft without texel snapping (can shimmer when moving).
- `geo/solar` `sunPosition`/`moonPosition` return fresh objects (two small allocations per frame;
  owned by `src/geo` — proposed: optional `out` parameters).
- Gusts are spatially uniform along the mean wind; continuous Dryden turbulence lives in the FDM. Call
  `WeatherSystem.update` from the fixed-step loop for deterministic gusts.
- Transitions match layers by index; wind layers present only in the source are dropped at the end.
- METAR: trend/TAF groups ignored, winds aloft synthesised (veer +15°/+30°, ×1.4/×2), `VCTS` counts as a
  thunderstorm. Open-Meteo is model data for the nearest hour of a 1-day forecast; network helpers
  resolve `null` on failure. aviationweather.gov needs a CORS proxy; metar.vatsim.net CORS is unverified.
- Each PMREM rebake allocates a new render target (r187 `fromScene`), throttled as above.

## Tuning knobs

| Where | Knob (default) |
|---|---|
| `SkySystemOptions` | `exposure` {day 0.6, twilight 1.0, night 1.5, overcastBoost 0.4, adaptTimeS 1.5}, `toneMapping` (ACES), `shadows` (true), `shadowMapSize` (2048), `shadowRadiusM` (200), `stars` (3000), `seed`, `environmentMap` (true), `envRebakeDeg` (1), `envRebakeMinS` (0.5), `sunIntensity` (3), `rayleigh` (1), `mieDirectionalG` (0.8), `inCloudBeta` (0.03 m⁻¹), `clouds`, `precipitation` |
| `CloudLayersOptions` | `radiusM` (100 000), `octaves` (3; 5 = richer), `maxLayers` (4), `segments` (1) |
| `cloudTypeParams` | feature size / σt / brightness / erosion: cumulus 2500 m, 0.006, 1.0, 0.4; stratus 3500 m, 0.004, 0.9, 0.2; cirrus 6000 m, 0.0006, 1.6, 0.6; `COVERAGE_SOFTNESS` 0.25, `VERTICAL_FEATHER` 0.12 |
| `PrecipitationOptions` | `maxParticles` (4000), `boxM` (60), `fullRateRain` (15 mm/h), `fullRateSnow` (6 mm/h), `seed` |
| `WeatherSystemOptions` | `airportElevationM`, `seed` (7), `z0` (0.03 m), `initial` ('clear'), `defaultTransitionS` (60), `gust` {meanIntervalS 40, minIntervalS 12, rampMinM 30, rampMaxM 120, magMin 0.5, magMax 1} |
| `lighting.ts` | `DEFAULT_HAZE` {omega 0.9, multiScatter 2.6, groundAlbedo 0.15, maxOfSky 0.8}, `HAZE_G` 0.7, `DAY_ILLUMINANCE` 1.8, `NIGHT_AMBIENT_COLOR`, `ambientFloor` 0.22 + 0.22·moon |
| `preetham.ts` / `SkySystem.ts` | `INSCATTER_KNEE` 25, `NIGHT_GLOW_SCALE_HEIGHT` 0.18, `NIGHT_GLOW_HORIZON`/`_ZENITH`, `SKYLIGHT_HORIZON_SHARE` 0.5 |
| runtime | `sky.stars.gain` (3.5), `sky.moon.brightness` (0.6), moon drawn at `MOON_APPARENT_DIAMETER_DEG` 1.0° (`SkySystem.ts`), `wind.ts` `LOG_PROFILE_MAX` (1.3), `lighting.ts` curves |
