/**
 * Scenery IBL shares (three r187 ignores `envMapIntensity` for materials lit by `scene.environment`): since the
 * sky's light calibration the environment's diffuse light IS the skylight (the hemisphere light is ≈ 0 by day),
 * so diffuse scenery keeps it in full — shaded like the terrain — and only the sky reflections are off (0.03 on
 * the facades' glass), as `envMapIntensity` 0 / 0.03 intended.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { iblScaleOf } from '../sky/iblScale';
import { ENV_DIFFUSE, ENV_SPECULAR, ENV_SPECULAR_GLASS, SceneryMaterials } from './materials';

describe('scenery image-based light share', () => {
  it('diffuse skylight in full, reflections off (a faint sheen on the glass), on top of the scenery patches', () => {
    const m = new SceneryMaterials(1);
    expect(ENV_DIFFUSE).toBe(1);
    expect(iblScaleOf(m.walls)).toEqual({ diffuse: 1, specular: expect.closeTo(ENV_SPECULAR_GLASS, 6) as unknown as number });
    for (const mat of [m.plain, m.roofs, m.surfaces, m.markings, m.trees]) expect(iblScaleOf(mat)).toEqual({ diffuse: 1, specular: ENV_SPECULAR });
    expect(m.surfaces.customProgramCacheKey()).toBe('scenery-surfaces-2|ibl:1.000,0.000');
    expect(m.walls.customProgramCacheKey()).toBe('scenery-walls-1|ibl:1.000,0.030');
    const lib = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), fragmentShader: lib.fragmentShader, vertexShader: lib.vertexShader };
    m.surfaces.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('sceneryDepthBias'); // the scenery's own patch still runs
    expect(shader.fragmentShader).toContain('sceneryAmbientSat');
    expect(shader.fragmentShader).toContain('radiance *= iblScale.y;');
    const lam = THREE.ShaderLib.lambert;
    const ts = { uniforms: THREE.UniformsUtils.clone(lam.uniforms), fragmentShader: lam.fragmentShader, vertexShader: lam.vertexShader };
    m.trees.onBeforeCompile(ts as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(ts.fragmentShader).toContain('iblIrradiance *= iblScale.x;');
    m.dispose();
  });
});
