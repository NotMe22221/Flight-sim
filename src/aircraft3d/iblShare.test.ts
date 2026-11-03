/**
 * Cabin IBL shares and the night panel. three r187 replaces `material.envMapIntensity` by
 * `scene.environmentIntensity` for materials lit by `scene.environment`, so the cabin's intended sky share
 * (0.12–0.35) did nothing and the cabin got the full environment (glare shield 49 → 91 at noon after the light
 * calibration); `applyIblScale` (src/sky/iblScale.ts) applies it in the shader instead.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { iblScaleOf } from '../sky/iblScale';
import { PANEL_NIGHT, applyPanelLighting, type PanelMesh } from './interior';
import { CABIN_IBL_SHARE, createModelMaterials } from './materials';

describe('cabin image-based light share', () => {
  it('every cabin surface gets its share (diffuse and reflections), the exterior the full environment', () => {
    const m = createModelMaterials();
    for (const [name, k] of Object.entries(CABIN_IBL_SHARE)) {
      const mat = (m as unknown as Record<string, THREE.Material>)[name];
      expect(iblScaleOf(mat), name).toEqual({ diffuse: expect.closeTo(k, 6) as unknown as number, specular: expect.closeTo(k, 6) as unknown as number });
      expect(k).toBeLessThanOrEqual(0.35);
    }
    for (const mat of [m.paint, m.paintPlain, m.trim, m.metal, m.rubber, m.glass]) expect(iblScaleOf(mat)).toBeNull();
    // the scale lands in the compiled shader, and different shares never share a program
    const lib = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), fragmentShader: lib.fragmentShader, vertexShader: lib.vertexShader };
    m.interior.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('iblIrradiance *= iblScale.x;');
    expect(m.interior.customProgramCacheKey()).not.toBe(m.trimDark.customProgramCacheKey());
    expect(m.interior.customProgramCacheKey()).toBe(m.seat.customProgramCacheKey());
    m.dispose();
  });
});

describe('night instrument lighting', () => {
  const plane = (): PanelMesh => new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()) as PanelMesh;
  it('dims the unlit panel to ≈ 25–35 % at night with the post lights on; daylight is the panel as drawn', () => {
    const steam = plane(), g1000 = plane();
    applyPanelLighting(steam, g1000, 0, 1);
    const c = steam.material.color;
    expect(c.r).toBeGreaterThanOrEqual(0.25);
    expect(c.r).toBeLessThanOrEqual(0.35);
    expect(c.b).toBeLessThan(c.r); // warm post lights
    expect(g1000.material.color.r).toBeCloseTo(PANEL_NIGHT.g1000, 6);
    expect(g1000.material.color.r).toBeGreaterThan(c.r); // the backlit screens stay the brightest thing on the panel
    // markings at the night factor: white ≈ sRGB 150 on black faces, readable
    const white = new THREE.Color(c.r, c.r, c.r).convertLinearToSRGB().r * 255;
    expect(white).toBeGreaterThan(130);
    applyPanelLighting(steam, g1000, 0, 0);
    expect(steam.material.color.r).toBeCloseTo(PANEL_NIGHT.floor, 6); // lights off: the dim floor
    applyPanelLighting(steam, g1000, 1, 1);
    expect(steam.material.color.getHex()).toBe(0xffffff);
    expect(g1000.material.color.getHex()).toBe(0xffffff);
  });
});
