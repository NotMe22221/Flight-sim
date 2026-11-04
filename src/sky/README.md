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
- `patchSkyDome(material)` — the dome's look patches (in-scatter knee, night glow, twilight; composed by `SKY_LIT_MAX_LINE`), mirrored by `PreethamSky`, plus
  the `skySaturation` (environment bake) and `skyFogMix` / `skyFogColor` (inside a cloud) uniforms.

### `SkyLighting` (from `types.ts`, mutated in place every frame)
`sunDirThree`, `sunColor` (hue, max channel 1), `sunIntensity`, `skyColorZenith`, `skyColorHorizon`,
`fogColor` (haze at 90° from the sun), `fogDensity` (β0, m⁻¹), `fogHeightFalloff` (1/H, m⁻¹), `exposure`,
`ambientIntensity`, plus `fogColorEncoded`, `fogExp2Density`, `sunRadiance`, `sunGlowColor` (haze looking
at the sun), `skyFogColor` (what objects seen against the sky fade to), `ambientIrradiance` (up-facing
surface, = hemisphere sky colour × intensity + ambient floor), `moonDirThree`, `moonIntensity`, `moonColor`,
`sunElevationDeg`, `cloudCover`, `starVisibility`, `inCloud`, `groundY`.
`HEIGHT_FOG_GLSL` provides `heightFogOpticalDepth(...)` / `heightFogFactor(origin, dir, dist, beta0, invH, groundY)`;
`HAZE_LOBE_GLSL` provides `hazeSunLobe(cosθ)` (mix `fogColor` → `sunGlowColor` by it).

### Per-material image-based light (`iblScale.ts`)
- `applyIblScale(material, diffuse, specular = diffuse)` — a material's share of the sky's environment light, relative
  to `scene.environmentIntensity`: three r187 binds `scene.environment` to every MeshStandard/Physical/Lambert/Phong
  material without its own `envMap` and overwrites `material.envMapIntensity` with `scene.environmentIntensity` on
  every draw (`WebGLRenderer.setProgram`), so a per-material value does nothing. The helper chains an
  `onBeforeCompile` that scales `iblIrradiance` (× diffuse) and `radiance` / `clearcoatRadiance` (× specular) right
  after `lights_fragment_maps` (where they hold the environment only), with a per-material `iblScale` uniform and a
  program cache key per value (`…|ibl:0.350,0.350`); earlier `onBeforeCompile` / `customProgramCacheKey` hooks are
  kept (apply it after them). Unlit materials are left alone; calling it again updates the values. `iblScaleOf`,
  `patchIblScaleSource`, `IBL_SCALE_ANCHOR`, `IBL_SCALE_GLSL`. Used by the cockpit (`aircraft3d` `CABIN_IBL_SHARE`
  0.12–0.35) and the OSM scenery (diffuse 1, reflections 0, 0.03 on glass).

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
- `preetham.ts`: `PreethamSky` (`setSun`, `setNightGlow`, `setTwilight`, `radiance`, `transmittance`, `sunTransmittance`,
  `zenith`, `horizonAverage`, `horizonTowardSun`, `irradianceUp`), `DEFAULT_PREETHAM`, `SKY_RADIANCE_SCALE`, the twilight
  (`twilightStrength`, `twilightColors`, `twilightAzimuthWeight`, `skyExtraDayFade`, `skyLitMax`, `TWILIGHT_GLSL`,
  `TWILIGHT_*` constants) and the night glow (`NIGHT_GLOW_GLSL`).
- `lighting.ts`: exposure/light/fog curves (`targetExposure`, `adaptExposure`, `sunLightIntensity`,
  `hemisphereIntensity`, `ambientFloor`, `moonLightIntensity`, `starVisibility`, `turbidityFromVisibility`,
  `mieFromVisibility`, `fogBetaFromVisibility`, `fogExp2DensityFromVisibility`, `hazeScaleHeight`,
  `heightFogOpticalDepth`), the haze model (`hazeColor`, `capBySky`, `hazeSunLobe`, `hgPhase`, `rayleighPhase`,
  `mieFraction`, `DEFAULT_HAZE`), the metered-free exposure (`exposureForIlluminance`, `surfaceIlluminance`,
  `DAY_ILLUMINANCE`, `cloudCoverAbove`), cloud dimming of the sun (`cloudShadowFloor`, `cloudSunFactor`), the calibration (`SUN_INTENSITY_BASE`, `SKYLIGHT_SATURATION`, `GROUND_ALBEDO`,
  `skylightIrradiance`, `saturateColor`, `sunSkyRatio`, `skylightBalance`), `NIGHT_AMBIENT_COLOR`, ACES/sRGB ports
  (`acesFilmic`, `linearToSrgb`, `encodeDisplayColor`), helpers.
- `cloudMath.ts`: `cloudDensityAt(layers, x, yMsl, z, drifts?)`, `cloudLayerDensityAt`, `cloudTypeParams`,
  `coverageMask`, `verticalProfile`, `fbm2`/`valueNoise2`/`hash2`, `CLOUD_NOISE_GLSL` (GPU twin).
- Renderables usable on their own: `CloudLayers` (+ `deckRadianceBelow`, the CPU twin of a deck's underside), `Precipitation`, `StarField` (+ `generateStarCatalog`,
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
visibility and aerosol. Three look patches (`patchSkyDome`, mirrored in the CPU twin): an in-scatter knee
`Lin · 1/(1 + lum(Lin)/25)` — Sky.js's single scattering puts the noon horizon at ≈ 16 × the zenith (real
clear skies: 2–4 ×), which turned the lower 15° of the dome and everything derived from it white; the knee
brings it to ≈ 3.5 ×, keeps the hue and barely touches the zenith and twilight skies —, a night glow
(warm light-pollution band at the horizon, airglow at the zenith, a little brighter under a moon), so night
skies have a gradient and hills silhouette against it, and a twilight term. Sky.js cuts its sun term once the
sun is ≈ 1–2° below the horizon (its `sunIntensity` earth-shadow hack), and the glow used to fade in only below
−3°: from ≈ −2° to −6° the dome was black (sRGB 0–4), darker than the night. The twilight is a deep-blue dome
(`TWILIGHT_ZENITH`) plus a warm band toward the sun's azimuth (`TWILIGHT_BAND` × exp(−sin el / 0.2) × an azimuth
weight 1 → 0.16 at 90° → 0.1 opposite), full down to a −1° (apparent) sun and e-folding every 1.6° below. The
glow and the twilight are composed with Sky.js's sunlit in-scatter by a per-channel smooth maximum
`skyLitMax(Lin·0.04, glow + twilight)` (p = 4; Sky.js's sun-independent floor L0 stays additive, so the night sky
is unchanged) and both fade out above a 5–15° sun: the day dome is exactly Sky.js's, the golden-hour dome within
a few percent, and the dome darkens monotonically from the sunset into the night glow with no gap.

**Lights and exposure (§7).** One set of light units for everything: the sky dome's radiance scale (Sky.js,
`SKY_RADIANCE_SCALE` included), so the sky you see is the sky that lights the ground (see "Calibration").
Sun `DirectionalLight`: colour = normalised Preetham transmittance (≈ 5 800 K at the zenith, ≈ 3 000 K at
5°), intensity `SUN_INTENSITY_BASE (12) · disc(el) · lum(T) · cloudSunFactor(cc)` (1 − 0.85 cc up to half cover, 0.05 under a full deck), shadow camera a ±200 m box
following the aircraft. Skylight (`ambientIrradiance`, up-facing): by day the dome's own irradiance
(`PreethamSky.irradianceUp`, re-integrated when the sun moves ≈ 0.25° or the air changes, not per frame),
desaturated to real skylight's hue (`SKYLIGHT_SATURATION` 0.3: Sky.js's irradiance is ≈ 30 000 K+, measured
clear-sky diffuse light ≈ 10–15 000 K) and ×(1 + 0.3 cc), greyer under cloud, handing over to π × the deck's radiance as cover closes (0.5 → 1); from sunset down the
twilight curve (zenith/horizon hue × `lerp(0.02, 0.9, smoothstep(−12°, 10°, el)) · (1 + 0.3 cc)`, the
pre-calibration skylight, which keeps dusk readable where the dome is nearly black; through civil dusk at the
luminance it was calibrated with — the hue normalised to luminance 1 instead of max channel 1 over the
`TWILIGHT_SKYLIGHT_KEEP_LUM_DEG` trapezoid −14°/−8° … −6°/+4° —, because the twilight term's deep-blue samples
have ≈ 0.55 of the luminance of Sky.js's neutral floor that the calibration saw there); the two hand over by a
smooth maximum (`skylightIrradiance`) around a 10° sun. Plus a night-blue ambient floor (≈ 0.12 luminance
moonless, ≈ 0.24 full moon) and moonlight. Built-in objects get the same skylight from the baked environment
map (intensity ≈ 1 by day, capped at 1 so reflections never outshine the sky they mirror) and the
hemisphere light, which fills in where the twilight curve is brighter than the dome (`skylightBalance`);
the environment's lower hemisphere is the lit ground (`GROUND_ALBEDO` · (sun + sky) / π), and the
hemisphere light's ground colour carries whatever the environment does not. Exposure is metered-free
partial adaptation to the light where the camera is, `day · (DAY_ILLUMINANCE / E)^0.5` bounded by
[day 0.5, night 1.5 (+15 % moonless)], E = sun·sin el + skylight luminance with the sun dimmed only by the
cloud layers ABOVE the camera (`cloudCoverAbove`) and by the cloud it is in: 0.5 at a clear noon, ≈ 0.6 at
40°, ≈ 0.9 at 20°, the night bound from a ≈ 6° sun down, ≈ 0.95 under a noon overcast (≈ 0.85 before the look pass 2 dimmed its residual sun) and back to ≈ 0.5
on top of it. It adapts with a 1.5 s first-order filter (frame-rate independent, no overshoot; the first
frame snaps). `targetExposure` (elevation curve) remains exported.

**Fog / aerial perspective (§3).** Koschmieder β0 = 3.912 / visibility with an exponential height
profile β(h) = β0·e^(−h/H) above the ground under the aircraft; H = 300–8000 m from visibility, or the
fog-layer depth when `fogTopM > 0`, so a ground-fog layer thins out above its top and still hides the
ground from above. Inside cloud the profile flattens and β at the camera blends to `inCloudBeta`
(0.03 m⁻¹ ≈ 130 m visibility) — the fly-through fog, near-neutral grey (the zenith/horizon mix at
`IN_CLOUD_SATURATION` 0.15: droplets scatter all colours alike). The haze colour is not the horizon sky: distant
ground fades to the light the haze itself scatters, `hazeColor` = ω·[ms·E☉c☉·P(θ) + (E_sky + ρ_g·E_ground)/2π]
(P = Rayleigh + Henyey–Greenstein g 0.7, weighted by the aerosol share of β; ms = 2.6 for multiple
scattering), in the same light units as the terrain's shading, capped at 0.8 × the sky behind it (since the calibration
the cap is what applies by day: the calibrated sun and skylight put the uncapped haze above the sky) (the
horizon 90° from the sun for `fogColor`, the sun-ward horizon for `sunGlowColor`; at night the glow band).
`fogColor` is that colour at 90° from the sun, `sunGlowColor` looking at the sun; shaders mix between them
with `hazeSunLobe(cos θ)` (`HAZE_LOBE_GLSL`, exact HG shape). Result at noon / 40 km (before the
calibration): a blue-grey ≈ 0.6 display value over ground at ≈ 0.25, below a ≈ 0.78 horizon; measured since
(clear noon, 50 km): distant terrain 141–174 / 255 under a 186–188 horizon — ridgelines read and the
horizon line shows. Cloud planes fade to `skyFogColor` (the horizon sky, the haze under a closing deck) instead.
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
ocean evaluate `skyCloudShadow` (the same noise field at the layer middle along the sun ray, floored at
`cloudShadowFloor(cover)` — 0.15 up to half cover, falling to 0.05 under a full deck — and normalised by the mean
dimming `cloudSunFactor(cover)` = 1 − cover·(1 − floor) the sun intensity already carries, so gaps get the full
sun and the average matches the dimmed sun; the old fixed floor kept 15 % of the sun under an overcast).
Under a closing deck (cover 0.5 → 1) the skylight hands over to π × the deck's underside radiance
(`CloudLayers.deckRadianceBelow`, the CPU twin of the planes' back face at full density) and the environment's
overcast shell takes the deck's colour, so a surface under an overcast is lit by the deck it is seen against.
The hand-over follows the cover above the aircraft (`cloudCoverAbove`, as the exposure does): on top of the deck
the aircraft keeps the sky's skylight (the review measured white paint on top of a golden-hour overcast at
173/151/129 when the dim, warm underside below it lit it; 198/190/184 before and after). Only layers whose middle is above the point count — the sun ray goes up — so the aircraft and peaks on top
of a deck are in full sun (before the review a deck below them shadowed them as if it were above).
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
into `scene.environment` (sun disc hidden, the dome desaturated to the skylight's hue by the
`skySaturation` uniform `patchSkyDome` adds — 1 on screen —, a grey shell over it as cover closes, the lit
ground below the horizon) when the sun moved > 1° (3° at time-scale ≥ 60) or turbidity/Mie/cloud cover
changed, at most every 0.5 s.

**Weather (§4.4, §6, §9, §11).** Presets are the §4.4 table (AGL at the departure airport → MSL).
`WeatherSystem` cross-fades numeric fields (visibility in log space, wind direction through the shortest
arc, layers by index), switches discrete fields at the midpoint, integrates cloud drift and runs the
`GustModel` (MIL-F-8785C 1 − cosine bumps, d_m 30–120 m, Poisson trigger with a 40 s mean, seeded).
Mean wind: FROM-direction layers converted to TO vectors, vector-interpolated between layers, log profile
(z0 = 0.03 m, referenced to 10 m, capped ×1.3) below the lowest layer. METAR: full §9.2 grammar subset;
Open-Meteo: winds at 10 m + 850/700/500/250 hPa (geopotential heights), low/mid/high cloud placed from
the lifted condensation level, precipitation as liquid-water equivalent (snowfall cm × 10/7, showers included).

## Calibration

Light units are the sky dome's radiance scale: a surface's radiance is albedo/π × irradiance in the same
units the dome is drawn in, so lit surfaces and the sky they are seen against are exposed together. The
sun (`SUN_INTENSITY_BASE` 12 at the zenith before extinction) is calibrated against the dome's own
irradiance: the direct sun on a horizontal surface is ≈ 5 × the skylight at a 76° sun, ≈ 4.7 × at 40°,
≈ 3 × at 20° (clear air; real clear skies ≈ 8 / 6 / 3). Before the calibration the sun was 3 and the
skylight a hand-tuned curve ≈ 3 × below the dome's irradiance: the sky read brighter than sunlit white
paint, and the environment map (the full-saturation dome) tinted shade sky-blue. The day exposure 0.5
then puts sunlit white paint where a photograph does. Measured in the real app (look-calibration harness:
KSFO 28R, 2026-06-21, low graphics, procedural imagery, chase camera broadside to the sun; sRGB 0–255
medians, before → after):

| Clear noon (sun 76°) | before | after | target |
|---|---|---|---|
| white paint, sunlit top | 190/194/201 (bluish) | 238/237/236 | 225–245, neutral |
| white paint, shaded side | 71/99/121 (sky-blue) | 153/157/160 | 120–180, slightly blue |
| runway asphalt (albedo ≈ 0.15) | 70/74/84 (bluish) | 156/155/155 (neutral) | 55–90: albedo ≈ 0.045 needed |
| runway markings (0xf2f2ea) | 194/197/201 | 239/238/236 | near the paint |
| procedural grass near the runway | 97/88/52 | 182/169/119 | mid green: albedo too high |
| sky at the horizon / 20° / 45° | 197 / 177 / 160 | 187 / 164 / 147 | blue, brighter toward the horizon |
| exposure | 0.60 | 0.50 | |

| Other times (clear) | before | after |
|---|---|---|
| 40° sun: white paint top / shaded side | 161/168/181 / 74/103/127 | 231/229/227 / 133/138/144 |
| 40° sun: asphalt; exposure | 52/56/67; 0.60 | 139/136/133; 0.60 |
| golden hour (6°): sun-facing paint / shaded side | 219/207/196 / 119/127/137 | 246/238/221 (warm) / 98/106/122 (blue) |
| golden hour: asphalt / markings | 19/28/49 / 96/120/156 (navy cast) | 67/59/59 / 185/176/173 |
| golden hour: sky 45°; exposure | 14/65/126; 1.07 | 32/89/157; 1.61 (night bound) |
| civil dusk (−3.5°): paint / markings | 77/70/81 / 104/101/105 | 79/77/85 / 114/111/116 |
| civil dusk: exposure | 1.39 | 1.61 |
| night (−25°): paint / markings / sky at the horizon | 67/76/112 / 66/77/111 / 58/55/65 | 61/71/106 / 67/77/110 / 58/55/65 |

| Clouds | before | after |
|---|---|---|
| noon overcast: paint top / shaded side; exposure | 153/155/156 / 126/129/132; 0.67 | 223/223/221 / 203/203/203; 0.82 |
| noon overcast: the deck at 20° / 45° | 186/190/193 / 191/194/197 | 198/205/211 / 202/207/211 |
| golden-hour overcast: paint top / deck at 45°; exposure | 136/137/141 / 80/75/73; 0.81 | 188/187/187 / 127/121/117; 1.61 |
| on top of the noon overcast (2100 m): sunlit paint; exposure | 208/206/202; 0.67 | 239/238/235; 0.50 (the cover-dimmed exposure would be 0.82: clipped) |
| inside the noon overcast: exposure; fog colour (linear) | 0.76; 0.81/1.16/1.73 (sky-blue) | 0.93; 1.08/1.13/1.22 (`IN_CLOUD_SATURATION` 0.15) |
| inside the noon overcast, looking level | blue sky dome above the fog (the dome ignored the in-cloud fog) | the dome fades to the fog (`skyFogMix`) |
| scattered noon from 2600 m: lit cumulus tops | 230/233/234; 0.60 | 227/230/232; 0.50 |
| scattered golden hour from 2600 m: lit tops | 178/160/132; 0.94 | 206/192/168; 1.54 |
| on top of the noon / golden overcast: the deck | 210/211/212 / 100/91/85 | 195/197/199 / 142/131/124 |
| exposure climbing through the scattered layer | 0.60 constant (global cover) | 0.56 → 0.52, monotonic, no reversal |
| exposure after a jump into the overcast | 0.67 → 0.75 in ≈ 12 s, monotonic | 0.82 → 0.92 in ≈ 12 s, monotonic |

The cockpit panel is unlit (`MeshBasicMaterial`, not tone mapped): its brightness is the same before and
after (mean ≈ 49 at noon, ≈ 37 at night with the panel lights on); the cabin around it is brighter by day
(glare shield ≈ 49 → 91 at noon), because three r187 ignores `material.envMapIntensity` for materials lit by
`scene.environment` (it uses `scene.environmentIntensity`, now ≈ 1 by day instead of ≈ 0.25), so the cabin's
0.35 sky fill is not applied — an `aircraft3d` follow-up.

The partial calibration found on disk (sun 12 and exposure 0.5 with the old skylight curve, the
environment's ground hemisphere left at MeshBasicMaterial's default white) measured: noon shade
91/102/121 (direct/sky ≈ 16 ×, crushed), golden-hour shade 220/222/224 and dusk paint 206–226 (the white
lower hemisphere lit every side and belly ≈ 3 × brighter than the sky did — the old "dusk ruined by a too
strong environment map" regression in a new form).

## Tests

`npx vitest run src/sky` — 20 files, all Node (no WebGL):

| File | Covers |
|---|---|
| `SkySystem.test.ts` | stub-renderer `SkySystem`: scene graph, ACES + shadows, NOAA sun placement in the render frame, sun light/shadow box, Koschmieder fog, fog colour reaching the GPU encoded once, shared cloud field + floating-origin rebase (shared and self-integrated drift), MSL = y + alt0, ground-fog layer seen from above, in-cloud fog, `patchSkyDepth` output, no cloud-fog lag, first-frame exposure |
| `haze.test.ts` | phase functions, aerosol share, noon haze between the lit ground and the horizon sky (ridge at 20 km still separable on screen), sun-ward glow, cap, exposure from illuminance, in-scatter knee (horizon ≈ 2–5 × zenith), night glow |
| `skyShared.test.ts` | shared uniforms (ambient irradiance = hemisphere + floor, cloud-shadow layers, no shadows at night, `null` publishes nothing), noon haze darker than the horizon and blue-grey on screen, night glow and ambient floor, built-in height-fog chunks + uniforms shared through `UniformsUtils.clone`, `patchSkyDome` idempotent |
| `calibration.test.ts` | sun vs sky calibration end to end: direct sun 3–8 × the dome's skylight (20°–76°), clear-noon white paint 225–245 and neutral, shade 120–180 and slightly blue, sky ≥ 2.5 × darker than the paint, golden hour warm and unclipped with bluish shade, dusk/night dark but readable; exposure on top of an overcast = clear air (was ≈ 2 × too open), settles without overshoot or pumping; the dome irradiance is not re-integrated per frame; the environment's lower hemisphere is the lit ground (was default white) |
| `lookReview.test.ts` | review regressions: a deck below the point casts no shadow (CPU twin, GLSL guard, the aircraft's sun light on top of an overcast), cloud-type parameters are shared constants, `uSkyGroundY` published, `irradianceUp` vs a fine quadrature (noon → sunset), `skylightBalance` parity and caps, built-in skylight = terrain skylight at a 40° sun and at sunset |
| `lookPass2.test.ts` | the civil-dusk dome (CPU twin through `SkySystem`) at the zenith, 45°/20°/3° 90° from the sun, the anti-sun and sun-ward horizon every 1° from +4° to −12°: monotonic, no step > 2.5× (sun-ward 5×), never below the night sky; deep-blue zenith and a warm sun-ward band at −3.5°; GPU uniforms = the twin's; the day dome exactly Sky.js, golden hour within 6 %; `skyLitMax`; the cloud-shadow floor 0.15 → 0.05 and `cloudSunFactor`; under a noon overcast ≈ 5 % of the sun, skylight = π × the deck, white paint within the deck's brightness; the deck twin mirrors the planes' underside lines; broken / scattered shadows still visible |
| `lookPass2Review.test.ts` | review of look pass 2: the civil-dusk skylight keeps its calibrated level (≥ 0.3 luminance at −2° / −3.5°; it had fallen to night level, 0.22, when the twilight dome turned the curve's hue deep blue), golden hour (6°) and the night (−25°) unchanged, monotonic every 0.5° from +8° to −16° with no step > 12 %; under a golden-hour overcast the skylight is π × the deck, on top of it the sky's (blue, ≥ 1.3 × brighter), continuous through the deck (20 m steps < 12 %); the smooth maximum exact for dusk-size radiances, no 4th powers in the dome shader (mediump underflow) |
| `iblScale.test.ts` | three r187 still overrides `envMapIntensity` (the helper's reason); the chunks declare / fill / consume the scaled terms; the scale lands after `lights_fragment_maps` and before use for Standard, Physical, Lambert and Phong; unlit materials untouched, no stacking, values update in place; one cache key per value, earlier patches and keys kept |
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
the pixels agree across the three modes. The review re-ran that harness after its shader changes (cloud
shadows only from layers above, the shared `uSkyGroundY` fog reference) with two more cases (on top of an
overcast at 3 km, NaN visibility): 60 programs compile and link in default, logarithmic and reversed
depth, no GL errors, identical pixels. `npm run smoke` covers the integrated app.

## Known limitations

- **Albedos** of the other modules were brought to the calibrated light by the look pass 2 (runway asphalt,
  markings, procedural grass and fields, OSM pavement; see "Calibration"); imagery terrain (Sentinel-2) is
  shown as delivered. The environment's lower hemisphere is the lit ground even on top of a cloud deck
  (where it should be the bright deck).
- **Twilight** is an empirical term (deep-blue dome, warm band toward the sun) composed with Sky.js by a
  smooth maximum, not multiple scattering: no Belt of Venus / earth shadow on the anti-sun side, no ozone
  colour; the sun-ward Mie glow of Sky.js still collapses ≈ 4× within a degree around −2.5° (continuous,
  but quick). The night glow is the same light-pollution band at any sun elevation (faded out by day).
- **Overcast**: the skylight under a closing deck is π × the deck's underside radiance as the cloud planes
  draw it at full density 90° from the sun (no per-direction integral, no aerial perspective); the residual
  sun under a full deck is 5 %. Under a low golden-hour or dusk overcast the ground is therefore as dark as
  the deck (the twilight skylight curve no longer applies there).
- **Dark surfaces in dim light**: with the calibrated albedos (asphalt ≈ 0.04, grass ≈ 0.08) and the exposure
  capped at the night bound from a ≈ 6° sun down, the runway asphalt and the grass sink into ACES's toe (its
  input below ≈ 0.003 maps to black): measured at golden hour asphalt ≈ 34, at civil dusk ≈ 2–5 and at night
  ≈ 1–2 / 255 (grass ≈ 41 / 9 / 7) while white paint stays as calibrated; the old values (22 at dusk,
  9/12/25 at night) came from the ≈ 3 × too bright albedos. Lifting them needs a brighter night/dusk exposure
  (the spec's 6–10) or a tone curve with a softer toe, not brighter albedos.
- **Cloud coverage is not the covered area** (pre-existing, `cloudMath.ts` `coverageMask`): the mask
  thresholds fbm2 — distributed ≈ N(0.505, 0.145) with 3 octaves — at 1 − c·(1 + softness), so FEW (0.19)
  draws ≈ 0 % cloud (mean mask 0.003), SCT (0.44) ≈ 33 %, BKN (0.75) a 93 %-solid deck with 0.1 % gaps (the
  eroded planes) and no sunlit gaps on the ground (the review's CPU probe: no point of a 20 × 20 km area under
  'broken' gets more than 41 % of the sun; it reads as an overcast and the look pass 2 floor (0.087 at its
  0.79 cover) darkens all of it). Proposed: put the soft step's middle at the fbm quantile of 1 − c
  (≈ 0.505 + 0.145 · probit(1 − c), e.g. Tukey's 4.91 · (p^0.14 − (1 − p)^0.14), in `coverageMask` and its GLSL twin).

- Tier A planes are 2-D slabs: weak look at the layer altitude, no cumulus towers, no earth curvature
  (≈ 0.8 km drop at the 100 km plane edge). Inside a cloud the fog is global, so rays leaving the cloud stay
  fogged. Cloud shadows skip the edge erosion (softer than the planes' edges); built-in objects get the
  shadow at the aircraft's position (one global sun light), so a far runway shares the aircraft's shadow state.
- Fog is referenced to the ground under the aircraft (`groundY`, published as `uSkyGroundY`; the terrain and
  ocean use it too since the review — they used the ground under the camera, so with a tower or drone camera
  over other ground the aircraft and runways hazed differently from the terrain behind them). With a far
  camera the haze near the camera is therefore referenced to the aircraft's ground. Built-in fog mixes in display space
  (after tone mapping, three's order), the terrain in linear: identical at 0 and full fog, a few percent
  apart in between. Programs compiled before `installBuiltinHeightFog` (or ShaderMaterials with their own
  fog uniforms) keep three's FogExp2. The height-fog values and `SKY_UNIFORMS` are process-wide (one sky per
  page): another scene on the same page that uses `FogExp2` (a preview, say) gets the main sky's height fog —
  give it a linear `Fog` or none, and give a second `SkySystem` `sharedUniforms: null`.
- The haze is one colour pair (90° / sun-ward) per frame: no per-azimuth sky colour, no wavelength-dependent
  extinction (distant terrain does not redden at sunset beyond the haze colour itself).
- Preetham twilight is approximate (knee + glow on top of single scattering); the star field is synthetic
  (no BSC5, no precession); moon position from `geo/solar` is good to ≈ 1°.
- Exposure follows the light where the camera is through the cloud layers above it (`cloudCoverAbove`, a smooth
  function of altitude) and the cloud it is in, not the cloud shadows on the ground: flying under broken cloud
  the exposure does not pump with each shadow, so a sunlit gap reads bright and a shadow dark.
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
| `SkySystemOptions` | `exposure` {day 0.5, twilight 1.0, night 1.5, overcastBoost 0.4, adaptTimeS 1.5}, `toneMapping` (ACES), `shadows` (true), `shadowMapSize` (2048), `shadowRadiusM` (200), `stars` (3000), `seed`, `environmentMap` (true), `envRebakeDeg` (1), `envRebakeMinS` (0.5), `sunIntensity` (`SUN_INTENSITY_BASE` 12), `rayleigh` (1), `mieDirectionalG` (0.8), `inCloudBeta` (0.03 m⁻¹), `clouds`, `precipitation` |
| `CloudLayersOptions` | `radiusM` (100 000), `octaves` (3; 5 = richer), `maxLayers` (4), `segments` (1) |
| `cloudTypeParams` | feature size / σt / brightness / erosion: cumulus 2500 m, 0.006, 1.0, 0.4; stratus 3500 m, 0.004, 0.9, 0.2; cirrus 6000 m, 0.0006, 1.6, 0.6; `COVERAGE_SOFTNESS` 0.25, `VERTICAL_FEATHER` 0.12 |
| `PrecipitationOptions` | `maxParticles` (4000), `boxM` (60), `fullRateRain` (15 mm/h), `fullRateSnow` (6 mm/h), `seed` |
| `WeatherSystemOptions` | `airportElevationM`, `seed` (7), `z0` (0.03 m), `initial` ('clear'), `defaultTransitionS` (60), `gust` {meanIntervalS 40, minIntervalS 12, rampMinM 30, rampMaxM 120, magMin 0.5, magMax 1} |
| `lighting.ts` | `DEFAULT_HAZE` {omega 0.9, multiScatter 2.6, groundAlbedo 0.15, maxOfSky 0.8}, `HAZE_G` 0.7, `DAY_ILLUMINANCE` 11, `SKYLIGHT_SATURATION` 0.3, `GROUND_ALBEDO` (0.15, 0.15, 0.13), `NIGHT_AMBIENT_COLOR`, `ambientFloor` 0.22 + 0.22·moon |
| `preetham.ts` / `SkySystem.ts` | `INSCATTER_KNEE` 25, `NIGHT_GLOW_SCALE_HEIGHT` 0.18, `NIGHT_GLOW_HORIZON`/`_ZENITH`, `SKYLIGHT_HORIZON_SHARE` 0.5, `TWILIGHT_ZENITH` (0.004, 0.01, 0.03), `TWILIGHT_BAND` (0.26, 0.13, 0.045), `TWILIGHT_BAND_SCALE_HEIGHT` 0.2, `TWILIGHT_FULL_DEG` −1, `TWILIGHT_DECAY_DEG` 1.6, `SKY_EXTRA_DAY_FADE_DEG` [5, 15], `DECK_SKYLIGHT_COVER` [0.5, 1] |
| `lighting.ts` (clouds) | `CLOUD_SHADOW_FLOOR_SCATTERED` 0.15, `CLOUD_SHADOW_FLOOR_OVERCAST` 0.05 (`cloudShadowFloor`: smoothstep over cover 0.5 → 1) |
| runtime | `sky.stars.gain` (3.5), `sky.moon.brightness` (0.6), moon drawn at `MOON_APPARENT_DIAMETER_DEG` 1.0° (`SkySystem.ts`), `wind.ts` `LOG_PROFILE_MAX` (1.3), `lighting.ts` curves |
