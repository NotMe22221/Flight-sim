import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { A320 } from '../fdm/aircraft/a320';
import { AircraftModel } from './AircraftModel';
import { defaultControlInputs, type AircraftState } from '../core/types';
import { makeAircraftState } from '../instruments/testing/sampleSnapshot';

function stateWith(ext: number, n1Rpm: number, speedbrake = 0): AircraftState {
  const s = makeAircraftState();
  s.gear = A320.gear.map(() => ({ compressionM: 0.1, normalForceN: 0, onGround: true, wheelSpeedMs: 10, steerRad: 0.1, extension: ext }));
  s.engine.rpm = n1Rpm;
  s.surfaces.speedbrake = speedbrake;
  return s;
}

describe('A320 3D model', () => {
  const model = new AircraftModel(A320);

  it('builds the airliner: 37.6 m long, 34 m span, two engines, panel at the displays aspect', () => {
    expect(model.airframe).toBe('a320');
    model.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.exterior);
    const size = box.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(36); expect(size.z).toBeLessThan(40);
    expect(size.x).toBeGreaterThan(33); expect(size.x).toBeLessThan(36);
    let nacelles = 0;
    model.exterior.traverse((o) => { if (o.name === 'nacelle') nacelles++; });
    expect(nacelles).toBe(2);
    const g = model.panelMesh.geometry.parameters;
    expect(g.width / g.height).toBeCloseTo(1536 / 640, 2);
    // the pilot sits in the nose, above the floor and inside the fuselage
    expect(model.eyePointLocal.z).toBeLessThan(-13);
    expect(Math.abs(model.eyePointLocal.x)).toBeLessThan(1);
  });

  it('gear retracts out of sight; fans spin with N1; spoilers rise with the speedbrake', () => {
    const u = defaultControlInputs();
    model.update(stateWith(1, 0), u, 0.1, false);
    const legs: THREE.Object3D[] = [];
    model.gear.group.children.forEach((c) => legs.push(c));
    expect(legs.length).toBe(3);
    expect(legs.every((l) => l.visible)).toBe(true);
    model.update(stateWith(0, 0), u, 0.1, false);
    expect(legs.every((l) => !l.visible)).toBe(true);
    const a0 = model.propeller.angle;
    model.update(stateWith(1, 5175 * 0.8), u, 0.05, false);
    expect(model.propeller.angle).not.toBeCloseTo(a0, 3);
    model.update(stateWith(1, 0, 1), u, 0.05, false);
    let raised = 0;
    model.exterior.traverse((o) => { if (o.name === 'spoiler' && o.parent && Math.abs(o.parent.rotation.x) > 0.5) raised++; });
    expect(raised).toBe(10);
  });

  it('disposes without throwing', () => {
    expect(() => new AircraftModel(A320).dispose()).not.toThrow();
  });
});
