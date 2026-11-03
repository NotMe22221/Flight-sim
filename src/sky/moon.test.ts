import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MoonDisc } from './moon';

const sunLocal = (m: MoonDisc) => (m.mesh.material as THREE.ShaderMaterial).uniforms.uSunLocal.value as THREE.Vector3;

describe('MoonDisc', () => {
  const cam = new THREE.Vector3(100, 50, -200);
  const tint = new THREE.Color(1, 1, 1);

  it('sits on the moon direction, faces the camera and has the 0.52° angular size', () => {
    const m = new MoonDisc();
    const dir = new THREE.Vector3(0.3, 0.5, -0.8).normalize();
    m.update(dir, new THREE.Vector3(0, -1, 0), cam, tint, 0);
    expect(m.mesh.visible).toBe(true);
    const offset = m.mesh.position.clone().sub(cam);
    expect(offset.clone().normalize().dot(dir)).toBeCloseTo(1, 9);
    // the quad's +Z (lit hemisphere normal) points back at the camera
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.mesh.quaternion);
    expect(normal.dot(dir)).toBeCloseTo(-1, 9);
    const angularDeg = (2 * Math.atan(m.mesh.scale.x / 2 / offset.length()) * 180) / Math.PI;
    expect(angularDeg).toBeCloseTo(0.52, 3);
    m.dispose();
  });

  it('phase: full when the sun is behind the observer, new when the sun is behind the moon', () => {
    const m = new MoonDisc();
    const dir = new THREE.Vector3(0, 0.6, 0.8);
    m.update(dir, dir.clone().negate(), cam, tint, 0); // opposition ⇒ full
    expect(sunLocal(m).z).toBeCloseTo(1, 6);
    m.update(dir, dir.clone(), cam, tint, 0); // conjunction ⇒ new
    expect(sunLocal(m).z).toBeCloseTo(-1, 6);
    // first quarter seen from the northern hemisphere: sun 90° to the WEST of a southern moon ⇒ lit on the right (+x local)
    const south = new THREE.Vector3(0, 0.2, 1).normalize();
    m.update(south, new THREE.Vector3(-1, 0, 0), cam, tint, 0);
    expect(sunLocal(m).x).toBeGreaterThan(0.9);
    // straight overhead does not degenerate
    m.update(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), cam, tint, 0);
    expect(m.mesh.quaternion.toArray().every(Number.isFinite)).toBe(true);
    m.dispose();
  });

  it('hides below the horizon', () => {
    const m = new MoonDisc();
    m.update(new THREE.Vector3(0, -0.2, 1).normalize(), new THREE.Vector3(0, 1, 0), cam, tint, 1);
    expect(m.mesh.visible).toBe(false);
    m.dispose();
  });
});
