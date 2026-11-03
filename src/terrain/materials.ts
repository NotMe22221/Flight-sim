/**
 * Terrain and ocean ShaderMaterials (docs/research/03 §6). One material per tile (per-tile
 * imagery and UV transform), all referencing the *same* uniform objects for sun, ambient, fog
 * and time, so `TerrainSystem.setSun/setFog` update every tile by writing one object. The sky's
 * shared uniforms (`src/sky/skyUniforms.ts`: ambient irradiance, sky colours, cloud-shadow layers)
 * are referenced the same way, so the sky reaches every tile without per-frame plumbing.
 *
 * Lighting is scaled like three's physically based lights (radiance = albedo/π · irradiance), so
 * terrain sits correctly next to MeshStandardMaterial objects lit by the same sun/ambient values.
 * Imagery already carries baked sun shading, so slope contrast is reduced: the direct term is
 * mix(N_flat·L, N·L, uSlopeContrast), times the cloud shadow along the sun ray. Ambient: the sky's
 * published irradiance (what the built-in materials' HemisphereLight + AmbientLight give) once a sky
 * is linked, else `uAmbient`. Fog is the sky module's exponential height fog (β(y) = β0·exp(−(y −
 * groundY)·falloff), closed-form optical depth along the view ray) toward the haze colour with the
 * sun-ward Henyey–Greenstein lobe, before tone mapping.
 *
 * Imagery is shown unmodified apart from that lighting and fog. Only the procedural fallback colours
 * (`uProcedural`) get a world-space detail texture, so they do not read as flat paint close up.
 *
 * Depth: no custom depth math. With a reversed depth buffer three supplies the projection and
 * depth function; with a logarithmic depth buffer the logdepthbuf chunks below write gl_FragDepth.
 */
import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, ShaderMaterial, Texture, UnsignedByteType, Vector2, Vector3 } from 'three';
import { SKY_UNIFORMS, SKY_UNIFORMS_GLSL, type SkySharedUniforms } from '../sky/skyUniforms';
import { HAZE_LOBE_GLSL } from '../sky/types';

/** Period (m) of the procedural detail noise; `uDetailOffset` is kept modulo this across rebases. */
export const DETAIL_PERIOD_M = 8192;

/** Uniform objects shared by every terrain and ocean material. */
export interface TerrainSharedUniforms extends SkySharedUniforms {
  /** unit vector toward the sun, render frame (x E, y U, z S) */
  uSunDir: { value: Vector3 };
  /** linear sun colour (hue), multiplied by uSunIntensity */
  uSunColor: { value: Color };
  /** sun irradiance scale, same units as a three DirectionalLight intensity (0 at night) */
  uSunIntensity: { value: number };
  /** ambient (sky) irradiance, same units as three AmbientLight colour × intensity (used until a sky is linked) */
  uAmbient: { value: Color };
  /** 0 = flat-ground lighting only, 1 = full N·L (imagery already contains shading) */
  uSlopeContrast: { value: number };
  /** linear in-scatter (haze) colour, seen at 90° from the sun */
  uFogColor: { value: Color };
  /** linear haze colour looking at the sun (the Henyey–Greenstein lobe mixes toward it) */
  uSunGlow: { value: Color };
  /** extinction at the reference height, 1/m (Koschmieder: 3.912 / visibility) */
  uFogDensity: { value: number };
  /** 1 / haze scale height, 1/m */
  uFogFalloff: { value: number };
  /** render-frame y of the fog's reference height (ground under the camera) */
  uFogGroundY: { value: number };
  /** render-frame position of the earth's centre (local vertical = normalize(p − centre)) */
  uEarthCenter: { value: Vector3 };
  /** seconds, ocean animation */
  uTime: { value: number };
  /** render x/z → ground-fixed detail-noise coordinates (moves with floating-origin rebases, mod DETAIL_PERIOD_M) */
  uDetailOffset: { value: Vector2 };
}

/** Shared uniforms; the sky's uniform objects (default the process-wide `SKY_UNIFORMS`) are referenced, not copied. */
export function createTerrainSharedUniforms(sky: SkySharedUniforms = SKY_UNIFORMS): TerrainSharedUniforms {
  return {
    ...sky,
    uSunDir: { value: new Vector3(0.3, 0.8, -0.5).normalize() },
    uSunColor: { value: new Color(1.0, 0.96, 0.9) },
    uSunIntensity: { value: Math.PI },
    uAmbient: { value: new Color(0.35, 0.42, 0.55) },
    uSlopeContrast: { value: 0.4 },
    uFogColor: { value: new Color(0.62, 0.72, 0.85) },
    uSunGlow: { value: new Color(0.85, 0.82, 0.75) },
    uFogDensity: { value: 3.912 / 80_000 },
    uFogFalloff: { value: 1 / 1200 },
    uFogGroundY: { value: 0 },
    uEarthCenter: { value: new Vector3(0, -6_371_000, 0) },
    uTime: { value: 0 },
    uDetailOffset: { value: new Vector2(0, 0) },
  };
}

/** Same formula as `HEIGHT_FOG_GLSL` in src/sky/types.ts, so terrain haze matches the sky's. */
const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uSunGlow;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogGroundY;
${HAZE_LOBE_GLSL}
float terrainFogFactor(vec3 origin, vec3 dir, float dist) {
  float invH = max(uFogFalloff, 1e-7);
  float k = dist * dir.y * invH;
  float e0 = exp(-min(max(origin.y - uFogGroundY, 0.0) * invH, 80.0));
  float g = abs(k) < 1e-3 ? 1.0 - k * (0.5 - k / 6.0) : (1.0 - exp(-clamp(k, -80.0, 80.0))) / k;
  return 1.0 - exp(-max(uFogDensity * e0 * dist * g, 0.0));
}
vec3 terrainFogColor(vec3 dir, vec3 sunDir) {
  return mix(uFogColor, uSunGlow, hazeSunLobe(dot(dir, sunDir)));
}
`;

/** Ground-fixed value noise for the procedural detail (periodic over DETAIL_PERIOD_M). */
const DETAIL_GLSL = /* glsl */ `
uniform vec2 uDetailOffset;
float detailHash(vec2 c) {
  vec3 q = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
// value noise with a lattice that wraps every 'period' cells (the offset is kept modulo the period)
float detailNoise(vec2 p, float period) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, period), i1 = mod(i + 1.0, period);
  float a = detailHash(i0), b = detailHash(vec2(i1.x, i0.y)), c = detailHash(vec2(i0.x, i1.y)), d = detailHash(i1);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// albedo × (brightness and dry/green variation): 4 octaves (4, 32, 128, 512 m — each divides the
// period, so the lattice wraps seamlessly), fine ones faded with the pixel footprint so they never alias
vec3 proceduralDetail(vec3 albedo, vec3 worldPos, float dist) {
  vec2 p = worldPos.xz + uDetailOffset;
  float fade1 = 1.0 - smoothstep(150.0, 900.0, dist);
  float fade2 = 1.0 - smoothstep(600.0, 4000.0, dist);
  float n1 = detailNoise(p / 4.0, ${DETAIL_PERIOD_M / 4}.0) - 0.5;
  float n2 = detailNoise(p / 32.0 + 17.0, ${DETAIL_PERIOD_M / 32}.0) - 0.5;
  float n3 = detailNoise(p / 128.0 + 5.0, ${DETAIL_PERIOD_M / 128}.0) - 0.5;
  float n4 = detailNoise(p / 512.0 + 9.0, ${DETAIL_PERIOD_M / 512}.0) - 0.5;
  float bright = 1.0 + 0.3 * n1 * fade1 + 0.26 * n2 * fade2 + 0.16 * n3 + 0.1 * n4;
  // hue: patches drift between lush (greener) and dry (yellow-brown), strongest on vegetated colours
  float veg = clamp((albedo.g - max(albedo.r, albedo.b)) * 8.0 + 0.3, 0.0, 1.0);
  float dry = (n3 * 0.7 + n2 * 0.5 * fade2) * veg;
  vec3 tint = vec3(1.0 + 0.35 * dry, 1.0 + 0.08 * dry, 1.0 - 0.25 * dry);
  return clamp(albedo * bright * tint, 0.0, 1.0);
}
`;

const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uUvTransform;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vUv = uv * uUvTransform.z + uUvTransform.xy;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  // modelViewMatrix is composed in float64 on the CPU: only small numbers reach float32 here
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
  #include <logdepthbuf_vertex>
}
`;

const TERRAIN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float uHasMap;
uniform float uProcedural;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uSlopeContrast;
uniform vec3 uEarthCenter;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${SKY_UNIFORMS_GLSL}
${FOG_GLSL}
${DETAIL_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 toFrag = vWorldPos - cameraPosition;
  float dist = length(toFrag);
  vec3 dir = toFrag / max(dist, 1e-3);
  vec3 albedo = uHasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(0.08, 0.1, 0.06);
  if (uProcedural > 0.5) albedo = proceduralDetail(albedo, vWorldPos, dist);
  vec3 n = normalize(vNormalW);
  vec3 up = normalize(vWorldPos - uEarthCenter);
  float direct = mix(max(dot(up, uSunDir), 0.0), max(dot(n, uSunDir), 0.0), uSlopeContrast);
  direct *= skyCloudShadow(vWorldPos, uSunDir);
  vec3 ambient = uSkyLinked > 0.5 ? uSkyIrradiance : uAmbient;
  vec3 irradiance = uSunColor * (uSunIntensity * direct) + ambient * (0.75 + 0.25 * dot(n, up));
  vec3 col = albedo * irradiance * RECIPROCAL_PI;
  col = mix(col, terrainFogColor(dir, uSunDir), terrainFogFactor(cameraPosition, dir, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WATER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aDepth;
varying vec3 vWorldPos;
varying float vDepth;
void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vDepth = max(-aDepth, 0.0);
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
  #include <logdepthbuf_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform vec3 uEarthCenter;
uniform float uTime;
varying vec3 vWorldPos;
varying float vDepth;
${SKY_UNIFORMS_GLSL}
${FOG_GLSL}
// Sum of four directional sine waves; returns the surface slope (dh/dx, dh/dz).
vec2 waveSlope(vec2 p, float t) {
  vec2 s = vec2(0.0);
  vec2 d1 = normalize(vec2(1.0, 0.35)), d2 = normalize(vec2(-0.6, 1.0)), d3 = normalize(vec2(0.2, -1.0)), d4 = normalize(vec2(0.9, 0.9));
  float k1 = 6.2832 / 14.0, k2 = 6.2832 / 7.0, k3 = 6.2832 / 3.1, k4 = 6.2832 / 1.3;
  s += d1 * 0.12 * k1 * cos(dot(p, d1) * k1 + t * 1.1);
  s += d2 * 0.08 * k2 * cos(dot(p, d2) * k2 - t * 1.5);
  s += d3 * 0.04 * k3 * cos(dot(p, d3) * k3 + t * 2.3);
  s += d4 * 0.015 * k4 * cos(dot(p, d4) * k4 - t * 3.1);
  return s;
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 up = normalize(vWorldPos - uEarthCenter);
  vec3 toFrag = vWorldPos - cameraPosition;
  float dist = length(toFrag);
  vec3 dir = toFrag / max(dist, 1e-3);
  vec3 v = -dir;
  // the pixel footprint grows with distance and grazing incidence: once it spans many wavelengths the
  // ripples average out, so fade them (no moiré or white sparkle) and let the surface read as rough water
  float cosView = max(dot(up, v), 0.0);
  float footprint = dist / max(cosView, 0.03);
  vec2 slope = waveSlope(vWorldPos.xz, uTime) * (0.8 - 0.8 * smoothstep(150.0, 2500.0, footprint));
  vec3 n = normalize(up + vec3(-slope.x, 0.0, -slope.y));
  // Schlick Fresnel, capped: micro-facets of rough water never reach the smooth-surface grazing peak
  float fresnel = min(0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0), 0.6);
  // reflected sky from the horizon (no brighter than the haze over it) up to the zenith colour
  vec3 r = reflect(dir, n);
  float re = clamp(dot(r, up), 0.0, 1.0);
  vec3 horizonR = uSkyLinked > 0.5 ? min(uSkyHorizon, uFogColor * 1.6) : uFogColor;
  vec3 skyR = uSkyLinked > 0.5 ? mix(horizonR, uSkyZenith, sqrt(re)) : uFogColor;
  // water body: dark blue-green, lighter and greener over shallow ground
  vec3 waterAlbedo = mix(vec3(0.010, 0.028, 0.040), vec3(0.030, 0.075, 0.070), exp(-vDepth / 4.0));
  float shadow = skyCloudShadow(vWorldPos, uSunDir);
  vec3 ambient = uSkyLinked > 0.5 ? uSkyIrradiance : uAmbient;
  vec3 irradiance = uSunColor * (uSunIntensity * shadow * max(dot(up, uSunDir), 0.0)) + ambient;
  vec3 body = waterAlbedo * irradiance * RECIPROCAL_PI;
  // sun glint: normalized Blinn-Phong whose lobe widens with distance (the glitter path)
  vec3 h = normalize(uSunDir + v);
  float shininess = mix(900.0, 120.0, smoothstep(300.0, 8000.0, dist));
  float glint = (shininess + 8.0) / (8.0 * PI) * pow(max(dot(n, h), 0.0), shininess) * max(dot(n, uSunDir), 0.0);
  float fresnelSun = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  vec3 col = mix(body, skyR, fresnel) + uSunColor * (uSunIntensity * shadow * glint * fresnelSun);
  col = mix(col, terrainFogColor(dir, uSunDir), terrainFogFactor(cameraPosition, dir, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Shader sources (exported for tests that check the depth chunks are present). */
export const TERRAIN_SHADERS = { terrainVertex: TERRAIN_VERT, terrainFragment: TERRAIN_FRAG, waterVertex: WATER_VERT, waterFragment: WATER_FRAG } as const;

/** Octaves of the cloud-shadow noise (the cloud planes use 3; shadows are soft, 3 keeps the shapes). */
const SHADOW_DEFINES = { CLOUD_OCTAVES: 3 } as const;

/**
 * Per-tile terrain material. `shared` uniform objects are referenced, not copied. `procedural` marks the
 * synthetic fallback colours (adds the world-space detail texture); real imagery is never altered.
 */
export function createTerrainMaterial(shared: TerrainSharedUniforms, map: Texture | null, uvTransform: ArrayLike<number>, procedural = false): ShaderMaterial {
  return new ShaderMaterial({
    name: 'terrain',
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    defines: { ...SHADOW_DEFINES },
    uniforms: {
      ...shared,
      map: { value: map },
      uHasMap: { value: map ? 1 : 0 },
      uProcedural: { value: procedural ? 1 : 0 },
      uUvTransform: { value: new Vector3(uvTransform[0], uvTransform[1], uvTransform[2]) },
    },
  });
}

/** Per-tile ocean material (same uniform sharing). */
export function createWaterMaterial(shared: TerrainSharedUniforms): ShaderMaterial {
  return new ShaderMaterial({ name: 'ocean', vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, defines: { ...SHADOW_DEFINES }, uniforms: { ...shared } });
}

/** Imagery texture from a flipped ImageBitmap (§3.4) — sRGB, mipmapped, anisotropic. */
export function textureFromBitmap(bitmap: ImageBitmap, anisotropy: number): Texture {
  const t = new Texture(bitmap);
  t.flipY = false;
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** Imagery texture from procedural RGBA rows (row 0 = north → flipY so v = 1 is north). */
export function textureFromRgba(data: Uint8ClampedArray, width: number, anisotropy: number): DataTexture {
  const t = new DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, width, RGBAFormat, UnsignedByteType);
  t.flipY = true;
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}
