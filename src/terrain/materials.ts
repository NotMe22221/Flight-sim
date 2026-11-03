/**
 * Terrain and ocean ShaderMaterials (docs/research/03 §6). One material per tile (per-tile
 * imagery and UV transform), all referencing the *same* uniform objects for sun, ambient, fog
 * and time, so `TerrainSystem.setSun/setFog` update every tile by writing one object.
 *
 * Lighting is scaled like three's physically based lights (radiance = albedo/π · irradiance), so
 * terrain sits correctly next to MeshStandardMaterial objects lit by the same sun/ambient values.
 * Imagery already carries baked sun shading, so slope contrast is reduced: the direct term is
 * mix(N_flat·L, N·L, uSlopeContrast). Fog is the sky module's exponential height fog
 * (β(y) = β0·exp(−(y − groundY)·falloff), closed-form optical depth along the view ray) mixed
 * toward the fog colour with a sun-glow lobe, before tone mapping.
 *
 * Depth: no custom depth math. With a reversed depth buffer three supplies the projection and
 * depth function; with a logarithmic depth buffer the logdepthbuf chunks below write gl_FragDepth.
 */
import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, ShaderMaterial, Texture, UnsignedByteType, Vector3 } from 'three';

/** Uniform objects shared by every terrain and ocean material. */
export interface TerrainSharedUniforms {
  /** unit vector toward the sun, render frame (x E, y U, z S) */
  uSunDir: { value: Vector3 };
  /** linear sun colour (hue), multiplied by uSunIntensity */
  uSunColor: { value: Color };
  /** sun irradiance scale, same units as a three DirectionalLight intensity (0 at night) */
  uSunIntensity: { value: number };
  /** ambient (sky) irradiance, same units as three AmbientLight colour × intensity */
  uAmbient: { value: Color };
  /** 0 = flat-ground lighting only, 1 = full N·L (imagery already contains shading) */
  uSlopeContrast: { value: number };
  /** linear in-scatter (haze) colour */
  uFogColor: { value: Color };
  /** linear horizon colour toward the sun (Mie glow lobe) */
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
}

export function createTerrainSharedUniforms(): TerrainSharedUniforms {
  return {
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
  };
}

/** Same formula as `HEIGHT_FOG_GLSL` in src/sky/types.ts, so terrain haze matches the sky's. */
const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uSunGlow;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogGroundY;
float terrainFogFactor(vec3 origin, vec3 dir, float dist) {
  float invH = max(uFogFalloff, 1e-7);
  float dy = abs(dir.y) < 1e-4 ? 1e-4 : dir.y;
  float h0 = max(origin.y - uFogGroundY, 0.0);
  float tau = uFogDensity / invH * exp(-h0 * invH) * (1.0 - exp(-dist * dy * invH)) / dy;
  return 1.0 - exp(-max(tau, 0.0));
}
vec3 terrainFogColor(vec3 dir, vec3 sunDir) {
  return mix(uFogColor, uSunGlow, pow(max(dot(dir, sunDir), 0.0), 8.0) * 0.5);
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
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uSlopeContrast;
uniform vec3 uEarthCenter;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${FOG_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 albedo = uHasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(0.08, 0.1, 0.06);
  vec3 n = normalize(vNormalW);
  vec3 up = normalize(vWorldPos - uEarthCenter);
  float direct = mix(max(dot(up, uSunDir), 0.0), max(dot(n, uSunDir), 0.0), uSlopeContrast);
  vec3 irradiance = uSunColor * (uSunIntensity * direct) + uAmbient * (0.75 + 0.25 * dot(n, up));
  vec3 col = albedo * irradiance * RECIPROCAL_PI;
  vec3 toFrag = vWorldPos - cameraPosition;
  float dist = length(toFrag);
  vec3 dir = toFrag / max(dist, 1e-3);
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
  // ripples fade with distance so the far sea does not sparkle
  vec2 slope = waveSlope(vWorldPos.xz, uTime) * (1.0 - smoothstep(2000.0, 20000.0, dist));
  vec3 n = normalize(up + vec3(-slope.x, 0.0, -slope.y));
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 waterAlbedo = mix(vec3(0.012, 0.045, 0.09), vec3(0.05, 0.22, 0.26), exp(-vDepth / 8.0));
  vec3 irradiance = uSunColor * (uSunIntensity * max(dot(up, uSunDir), 0.0)) + uAmbient;
  vec3 body = waterAlbedo * irradiance * RECIPROCAL_PI;
  // sky reflection ≈ the horizon haze colour; normalized Blinn-Phong sun glint
  vec3 h = normalize(uSunDir + v);
  float shininess = 400.0;
  float glint = (shininess + 8.0) / (8.0 * PI) * pow(max(dot(n, h), 0.0), shininess) * max(dot(n, uSunDir), 0.0);
  float fresnelSun = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  vec3 col = mix(body, uFogColor, fresnel) + uSunColor * (uSunIntensity * glint * fresnelSun);
  col = mix(col, terrainFogColor(dir, uSunDir), terrainFogFactor(cameraPosition, dir, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Shader sources (exported for tests that check the depth chunks are present). */
export const TERRAIN_SHADERS = { terrainVertex: TERRAIN_VERT, terrainFragment: TERRAIN_FRAG, waterVertex: WATER_VERT, waterFragment: WATER_FRAG } as const;

/** Per-tile terrain material. `shared` uniform objects are referenced, not copied. */
export function createTerrainMaterial(shared: TerrainSharedUniforms, map: Texture | null, uvTransform: ArrayLike<number>): ShaderMaterial {
  return new ShaderMaterial({
    name: 'terrain',
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      ...shared,
      map: { value: map },
      uHasMap: { value: map ? 1 : 0 },
      uUvTransform: { value: new Vector3(uvTransform[0], uvTransform[1], uvTransform[2]) },
    },
  });
}

/** Per-tile ocean material (same uniform sharing). */
export function createWaterMaterial(shared: TerrainSharedUniforms): ShaderMaterial {
  return new ShaderMaterial({ name: 'ocean', vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: { ...shared } });
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
