/**
 * Terrain and ocean ShaderMaterials (docs/research/03 §6). One material instance per tile
 * (so per-tile uniforms upload per draw), all sharing the *same* uniform objects for sun,
 * sky and fog so the sky module drives every tile by writing `TerrainSharedUniforms` once.
 *
 * Lighting: imagery already carries baked sun shading, so N·L contrast is kept low
 * (0.6 + 0.4·max(N·L, 0)) under hemisphere ambient. Fog: height fog integrated analytically
 * along the ray between the camera altitude and the fragment altitude (Quílez), with a
 * sun-side/anti-sun horizon colour. No depth tricks: works with reversed-Z and log depth.
 */
import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, ShaderMaterial, Texture, UnsignedByteType, Vector3 } from 'three';

export interface TerrainSharedUniforms {
  /** unit vector toward the sun, Three.js frame (x E, y U, z S) */
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  /** hemisphere ambient: sky (above) and ground (below) */
  uSkyColor: { value: Color };
  uGroundColor: { value: Color };
  /** horizon haze colour looking toward / away from the sun */
  uFogColorSun: { value: Color };
  uFogColorAnti: { value: Color };
  /** extinction at sea level, 1/m (Koschmieder: 3.912 / visibility) */
  uFogDensity: { value: number };
  /** fog scale height, m */
  uFogHeightScale: { value: number };
  /** camera altitude above the ellipsoid, m (set by TerrainSystem every frame) */
  uCamAltitude: { value: number };
  /** seconds, for water animation */
  uTime: { value: number };
}

export function createTerrainSharedUniforms(): TerrainSharedUniforms {
  return {
    uSunDir: { value: new Vector3(0.3, 0.8, -0.5).normalize() },
    uSunColor: { value: new Color(1.0, 0.96, 0.9) },
    uSkyColor: { value: new Color(0.45, 0.6, 0.85) },
    uGroundColor: { value: new Color(0.25, 0.22, 0.18) },
    uFogColorSun: { value: new Color(0.85, 0.82, 0.75) },
    uFogColorAnti: { value: new Color(0.62, 0.72, 0.85) },
    uFogDensity: { value: 3.912 / 80_000 },
    uFogHeightScale: { value: 1200 },
    uCamAltitude: { value: 0 },
    uTime: { value: 0 },
  };
}

const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColorSun;
uniform vec3 uFogColorAnti;
uniform float uFogDensity;
uniform float uFogHeightScale;
uniform float uCamAltitude;
uniform vec3 uSunDir;
// Optical depth of an exponential atmosphere between altitudes hc (camera) and hp over distance d.
float fogAmount(float d, float hc, float hp) {
  float b = 1.0 / uFogHeightScale;
  float dh = hp - hc;
  float tau = abs(dh) < 1.0
    ? uFogDensity * exp(-hc * b) * d
    : uFogDensity * uFogHeightScale * (exp(-hc * b) - exp(-hp * b)) * d / dh;
  return 1.0 - exp(-max(tau, 0.0));
}
vec3 fogColor(vec3 viewDir) {
  vec2 v = viewDir.xz, s = uSunDir.xz;
  float lv = length(v), ls = length(s);
  float c = (lv > 1e-4 && ls > 1e-4) ? dot(v / lv, s / ls) : 0.0;
  float k = 0.5 + 0.5 * c;
  return mix(uFogColorAnti, uFogColorSun, k * k);
}
`;

const TERRAIN_VERT = /* glsl */ `
attribute float aHeight;
uniform vec3 uUvTransform;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying float vAlt;
void main() {
  vUv = uv * uUvTransform.z + uUvTransform.xy;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0); // modelViewMatrix is composed in float64 on the CPU
  vViewPos = mv.xyz;
  vAlt = aHeight;
  gl_Position = projectionMatrix * mv;
}
`;

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uHasMap;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying float vAlt;
${FOG_GLSL}
void main() {
  vec3 albedo = uHasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(0.32, 0.36, 0.28);
  vec3 n = normalize(vNormalW);
  float ndl = max(dot(n, uSunDir), 0.0);
  float daylight = clamp(uSunDir.y * 6.0 + 0.15, 0.0, 1.0);
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 light = hemi * 0.35 + uSunColor * daylight * (0.6 + 0.4 * ndl);
  vec3 col = albedo * light;
  float dist = length(vViewPos);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  col = mix(col, fogColor(viewDir), fogAmount(dist, uCamAltitude, vAlt));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WATER_VERT = /* glsl */ `
attribute float aDepth;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying float vDepth;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vDepth = max(-aDepth, 0.0);
  gl_Position = projectionMatrix * mv;
}
`;

const WATER_FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying float vDepth;
${FOG_GLSL}
// Analytic sum of directional waves; returns the surface slope (dh/dx, dh/dz).
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
  vec3 up = normalize(vNormalW);
  float dist = length(vViewPos);
  // fade the ripples out with distance so the far sea does not sparkle
  float ripple = 1.0 - smoothstep(2000.0, 20000.0, dist);
  vec2 slope = waveSlope(vWorldPos.xz, uTime) * ripple;
  vec3 n = normalize(up + vec3(-slope.x, 0.0, -slope.y));
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  vec3 v = -viewDir;
  float cosT = max(dot(n, v), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  float daylight = clamp(uSunDir.y * 6.0 + 0.15, 0.0, 1.0);
  vec3 deep = vec3(0.012, 0.045, 0.09), shallow = vec3(0.05, 0.22, 0.26);
  vec3 water = mix(deep, shallow, exp(-vDepth / 8.0));
  vec3 hemi = mix(uGroundColor, uSkyColor, 0.75);
  vec3 body = water * (hemi * 0.5 + uSunColor * daylight * 0.8);
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), 400.0) * daylight * (0.6 + 2.0 * (1.0 - clamp(uSunDir.y * 3.0, 0.0, 1.0)));
  vec3 col = mix(body, uSkyColor, fresnel) + uSunColor * spec;
  col = mix(col, fogColor(viewDir), fogAmount(dist, uCamAltitude, 0.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

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
  return new ShaderMaterial({
    name: 'ocean',
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: { ...shared },
  });
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
