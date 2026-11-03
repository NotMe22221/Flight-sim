import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyIblScale, IBL_SCALE_ANCHOR, iblScaleOf, patchIblScaleSource } from './iblScale';

/** Expand `#include <chunk>` recursively like three's WebGLProgram does. */
function resolveIncludes(src: string): string {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
    const chunk = (THREE.ShaderChunk as unknown as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`unknown chunk ${name}`);
    return resolveIncludes(chunk);
  });
}

type Shader = { uniforms: Record<string, { value: unknown }>; fragmentShader: string; vertexShader: string };

function compileStub(m: THREE.Material, lib: 'standard' | 'physical' | 'lambert' | 'phong' | 'basic'): Shader {
  const src = THREE.ShaderLib[lib];
  const shader: Shader = { uniforms: THREE.UniformsUtils.clone(src.uniforms), fragmentShader: src.fragmentShader, vertexShader: src.vertexShader };
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

describe('applyIblScale (per-material IBL share; three r187 overwrites envMapIntensity with scene.environmentIntensity)', () => {
  it('three r187 still overrides material.envMapIntensity for materials lit by scene.environment', async () => {
    // the reason the helper exists: if three stops doing this, the helper's factors would apply twice
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(process.cwd(), 'node_modules/three/src/renderers/WebGLRenderer.js');
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/envMap === null && scene\.environment !== null[\s\S]{0,200}envMapIntensity\.value = scene\.environmentIntensity/);
  });

  it('the anchor chunk adds only the IBL terms, to the variables the patch scales', () => {
    const begin = THREE.ShaderChunk.lights_fragment_begin;
    const maps = THREE.ShaderChunk.lights_fragment_maps;
    const end = THREE.ShaderChunk.lights_fragment_end;
    // declared (zero) in lights_fragment_begin …
    expect(begin).toMatch(/vec3 iblIrradiance = vec3\( 0\.0 \);/);
    expect(begin).toMatch(/vec3 radiance = vec3\( 0\.0 \);/);
    expect(begin).toMatch(/vec3 clearcoatRadiance = vec3\( 0\.0 \);/);
    // … filled with the environment only in lights_fragment_maps …
    expect(maps).toMatch(/iblIrradiance \+= getIBLIrradiance/);
    expect(maps).toMatch(/radiance \+= iblRadiance/);
    expect(maps).toMatch(/clearcoatRadiance \+= getIBLRadiance/);
    // … and consumed in lights_fragment_end (Lambert / Phong add the diffuse IBL to their irradiance there)
    expect(end).toMatch(/irradiance \+= iblIrradiance/);
    expect(end).toMatch(/RE_IndirectSpecular\( radiance, iblIrradiance, clearcoatRadiance/);
  });

  for (const lib of ['standard', 'physical', 'lambert', 'phong'] as const) {
    it(`scales diffuse and specular IBL after lights_fragment_maps (${lib})`, () => {
      const m = lib === 'physical' ? new THREE.MeshPhysicalMaterial() : lib === 'lambert' ? new THREE.MeshLambertMaterial() : lib === 'phong' ? new THREE.MeshPhongMaterial() : new THREE.MeshStandardMaterial();
      applyIblScale(m, 0.35, 0.1);
      const sh = compileStub(m, lib);
      const u = sh.uniforms.iblScale as { value: THREE.Vector2 };
      expect(u.value.x).toBeCloseTo(0.35);
      expect(u.value.y).toBeCloseTo(0.1);
      expect(sh.fragmentShader).toContain('uniform vec2 iblScale;');
      const full = resolveIncludes(sh.fragmentShader);
      const iMaps = full.indexOf('iblIrradiance += getIBLIrradiance');
      const iScaleD = full.indexOf('iblIrradiance *= iblScale.x;');
      const iScaleS = full.indexOf('radiance *= iblScale.y;');
      const iScaleC = full.indexOf('clearcoatRadiance *= iblScale.y;');
      const iEnd = full.indexOf('RE_IndirectDiffuse( irradiance, geometryPosition');
      expect(iMaps).toBeGreaterThan(0);
      // after the IBL is gathered, before it is used
      for (const i of [iScaleD, iScaleS, iScaleC]) { expect(i).toBeGreaterThan(iMaps); expect(i).toBeLessThan(iEnd); }
      // the uniform is declared before main()
      expect(full.indexOf('uniform vec2 iblScale;')).toBeLessThan(full.indexOf('void main() {'));
    });
  }

  it('leaves unlit materials alone and does not stack the patch', () => {
    const basic = new THREE.MeshBasicMaterial();
    applyIblScale(basic, 0.2);
    const sh = compileStub(basic, 'basic');
    expect(sh.fragmentShader).toBe(THREE.ShaderLib.basic.fragmentShader);
    expect(sh.uniforms.iblScale).toBeUndefined();
    const once = patchIblScaleSource(THREE.ShaderLib.standard.fragmentShader);
    expect(patchIblScaleSource(once)).toBe(once);
    expect(once.split(IBL_SCALE_ANCHOR).length).toBe(2);
    // applying again updates the values in place (one uniform, one patch)
    const m = new THREE.MeshStandardMaterial();
    const a = applyIblScale(m, 0.3);
    const b = applyIblScale(m, 0.5, 0.2);
    expect(b).toBe(a);
    expect(iblScaleOf(m)).toEqual({ diffuse: 0.5, specular: expect.closeTo(0.2, 6) as unknown as number });
    const fs = compileStub(m, 'standard').fragmentShader;
    expect(fs.split('iblIrradiance *= iblScale.x;').length).toBe(2);
  });

  it('gives each value its own program cache key and keeps earlier patches', () => {
    const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial(), c = new THREE.MeshStandardMaterial();
    applyIblScale(a, 0.35); applyIblScale(b, 0.12); applyIblScale(c, 0.35);
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).toBe(c.customProgramCacheKey());
    expect(applyIblScale(new THREE.MeshStandardMaterial(), 1, 0).key).not.toBe(applyIblScale(new THREE.MeshStandardMaterial(), 1, 0.03).key);
    // a material with its own patch (scenery-style): both patches run, both keys are kept
    const s = new THREE.MeshStandardMaterial();
    s.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('void main() {', '// other patch\nvoid main() {'); };
    s.customProgramCacheKey = () => 'scenery-walls-1';
    applyIblScale(s, 1, 0.03);
    expect(s.customProgramCacheKey()).toBe('scenery-walls-1|ibl:1.000,0.030');
    const sh = compileStub(s, 'standard');
    expect(sh.fragmentShader).toContain('// other patch');
    expect(sh.fragmentShader).toContain('radiance *= iblScale.y;');
    // a NaN share falls back to three's own (1), a negative one to 0
    expect(applyIblScale(new THREE.MeshStandardMaterial(), Number.NaN, -1).key).toBe('ibl:1.000,0.000');
  });
});
