import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultControlInputs } from '../core/types';
import { AircraftModel } from './AircraftModel';
import { c172ModelConfig } from './c172Layout';
import { makeTestState } from './testState';

const D2R = Math.PI / 180;

/** World-space (model-root-space) position of the trailing-edge point of a hinged surface. */
function tePoint(pivot: THREE.Group, side: 'x' | 'y' = 'x'): THREE.Vector3 {
  const mesh = pivot.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  // TE = max local z, mid span, chord-line height
  const p = new THREE.Vector3(side === 'x' ? (bb.min.x + bb.max.x) / 2 : 0, side === 'x' ? 0 : (bb.min.y + bb.max.y) / 2, bb.max.z);
  pivot.updateWorldMatrix(true, true);
  return p.applyMatrix4(pivot.matrixWorld);
}

describe('AircraftModel (Node build, no DOM)', () => {
  const model = new AircraftModel(c172ModelConfig());

  it('builds the scene graph and exposes the panel planes and eye point', () => {
    expect(model.root.children).toContain(model.exterior);
    expect(model.root.children).toContain(model.interior);
    expect(model.panelMesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(model.panelMeshG1000.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(model.eyePointLocal.x).toBeCloseTo(-0.25);
    expect(model.eyePointLocal.y).toBeCloseTo(0.55);
    expect(model.eyePointLocal.z).toBeCloseTo(-0.15);
    // Panel ≈ 0.65 m ahead of the eye, aft of the firewall (FS 0 ≈ z −1.04). As in the real 172
    // the glareshield sits ≈ 0.16 m below the design eye and the 0.48 m panel hangs from just under
    // its lip (top edge ≈ 0.19 m, centre ≈ 0.43 m below the eye), so from the seat the six-pack
    // fills the bottom third of a 60–75° view with the cowl visible over the glareshield.
    const pm = model.panelMesh, eyeY = model.eyePointLocal.y;
    expect(pm.position.z).toBeCloseTo(-0.8, 2);
    const top = pm.position.y + (0.48 / 2) * Math.cos(pm.rotation.x);
    expect(top).toBeLessThan(model.layout.glareshield.lipY);
    expect(eyeY - top).toBeGreaterThan(0.15);
    expect(eyeY - top).toBeLessThan(0.22);
    expect(eyeY - pm.position.y).toBeGreaterThan(0.38);
    expect(eyeY - pm.position.y).toBeLessThan(0.46);
    // in front of the left seat: the six-pack (left 47 % of the texture) is centred on the pilot
    const sixPackX = pm.position.x - 0.48 + 0.245 * 0.96;
    expect(Math.abs(sixPackX - model.eyePointLocal.x)).toBeLessThan(0.05);
  });

  it('panel planes show an assigned instrument texture at full brightness without a recompile', () => {
    for (const mesh of [model.panelMesh, model.panelMeshG1000]) {
      const mat = mesh.material;
      // MeshBasicMaterial multiplies map × color: a dark placeholder colour would black out the gauges
      expect(mat.color.getHex()).toBe(0xffffff);
      // a placeholder map is bound from the start, so swapping in a CanvasTexture keeps the same program
      expect(mat.map).toBeInstanceOf(THREE.Texture);
      expect(mat.toneMapped).toBe(false);
      // the plane faces the pilot (+Z normal tilted up) and is in front of the eye
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
      expect(n.z).toBeGreaterThan(0.9);
      expect(n.y).toBeGreaterThan(0);
      expect(mesh.position.z).toBeLessThan(model.eyePointLocal.z - 0.4);
    }
  });

  it('has C172-like overall extents (span 11 m, length ≈ 8.3 m, sits on its gear ~1.2 m below the CG)', () => {
    model.root.updateMatrixWorld(true);
    // light halos are 0.9 m billboards at the wing tips; measure the airframe without them.
    // `precise`: the default box of a rotated hinge mount is the box of its rotated local box,
    // which overstates the swept rudder's reach by ~0.35 m.
    const box = new THREE.Box3();
    for (const child of model.exterior.children) if (child.name !== 'lights') box.expandByObject(child, true);
    expect(box.max.x - box.min.x).toBeGreaterThan(10.8);
    expect(box.max.x - box.min.x).toBeLessThan(11.4);
    // real 172S: length 8.28 m (spinner to rudder), height 2.72 m
    expect(box.max.z - box.min.z).toBeGreaterThan(8.1);
    expect(box.max.z - box.min.z).toBeLessThan(8.45);
    expect(box.min.y).toBeLessThan(-1.15);
    expect(box.min.y).toBeGreaterThan(-1.3);
    expect(box.max.y).toBeGreaterThan(1.4);
  });

  it('control surfaces deflect in the JSBSim sign convention', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    model.update(st, inputs, 1 / 60, false);
    const e0 = tePoint(model.surfaces.elevator);
    const aL0 = tePoint(model.surfaces.aileronLeft);
    const aR0 = tePoint(model.surfaces.aileronRight);
    const fL0 = tePoint(model.surfaces.flapLeft);
    const r0 = tePoint(model.surfaces.rudder, 'y');

    st.surfaces.elevatorRad = 15 * D2R; // TE down ⇒ nose down
    st.surfaces.aileronLeftRad = 15 * D2R; // left TE down
    st.surfaces.aileronRightRad = -10 * D2R; // right TE up
    st.surfaces.flapDeg = 30;
    st.surfaces.rudderRad = 15 * D2R; // TE left
    model.update(st, inputs, 1 / 60, false);

    expect(tePoint(model.surfaces.elevator).y).toBeLessThan(e0.y - 0.05);
    expect(tePoint(model.surfaces.aileronLeft).y).toBeLessThan(aL0.y - 0.03);
    expect(tePoint(model.surfaces.aileronRight).y).toBeGreaterThan(aR0.y + 0.02);
    expect(tePoint(model.surfaces.flapLeft).y).toBeLessThan(fL0.y - 0.1);
    expect(tePoint(model.surfaces.rudder, 'y').x).toBeLessThan(r0.x - 0.05);
    // aileron on the left wing is on the left (−x) and the elevator TE is at the tail (+z)
    expect(aL0.x).toBeLessThan(-3);
    expect(aR0.x).toBeGreaterThan(3);
    expect(e0.z).toBeGreaterThan(5.5);
  });

  it('every hinged surface rotates about its own (swept / dihedral) hinge line', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    const hingeEnds = (pivot: THREE.Group, axis: 'x' | 'y'): [THREE.Vector3, THREE.Vector3] => {
      model.root.updateMatrixWorld(true);
      const m = pivot.matrixWorld;
      const a = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
      const b = (axis === 'x' ? new THREE.Vector3(1.5, 0, 0) : new THREE.Vector3(0, 1.5, 0)).applyMatrix4(m);
      return [a, b];
    };
    const sf = model.surfaces;
    const cases: [THREE.Group, 'x' | 'y'][] = [
      [sf.aileronLeft, 'x'], [sf.aileronRight, 'x'], [sf.flapLeft, 'x'], [sf.flapRight, 'x'], [sf.elevator, 'x'], [sf.rudder, 'y'],
    ];
    model.root.position.set(0, 0, 0); model.root.quaternion.identity();
    model.update(st, inputs, 0, false);
    const before = cases.map(([p, ax]) => hingeEnds(p, ax));
    st.surfaces.elevatorRad = -25 * D2R;
    st.surfaces.aileronLeftRad = 15 * D2R;
    st.surfaces.aileronRightRad = -20 * D2R;
    st.surfaces.flapDeg = 30;
    st.surfaces.rudderRad = 16 * D2R;
    model.update(st, inputs, 0, false);
    cases.forEach(([p, ax], i) => {
      const [a, b] = hingeEnds(p, ax);
      expect(a.distanceTo(before[i][0])).toBeLessThan(1e-6);
      expect(b.distanceTo(before[i][1])).toBeLessThan(1e-6);
    });
    // the aileron hinge on the tapered panel really is swept and has dihedral (so the test bites)
    const [a0, a1] = before[1];
    const dir = a1.clone().sub(a0).normalize();
    expect(Math.abs(dir.z)).toBeGreaterThan(0.05);
    expect(Math.abs(dir.y)).toBeGreaterThan(0.01);
  });

  it('propeller shows blades at low rpm and the blurred disc above ~400 rpm', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    st.engine.rpm = 200;
    model.update(st, inputs, 0.01, false);
    expect(model.propeller.bladesVisible).toBe(true);
    expect(model.propeller.discVisible).toBe(false);
    const a0 = model.propeller.angle;
    model.update(st, inputs, 0.01, false);
    // ω = 200 rpm = 20.9 rad/s; sense +1 (clockwise from behind) ⇒ angle decreases about +Z
    expect(model.propeller.angle - a0).toBeCloseTo(-(200 * 2 * Math.PI / 60) * 0.01, 6);
    st.engine.rpm = 2400;
    model.update(st, inputs, 0.01, false);
    expect(model.propeller.bladesVisible).toBe(false);
    expect(model.propeller.discVisible).toBe(true);
    expect(model.materials.propDisc.opacity).toBeGreaterThan(0.5);
  });

  it('gear compresses, steers and spins the wheels', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    st.gear[0].compressionM = 0.05;
    st.gear[0].steerRad = 10 * D2R;
    st.gear[1].compressionM = 0.04;
    st.gear[1].wheelSpeedMs = 10;
    model.update(st, inputs, 0.1, false);
    const noseCarrier = model.gear.carrierFor(0)!;
    expect(noseCarrier.position.y).toBeCloseTo(0.05, 6);
    // steering right (+) turns the wheel's forward direction toward +x
    const noseRoot = model.gear.noseRoot!;
    noseRoot.updateMatrixWorld(true);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(noseRoot.quaternion);
    expect(fwd.x).toBeGreaterThan(0.1);
    const mainCarrier = model.gear.carrierFor(1)!;
    expect(mainCarrier.position.y).toBeCloseTo(0.04, 3);
    const wheel = model.gear.wheelFor(1)!;
    // rolling forward ⇒ negative rotation about +x: 10 m/s / 0.22 m * 0.1 s
    expect(wheel.rotation.x).toBeLessThan(0);
    expect(Math.abs(wheel.rotation.x)).toBeCloseTo((10 / 0.22) * 0.1, 3);
  });

  it('a single non-finite state sample does not permanently poison the animation accumulators', () => {
    const m = new AircraftModel(c172ModelConfig());
    const st = makeTestState();
    const inputs = defaultControlInputs();
    st.engine.rpm = Number.NaN;
    st.gear[0].compressionM = Number.NaN; st.gear[0].steerRad = Number.NaN;
    st.gear[1].wheelSpeedMs = Number.NaN; st.gear[1].compressionM = Number.POSITIVE_INFINITY;
    st.surfaces.elevatorRad = Number.NaN;
    m.update(st, inputs, Number.NaN, false);
    m.update(st, inputs, 1 / 60, false);
    st.engine.rpm = 300;
    st.gear[0].compressionM = 0.02; st.gear[0].steerRad = 0;
    st.gear[1].wheelSpeedMs = 5; st.gear[1].compressionM = 0.03;
    st.surfaces.elevatorRad = 0.1;
    m.update(st, inputs, 1 / 60, false);
    expect(Number.isFinite(m.propeller.angle)).toBe(true);
    expect(Number.isFinite(m.gear.wheelFor(1)!.rotation.x)).toBe(true);
    expect(m.gear.wheelFor(1)!.rotation.x).not.toBe(0);
    expect(m.gear.carrierFor(0)!.position.y).toBeCloseTo(0.02, 9);
    expect(m.gear.carrierFor(1)!.position.y).toBeCloseTo(0.03, 6);
    expect(m.surfaces.elevator.rotation.x).toBeCloseTo(0.1, 9);
    m.root.updateMatrixWorld(true);
    m.root.traverse((o) => { expect(Number.isFinite(o.matrixWorld.elements[12] + o.matrixWorld.elements[0])).toBe(true); });
    m.dispose();
  });

  it('lights: nav steady, beacon 1 Hz, strobes double-flash every 1.5 s, spotlights gated', () => {
    const fresh = new AircraftModel(c172ModelConfig());
    const st = makeTestState();
    const inputs = defaultControlInputs();
    inputs.lights = { nav: true, beacon: true, strobe: true, landing: true, taxi: true, panel: 0 };
    const step = (dt: number, cockpit: boolean) => fresh.update(st, inputs, dt, cockpit);
    step(0.02, false); // t = 0.02
    expect(fresh.lights.navLit).toBe(true);
    expect(fresh.lights.beaconLit).toBe(true);
    expect(fresh.lights.strobeLit).toBe(true);
    expect(fresh.lights.landingLight.visible).toBe(true);
    step(0.06, false); // t = 0.08: beacon still on (0.12 s), strobe off between flashes
    expect(fresh.lights.beaconLit).toBe(true);
    expect(fresh.lights.strobeLit).toBe(false);
    step(0.06, false); // t = 0.14: second strobe flash, beacon off
    expect(fresh.lights.strobeLit).toBe(true);
    expect(fresh.lights.beaconLit).toBe(false);
    step(0.36, false); // t = 0.50
    expect(fresh.lights.beaconLit).toBe(false);
    expect(fresh.lights.strobeLit).toBe(false);
    step(0.52, false); // t = 1.02: beacon on again (period 1 s), strobe off (period 1.5 s)
    expect(fresh.lights.beaconLit).toBe(true);
    expect(fresh.lights.strobeLit).toBe(false);
    step(0.50, false); // t = 1.52: strobe first flash of the second cycle
    expect(fresh.lights.strobeLit).toBe(true);
    // spotlights are dark in the cockpit by day, lit at night. The gate uses intensity, not
    // `visible`, so switching views never changes the scene's light count (no shader recompiles).
    step(0.01, true);
    expect(fresh.lights.landingLit).toBe(false);
    expect(fresh.lights.landingLight.visible).toBe(true);
    expect(fresh.lights.landingLight.intensity).toBe(0);
    fresh.setSunElevation(-10 * D2R);
    step(0.01, true);
    expect(fresh.lights.landingLit).toBe(true);
    expect(fresh.lights.landingLight.intensity).toBeGreaterThan(1000);
    // by day the landing light's pool fades out in exterior views too (invisible on sunlit pavement)
    fresh.setSunElevation(40 * D2R);
    step(0.01, false);
    expect(fresh.lights.landingLight.intensity).toBe(0);
    fresh.setSunElevation(1 * D2R); // around sunset: partly
    step(0.01, false);
    expect(fresh.lights.landingLight.intensity).toBeGreaterThan(0);
    expect(fresh.lights.landingLight.intensity).toBeLessThan(4000);
    fresh.setSunElevation(-10 * D2R);
    inputs.lights.landing = false;
    step(0.01, false);
    expect(fresh.lights.landingLight.visible).toBe(false);
    expect(fresh.lights.landingLit).toBe(false);
    inputs.lights.nav = false;
    step(0.01, false);
    expect(fresh.lights.navLit).toBe(false);
    fresh.dispose();
  });

  it('switches the cabin shell / interior with the cockpit camera and honours setVisibility', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    model.update(st, inputs, 0.01, true);
    expect(model.cabinShell.visible).toBe(false);
    expect(model.interior.visible).toBe(true);
    expect(model.exterior.visible).toBe(true); // wings/cowl/prop stay visible from inside
    model.update(st, inputs, 0.01, false);
    expect(model.cabinShell.visible).toBe(true);
    expect(model.interior.visible).toBe(false);
    model.setVisibility(false, true);
    model.update(st, inputs, 0.01, true);
    expect(model.exterior.visible).toBe(false);
    expect(model.interior.visible).toBe(true);
    model.setVisibility(true, false);
    model.update(st, inputs, 0.01, true);
    expect(model.interior.visible).toBe(false);
    model.setVisibility(true, true);
  });

  it('cockpit controls follow the inputs', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    inputs.pitch = 1; inputs.roll = 1;
    model.update(st, inputs, 0.01, true);
    const yoke = model.cockpit.yokeGroups[0];
    const zBack = yoke.position.z;
    expect(yoke.rotation.z).toBeLessThan(0); // clockwise as seen by the pilot
    inputs.pitch = -1;
    model.update(st, inputs, 0.01, true);
    expect(yoke.position.z).toBeLessThan(zBack); // forward = −z
    model.setPanelVariant('g1000');
    expect(model.panelMeshG1000.visible).toBe(true);
    expect(model.panelMesh.visible).toBe(false);
    model.setPanelVariant('steam');
  });

  it('instrument faces are lit by daylight, or by the panel lights at night', () => {
    const m = new AircraftModel(c172ModelConfig());
    const st = makeTestState();
    const inputs = defaultControlInputs();
    const steam = m.panelMesh.material.color, glass = m.panelMeshG1000.material.color;
    m.setSunElevation(35 * D2R);
    m.update(st, inputs, 0.01, true);
    expect(steam.getHex()).toBe(0xffffff); // full brightness by day
    m.setSunElevation(-20 * D2R);
    m.update(st, inputs, 0.01, true);
    expect(steam.r).toBeLessThan(0.15); // dark night, panel lights off: dim but readable
    expect(steam.r).toBeGreaterThan(0);
    // the G1000 screens are emissive: dimmed for the night (≈ 35 %), still well above the unlit faces
    expect(glass.r).toBeGreaterThan(0.3);
    expect(glass.r).toBeLessThan(0.45);
    inputs.lights.panel = 1;
    m.update(st, inputs, 0.01, true);
    // post lights: faces, markings and background at ≈ 25–35 % of daylight (0.7 read as a daylight panel at night)
    expect(steam.r).toBeGreaterThanOrEqual(0.25);
    expect(steam.r).toBeLessThanOrEqual(0.35);
    expect(steam.r).toBeGreaterThan(0.15 * 1.5); // clearly brighter than the lights-off floor
    expect(steam.b).toBeLessThan(steam.r); // warm post lights
    inputs.lights.panel = Number.NaN;
    m.setSunElevation(Number.NaN); // ignored: keeps the last good elevation
    m.update(st, inputs, 0.01, true);
    expect(Number.isFinite(steam.r)).toBe(true);
    m.dispose();
  });

  it('setPose copies the pose and dispose releases resources', () => {
    const p = new THREE.Vector3(10, 20, 30);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    model.setPose(p, q);
    expect(model.root.position.equals(p)).toBe(true);
    expect(model.root.quaternion.equals(q)).toBe(true);
    let disposedGeos = 0;
    model.root.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) g.addEventListener('dispose', () => disposedGeos++); });
    let disposedMats = 0;
    model.materials.paint.addEventListener('dispose', () => disposedMats++);
    // three.js shares one geometry between every Sprite in the app: it must survive our dispose
    let spriteGeoDisposed = false;
    const sprite = new THREE.Sprite();
    sprite.geometry.addEventListener('dispose', () => { spriteGeoDisposed = true; });
    model.dispose();
    expect(disposedGeos).toBeGreaterThan(20);
    expect(disposedMats).toBe(1);
    expect(spriteGeoDisposed).toBe(false);
    model.dispose(); // idempotent
  });
});
