/**
 * Height fog for three's built-in materials (docs/research/04 §3.2): the same exponential-height
 * extinction, closed-form optical depth along the Euclidean view ray and sun-ward haze lobe as the
 * terrain and cloud shaders, so the aircraft, runways and buildings fade exactly like the ground
 * around them (three's `FogExp2` uses exp(−(d·z)²) of the view depth: ~6 % at 5 km where the terrain
 * shows 40 %, so runways looked pasted onto the haze).
 *
 * `installBuiltinHeightFog()` patches the `fog_*` shader chunks once and adds three shared uniforms
 * to every ShaderLib entry with fog and to `UniformsLib.fog`. Their values are `Float32Array`s, which
 * three's `cloneUniforms` keeps by reference, so every material program sees `setBuiltinHeightFog`
 * without per-material bookkeeping. Built-in fog runs after tone mapping and output encoding, so the
 * colours given here are display (tone-mapped, sRGB) values, like `scene.fog.color`.
 *
 * Robustness: a program whose uniforms lack the new values (a ShaderMaterial built before the install or
 * without `UniformsLib.fog`) reads zeros and keeps three's exact FogExp2 / linear `Fog` maths; with
 * `enabled = 0` every material does. Only `mvPosition`, `viewMatrix` and `cameraPosition` are used,
 * which every built-in and ShaderMaterial program declares (RawShaderMaterial does not use these chunks).
 */
import * as THREE from 'three';
import { HAZE_LOBE_GLSL } from './types';

/** (β0 m⁻¹, 1/H m⁻¹, ground render-y, enabled 0/1) */
const FOG_A = new Float32Array([0, 0, 0, 0]);
/** (unit sun direction xyz, unused) */
const FOG_B = new Float32Array([0, 1, 0, 0]);
/** (sun-ward haze colour, display-encoded rgb, unused) */
const FOG_C = new Float32Array([1, 1, 1, 0]);

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldOffset;
#endif
`;

const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// camera → vertex in world axes (row-vector product = transpose of the view rotation)
	vFogWorldOffset = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldOffset;
	uniform vec4 skyFogA;
	uniform vec4 skyFogB;
	uniform vec4 skyFogC;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${HAZE_LOBE_GLSL.replace('hazeSunLobe', 'skyFogSunLobe')}
#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	vec3 fogMixColor = fogColor;
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	if ( skyFogA.w > 0.5 ) {
		float skyFogDist = length( vFogWorldOffset );
		vec3 skyFogDir = vFogWorldOffset / max( skyFogDist, 1e-3 );
		float skyFogK = skyFogDist * skyFogDir.y * skyFogA.y;
		float skyFogE0 = exp( - min( max( cameraPosition.y - skyFogA.z, 0.0 ) * skyFogA.y, 80.0 ) );
		float skyFogG = abs( skyFogK ) < 1e-3 ? 1.0 - skyFogK * ( 0.5 - skyFogK / 6.0 ) : ( 1.0 - exp( - clamp( skyFogK, -80.0, 80.0 ) ) ) / skyFogK;
		fogFactor = 1.0 - exp( - max( skyFogA.x * skyFogE0 * skyFogDist * skyFogG, 0.0 ) );
		fogMixColor = mix( fogColor, skyFogC.rgb, skyFogSunLobe( dot( skyFogDir, skyFogB.xyz ) ) );
	}
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogMixColor, fogFactor );
#endif
`;

let installed = false;

/** Patch three's fog chunks and fog uniforms (idempotent; call before the first render). */
export function installBuiltinHeightFog(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_vertex = PARS_VERTEX;
  chunks.fog_vertex = VERTEX;
  chunks.fog_pars_fragment = PARS_FRAGMENT;
  chunks.fog_fragment = FRAGMENT;
  const add = (u: Record<string, THREE.IUniform>): void => {
    u.skyFogA = { value: FOG_A };
    u.skyFogB = { value: FOG_B };
    u.skyFogC = { value: FOG_C };
  };
  add(THREE.UniformsLib.fog as unknown as Record<string, THREE.IUniform>);
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader.uniforms && 'fogColor' in shader.uniforms) add(shader.uniforms);
  }
}

/** True once `installBuiltinHeightFog` ran (tests). */
export const builtinHeightFogInstalled = (): boolean => installed;

/**
 * Per-frame values. `glowEncoded` is the sun-ward haze colour after tone mapping and sRGB encoding
 * (the counterpart of `scene.fog.color`). `enabled = false` restores three's FogExp2 everywhere.
 */
export function setBuiltinHeightFog(beta0: number, invH: number, groundY: number, sunDir: THREE.Vector3, glowEncoded: THREE.Color, enabled = true): void {
  FOG_A[0] = Number.isFinite(beta0) ? Math.max(beta0, 0) : 0;
  FOG_A[1] = Number.isFinite(invH) ? Math.max(invH, 1e-7) : 1e-7;
  FOG_A[2] = Number.isFinite(groundY) ? groundY : 0;
  FOG_A[3] = enabled ? 1 : 0;
  FOG_B[0] = sunDir.x; FOG_B[1] = sunDir.y; FOG_B[2] = sunDir.z;
  FOG_C[0] = glowEncoded.r; FOG_C[1] = glowEncoded.g; FOG_C[2] = glowEncoded.b;
}

/** The shared uniform arrays (tests / debugging). */
export const builtinHeightFogValues = { a: FOG_A, b: FOG_B, c: FOG_C } as const;
