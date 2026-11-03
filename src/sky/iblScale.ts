/**
 * Per-material share of the sky's image-based light (IBL).
 *
 * The sky bakes `scene.environment` and drives `scene.environmentIntensity` (≈ 1 by day since the light
 * calibration: the environment IS the skylight for built-in materials). three r187 binds that environment to
 * every MeshStandard / MeshPhysical / MeshLambert / MeshPhong material without an `envMap` of its own and, in
 * `WebGLRenderer.setProgram`, overwrites the material's `envMapIntensity` uniform with
 * `scene.environmentIntensity` on every draw — so a per-material `envMapIntensity` (a cabin that sees a third
 * of the sky, scenery that should not mirror it) does nothing.
 *
 * `applyIblScale` scales the IBL terms in the fragment shader instead, right after three's
 * `lights_fragment_maps` chunk, where they are still separate from the analytic lights:
 *   - `iblIrradiance` (diffuse IBL; Standard / Physical / Lambert / Phong) × `diffuse`,
 *   - `radiance` and `clearcoatRadiance` (specular IBL; Standard / Physical) × `specular`.
 * The factors are relative to `scene.environmentIntensity` (they multiply what three applies), so the sky's
 * day / twilight / night balance still holds. The values live in a per-material uniform (`iblScale`, vec2)
 * and the program cache key carries them, so materials with different shares never share a program by
 * accident. Any `onBeforeCompile` / `customProgramCacheKey` already on the material is kept (chained): apply
 * this AFTER other patches that assign those hooks.
 *
 * Unlit materials (no `lights_fragment_maps`) are left as they are.
 */
import type { Material, Vector2 } from 'three';
import { Vector2 as Vec2 } from 'three';

/** Anchor the scale is inserted after (three r187 `meshphysical` / `meshlambert` / `meshphong` fragment). */
export const IBL_SCALE_ANCHOR = '#include <lights_fragment_maps>';

/** GLSL inserted after {@link IBL_SCALE_ANCHOR}. */
export const IBL_SCALE_GLSL = /* glsl */ `
#if defined( RE_IndirectDiffuse )
	iblIrradiance *= iblScale.x;
#endif
#if defined( RE_IndirectSpecular )
	radiance *= iblScale.y;
	clearcoatRadiance *= iblScale.y;
#endif
`;

/** What `applyIblScale` keeps per material (see {@link iblScaleOf}). */
export interface IblScaleState {
  /** the per-material uniform (x = diffuse, y = specular) */
  uniform: { value: Vector2 };
  /** cache-key suffix, e.g. `ibl:0.350,0.350` */
  key: string;
}

/** Shader object as passed to `onBeforeCompile` (only the parts the patch touches). */
interface PatchableShader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

const clampShare = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 1);
/** per-material state (a WeakMap, not `userData`: that is JSON-cloned by `Material.clone` / `toJSON`) */
const STATES = new WeakMap<Material, IblScaleState>();

/**
 * Patch the GLSL of a lit material: declare `iblScale` and scale the IBL terms after the maps chunk.
 * Returns the source unchanged when the anchor is missing (unlit material) or the patch is already in.
 */
export function patchIblScaleSource(fragmentShader: string): string {
  if (!fragmentShader.includes(IBL_SCALE_ANCHOR) || fragmentShader.includes('uniform vec2 iblScale;')) return fragmentShader;
  return fragmentShader
    .replace('void main() {', 'uniform vec2 iblScale;\nvoid main() {')
    .replace(IBL_SCALE_ANCHOR, `${IBL_SCALE_ANCHOR}\n${IBL_SCALE_GLSL}`);
}

/**
 * Give `material` its own share of the environment light: `diffuse` scales the IBL irradiance, `specular`
 * (default: `diffuse`) the IBL reflections incl. clearcoat. 1 = what three applies (scene.environmentIntensity).
 * Calling it again updates the values (and the cache key) without stacking the patch.
 */
export function applyIblScale(material: Material, diffuse: number, specular: number = diffuse): IblScaleState {
  const d = clampShare(diffuse), s = clampShare(specular);
  const key = `ibl:${d.toFixed(3)},${s.toFixed(3)}`;
  const existing = STATES.get(material);
  if (existing) {
    existing.uniform.value.set(d, s);
    existing.key = key;
    return existing;
  }
  const state: IblScaleState = { uniform: { value: new Vec2(d, s) }, key };
  STATES.set(material, state);
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(material, shader, renderer);
    const sh = shader as unknown as PatchableShader;
    const patched = patchIblScaleSource(sh.fragmentShader);
    if (patched === sh.fragmentShader) return;
    sh.uniforms.iblScale = state.uniform;
    sh.fragmentShader = patched;
  };
  // three's default key is `onBeforeCompile.toString()`: keep the previous key (its patches) and add the values
  material.customProgramCacheKey = () => `${prevKey.call(material)}|${state.key}`;
  material.needsUpdate = true;
  return state;
}

/** The share set by {@link applyIblScale} (diffuse, specular), or null when the material has none. */
export function iblScaleOf(material: Material): { diffuse: number; specular: number } | null {
  const st = STATES.get(material);
  return st ? { diffuse: st.uniform.value.x, specular: st.uniform.value.y } : null;
}
