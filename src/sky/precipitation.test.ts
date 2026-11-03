import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { weatherFromPreset } from './presets';
import { Precipitation } from './precipitation';
import { createSkyLighting } from './types';

const uniforms = (p: Precipitation) => (p.mesh.material as THREE.ShaderMaterial).uniforms;

describe('Precipitation', () => {
  it('scales the instance count with the rate, capped at the ≤ 4 k budget, hidden when dry', () => {
    const p = new Precipitation();
    const L = createSkyLighting();
    const cam = new THREE.Vector3(10, 500, -20), still = new THREE.Vector3(), calm = new THREE.Vector3();
    expect(p.maxParticles).toBeLessThanOrEqual(4000);
    p.update(1 / 60, cam, still, calm, weatherFromPreset('clear'), L);
    expect(p.mesh.visible).toBe(false);
    expect(p.activeCount).toBe(0);
    const rain = weatherFromPreset('rain'); // 4 mm/h
    p.update(1 / 60, cam, still, calm, rain, L);
    expect(p.mesh.visible).toBe(true);
    expect(p.activeCount).toBeGreaterThan(0);
    expect(p.activeCount).toBeLessThan(p.maxParticles);
    p.update(1 / 60, cam, still, calm, weatherFromPreset('storm'), L); // 15 mm/h ⇒ full budget
    expect(p.activeCount).toBe(p.maxParticles);
    expect((uniforms(p).uCamPos.value as THREE.Vector3).equals(cam)).toBe(true);
    p.dispose();
  });

  it('streaks along the relative velocity: fall + wind − camera motion (render frame)', () => {
    const p = new Precipitation();
    const L = createSkyLighting();
    const cam = new THREE.Vector3();
    // still air, parked: rain falls straight down
    p.update(1 / 60, cam, new THREE.Vector3(), new THREE.Vector3(), weatherFromPreset('rain'), L);
    const axis = uniforms(p).uAxis.value as THREE.Vector3;
    expect(axis.y).toBeCloseTo(-1, 9);
    // flying north (−z) at 50 m/s through calm air: streaks sweep back toward the camera (+z) and down
    p.update(1 / 60, cam, new THREE.Vector3(0, 0, -50), new THREE.Vector3(), weatherFromPreset('rain'), L);
    expect(axis.z).toBeGreaterThan(0.9);
    expect(axis.y).toBeLessThan(0);
    expect(axis.length()).toBeCloseTo(1, 9);
    expect(uniforms(p).uLength.value).toBeGreaterThan(0.5); // stretched with speed
    // snow drifts with an eastward wind (+x) when parked
    p.update(1 / 60, cam, new THREE.Vector3(), new THREE.Vector3(3, 0, 0), weatherFromPreset('snow'), L);
    expect(uniforms(p).uSnow.value).toBe(1);
    expect(axis.x).toBeGreaterThan(0.8);
    p.dispose();
  });
});
