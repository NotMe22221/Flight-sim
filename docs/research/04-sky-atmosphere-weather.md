# 04 — Sky, Atmosphere & Weather (Three.js r0.187, WebGL2, static site)

Research date: 2026-11-02. Target: browser flight sim in the spirit of MSFS, Three.js r187 + TypeScript + Vite,
integrated/laptop GPU, no backend (optional runtime fetch of public data). Everything here is implementation-ready
or flagged **UNVERIFIED** where a primary source could not be reached from the research container
(blocked hosts: noaa.gov, aviationweather.gov, open-meteo.com, wikipedia, shadertoy, guerrilla-games.com, docs.flightsimulator.com).

Conventions used throughout: world frame is **+X = East, +Y = Up, +Z = South** (right-handed, Three.js Y-up).
A direction *to* the sun with azimuth `az` (clockwise from north) and elevation `el` is
`sunDir = ( cos(el)·sin(az), sin(el), −cos(el)·cos(az) )`.

---

## 0. Recommendation summary (tiered)

| Tier | Sky | Aerial perspective | Clouds | Cost (iGPU, 1080p) |
|---|---|---|---|---|
| **A (MVP, week 1)** | `three/addons/objects/Sky.js` (Preetham) driven by NOAA sun position; PMREM env map rebaked when sun moves >1° | Custom analytic **height fog** patched into `ShaderChunk.fog_fragment`, fog colour sampled from a CPU port of the same Preetham formula at the horizon | r187 `Sky` built-in 2D fbm cloud layer (directional only) **plus** our own world-positioned **cloud-layer planes** (fly-through = fog blend) | sky ≤0.3 ms, fog ≈0, planes ≤0.6 ms |
| **B (quality, month 1–2)** | `@takram/three-atmosphere` 0.19.1 (MIT, Bruneton precomputed scattering, WebGL, `three ≥0.170`, needs `postprocessing` ≥6.36.7 [Zlib]) → correct twilight, night sky, stars, moon, sun transmittance | `AerialPerspectiveEffect` (post-process, physically based) | Own Nubis-style **volumetric ray-marcher** at ¼ res + 4×4 temporal reprojection, 1–4 layers, *or* `@takram/three-clouds` 0.7.6 (MIT) | atmosphere ≈1 ms, clouds 3–5 ms (Low/Medium preset) |
| **C (future)** | Hillaire-2020 LUT sky (`@pmndrs/sky` is **WebGPU-only**) | included | included | n/a until WebGPU |

Live weather: **aviationweather.gov blocks CORS** (official statement) → use **Open-Meteo** (CORS enabled, CC BY 4.0, winds aloft at pressure levels, cloud cover low/mid/high, visibility) directly from the browser, optionally METAR from `metar.vatsim.net` (CORS `*` per community reports, **UNVERIFIED**), or a 20-line Cloudflare Worker proxy in front of aviationweather.gov.

---

## 1. Physically based sky models

### 1.1 Comparison

| Model | Type | Twilight / below-horizon sun | Aerial perspective | Runtime cost | Code under permissive licence | Notes |
|---|---|---|---|---|---|---|
| **Preetham 1999** (three.js `Sky`) | analytic, per-pixel Rayleigh+Mie with hacks | Poor: sun < ~−2° goes to a flat dark blue; no earth-shadow gradient; three.js adds a `sunfade` hack | None (sky only) | ~20 ALU + 2 `pow`, trivially cheap | Yes — three.js MIT, [`Sky.js` r187](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/objects/Sky.js) | De-facto default; the r187 version grew a procedural **2D cloud layer** (uniforms `cloudScale 2e-4, cloudSpeed 2e-5, cloudCoverage 0.4, cloudDensity 0.4, cloudElevation 0.5, time`) |
| **Hosek–Wilkie 2012** | analytic fit to brute-force spectral sim; 9 coefficients + radiance per channel from a dataset | Defined only for solar elevation ≥ 0°; no night; needs separate sun disc | None | ~15 ALU per pixel once coefficients are computed on CPU | Reference C code is **BSD-3-Clause** ([licence header as carried in Blender's copy](https://projects.blender.org/archive/blender-archive/src/commit/b3ba41ecd1e1ed1cbb28b9fe90efb3c4f4e596c8/intern/sky/include/sky_model.h), © 2012–2013 Hosek & Wilkie); C++ re-implementations: [andrewwillmott/sun-sky](https://github.com/andrewwillmott/sun-sky) (Unlicense, has `HosekDataXYZ.h`), [diharaw/sky-models](https://github.com/diharaw/sky-models) (MIT, GLSL) | Noticeably better than Preetham near horizon and for high turbidity; no JS/three.js port found — would need a ~300-line port + 3600-float dataset |
| **Bruneton 2008/2017** precomputed scattering | LUTs: transmittance 256×64, scattering 4D in 3D texture 256×128×32 (r 32 × μ 128 × μs 32 × ν 8), irradiance 64×16 ([constants.h](https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/constants.h)) | Correct multiple scattering, earth shadow, twilight; views from space | Yes — transmittance & in-scatter for any point pair | 3–5 texture fetches/pixel for sky; AP as post-process | Original: BSD (© 2017 Eric Bruneton, [LICENSE](https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/LICENSE)). Three.js port: [`@takram/three-atmosphere`](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/atmosphere) **MIT** | Precompute once at startup on the GPU (`PrecomputedTexturesGenerator`, a few hundred ms on iGPU, **UNVERIFIED timing**) or download LUTs (`DEFAULT_PRECOMPUTED_TEXTURES_URL` points at `media.githubusercontent.com` — mirror them locally) |
| **Hillaire 2020** (UE4/5 sky) | small LUTs recomputed every frame (transmittance, multi-scattering 32×32, sky-view, AP volume) | Correct | Yes | ~0.5–1 ms | [`@pmndrs/sky`](https://github.com/pmndrs/sky) MIT but **WebGPURenderer only**; [JolifantoBambla/webgpu-sky-atmosphere](https://github.com/JolifantoBambla/webgpu-sky-atmosphere) WebGPU | Best future path once we move to WebGPU; no maintained WebGL2 library |

### 1.2 Three.js `Sky` (Preetham) — how to drive it

Source facts ([Sky.js r187](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/objects/Sky.js)): `BoxGeometry(1,1,1)`, `BackSide`, `depthWrite:false`, vertex shader forces `gl_Position.z = gl_Position.w` (always at far plane), so any `scale` ≤ `camera.far` works. Fragment computes `Fex = exp(−(βR·sR + βM·sM))`, in-scatter `Lin`, sun disc (angular diameter 66 arcsec → `cos = 0.99995667…`), night floor `vec3(0.1)*Fex`, final `(Lin+L0)*0.04 + sundisc + vec3(0,0.0003,0.00075)`, then `#include <tonemapping_fragment>` and `<colorspace_fragment>` — i.e. it is tone-mapped with the renderer's operator.

```ts
import { Sky } from 'three/addons/objects/Sky.js';
import * as THREE from 'three';

const sky = new Sky();
sky.scale.setScalar(100_000);            // ≤ camera.far; sky is drawn at far plane anyway
scene.add(sky);
const u = sky.material.uniforms;
u.turbidity.value = 2.5;                 // 1 (very clear) … 10 (hazy); example uses 10
u.rayleigh.value = 1.0;                  // 0–4; higher = bluer/darker zenith, redder sunsets
u.mieCoefficient.value = 0.005;          // 0–0.1 haze amount
u.mieDirectionalG.value = 0.8;           // forward lobe 0.7–0.9
u.cloudCoverage.value = 0.0;             // disable built-in 2D clouds when using our own layers

export function applySun(elDeg: number, azDeg: number) {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  // our frame: x=E, y=Up, z=S
  u.sunPosition.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}
```

Environment lighting from the sky (needed for `MeshStandardMaterial` reflections on the airframe/glass):

```ts
const pmrem = new THREE.PMREMGenerator(renderer);
const skyScene = new THREE.Scene(); skyScene.add(skyForEnv);      // a second Sky instance sharing uniforms
let lastSunDir = new THREE.Vector3();
function maybeRebakeEnv(sunDir: THREE.Vector3) {
  if (sunDir.angleTo(lastSunDir) < THREE.MathUtils.degToRad(1)) return;   // throttle: ≈ every 4 sim-minutes
  lastSunDir.copy(sunDir);
  u.showSunDisc.value = 0;                      // per three.js docs: hide disc to avoid PMREM fireflies
  scene.environment?.dispose();
  scene.environment = pmrem.fromScene(skyScene, 0, 0.1, 1000).texture;  // ~1–2 ms on iGPU (UNVERIFIED)
  u.showSunDisc.value = 1;
}
```

Known limitations for a flight sim: (a) no aerial perspective on terrain (we add height fog, §3); (b) night is a constant dark blue — fade in a star dome (§2.3) and lower exposure; (c) the built-in r187 cloud layer is **purely directional** (`cloudUV = direction.xz / (direction.y·elevation)`): it does not move with camera position and cannot be flown through — use it only as a distant cirrus veil and render real layers ourselves (§4).

### 1.3 Hosek–Wilkie formula (if we port it)

Per channel (RGB dataset or XYZ), with θ = view zenith angle, γ = angle between view and sun:

```
F(θ,γ) = (1 + A·exp(B / (cosθ + 0.01))) · (C + D·exp(E·γ) + F·cos²γ + G·χ(H,γ) + I·sqrt(cosθ))
χ(g,α) = (1 + cos²α) / (1 + g² − 2g·cosα)^1.5
L_channel = F(θ,γ) · L_M_channel          // L_M = "radiance" dataset value
```

Coefficients A…I and L_M come from the dataset indexed by (albedo ∈{0,1} → lerp, turbidity 1…10 → lerp, solar elevation → quintic Bézier in `(el/90°)^(1/3)` over 6 control points). Dataset size for RGB: 3 ch × 2 × 10 × 6 × 9 = 3240 coefficients + 3 × 120 radiance values. Compute the 27+3 numbers on the CPU once per frame, pass as uniforms, evaluate F per pixel. Licence of the reference implementation: BSD-3-Clause (verify against the authors' original distribution at `cgg.mff.cuni.cz/projects/SkylightModelling/` — **UNVERIFIED**, host not fetched). Verdict: nice-to-have; Bruneton via takram gives more (night, AP) for less engineering.

### 1.4 `@takram/three-atmosphere` integration notes (Tier B)

- Package facts from [package.json](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/package.json): `0.19.1`, MIT, peer `three >=0.170.0`, `postprocessing >=6.36.7` (npm latest 6.39.6, **Zlib** licence, peer `three >=0.168 <0.188` → r187 OK), deps `astronomy-engine ^2.1.19` (MIT; used for sun/moon ECEF directions).
- Vanilla usage (from its README): `SkyMaterial` on a `PlaneGeometry(2,2)` with `frustumCulled=false`, `SkyLightProbe`, `SunDirectionalLight`, `AerialPerspectiveEffect(camera)` in a `postprocessing` `EffectComposer` with `frameBufferType: HalfFloatType`, then a `ToneMappingEffect` (README example uses AgX). Textures via `PrecomputedTexturesGenerator(renderer).update()` or `PrecomputedTexturesLoader` from a URL you host.
- **Hard constraint:** reference frame is fixed to **ECEF** metres ([issue #11](https://github.com/takram-design-engineering/three-geospatial/issues/11)). Our sim will use a local ENU scene; the cheapest adapter is a parent `Group` whose matrix is the ENU→ECEF transform for the current reference point (re-centred when the aircraft moves >50 km), and feed `getSunDirectionECEF(date)`. Verify precision (Float32 ECEF ≈ 0.5 m at Earth radius; fine for sky, questionable for cockpit geometry → keep cockpit in a separate ENU scene/camera pass).
- Extras we get for free: `StarsMaterial` (BSC5, 9,096 stars, `stars.bin` J2000 ECI directions + magnitude + black-body chromaticity), `getMoonDirectionECEF`, `getSunLightColor`, light shafts are **not** implemented (noted in README limitations).

---

## 2. Sun, moon, stars

### 2.1 Sun position — NOAA / Meeus algorithm (validated)

Implementation below reproduces the NOAA Solar Calculator spreadsheet equations (Meeus, *Astronomical Algorithms*, ch. 25) — [NOAA calculation details](https://gml.noaa.gov/grad/solcalc/calcdetails.html) (page not reachable from the container; equations reproduced from the well-known spreadsheet). I cross-checked it against **suncalc 2.1.1** (which uses the same Meeus series + Sæmundsson refraction): max difference **0.016°** in elevation/azimuth across 5 daytime test cases (London solstice, KSFO, Sydney, KJFK); 0.46° at −14° elevation (different below-horizon refraction formulas; irrelevant). Accuracy is ~0.01° for 1900–2100, far better than needed.

```ts
// src/sky/solar.ts — NOAA/Meeus solar position. Angles in degrees unless noted.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export interface SunPos { elevation: number; apparentElevation: number; azimuth: number; declination: number; eotMin: number }

export function julianDay(date: Date): number { return date.getTime() / 86_400_000 + 2_440_587.5; }

export function sunPosition(date: Date, latDeg: number, lonDeg: number): SunPos {
  const T  = (julianDay(date) - 2_451_545) / 36_525;                                   // Julian centuries since J2000
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;    // geometric mean longitude
  const M  = 357.52911 + T * (35999.05029 - 0.0001537 * T);                            // mean anomaly
  const e  = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);                        // eccentricity
  const Mr = M * D2R;
  const C  = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
           + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289; // equation of centre
  const omega   = 125.04 - 1934.136 * T;
  const appLong = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * D2R);                  // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps  = eps0 + 0.00256 * Math.cos(omega * D2R);                                  // corrected obliquity
  const decl = Math.asin(Math.sin(eps * D2R) * Math.sin(appLong * D2R));                // radians
  const y = Math.tan(eps * D2R / 2) ** 2, L0r = L0 * D2R;
  const eotMin = 4 * R2D * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
               - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));   // equation of time, minutes
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  const tst = (((utcMin + eotMin + 4 * lonDeg) % 1440) + 1440) % 1440;                 // true solar time, minutes
  let ha = tst / 4 - 180; if (ha < -180) ha += 360;                                      // hour angle, degrees
  const lat = latDeg * D2R, har = ha * D2R;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(har);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevation = 90 - zen * R2D;
  let az = Math.acos(Math.min(1, Math.max(-1, (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zen))))) * R2D;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;                                     // clockwise from north
  // NOAA refraction correction (degrees)
  const te = Math.tan(elevation * D2R); let refr = 0;
  if (elevation > 85) refr = 0;
  else if (elevation > 5) refr = (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600;
  else if (elevation > -0.575) refr = (1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))) / 3600;
  else refr = (-20.772 / te) / 3600;
  return { elevation, apparentElevation: elevation + refr, azimuth: az, declination: decl * R2D, eotMin };
}

export function dirFromAzEl(azDeg: number, elDeg: number, out = new THREE.Vector3()) {   // x=E, y=Up, z=S
  const az = azDeg * D2R, el = elDeg * D2R;
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}
```

Use `apparentElevation` for the visible sun disc and `elevation` (geometric) for lighting thresholds. Sunrise/sunset = apparent elevation −0.833° (refraction 34′ + semi-diameter 16′); civil twilight −6°, nautical −12°, astronomical −18°.

### 2.2 Moon (cheap): use **suncalc**

[suncalc](https://github.com/mourner/suncalc) 2.1.1 on npm (BSD-2-Clause, © Volodymyr Agafonkin; ~16 KB CJS, ESM build included, TypeScript types shipped). In 2.x `getPosition`/`getMoonPosition` return **degrees** (azimuth 0 = north, clockwise; altitude refraction-corrected) — unlike 1.x radians-from-south. It uses a truncated ELP-2000 series for the Moon (Meeus ch. 47) so the Moon is good to a few arc-minutes.

```ts
import * as SunCalc from 'suncalc';
const m = SunCalc.getMoonPosition(date, lat, lon);        // { azimuth°, altitude°, distance km, parallacticAngle° }
const ill = SunCalc.getMoonIllumination(date);            // { fraction 0..1, phase 0..1 (0.5 = full), angle }
const times = SunCalc.getTimes(date, lat, lon);           // sunrise, sunset, dawn, dusk, nauticalDawn, night, solarNoon …
```

Rendering: textured `Sprite`/quad of angular diameter 0.52°, oriented with `parallacticAngle`; phase shading in the fragment shader by lighting a virtual sphere with the **actual sun direction** (dot(normal, sunDir)) — gives correct terminator orientation for free. Moonlight: add a second `DirectionalLight` with intensity ≈ `0.0025 · fraction` of the sun light (full moon ≈ 0.25 lx vs sun ≈ 100 klx) and colour `#b4c0ff`-ish after exposure; only matters at night with exposure boosted.

### 2.3 Star field

Data: **Yale Bright Star Catalog v5** (9,110 stars to V≈6.5, public-domain data). Ready-made mirrors: [brettonw/YaleBrightStarCatalog `bsc5-short.json`](https://github.com/brettonw/YaleBrightStarCatalog) (MIT; 954 KB JSON, fields `RA "00h 05m 09.9s"`, `Dec "+45° 13′ 45″"`, `V` magnitude, `K` colour temperature, optional constellation/Flamsteed) — convert offline to a compact binary (`Float32 ×4 per star: x,y,z unit vector J2000, magnitude` + `Uint8 ×3 colour` ≈ 170 KB). takram's `stars.bin` is the same catalogue pre-packed (MIT package). Alternative [HYG database](https://github.com/astronexus/HYG-Database) (now on Codeberg; ~120k stars; licence CC BY-SA — **UNVERIFIED version**, site unreachable) — overkill.

Equatorial → horizontal each frame (cheap, do it in the vertex shader via a single rotation matrix built on CPU):

```ts
// Greenwich mean sidereal time (Meeus 12.4), degrees
export function gmstDeg(date: Date) {
  const d = julianDay(date) - 2_451_545, T = d / 36_525;
  return (((280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38_710_000) % 360) + 360) % 360;
}
// Build matrix taking J2000 equatorial unit vectors (x toward RA=0, z toward north pole) into our ENU(x=E,y=Up,z=S) frame
export function equatorialToLocal(date: Date, latDeg: number, lonDeg: number, out = new THREE.Matrix4()) {
  const lst = (gmstDeg(date) + lonDeg) * D2R;                 // local sidereal time
  const rotZ = new THREE.Matrix4().makeRotationZ(-lst);        // rotate equatorial frame by −LST about the pole
  const tilt = new THREE.Matrix4().makeRotationX(-(90 - latDeg) * D2R); // tilt pole down to local latitude
  // equatorial after rotZ: x = toward local meridian (south at equator), z = north pole
  // after tilt around x by −(90−lat): z → up… then permute axes into (E, Up, S)
  const perm = new THREE.Matrix4().set(0, -1, 0, 0,   0, 0, 1, 0,   1, 0, 0, 0,   0, 0, 0, 1);
  return out.copy(perm).multiply(tilt).multiply(rotZ);
}
```
(Verify the permutation once against a known star, e.g. Polaris should sit at azimuth ≈ 0°, elevation ≈ latitude.)

Brightness: relative flux `I = 10^(−0.4·(m − m₀))`; size in pixels `size = clamp(3.0 − 0.4·m, 1.0, 4.0)`, intensity `pow(10, −0.4·m) · gain` with `gain` tuned so m=0 saturates after tone mapping at night exposure. Colour from BSC `K` (or B−V → T ≈ 4600·(1/(0.92·BV+1.7) + 1/(0.92·BV+0.62)) K) → sRGB via a 10-entry blackbody table. Fade stars with sky brightness: `starAlpha = smoothstep(−3°, −12°, sunElevation) · (1 − cloudCoverageAtZenith)`; render as `THREE.Points` with additive blending, `depthTest:false`, drawn right after the sky.

---

## 3. Aerial perspective & fog

### 3.1 What Three.js gives you

`scene.fog = new THREE.FogExp2(color, density)` → `fogFactor = 1 − exp(−density²·depth²)` with `depth = −mvPosition.z` (**view-space z, not Euclidean distance**, so it is wrong at wide FOV edges) and a single global colour ([fog_fragment.glsl.js](https://github.com/mrdoob/three.js/blob/r187/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js)). Linear `Fog` → `smoothstep(near, far, depth)`. Neither is height-dependent, so mountains above a valley haze look wrong and the fog colour cannot differ between the bright sun side and the dark anti-solar side.

Mapping meteorological visibility to the built-in `FogExp2`: Koschmieder with 2% contrast threshold: `exp(−density²·V²) = 0.02 ⇒ density = 1.978 / V_m` (V = 10 km → 1.98e-4). For physically meaningful extinction use `β = 3.912 / V_m` per metre (V = 10 km → 3.9e-4 m⁻¹; 50 km → 7.8e-5).

### 3.2 Custom analytic height fog (recommended for Tier A)

Exponential density `β(h) = β₀·exp(−h/H)` (H = scale height; 1200 m for haze, 8000 m for clean air). Optical depth along a ray from origin `o` (altitude `o.y`), direction `d`, length `t` has the closed form (Quilez, "better fog"):

```glsl
// GLSL, all metres. Returns in-scatter weight 0..1
float heightFogFactor(vec3 o, vec3 d, float t, float beta0, float invH) {
  float dy = abs(d.y) < 1e-4 ? 1e-4 * sign(d.y + 1e-9) : d.y;
  float od = beta0 / invH * exp(-o.y * invH) * (1.0 - exp(-t * dy * invH)) / dy;   // ∫ β(h) ds
  return 1.0 - exp(-od);
}
// Fog colour: sky colour at the horizon in the view direction, plus a sun-ward Mie glow
vec3 fogColor = mix(uHorizonColor, uSunGlowColor, pow(max(dot(d, uSunDir), 0.0), 8.0) * uSunGlowAmount);
```

Patch it into every built-in material once at startup (no custom materials needed):

```ts
import * as THREE from 'three';
THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor; uniform vec3 fogSunDir; uniform vec3 fogSunGlow; uniform float fogBeta0; uniform float fogInvH;
  varying vec3 vFogWorldPos;
#endif`;
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG\n varying vec3 vFogWorldPos;\n#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG\n vFogWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  vec3 fd = vFogWorldPos - cameraPosition; float ft = length(fd); fd /= ft;
  float fdy = abs(fd.y) < 1e-4 ? 1e-4 : fd.y;
  float od = fogBeta0 / fogInvH * exp(-cameraPosition.y * fogInvH) * (1.0 - exp(-ft * fdy * fogInvH)) / fdy;
  float fogFactor = 1.0 - exp(-od);
  vec3 fc = mix(fogColor, fogSunGlow, pow(max(dot(fd, fogSunDir), 0.0), 8.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, fogFactor);
#endif`;
// Supply the extra uniforms via material.onBeforeCompile or a global UniformsLib patch:
Object.assign(THREE.UniformsLib.fog, { fogSunDir: { value: new THREE.Vector3() }, fogSunGlow: { value: new THREE.Color() },
                                       fogBeta0: { value: 3.9e-4 }, fogInvH: { value: 1 / 1200 } });
```
Keep `scene.fog = new THREE.FogExp2(...)` set so `USE_FOG` is defined; update the four custom uniforms through `renderer` material refresh (`UniformsLib.fog` values are copied per program — set them each frame via `material.onBeforeCompile`/`uniformsNeedUpdate`, or simplest: iterate materials once to store their `uniforms` reference). The Sky mesh must have `material.fog = false`.

**Fog colour matched to the sky**: port the Preetham fragment maths to TypeScript (same constants: `totalRayleigh = (5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5)`, `MieConst = (1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14)`, `rayleighZenithLength 8.4e3`, `mieZenithLength 1.25e3`, `EE = 1000`, exposure `0.04`) and evaluate it at `dir = (sin az, 0.02, −cos az)` for 8–16 azimuths each frame → a 16×1 `DataTexture` (or just the colour in the camera's forward azimuth). This guarantees the horizon seam between terrain fog and sky dome is invisible. With Tier B, delete all of this and use `AerialPerspectiveEffect`.

Cloud-layer interaction: when the camera is inside a layer (`base ≤ h ≤ top`), lerp `fogBeta0` toward `0.02–0.05 m⁻¹` (visibility 80–200 m) and the fog colour toward the cloud's ambient colour; this is also how we hide the layer plane's edge when flying through it (§4.2).

---

## 4. Clouds

### 4.1 Tiers and which to pick

| Approach | Looks | Fly-through | Shadows on terrain | Cost @1080p iGPU | Use for |
|---|---|---|---|---|---|
| r187 `Sky` built-in fbm layer | good from the ground, flat | no (directional only) | no | ~0 | distant cirrus veil only |
| **Cloud-layer planes** (world-positioned textured quads, 2–3 layers) | good above FL100 and below the deck; weak at the layer altitude | via fog blend | cheap projected texture | 0.2–0.6 ms | **Tier A default** for Few/Scattered/Broken/Overcast |
| Billboard impostors (hundreds of cumulus sprites, MSFS-FSX style) | ok mid-distance, popping/sorting issues | poor | yes (blob shadows) | 0.5–2 ms (overdraw) | optional cumulus "puffs" under 5 km |
| **Volumetric ray-march** (Nubis style) | best | yes | yes (Beer shadow map) | 3–6 ms at ¼ res + reprojection; 10–20 ms naive | **Tier B** on `qualityPreset` ≥ medium |

### 4.2 Cloud-layer plane shader (Tier A)

One `PlaneGeometry(2·R, 2·R)` per layer, `R = 60 km`, centred on the camera XZ every frame (snap UVs to world coords so it does not swim), at `y = layer.base + 0.5·layer.thickness`, `DoubleSide`, `transparent`, `depthWrite:false`, `renderOrder` after terrain/sky, `fog=false` (we apply our own aerial perspective inside).

```glsl
// cloudLayer.frag — ShaderMaterial, GLSL ES 1.00 (varyings + gl_FragColor). Uniforms set from WeatherState.layers[i]
uniform vec3  uSunDir, uSunColor, uSkyAmbient, uHorizonColor;
uniform float uCoverage;        // 0..1 (FEW≈0.19, SCT≈0.44, BKN≈0.75, OVC≈1.0)
uniform float uDensity;         // 0.3 thin stratus … 1.5 towering
uniform float uBase, uTop;      // metres MSL
uniform float uTime; uniform vec2 uWind; // m/s layer wind (x=E, z=S) → uv drift
uniform float uFogBeta0, uFogInvH;
varying vec3 vWorld;

float hash(vec2 p){ vec3 q = fract(p.xyx*vec3(.1031,.1030,.0973)); q += dot(q, q.yzx+33.33); return fract((q.x+q.y)*q.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+17.1; a*=.5;} return s; }

void main(){
  vec3  camToP = vWorld - cameraPosition; float dist = length(camToP); vec3 d = camToP / dist;
  vec2  p = (vWorld.xz - uWind * uTime) * (1.0 / 2500.0);          // 2.5 km base feature size
  float shape  = fbm(p);                                           // 0..1
  float detail = fbm(p * 7.0 + 3.7) ;                              // erosion
  float cov    = uCoverage;
  float dens   = smoothstep(1.0 - cov, 1.0 - cov + 0.25, shape);  // coverage threshold (Nubis "remap" idea)
  dens = clamp((dens - (1.0 - dens) * detail * 0.35) , 0.0, 1.0);  // erode edges
  float thickness = (uTop - uBase) * dens * uDensity;              // metres of cloud along the vertical
  // slant path through the slab ~ thickness / |d.y|
  float od   = thickness * 0.0025 / max(abs(d.y), 0.08);          // σ_t ≈ 0.0025 m⁻¹ … 0.05 m⁻¹ for cumulus
  float alpha = 1.0 - exp(-od);
  // lighting: sun transmittance through the slab above the sample + ambient; powder darkens thin edges
  float sunT  = exp(-thickness * 0.0025 * 0.6);
  float powder = 1.0 - exp(-2.0 * od);
  float cosT = dot(d, uSunDir);
  float hg   = 0.0795775 * (1.0 - 0.36) / pow(1.0 + 0.36 - 1.2 * cosT, 1.5);   // HG g=0.6, 1/(4π)
  vec3  col  = uSkyAmbient * 0.8 + uSunColor * (sunT * 0.9 + hg * 2.5 * powder * (1.0 - alpha));
  // aerial perspective to match terrain fog
  float fdy = abs(d.y) < 1e-3 ? 1e-3 : d.y;
  float fogOD = uFogBeta0 / uFogInvH * exp(-cameraPosition.y * uFogInvH) * (1.0 - exp(-dist * fdy * uFogInvH)) / fdy;
  col = mix(col, uHorizonColor, 1.0 - exp(-fogOD));
  alpha *= smoothstep(0.0, 0.015, abs(d.y));                       // hide the razor edge at the horizon
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
```
Underside vs top: pass `gl_FrontFacing` or compare `cameraPosition.y` with the plane to darken the underside (`col *= 0.55` plus more ambient, less sun). Terrain cloud shadows: sample the same `fbm` in the terrain shader (or a 512² `WebGLRenderTarget` of `dens` rendered top-down each few frames) at `worldXZ − (sunDir.xz/sunDir.y)·(cloudBase − terrainY)` and multiply the sun term by `exp(−thickness·σ)`.

### 4.3 Volumetric ray-marched clouds (Tier B) — Nubis / HZD recipe

Primary sources: Schneider & Vos, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015 ([Guerrilla PDF](https://www.guerrilla-games.com/media/News/Files/The-Real-time-Volumetric-Cloudscapes-of-Horizon-Zero-Dawn.pdf), not fetchable here; [Schneider's publications page](https://sites.google.com/view/vonschneidz/publications)); Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite", SIGGRAPH 2016; open reimplementations with sourced parameters: [TylerDodds/VolumetricCloudsTutorial](https://github.com/TylerDodds/VolumetricCloudsTutorial) (Unity, detailed write-up), [adrianderstroff/realtime-clouds](https://github.com/adrianderstroff/realtime-clouds) (Go/GLSL, MIT), takram's [`@takram/three-clouds`](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds) (MIT, three.js, the most relevant reference code). Schneider reports Nubis at **< 2 ms on PS4**.

**Inputs**
- Shape noise: 3D `128³` RGBA8, R = Perlin–Worley, G/B/A = Worley fBm at increasing frequency (takram `CLOUD_SHAPE_TEXTURE_SIZE = 128`; the "128³ base / 32³ detail" split is confirmed by several reimplementations). 128³×4 B = 8 MB raw; generate at startup in a fragment shader into a `WebGL3DRenderTarget` (~100 ms) or ship as `.bin` (gzip ≈ 2–3 MB). Use Hillaire's [TileableVolumeNoise](https://github.com/sebh/TileableVolumeNoise) (MIT) generator to pre-bake.
- Detail noise: 3D `32³` RGB8 Worley fBm (`CLOUD_SHAPE_DETAIL_TEXTURE_SIZE = 32`).
- Weather map: 2D 512² RGBA8 tiled over ~60–100 km: R = coverage, G = cloud type (0 stratus … 0.5 stratocumulus … 1 cumulus/towering), B = precipitation/density, A = spare. For MSFS-style presets we generate it procedurally from `WeatherState` (fBm thresholded to the preset coverage); for live weather, paint Open-Meteo `cloud_cover_low/mid/high` into R per layer.
- Optional: 2D curl noise for wispiness, spatiotemporal blue noise (STBN) 128×128×64 for jitter (takram ships one; NVIDIA STBN paper).
- Scene depth texture for compositing against terrain.

**Density function** (per sample position `p`, layer with `base`, `top`):

```glsl
float remap(float v, float lo, float hi, float nlo, float nhi){ return nlo + (v - lo) * (nhi - nlo) / (hi - lo); }
float heightFrac(vec3 p){ return clamp((p.y - uBase) / (uTop - uBase), 0.0, 1.0); }
// Height gradients (community values used by most HZD reimplementations — UNVERIFIED vs. the original slides)
const vec4 STRATUS = vec4(0.0, 0.1, 0.2, 0.3), STRATOCU = vec4(0.02, 0.2, 0.48, 0.625), CUMULUS = vec4(0.0, 0.1625, 0.88, 0.98);
float gradient(float h, vec4 g){ return smoothstep(g.x, g.y, h) - smoothstep(g.z, g.w, h); }
float heightGradient(float h, float type){
  return mix(mix(gradient(h, STRATUS), gradient(h, STRATOCU), clamp(type * 2.0, 0.0, 1.0)),
             gradient(h, CUMULUS), clamp(type * 2.0 - 1.0, 0.0, 1.0)); }

float sampleDensity(vec3 p, bool cheap){
  vec3 w = texture(uWeather, p.xz * uWeatherScale + uWeatherOffset).rgb;   // r=coverage g=type b=density
  float h = heightFrac(p);
  vec4 s = texture(uShape, p * uShapeScale + vec3(uWind * uTime, 0.0).xzy);  // 1/ (≈ 4–8 km) scale
  float lowFreqFBM = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float base = remap(s.r, lowFreqFBM - 1.0, 1.0, 0.0, 1.0);                   // Perlin-Worley eroded by Worley fBm
  base *= heightGradient(h, w.g);
  float coverage = w.r * uCoverageScale;
  base = remap(base, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage;                 // carve by coverage, keep soft
  base = max(base, 0.0);
  if (cheap || base <= 0.0) return base * uDensityScale;
  vec3 dtl = texture(uDetail, p * uDetailScale + curlOffset(p)).rgb;            // ≈ 1/300 m scale
  float hfFBM = dtl.r * 0.625 + dtl.g * 0.25 + dtl.b * 0.125;
  float hfMod = mix(hfFBM, 1.0 - hfFBM, clamp(h * 10.0, 0.0, 1.0));           // wispy bottoms, billowy tops
  base = remap(base, hfMod * 0.2, 1.0, 0.0, 1.0);
  return max(base, 0.0) * uDensityScale;                                        // σ_t in m⁻¹ (≈0.01–0.1 inside clouds)
}
```

**Lighting** (per view sample, `sigma` = density):

```glsl
float hg(float c, float g){ float g2=g*g; return 0.0795775 * (1.0 - g2) / pow(1.0 + g2 - 2.0*g*c, 1.5); }
float phase(float c){ return mix(hg(c, 0.7), hg(c, -0.2), 0.5); }      // dual lobe; takram defaults 0.7 / −0.2 / mix 0.5

float lightOD(vec3 p){ // optical depth toward the sun: 5 cone samples + 1 far sample (HZD: "5 + 1 long distance")
  float od = 0.0; float step = (uTop - uBase) * 0.1;
  for (int i = 1; i <= 5; i++) { vec3 q = p + uSunDir * step * float(i) + coneNoise(i) * step * float(i) * 0.3;
    od += sampleDensity(q, i > 2) * step; }
  od += sampleDensity(p + uSunDir * step * 18.0, true) * step * 3.0;
  return od;
}
// Multiple-scattering approximation (Wrenninge 2013 "Oz", used by Frostbite/HZD-2017): N octaves with a,b,c = 0.5
vec3 scatterLight(float od, float cosTheta, float viewOD){
  vec3 L = vec3(0.0); float a = 1.0, b = 1.0, c = 1.0;
  for (int i = 0; i < 3; i++) { L += b * exp(-od * a) * phaseG(cosTheta, c); a *= 0.5; b *= 0.5; c *= 0.5; }
  // 2015-style "powder" (view-dependent darkening of thin edges); takram: powderScale 0.8, exponent 150
  float powder = 1.0 - exp(-viewOD * 2.0);
  return uSunColor * L * mix(1.0, powder, 0.8);
}
```

**Ray march** (full-screen pass at ¼ resolution, 4×4 Bayer/STBN pixel selection so each frame marches 1/16 of the pixels, reprojected with the previous view-projection; takram: "reduces the number of texels to ray march by 1/16"):

```glsl
void main(){
  vec3 ro = cameraPosition, rd = viewRay();                    // from inverse projection
  vec2 t = intersectSlab(ro, rd, uBase, uTop);                 // or spherical shells for > 100 km views
  float sceneT = linearDepth(texture(uDepth, uv).r);           // stop at terrain
  if (t.x > sceneT || t.y <= 0.0) { out = vec4(0,0,0,1); return; }
  t.x = max(t.x, 0.0); t.y = min(t.y, sceneT);
  float dist = t.y - t.x;
  int   n    = int(clamp(dist / 100.0, 32.0, 96.0));           // 32–96 samples; step 100–1000 m (takram min 50/max 1000)
  float dt   = dist / float(n), tt = t.x + dt * stbn(uv, uFrame);
  vec3  L = vec3(0.0); float T = 1.0; int zeroRun = 0; bool fine = false;
  for (int i = 0; i < n && T > 0.01; i++) {
    vec3 p = ro + rd * tt;
    float sigma = sampleDensity(p, !fine);
    if (sigma > 0.0) {
      if (!fine) { fine = true; tt -= dt; dt *= 0.5; continue; }  // step back, switch to small steps
      zeroRun = 0;
      float od  = lightOD(p);
      vec3  S   = scatterLight(od, dot(rd, uSunDir), sigma * dt) + uSkyAmbient * mix(0.5, 1.0, heightFrac(p)) ;
      float Ts  = exp(-sigma * dt);
      L += T * (S - S * Ts) / max(sigma, 1e-5) * sigma;        // energy-conserving integration (Hillaire 2016)
      T *= Ts;
    } else if (fine && ++zeroRun > 6) { fine = false; dt *= 2.0; }
    tt += dt;
  }
  out = vec4(L, T);                                            // premultiplied colour + transmittance
}
```
Composite pass: `reproject(history) ⊕ current` (lerp weight ≈ 0.05–0.1 toward the fresh sample, clamp to neighbourhood to limit ghosting — takram notes ghosting is its main open issue), upsample to full res with depth-aware bilateral filter, then `scene.rgb = scene.rgb * T + L`, then aerial perspective using transmittance-weighted mean cloud depth. Terrain shadows: Beer shadow map (ray-march optical depth from the sun into a 512²–1024² RT with 2–3 cascades; takram `shadow.cascadeCount = 3`), sampled in the terrain shader as `exp(−od)`.

Performance knobs (and what takram measured — its README table): iPhone 13 at 'Low' with temporal upscaling 36–53 fps; M3 Max 'High' 4K 92–95 fps with upscaling vs 31 fps without → **temporal upscaling is a 3× win**, non-negotiable on iGPU. Our budget: ¼-res march (480×270 at 1080p), ≤64 steps, 5+1 light samples only when `sigma > 0`, detail noise only in fine mode, `maxRayDistance` 100–200 km, early-out `T < 0.01`.

### 4.4 Weather presets (MSFS naming)

MSFS 2024 ships nine presets: Clear Skies, Few Clouds, Scattered Clouds, Broken Clouds, High Level Clouds, Overcast, Rain, Snow, Storm ([list](https://flyawaysimulation.com/ask/answers/msfs-2024-weather-presets/)). MSFS exposes per layer: base/top altitude (metres in the WPR XML), coverage, density, scattering ([official WPR docs](https://docs.flightsimulator.com/msfs2024/retail/content-configuration/mission-xml-files/weather-xml-wpr-file-properties/index.md), not fetchable here) and a community guide maps coverage ≈ 16/45/66/95 % to Few/Scattered/Broken/Overcast ([DC3 Airways guide](https://dc3airways.net/wr/Weather_MSFS.pdf)). Our presets (octas → coverage: FEW 1–2 → 0.19, SCT 3–4 → 0.44, BKN 5–7 → 0.75, OVC 8 → 1.0):

| Preset | Layers (base–top m AGL, coverage, type) | Vis (m) | Wind sfc / aloft | Precip | Turb |
|---|---|---|---|---|---|
| Clear | — (optional cirrus 9000–9500, 0.1, stratus-type thin) | 50 000 | 3 m/s / 10 m/s | — | 0 |
| Few | 1200–1700, 0.19, cumulus | 40 000 | 4 / 12 | — | 0.05 |
| Scattered | 1000–1800, 0.44, cumulus | 25 000 | 5 / 15 | — | 0.1 |
| Broken | 800–1900, 0.75, stratocumulus; 6000–6500, 0.3, stratus | 15 000 | 7 / 20 | — | 0.2 |
| High Level | 7000–8500, 0.6, stratus-type (cirrostratus) | 40 000 | 3 / 25 | — | 0.05 |
| Overcast | 500–1500, 1.0, stratus | 8 000 | 6 / 15 | — | 0.15 |
| Rain | 400–2200, 1.0, stratus (dense); 3000–4500, 0.8 | 4 000 | 9 (gust 14) / 20 | rain 4 mm/h | 0.3 |
| Snow | 300–1800, 1.0, stratus | 2 000 | 6 / 15 | snow 2 mm/h | 0.2 |
| Storm | 600–9000, 0.7, cumulus (towering, density 1.5); 1500–2500 BKN stratocu | 3 000 | 12 (gust 22) / 30 | rain 15 mm/h, lightning | 0.6 |

Layer altitudes are **AGL at the departure airport** in presets (MSFS behaviour per [forum investigation](https://forums.flightsimulator.com/t/investigating-how-msfs-draws-clouds-for-weather/482387/36)); METAR heights are AGL, Open-Meteo gives MSL geopotential heights for pressure levels — store MSL internally.

---

## 5. Precipitation

**Camera-relative particle box** (rain and snow share the code): `N` instanced quads in a box `B = 40 m × 30 m × 40 m` centred on the camera; positions live entirely in the vertex shader so there is no per-frame CPU work:

```glsl
// rainParticles.vert — instanced quads; per-instance: aSeed (vec3 0..1), per-draw: uTime, uBox, uCamPos, uVelRel
vec3 p0  = aSeed * uBox;
vec3 p   = mod(p0 + uVelRel * uTime, uBox) - 0.5 * uBox + uCamPos;      // wrap-around, follows camera
// stretch along relative velocity for streaks: length = |v_rel| * exposure (1/60 s) clamped 0.05–1.5 m
vec3 axis = normalize(uVelRel); float len = clamp(length(uVelRel) / 60.0, 0.05, 1.5);
vec3 right = normalize(cross(axis, normalize(uCamPos - p))) * uWidth;     // uWidth 0.003 m rain, 0.006 m snow
vec3 world = p + axis * (position.y * len) + right * position.x;
```
`uVelRel = v_fall + v_wind − v_aircraft` with terminal fall speed **rain 6–9 m/s** (drop 1–3 mm), **snow 0.5–1.5 m/s** (add per-instance sinusoidal flutter `0.3·sin(uTime·2 + seed·6.28)` in x/z for snow). Counts: rain 6 000–12 000 instances for 4–15 mm/h; snow 3 000–8 000 round sprites 5–12 mm. Material: `MeshBasicMaterial`-like custom shader, `transparent`, `depthWrite:false`, colour = fog/ambient colour × 0.6 with 0.3–0.5 alpha; streak alpha fades at both ends. Cost ≈ 0.1–0.3 ms. Also reduce `visibility` (rain 4 mm/h → 4–8 km; heavy 15 mm/h → 1–3 km) and raise `turbidity`.

**Windshield rain** (cockpit view only): screen-space pass over the glass region (or full-screen post pass masked by the canopy): divide the screen into a grid (cells ≈ 40–60 px); per cell pick a random drop position/phase; SDF ellipse drop with a tear-shaped trail whose direction is the airflow vector projected to screen (slanted backward/upward with airspeed); drops fall slowly when parked, streak when fast; compute a pseudo-normal from the drop SDF gradient and **offset the scene-texture UV by `normal.xy · 0.02–0.05`** (refraction) plus `textureLod` blur (LOD 2–3) inside trails to fake condensation. The canonical reference is Martijn Steinrucken's "Heartfelt" (Shadertoy `ltffzl`) — **Shadertoy's default licence is CC BY-NC-SA 3.0**, so study it but write our own (several MIT rewrites exist, e.g. the [Godot "Rain on Glass" shader](https://godotshaders.com/shader/rain-on-glass/) notes the same technique). Wiper: a rotating sector mask that resets drops. Requires rendering the exterior scene to a render target first (we already do for post-processing in Tier B).

---

## 6. Wind model

```ts
export interface WindLayer { altitudeM: number; dirFromDeg: number; speedMps: number; gustMps?: number }
export interface WindSample { v: THREE.Vector3; gust: number }
// Interpolate layers (vector-lerp so direction wraps correctly), log profile below the lowest layer (z0 = 0.03 m grass, 0.5 m city)
export function windAt(layers: WindLayer[], altMslM: number, aglM: number, z0 = 0.03, out = new THREE.Vector3()): WindSample {
  const toVec = (l: WindLayer) => { const a = (l.dirFromDeg + 180) * D2R; // "from" → "to"
    return new THREE.Vector3(Math.sin(a) * l.speedMps, 0, -Math.cos(a) * l.speedMps); };
  let v: THREE.Vector3; let gust = 0;
  if (altMslM <= layers[0].altitudeM) {                      // surface layer: logarithmic profile referenced to 10 m
    const ref = toVec(layers[0]); const f = Math.log(Math.max(aglM, z0 * 1.01) / z0) / Math.log(10 / z0);
    v = ref.multiplyScalar(Math.min(f, 1.3)); gust = layers[0].gustMps ?? 0;
  } else {
    let i = 0; while (i < layers.length - 1 && layers[i + 1].altitudeM < altMslM) i++;
    const a = layers[i], b = layers[Math.min(i + 1, layers.length - 1)];
    const t = b === a ? 0 : (altMslM - a.altitudeM) / (b.altitudeM - a.altitudeM);
    v = toVec(a).lerp(toVec(b), THREE.MathUtils.clamp(t, 0, 1)); gust = THREE.MathUtils.lerp(a.gustMps ?? 0, b.gustMps ?? 0, t);
  }
  return { v: out.copy(v), gust };
}
```

**Discrete gusts** (MIL-F-8785C "1−cosine"): `V_g(x) = (V_m/2)·(1 − cos(π·x/d_m))` for `0 ≤ x ≤ d_m`, `d_m` 30–120 m (ramp length), `V_m` = METAR gust − mean; trigger stochastically with mean interval 20–60 s when `gust > 0`.

**Continuous turbulence — Dryden model** (MIL-F-8785C forms as documented by [MathWorks' Dryden block](https://www.mathworks.com/help/aeroblks/drydenwindturbulencemodelcontinuous.html) and [Modelica's example](https://doc.modelica.org/Modelica%204.0.0/Resources/helpWSM/Modelica/Modelica.Blocks.Examples.Noise.DrydenContinuousTurbulence.html)). Shaping filters (V = true airspeed, L = scale length, σ = intensity):

```
H_u(s) = σ_u · sqrt(2 L_u / (π V)) · 1 / (1 + (L_u/V) s)
H_v(s) = σ_v · sqrt(L_v / (π V)) · (1 + √3 (L_v/V) s) / (1 + (L_v/V) s)²
H_w(s) = σ_w · sqrt(L_w / (π V)) · (1 + √3 (L_w/V) s) / (1 + (L_w/V) s)²
Low altitude (h < 1000 ft, h in ft):  L_w = h,  L_u = L_v = h / (0.177 + 0.000823 h)^1.2
                                     σ_w = 0.1·W20,  σ_u = σ_v = σ_w / (0.177 + 0.000823 h)^0.4
W20 (wind at 20 ft) = 15 kt light, 30 kt moderate, 45 kt severe   (MIL-F-8785C defaults — UNVERIFIED here)
Medium/high altitude (> 2000 ft): L_u = L_v = L_w = 1750 ft (MIL-F-8785C); σ from the severity-vs-altitude table (≈ light 1.5, moderate 3, severe 6 m/s near 10 kft — approximate)
```

Discrete realisation verified numerically (Euler at dt = 1/120 s reproduces σ within 2 %): drive the filters with `η_k = n_k · sqrt(π / dt)`, `n_k ~ N(0,1)`.

```ts
export class DrydenTurbulence {
  private u = 0; private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  /** returns body-ish gust velocity (m/s) in [along-wind, cross, vertical]; call at FDM rate */
  step(dt: number, V: number, hFt: number, W20kt: number): [number, number, number] {
    const hm = hFt * 0.3048, k = Math.pow(0.177 + 0.000823 * hFt, 1);
    const Lw = Math.max(hm, 10), Lu = Math.max(hm / Math.pow(k, 1.2), 10);
    const sw = 0.1 * W20kt * 0.5144, su = sw / Math.pow(k, 0.4);
    const eta = () => gaussian() * Math.sqrt(Math.PI / dt);
    const tu = Lu / V, Ku = su * Math.sqrt(2 * Lu / (Math.PI * V));
    this.u += dt * (-this.u + Ku * eta()) / tu;
    const second = (s: { a: number; b: number }, tau: number, K: number) => {       // H = K(1+√3τs)/(1+τs)²
      const e = eta(); const a1 = s.b, b1 = (-s.a - 2 * tau * s.b + e) / (tau * tau);
      s.a += dt * a1; s.b += dt * b1; return K * (s.a + Math.sqrt(3) * tau * s.b); };
    const v = second({ a: this.x1, b: this.x2 } as any, Lu / V, su * Math.sqrt(Lu / (Math.PI * V)));
    const w = second({ a: this.y1, b: this.y2 } as any, Lw / V, sw * Math.sqrt(Lw / (Math.PI * V)));
    return [this.u, v, w];
  }
}
```
(Store the `{a,b}` state objects as fields rather than the `as any` shortcut.) Add the result to the wind vector fed to the FDM (`V_air = V_ground − (wind + gust + turbulence)`), rotated into the body frame. Clamp above 2000 ft AGL to the fixed-L form.

**Intensity mapping** for UI/METAR/EDR: ICAO Annex 3 classes turbulence by peak EDR (m^(2/3) s⁻¹): light < 0.2, moderate 0.2–0.45, severe ≥ 0.45 ([Skybrary EDR](https://skybrary.aero/articles/eddy-dissipation-rate-edr); older ICAO 2001 thresholds 0.1/0.3/0.5). Suggested mapping of our `WeatherState.turbulence` (0–1) → W20 for the Dryden model: `W20kt = 45·turbulence` (0.33 ≈ light, 0.67 ≈ moderate, 1.0 ≈ severe); extra bumpiness near/inside cumulus: `turbulence = max(turbulence, 0.4·cloudDensityAtAircraft)`.

**Thermals (optional, soaring)**: Allen's NASA model (TM-2006-214019, *Updraft Model for Development of Autonomous Soaring UAVs*, not fetched — **UNVERIFIED details**): thermal columns of radius `R ≈ 0.102·z_i^(1/3)·(1 − 0.25·z/z_i)·z_i` (convective layer depth `z_i` 1–2.5 km), updraft `w(r) = w* · (1 − (r/R)²)·exp(−(r/R)²)`-like bell with sink ring outside; `w*` 1–4 m/s scaled by `sin(solarElevation)` and surface type; spawn on a Poisson grid with spacing ≈ 1.5–2.5·z_i, drift with the wind, lifetime 10–20 min. Feed as a vertical wind component in `windAt`.

---

## 7. Lighting

Sun light = `DirectionalLight`; sky light = `HemisphereLight` (sky colour = sky zenith sample, ground colour = horizon colour × ground albedo ≈ 0.3) + `scene.environment` (PMREM, §1.2) for specular. Drive all three from the same sky model so colours stay consistent:

```ts
// Sun transmittance from the Preetham extinction used by Sky.js (so sun colour matches the sky)
const totalRayleigh = new THREE.Vector3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const mieConst = new THREE.Vector3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
export function sunTransmittance(elDeg: number, turbidity: number, rayleigh = 1, mieCoefficient = 0.005) {
  const zen = Math.max(0, 90 - elDeg) * D2R;
  const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - zen * R2D, -1.253));
  const sR = 8.4e3 * inv, sM = 1.25e3 * inv;
  const c = 0.2 * turbidity * 10e-18; const bM = mieConst.clone().multiplyScalar(0.434 * c * mieCoefficient);
  const bR = totalRayleigh.clone().multiplyScalar(rayleigh);
  return new THREE.Color(Math.exp(-(bR.x * sR + bM.x * sM)), Math.exp(-(bR.y * sR + bM.y * sM)), Math.exp(-(bR.z * sR + bM.z * sM)));
}
export function updateLighting(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, moon: THREE.DirectionalLight,
                               elDeg: number, sunDir: THREE.Vector3, cloudCover: number, moonFrac: number, moonDir: THREE.Vector3, moonEl: number) {
  const T = sunTransmittance(elDeg, weather.turbidity);
  const up = THREE.MathUtils.smoothstep(elDeg, -1, 4);                 // disc rising
  sun.color.copy(T); sun.intensity = 3.0 * up * (1 - 0.85 * cloudCover);   // 3.0 ≈ 100 klx after exposure 0.6–1.0 with AgX
  sun.position.copy(sunDir).multiplyScalar(1000); sun.target.position.set(0, 0, 0);
  const sky = skyZenithColor(elDeg), horizon = skyHorizonColor(elDeg);   // CPU Preetham samples (§3.2)
  hemi.color.copy(sky); hemi.groundColor.copy(horizon).multiplyScalar(0.35);
  hemi.intensity = THREE.MathUtils.lerp(0.02, 0.9, THREE.MathUtils.smoothstep(elDeg, -12, 10)) * (1 + 0.3 * cloudCover);
  moon.intensity = 0.0075 * moonFrac * THREE.MathUtils.smoothstep(moonEl, -1, 5) * (1 - 0.9 * cloudCover);   // ≈ 0.25 lx full moon
  moon.color.set(0xb8c4ff); moon.position.copy(moonDir).multiplyScalar(1000);
}
```

Reference illuminances (order-of-magnitude anchors, widely quoted — e.g. the Wikipedia "Daylight" table, mirrored [here](https://ipfs.ssi.eecc.de/ipns/en.wikipedia-on-ipfs.org/wiki/Daylight)): direct sun 100–120 klx; full daylight no sun 10–25 klx; overcast 1–2 klx (dark overcast 100 lx); sunrise/sunset clear 400 lx; civil twilight end ≈ 3 lx; full moon 0.05–0.3 lx; starlight 0.001 lx. Colour temperature: sun at zenith ≈ 5 500–5 800 K at the surface (5 900 K above the atmosphere), ≈ 3 000–3 500 K at 5° elevation, 1 850–2 500 K at the horizon; blue sky 10 000–20 000 K; overcast ≈ 6 500 K. **Do not hard-code Kelvin**: the transmittance function above reproduces the reddening automatically; a blackbody table is only needed for the moon/stars/lamps.

Night: boost exposure (eye adaptation) and switch materials' emissives on:
- Instruments/panels: `MeshStandardMaterial.emissive` (warm `#ff9a3c`-ish ≈ 2 700 K for incandescent flood, `#ff2a1a` red flood) with `emissiveIntensity` 1–3; bloom via `UnrealBloomPass` at half resolution (`strength 0.4, radius 0.3, threshold 1.0`) — selective bloom by rendering emissives above 1.0 only; ≈1 ms at 1080p half-res.
- Runway/approach lights: single `THREE.Points` draw with a custom shader: per-point colour (edge white → amber in last 600 m, threshold green/red, centreline white → alternating red/white last 900 m → red last 300 m, PAPI red/white by glide-path angle, taxiway blue edge / green centreline, REIL and sequenced flashers at 2 Hz driven by `uTime`), `gl_PointSize = clamp(k / viewDepth, 2.0, 14.0)` plus a radial glow sprite, additive blending, intensity `× exp(−β·dist)` using the current fog extinction so lights fade correctly in haze; depth test on, `depthWrite` off. Thousands of lights ≈ 0.1 ms.
- Beacon/strobe/nav lights on the aircraft: emissive sprites with time-based flash patterns; landing/taxi lights as `SpotLight` with shadow off (one or two max on iGPU).

Tone mapping in r187 ([tonemapping_pars_fragment](https://github.com/mrdoob/three.js/blob/r187/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js)): `ACESFilmicToneMapping` (note: three multiplies by `exposure / 0.6` — brighter than reference ACES), `AgXToneMapping` (Filament/Blender-based, rec2020 inset/outset, best highlight desaturation for sun/sky/sunsets), `NeutralToneMapping` (Khronos PBR Neutral, preserves hue — good for cockpit textures but sky highlights clip), plus Reinhard/Cineon/Linear. **Recommendation: AgX**, `renderer.toneMappingExposure` as the sole exposure control, `renderer.outputColorSpace = SRGBColorSpace` (default). If using `postprocessing`/`EffectComposer`, set `renderer.toneMapping = NoToneMapping` and add `ToneMappingEffect({ mode: ToneMappingMode.AGX })` as the last effect (the Sky material's `#include <tonemapping_fragment>` then becomes a no-op, which is what we want).

Auto-exposure without GPU read-back (deterministic, cheap):

```ts
export function targetExposure(sunEl: number, cloudCover: number, inCockpit: boolean, moonFrac: number) {
  const day = 0.6, civil = 2.0, night = 6.0 + 4.0 * (1 - moonFrac);
  const t1 = THREE.MathUtils.smoothstep(sunEl, -6, 8);         // dawn→day
  const t0 = THREE.MathUtils.smoothstep(sunEl, -18, -6);        // night→dawn
  let e = THREE.MathUtils.lerp(THREE.MathUtils.lerp(night, civil, t0), day, t1);
  e *= 1 + 0.5 * cloudCover * t1;                               // overcast is darker
  return inCockpit ? e * 1.25 : e;                              // cockpit interior is in shadow
}
// per frame: exposure += (target − exposure) · (1 − exp(−dt / 1.5))   // 1.5 s adaptation
```
Optionally replace with a real average-luminance measurement later (render to 64×64 half-float, mipmap to 1×1, `readRenderTargetPixelsAsync` every ~10 frames).

---

## 8. Time-of-day control & time acceleration

```ts
export class SimClock {
  epochMs: number;                 // simulated UTC time
  rate = 1;                        // 0 (paused), 1, 2, 4, 8, 16, 60, 3600 …
  constructor(start = Date.now()) { this.epochMs = start; }
  tick(realDtSec: number) { this.epochMs += realDtSec * 1000 * this.rate; }
  get date() { return new Date(this.epochMs); }
  setLocalTime(hh: number, mm: number, lonDeg: number) {   // "local" = mean solar time ≈ lon/15 h offset (no tz database needed)
    const d = this.date; const offsetMs = (lonDeg / 15) * 3_600_000;
    const local = new Date(d.getTime() + offsetMs); local.setUTCHours(hh, mm, 0, 0);
    this.epochMs = local.getTime() - offsetMs;
  }
  jumpTo(event: 'sunrise' | 'solarNoon' | 'sunset' | 'dusk' | 'night', lat: number, lon: number) {
    const t = SunCalc.getTimes(this.date, lat, lon)[event]; if (t) this.epochMs = t.getTime();
  }
}
```
Update policy per frame: sun/moon directions (≈ 20 µs), sky uniforms, star rotation matrix, lighting (§7) every frame; PMREM env rebake when sun moved > 1° or weather changed (throttle ≥ 0.5 s real time); cloud weather-map regeneration when coverage changes (fade over 60 s sim time for preset transitions). At `rate ≥ 60` also lower the env-rebake threshold to 3° to avoid rebaking every frame. The FDM must use **real** `dt` for physics — never scale physics by time rate (MSFS also pauses sim rate semantics separately); only the clock/sky/weather evolution accelerate.

---

## 9. METAR parsing & live weather sources

### 9.1 Sources and CORS status

| Source | Data | CORS from browser | Limits / licence | Notes |
|---|---|---|---|---|
| **aviationweather.gov Data API** `https://aviationweather.gov/api/data/metar?ids=KSFO,KJFK&format=json` (also `format=raw|xml|geojson`, `bbox=`, `hours=`, `taf=true`) | METAR/TAF/PIREP/SIGMET, US-gov public domain | **No** — the API page states cross-origin resource sharing is not permitted; a 2025-11 report confirms no `Access-Control-Allow-Origin` on METAR/TAF ([issue](https://github.com/t288matt/runway-selector/issues/16)) | 100 requests/min ([Data API docs](https://aviationweather.gov/data/api/)) | Needs a proxy: Cloudflare Worker/Pages Function (free tier 100k req/day) that forwards and adds `Access-Control-Allow-Origin: *` + 5-min cache |
| **metar.vatsim.net** `https://metar.vatsim.net/metar.php?id=KSFO` (plain text; `/KSFO` also works) | METAR only, worldwide | **Yes (`*`)** per community report in the same issue — **UNVERIFIED** (host blocked here) | no key, unpublished limits | Good keyless fallback; cache 10 min |
| **Open-Meteo** `https://api.open-meteo.com/v1/forecast?latitude=37.62&longitude=-122.38&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_850hPa,wind_direction_850hPa,geopotential_height_850hPa,wind_speed_500hPa,wind_direction_500hPa,wind_speed_250hPa,temperature_2m,dew_point_2m,surface_pressure,pressure_msl,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,precipitation,rain,snowfall,cape,freezing_level_height,weather_code&wind_speed_unit=kn&forecast_days=1` | Model forecast (ICON/GFS/…) incl. **winds aloft at pressure levels** (ICON levels 1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30 hPa — list from memory, **UNVERIFIED**), cloud cover by level, visibility, precipitation | **Yes** — README: "No API key required, CORS supported" ([open-meteo README](https://github.com/open-meteo/open-meteo)) | Free for non-commercial use, fair use, contact above 10 000 req/day; data **CC BY 4.0** → show "Weather data by Open-Meteo.com" in the UI | Best single source for a static site: gives a full `WeatherState` incl. 3-D wind; variable names follow `wind_speed_<level>hPa`, `geopotential_height_<level>hPa` |
| CheckWX / AVWX | METAR/TAF JSON | yes with API key | key, quotas | avoid secrets in a static site |

Pressure level → altitude: use the returned `geopotential_height_XhPa` (m) directly as the wind layer altitude; fallback ISA: 850 hPa ≈ 1 460 m, 700 ≈ 3 010 m, 500 ≈ 5 570 m, 300 ≈ 9 160 m, 250 ≈ 10 360 m, 200 ≈ 11 780 m.

### 9.2 METAR grammar (what we need)

```
KSFO 021756Z 28012G18KT 250V310 10SM FEW015 SCT025 BKN250 18/11 A3002 RMK AO2 …
EGLL 021750Z 24008KT 9999 -RA SCT012 BKN020 OVC045CB 12/10 Q1009 TEMPO 4000 RA
```
| Token | Regex | Meaning / conversion |
|---|---|---|
| station | `^[A-Z0-9]{4}$` | ICAO id |
| time | `^(\d{2})(\d{2})(\d{2})Z$` | day, hh, mm UTC |
| wind | `^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$` | dir from (°true), speed, gust; KT×0.5144 → m/s; `00000KT` calm |
| wind var | `^(\d{3})V(\d{3})$` | variability range |
| visibility | `^(\d{4})$` (m; `9999` = ≥10 km) or `^(?:(\d+)\s)?(\d+)(?:/(\d+))?SM$` (statute miles ×1609.34; `P6SM` = >6 SM; `M1/4SM` = <0.25 SM) | prevailing visibility |
| RVR | `^R(\d{2}[LCR]?)/([PM]?\d{4})(?:V[PM]?\d{4})?(FT)?[UDN]?$` | runway visual range |
| weather | `^([-+]|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP)?(BR|FG|FU|VA|DU|SA|HZ|PY)?(PO|SQ|FC|SS|DS)?$` | intensity `-`/`+`, descriptor, precipitation, obscuration |
| clouds | `^(FEW|SCT|BKN|OVC|VV|NSC|NCD|SKC|CLR|CAVOK)(\d{3})?(CB|TCU)?$` | coverage; height ×100 ft **AGL** → m ×30.48; CB/TCU → towering type; `CAVOK` = vis ≥10 km, no cloud <5000 ft, no weather |
| temp/dew | `^(M?\d{2})/(M?\d{2})?$` | `M` = minus, °C |
| altimeter | `^A(\d{4})$` (inHg×0.01 → hPa ×33.8639) or `^Q(\d{4})$` (hPa) | QNH |
| remarks | `RMK …` | ignore except `SLP###`, `AO2` |

```ts
export function parseMetar(raw: string): Partial<WeatherState> & { stationId: string; obsTime: Date } {
  const t = raw.trim().replace(/=$/, '').split(/\s+/); const out: any = { layers: [], wind: [], phenomena: [] };
  out.stationId = t.shift()!;
  for (const tok of t) { let m: RegExpMatchArray | null;
    if (tok === 'RMK') break;
    if ((m = tok.match(/^(\d{2})(\d{2})(\d{2})Z$/))) { const d = new Date(); d.setUTCDate(+m[1]); d.setUTCHours(+m[2], +m[3], 0, 0); out.obsTime = d; }
    else if ((m = tok.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/))) {
      const k = m[4] === 'KT' ? 0.5144 : m[4] === 'KMH' ? 1 / 3.6 : 1;
      out.wind.push({ altitudeM: 10, dirFromDeg: m[1] === 'VRB' ? NaN : +m[1], speedMps: +m[2] * k, gustMps: m[3] ? +m[3] * k : undefined }); }
    else if ((m = tok.match(/^(\d{4})$/)) && out.visibilityM === undefined) out.visibilityM = +m[1] === 9999 ? 10_000 : +m[1];
    else if ((m = tok.match(/^(?:(\d+)\s)?([PM]?)(\d+)(?:\/(\d+))?SM$/))) { let sm = +m[3] / (m[4] ? +m[4] : 1); if (m[1]) sm += +m[1]; out.visibilityM = sm * 1609.34 * (m[2] === 'P' ? 1.5 : 1); }
    else if (tok === 'CAVOK') { out.visibilityM = 10_000; out.layers = []; }
    else if ((m = tok.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/))) {
      const cov = { FEW: 0.19, SCT: 0.44, BKN: 0.75, OVC: 1, VV: 1 }[m[1] as 'FEW']; const base = +m[2] * 30.48;
      out.layers.push({ baseAglM: base, topAglM: base + (m[3] ? 4000 : cov > 0.5 ? 900 : 600), coverage: cov,
                        type: m[3] ? 'cumulonimbus' : cov > 0.7 ? 'stratus' : 'cumulus', density: m[3] ? 1.5 : 1 }); }
    else if ((m = tok.match(/^(M?\d{2})\/(M?\d{2})?$/))) { const n = (s?: string) => s ? +s.replace('M', '-') : NaN; out.temperatureC = n(m[1]); out.dewpointC = n(m[2]); }
    else if ((m = tok.match(/^A(\d{4})$/))) out.qnhHpa = +m[1] / 100 * 33.8639;
    else if ((m = tok.match(/^Q(\d{4})$/))) out.qnhHpa = +m[1];
    else if ((m = tok.match(/^([-+]|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP)?(BR|FG|FU|VA|DU|SA|HZ|PY)?(PO|SQ|FC|SS|DS)?$/)) && tok.length >= 2) out.phenomena.push(tok);
  }
  // derived
  const intensity = (p: string) => p.startsWith('+') ? 3 : p.startsWith('-') ? 0.5 : 1;
  out.precipitation = out.phenomena.some((p: string) => /SN|SG/.test(p)) ? { type: 'snow', rateMmH: 2 * Math.max(...out.phenomena.map(intensity)) }
                    : out.phenomena.some((p: string) => /RA|DZ|SH/.test(p)) ? { type: 'rain', rateMmH: 4 * Math.max(...out.phenomena.map(intensity)) } : { type: 'none', rateMmH: 0 };
  out.lightning = out.phenomena.some((p: string) => /TS/.test(p));
  out.turbulence = out.lightning ? 0.6 : (out.wind[0]?.gustMps ?? 0) > 8 ? 0.35 : 0.1;
  return out;
}
```
Derived atmospheric optics: relative humidity from Magnus `RH = 100·exp(17.625·Td/(243.04+Td)) / exp(17.625·T/(243.04+T))`; turbidity from visibility `T ≈ clamp(2 + 8·(1 − min(vis, 20 km)/20 km), 2, 10)`; fog `β₀ = 3.912 / visibilityM`; haze scale height `H = 1200 m` (lower to 400 m for FG/BR).

---

## 10. Performance budget (integrated GPU, 1080p, 60 fps target = 16.6 ms; sky/weather share ≤ 6 ms)

| Item | Budget | How |
|---|---|---|
| Sky dome (Preetham or Bruneton LUT) | 0.2–0.4 ms | full-res but ~30 ALU; draw **after** opaque geometry with `depthTest` so terrain-covered pixels are rejected (set `sky.renderOrder = 1`, keep `depthWrite:false`) |
| Stars + moon | <0.1 ms | one `Points` draw, skip when sunEl > −3° |
| Height fog | ≈0 | inside existing material shaders (≈10 ALU) |
| PMREM rebake | 1–2 ms, amortised | throttle to ≥0.5 s and >1° sun motion; use `PMREMGenerator` default 256 size |
| Cloud-layer planes (×3) | 0.3–0.6 ms | 5-octave fbm ×2 per pixel on ~50 % of screen; drop to 3 octaves on 'low' |
| Volumetric clouds | 3–5 ms | ¼-res march, 1/16 temporal, ≤64 steps, 5+1 light samples, STBN jitter, early out; 'low' preset ⇒ layers instead |
| Precipitation | 0.1–0.3 ms | ≤12 k instanced quads, no CPU update |
| Windshield rain | 0.3–0.5 ms | only in cockpit view, only canopy pixels |
| Bloom (night) | 0.8–1.2 ms | half-res `UnrealBloomPass`, 3 mips; disable by day |
| Tone mapping | ≈0 | in material shaders (`renderer.toneMapping`) or one full-screen pass |
| Shadow map (sun) | 1–2 ms | 1 cascade 2048² near the aircraft only; cloud shadows via projected texture, not shadow maps |

General iGPU rules: avoid full-screen `FloatType` targets (use `HalfFloatType`); keep post-processing to one composer pass chain; `renderer.setPixelRatio(min(devicePixelRatio, 1.5))`; prefer `precision mediump` in cloud detail math where WebGL allows; test on Intel Iris Xe / Apple M1 / Ryzen 680M; adaptive quality: measure frame time with a 60-frame EMA and step `cloudQuality` down/up.

---

## 11. `WeatherState` interface and module API

```ts
// src/weather/types.ts
export type CloudType = 'stratus' | 'stratocumulus' | 'cumulus' | 'cumulonimbus' | 'cirrus';
export interface CloudLayer {
  baseM: number;            // MSL metres
  topM: number;             // MSL metres
  coverage: number;         // 0..1 (FEW .19, SCT .44, BKN .75, OVC 1)
  density: number;          // 0.3 thin … 1.5 towering (scales σ_t)
  type: CloudType;
  scattering?: number;      // 0..1 "lumpiness" (MSFS "scattering"); maps to coverageFilterWidth / threshold softness
  precipitationRate?: number; // mm/h falling from this layer
  lightning?: boolean;
}
export interface Precipitation { type: 'none' | 'rain' | 'snow' | 'hail'; rateMmH: number }
export interface WeatherState {
  timestamp: number;        // sim epoch ms this state is valid for
  source: 'preset' | 'metar' | 'open-meteo' | 'manual';
  presetName?: string;
  layers: CloudLayer[];     // ≤ 4, sorted by baseM
  wind: WindLayer[];        // sorted by altitudeM; [0] is the surface (10 m) layer
  turbulence: number;       // 0..1 → Dryden W20 = 45·turbulence kt
  thermals?: { strengthMps: number; depthM: number; spacingM: number };
  visibilityM: number;      // meteorological visibility (Koschmieder β = 3.912 / vis)
  hazeScaleHeightM: number; // 400 fog … 1200 haze … 8000 clean
  turbidity: number;        // 2..10 for Preetham; or aerosol density for Bruneton
  temperatureC: number;     // at station / sea level
  dewpointC: number;
  qnhHpa: number;           // 1013.25 std; feeds altimeter
  precipitation: Precipitation;
  lightning: boolean;
  aerosolAlbedo?: number;   // optional for Bruneton AP
}
export interface SkyFrameInputs {       // computed every frame from clock + position
  date: Date; latDeg: number; lonDeg: number; altitudeM: number;
  sun: { dir: THREE.Vector3; elevationDeg: number; azimuthDeg: number };
  moon: { dir: THREE.Vector3; elevationDeg: number; illuminatedFraction: number; phase: number };
}
export interface WeatherSystem {
  state: WeatherState;
  setPreset(name: PresetName, transitionSec?: number): void;
  applyMetar(raw: string): void;
  applyOpenMeteo(json: unknown, hourIndex: number): void;
  windAt(posEnu: THREE.Vector3): THREE.Vector3;         // mean wind + gusts + Dryden, ENU m/s
  cloudDensityAt(posEnu: THREE.Vector3): number;        // 0..1, for FDM bumpiness, icing and visibility
  update(dt: number, inputs: SkyFrameInputs): void;     // advances turbulence, gusts, transitions
}
```

Preset → layer defaults are the table in §4.4 (convert AGL to MSL with the departure airport elevation). Transitions: lerp numeric fields over `transitionSec` (default 60 s sim time); layers matched by index.

---

## 12. Open questions / uncertainties

1. **ECEF-only frame of `@takram/three-atmosphere`** ([issue #11](https://github.com/takram-design-engineering/three-geospatial/issues/11)) — needs a prototype to confirm precision with a parent-group ENU→ECEF transform and camera-relative rendering; otherwise fall back to Tier A for longer.
2. `metar.vatsim.net` CORS and rate limits are community-reported only; verify with a browser `fetch` before relying on it. aviationweather.gov field names (`icaoId, obsTime, wdir, wspd, wgst, visib, altim, clouds[{cover,base}], rawOb`) are from memory — verify against the OpenAPI spec once a proxy is in place.
3. Open-Meteo pressure-level list and exact `geopotential_height_*` variable availability per model — verify against the live docs (host blocked here).
4. HZD height-gradient vectors and the 2015 powder formula are community reconstructions; tune visually. Takram's defaults (`scatterAnisotropy 0.7/−0.2 mix 0.5`, `powderScale 0.8`, `powderExponent 150`, `multiScatteringOctaves 8`, `minStepSize 50`, `maxStepSize 1000`, `maxIterationCount 500`) are a good starting point.
5. MIL-F-8785C W20 defaults (15/30/45 kt) and the medium/high-altitude σ table were not re-verified against the spec text.
6. r187 `Sky` cloud layer is directional-only (confirmed from source) — decide whether to keep it at all or render cirrus as our own high plane for consistency.
7. Allen thermal-model constants not verified; optional feature.

---

## Appendix A — Sources

- Three.js r187: [`Sky.js`](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/objects/Sky.js), [`webgl_shaders_sky.html`](https://github.com/mrdoob/three.js/blob/r187/examples/webgl_shaders_sky.html) (example uses `ACESFilmicToneMapping`, exposure 0.5, turbidity 10, rayleigh 3, mieG 0.7), [fog chunks](https://github.com/mrdoob/three.js/tree/r187/src/renderers/shaders/ShaderChunk), [`tonemapping_pars_fragment`](https://github.com/mrdoob/three.js/blob/r187/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js), [`webgl_volume_cloud.html`](https://github.com/mrdoob/three.js/blob/r187/examples/webgl_volume_cloud.html) (GLSL3 `sampler3D` ray-march with Wang-hash jitter — template for our volumetric pass), [`Lensflare.js`](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/objects/Lensflare.js). Licence MIT.
- takram three-geospatial (MIT): [atmosphere README](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/README.md), [clouds README](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/README.md), [atmosphere constants](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/src/constants.ts), [clouds constants](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/constants.ts).
- Bruneton: [repo (BSD)](https://github.com/ebruneton/precomputed_atmospheric_scattering), [docs/demo](https://ebruneton.github.io/precomputed_atmospheric_scattering/).
- Hillaire 2020: [paper PDF](https://sebh.github.io/publications/egsr2020.pdf); WebGPU ports [pmndrs/sky](https://github.com/pmndrs/sky), [webgpu-sky-atmosphere](https://github.com/JolifantoBambla/webgpu-sky-atmosphere).
- Hosek–Wilkie: [licence header (BSD-3)](https://projects.blender.org/archive/blender-archive/src/commit/b3ba41ecd1e1ed1cbb28b9fe90efb3c4f4e596c8/intern/sky/include/sky_model.h), [andrewwillmott/sun-sky](https://github.com/andrewwillmott/sun-sky) (Unlicense), [diharaw/sky-models](https://github.com/diharaw/sky-models) (MIT), [Shadertoy port](https://www.shadertoy.com/view/wslfD7) (fixed turbidity 3 / albedo 1).
- Sun/moon: [NOAA solar calculator details](https://gml.noaa.gov/grad/solcalc/calcdetails.html); [suncalc](https://github.com/mourner/suncalc) 2.1.1 (BSD-2); [astronomy-engine](https://www.npmjs.com/package/astronomy-engine) 2.1.19 (MIT).
- Stars: [Yale BSC5](http://tdc-www.harvard.edu/catalogs/bsc5.html); [brettonw JSON mirror (MIT)](https://github.com/brettonw/YaleBrightStarCatalog); [HYG](https://github.com/astronexus/HYG-Database) (moved to Codeberg).
- Clouds: [Schneider publications](https://sites.google.com/view/vonschneidz/publications), [HZD 2015 slides](https://www.slideshare.net/guerrillagames/the-realtime-volumetric-cloudscapes-of-horizon-zero-dawn), [Nubis Cubed PDF](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Nubis%20Cubed.pdf), [TylerDodds tutorial](https://github.com/TylerDodds/VolumetricCloudsTutorial) (multi-scatter octaves a=b=c=0.5, 4×4 history reprojection, blend 0.05, Bayer offsets), [adrianderstroff/realtime-clouds](https://github.com/adrianderstroff/realtime-clouds) (MIT), [TileableVolumeNoise](https://github.com/sebh/TileableVolumeNoise), [Wedekind write-up](https://www.wedesoft.de/software/2023/05/03/volumetric-clouds/), [three.js forum thread](https://discourse.threejs.org/t/efficient-volumetric-clouds/66067).
- Weather data: [AWC Data API](https://aviationweather.gov/data/api/) (CORS not permitted, 100 req/min), [CORS issue thread](https://github.com/t288matt/runway-selector/issues/16), [Open-Meteo](https://github.com/open-meteo/open-meteo) (CORS, CC BY 4.0), [MSFS 2024 presets](https://flyawaysimulation.com/ask/answers/msfs-2024-weather-presets/), [MSFS WPR docs](https://docs.flightsimulator.com/msfs2024/retail/content-configuration/mission-xml-files/weather-xml-wpr-file-properties/index.md), [DC3 Airways MSFS weather guide](https://dc3airways.net/wr/Weather_MSFS.pdf).
- Turbulence: [MathWorks Dryden (continuous)](https://www.mathworks.com/help/aeroblks/drydenwindturbulencemodelcontinuous.html), [Modelica Dryden example](https://doc.modelica.org/Modelica%204.0.0/Resources/helpWSM/Modelica/Modelica.Blocks.Examples.Noise.DrydenContinuousTurbulence.html), [Skybrary EDR](https://skybrary.aero/articles/eddy-dissipation-rate-edr), [UCAR EDR thresholds talk](https://cpaess.ucar.edu/sites/default/files/2023-08/Sharman-Bob.pdf).
- Rain on glass: [Godot "Rain on Glass"](https://godotshaders.com/shader/rain-on-glass/) (technique description; original Shadertoy "Heartfelt" is CC BY-NC-SA).
