import { ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { TERRAIN_SHADERS, createTerrainMaterial, createTerrainSharedUniforms, createWaterMaterial } from './materials';

/** Expand `#include <chunk>` the way three's WebGLProgram does; throws on an unknown chunk. */
function resolveIncludes(src: string, depth = 0): string {
  if (depth > 8) throw new Error('include depth');
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
    const chunk = (ShaderChunk as unknown as Record<string, string | undefined>)[name];
    if (chunk === undefined) throw new Error(`unknown shader chunk <${name}>`);
    return resolveIncludes(chunk, depth + 1);
  });
}

describe('terrain materials', () => {
  it('every shader includes the logarithmic-depth chunks and resolves against three’s ShaderChunk', () => {
    for (const [name, src] of Object.entries(TERRAIN_SHADERS)) {
      const vertex = name.endsWith('Vertex');
      expect(src).toContain(vertex ? '#include <logdepthbuf_pars_vertex>' : '#include <logdepthbuf_pars_fragment>');
      expect(src).toContain(vertex ? '#include <logdepthbuf_vertex>' : '#include <logdepthbuf_fragment>');
      const full = resolveIncludes(src);
      expect(full).toContain('USE_LOGARITHMIC_DEPTH_BUFFER');
      // logdepthbuf_vertex calls isPerspectiveMatrix(), defined in <common>
      if (vertex) expect(full).toContain('bool isPerspectiveMatrix');
    }
  });

  it('declared custom uniforms exist on the materials, and the shared uniform objects are shared', () => {
    const shared = createTerrainSharedUniforms();
    const terrain = createTerrainMaterial(shared, null, [0, 0, 1]);
    const water = createWaterMaterial(shared);
    const check = (src: string, uniforms: Record<string, unknown>): void => {
      for (const m of src.matchAll(/^uniform \w+ (\w+);/gm)) expect(uniforms, m[1]).toHaveProperty(m[1]);
    };
    check(TERRAIN_SHADERS.terrainVertex + TERRAIN_SHADERS.terrainFragment, terrain.uniforms);
    check(TERRAIN_SHADERS.waterVertex + TERRAIN_SHADERS.waterFragment, water.uniforms);
    expect(terrain.uniforms.uSunDir).toBe(shared.uSunDir);
    expect(water.uniforms.uFogColor).toBe(shared.uFogColor);
    expect(terrain.uniforms.uHasMap.value).toBe(0);
    terrain.dispose();
    water.dispose();
  });
});

describe('terrain materials: sky link and procedural detail', () => {
  it('reference the sky module’s shared uniforms (default SKY_UNIFORMS) and flag only procedural colours for detail', async () => {
    const { SKY_UNIFORMS, createSkySharedUniforms } = await import('../sky/skyUniforms');
    const shared = createTerrainSharedUniforms();
    expect(shared.uSkyIrradiance).toBe(SKY_UNIFORMS.uSkyIrradiance);
    expect(shared.uCloudShadowA).toBe(SKY_UNIFORMS.uCloudShadowA);
    const own = createSkySharedUniforms();
    const isolated = createTerrainSharedUniforms(own);
    expect(isolated.uSkyLinked).toBe(own.uSkyLinked);
    const real = createTerrainMaterial(shared, null, [0, 0, 1]);
    const synthetic = createTerrainMaterial(shared, null, [0, 0, 1], true);
    expect(real.uniforms.uProcedural.value).toBe(0);
    expect(synthetic.uniforms.uProcedural.value).toBe(1);
    expect(real.uniforms.uSkyIrradiance).toBe(SKY_UNIFORMS.uSkyIrradiance);
    expect(real.defines.CLOUD_OCTAVES).toBeGreaterThan(0);
    const water = createWaterMaterial(shared);
    expect(water.uniforms.uSkyHorizon).toBe(SKY_UNIFORMS.uSkyHorizon);
    expect(water.defines.CLOUD_OCTAVES).toBeGreaterThan(0);
    // array uniforms declared in GLSL exist too
    for (const src of [TERRAIN_SHADERS.terrainFragment, TERRAIN_SHADERS.waterFragment]) {
      for (const m of src.matchAll(/^uniform \w+ (\w+)\[/gm)) expect(real.uniforms, m[1]).toHaveProperty(m[1]);
      expect(src).toContain('skyCloudShadow(vWorldPos, uSunDir)');
    }
    // real imagery is sampled and lit, never recoloured: the detail runs only behind the procedural flag
    expect(TERRAIN_SHADERS.terrainFragment).toContain('if (uProcedural > 0.5) albedo = proceduralDetail(albedo, vWorldPos, dist);');
    real.dispose(); synthetic.dispose(); water.dispose();
  });
});
