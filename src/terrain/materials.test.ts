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
