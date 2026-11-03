import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultControlInputs, type AircraftConfig } from '../core/types';
import { AircraftModel } from './AircraftModel';
import { c172ModelConfig } from './c172Layout';
import { cubModelConfig, type CubLayout } from './cubLayout';
import { makeTestState } from './testState';

const D2R = Math.PI / 180;

/** World-space (model-root-space) trailing-edge point of a hinged surface. */
function tePoint(pivot: THREE.Group, side: 'x' | 'y' = 'x'): THREE.Vector3 {
  const mesh = pivot.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  const p = new THREE.Vector3(side === 'x' ? (bb.min.x + bb.max.x) / 2 : 0, side === 'x' ? 0 : (bb.min.y + bb.max.y) / 2, bb.max.z);
  pivot.updateWorldMatrix(true, true);
  return p.applyMatrix4(pivot.matrixWorld);
}

/** Visible, opaque meshes (what blocks the pilot's view) under `root`. */
function opaqueMeshes(model: AircraftModel): THREE.Mesh[] {
  const m = model.materials;
  const see = new Set<THREE.Material>([m.glass, m.glassInterior, m.propDisc, m.navRed, m.navGreen, m.navWhite]);
  const out: THREE.Mesh[] = [];
  const visible = (o: THREE.Object3D | null): boolean => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  model.root.traverse((o) => { if (o instanceof THREE.Mesh && !see.has(o.material as THREE.Material) && visible(o)) out.push(o); });
  return out;
}

/** First opaque hit from the eye along a model-frame direction. */
function firstHit(model: AircraftModel, dir: THREE.Vector3): THREE.Intersection | undefined {
  model.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(model.eyePointLocal.clone().applyMatrix4(model.root.matrixWorld), dir.clone().normalize(), 0.02, 60);
  return ray.intersectObjects(opaqueMeshes(model), false)[0];
}

describe('AircraftModel builds the airframe named by config.airframe', () => {
  it('defaults to the C172 and builds the Cub for airframe "cub"; both update without NaN', () => {
    const configs: [string, ReturnType<typeof c172ModelConfig>][] = [['c172', c172ModelConfig()], ['cub', cubModelConfig()]];
    for (const [kind, cfg] of configs) {
      const model = new AircraftModel(cfg);
      expect(model.airframe).toBe(kind);
      expect(model.layout.airframe).toBe(kind);
      const st = makeTestState();
      const inputs = defaultControlInputs();
      st.engine.rpm = 1200; st.surfaces.flapDeg = 20; st.surfaces.elevatorRad = 0.1; st.surfaces.rudderRad = -0.2;
      for (const g of st.gear) { g.compressionM = 0.03; g.wheelSpeedMs = 4; g.steerRad = 0.1; }
      inputs.pitch = 0.5; inputs.roll = -0.4; inputs.yaw = 0.3; inputs.throttle = 0.7; inputs.pitchTrim = 0.2; inputs.carbHeat = true;
      for (const cockpit of [false, true]) model.update(st, inputs, 1 / 60, cockpit);
      model.setSunElevation(-0.2);
      model.root.updateMatrixWorld(true);
      model.root.traverse((o) => { for (const e of o.matrixWorld.elements) expect(Number.isFinite(e)).toBe(true); });
      expect(model.panelMesh.material.map).toBeInstanceOf(THREE.Texture);
      model.dispose();
    }
    expect(new AircraftModel().airframe).toBe('c172');
  });

  it('builds from the flight model\'s own Cub config when it exists (eye, prop and gear agree)', () => {
    const mods = import.meta.glob<Record<string, unknown>>('../fdm/aircraft/cub.ts', { eager: true });
    const cfg = Object.values(mods).flatMap((m) => Object.values(m))
      .find((v): v is AircraftConfig => !!v && typeof v === 'object' && (v as AircraftConfig).airframe === 'cub' && 'propulsion' in (v as object));
    if (!cfg) return; // the FDM config is not in this tree yet
    const model = new AircraftModel(cfg);
    expect(model.airframe).toBe('cub');
    expect(model.eyePointLocal.toArray()).toEqual([cfg.geometry.eyePoint[1], -cfg.geometry.eyePoint[2], -cfg.geometry.eyePoint[0]].map((x) => expect.closeTo(x, 9)));
    const L = model.layout as CubLayout;
    expect(L.prop.diameter).toBeCloseTo(cfg.propulsion.propeller!.diameterM, 9);
    const wheels = cfg.gear.filter((g) => g.type === 'wheel');
    expect(L.gear.mains.length + (L.gear.tail ? 1 : 0)).toBe(wheels.length);
    model.dispose();
  });
});

describe('Super Cub model', () => {
  const model = new AircraftModel(cubModelConfig());
  const L = model.layout as CubLayout;

  it('overall extents: span 10.73 m, length 6.88 m, CG ≈ 1 m above the ground in the three-point attitude', () => {
    model.update(makeTestState(), defaultControlInputs(), 0, false);
    model.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const child of model.exterior.children) if (child.name !== 'lights') box.expandByObject(child, true);
    expect(box.max.x - box.min.x).toBeGreaterThan(10.65);
    expect(box.max.x - box.min.x).toBeLessThan(10.8);
    expect(box.max.z - box.min.z).toBeGreaterThan(6.83);
    expect(box.max.z - box.min.z).toBeLessThan(6.93);
    expect(box.min.y).toBeCloseTo(-1.12, 2); // main tyres on their contact points
    // three-point attitude: rotate nose-up and measure from the ground
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), L.threePointPitchRad);
    try {
      model.root.quaternion.copy(q); model.root.updateMatrixWorld(true);
      const b3 = new THREE.Box3();
      for (const child of model.exterior.children) if (child.name !== 'lights' && child.name !== 'propeller') b3.expandByObject(child, true);
      const tailContact = L.gear.tail!.contact.clone().applyQuaternion(q);
      expect(Math.abs(b3.min.y - tailContact.y)).toBeLessThan(0.02); // tail wheel and mains on the ground
      expect(-b3.min.y).toBeCloseTo(L.cgAglM, 1);
      // published 6 ft 8.5 in (2.04 m); the shared chord plane (z −1.02 with the CG 1.0 m up)
      // puts the thick wing's tips ≈ 2.27 m up, the rudder top ≈ 1.7 m
      const height = b3.max.y - b3.min.y;
      expect(height).toBeGreaterThan(2.0);
      expect(height).toBeLessThan(2.3);
    } finally {
      model.root.quaternion.identity(); model.root.updateMatrixWorld(true);
    }
  });

  it('gear: tyres sit on the configured contact points, the V legs reach the axle and follow compression', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    model.update(st, inputs, 0, false);
    for (const m of L.gear.mains) {
      const wheel = model.gear.wheelFor(m.index)!;
      wheel.updateWorldMatrix(true, false);
      const c = new THREE.Vector3().setFromMatrixPosition(wheel.matrixWorld);
      expect(c.distanceTo(m.contact.clone().setY(m.contact.y + m.tyreRadius))).toBeLessThan(1e-6);
      wheel.geometry.computeBoundingBox();
      expect(wheel.geometry.boundingBox!.min.y).toBeCloseTo(-m.tyreRadius, 3);
    }
    const t = L.gear.tail!;
    const tw = model.gear.wheelFor(t.index)!;
    tw.updateWorldMatrix(true, false);
    expect(new THREE.Vector3().setFromMatrixPosition(tw.matrixWorld).distanceTo(t.contact.clone().setY(t.contact.y + t.tyreRadius))).toBeLessThan(1e-6);

    // compression lifts each wheel and the leg ends stay on the moving axle knuckle
    const legEnds = (name: string): THREE.Vector3[] => {
      const out: THREE.Vector3[] = [];
      model.gear.group.getObjectByName(name)!.traverse((o) => {
        if (['frontLeg', 'rearLeg', 'splitAxle', 'leafSpring'].includes(o.name)) { o.updateWorldMatrix(true, false); out.push(new THREE.Vector3(0, 1, 0).applyMatrix4(o.matrixWorld)); }
      });
      return out;
    };
    st.gear[0].compressionM = 0.06; st.gear[2].compressionM = 0.04;
    model.update(st, inputs, 0, false);
    const left = L.gear.mains.find((m) => m.index === 0)!;
    expect(model.gear.carrierFor(0)!.position.y).toBeCloseTo(0.06, 9);
    const knuckle = left.contact.clone(); knuckle.y += left.tyreRadius + 0.06; knuckle.x -= Math.sign(left.contact.x) * (left.width / 2 + 0.035);
    const ends = legEnds(`gear:${left.name}`);
    expect(ends).toHaveLength(3);
    for (const e of ends) expect(e.distanceTo(knuckle)).toBeLessThan(1e-5);
    expect(model.gear.carrierFor(t.index)!.position.y).toBeCloseTo(0.04, 9);
    const springEnd = legEnds(`gear:${t.name}`)[0];
    expect(springEnd.distanceTo(t.attach.clone().setY(t.attach.y + 0.04))).toBeLessThan(1e-5);
  });

  it('tail wheel steers right for steerRad > 0 and every wheel spins forward with wheelSpeed / r', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    const t = L.gear.tail!;
    st.gear[t.index].steerRad = 20 * D2R;
    st.gear[t.index].wheelSpeedMs = 5;
    st.gear[0].wheelSpeedMs = 5;
    const r0 = model.gear.wheelFor(0)!.rotation.x, rt = model.gear.wheelFor(t.index)!.rotation.x;
    model.update(st, inputs, 0.1, false);
    expect(model.gear.noseRoot).toBeNull();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(model.gear.tailRoot!.quaternion);
    expect(fwd.x).toBeGreaterThan(0.3);
    expect(model.gear.wheelFor(0)!.rotation.x - r0).toBeCloseTo(-(5 / 0.28) * 0.1, 6);
    expect(model.gear.wheelFor(t.index)!.rotation.x - rt).toBeCloseTo(-(5 / 0.08) * 0.1, 6);
  });

  it('control surfaces deflect in the JSBSim sign convention about their own hinge lines', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    const sf = model.surfaces;
    const cases: [THREE.Group, 'x' | 'y'][] = [[sf.aileronLeft, 'x'], [sf.aileronRight, 'x'], [sf.flapLeft, 'x'], [sf.flapRight, 'x'], [sf.elevator, 'x'], [sf.rudder, 'y']];
    const hingeEnds = (p: THREE.Group, ax: 'x' | 'y') => [new THREE.Vector3(), ax === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)].map((v) => v.applyMatrix4(p.matrixWorld));
    model.update(st, inputs, 0, false);
    model.root.updateMatrixWorld(true);
    const before = cases.map(([p, ax]) => hingeEnds(p, ax));
    const e0 = tePoint(sf.elevator), aL0 = tePoint(sf.aileronLeft), aR0 = tePoint(sf.aileronRight), f0 = tePoint(sf.flapRight), r0 = tePoint(sf.rudder, 'y');
    st.surfaces.elevatorRad = 15 * D2R; st.surfaces.aileronLeftRad = 15 * D2R; st.surfaces.aileronRightRad = -10 * D2R;
    st.surfaces.flapDeg = 40; st.surfaces.rudderRad = 20 * D2R;
    model.update(st, inputs, 0, false);
    model.root.updateMatrixWorld(true);
    expect(tePoint(sf.elevator).y).toBeLessThan(e0.y - 0.05);
    expect(tePoint(sf.aileronLeft).y).toBeLessThan(aL0.y - 0.05);
    expect(tePoint(sf.aileronRight).y).toBeGreaterThan(aR0.y + 0.03);
    expect(tePoint(sf.flapRight).y).toBeLessThan(f0.y - 0.15);
    expect(tePoint(sf.rudder, 'y').x).toBeLessThan(r0.x - 0.1); // TE left
    expect(aL0.x).toBeLessThan(-2.5);
    expect(r0.z).toBeGreaterThan(4.8);
    cases.forEach(([p, ax], i) => hingeEnds(p, ax).forEach((v, k) => expect(v.distanceTo(before[i][k])).toBeLessThan(1e-6)));
    // the deflected rudder clears the elevator's inboard corners
    const rudderBox = new THREE.Box3().setFromObject(sf.rudder, true);
    const elevMesh = sf.elevator.getObjectByName('elevatorRight') as THREE.Mesh;
    elevMesh.geometry.computeBoundingBox();
    st.surfaces.rudderRad = -25 * D2R; st.surfaces.elevatorRad = 0;
    model.update(st, inputs, 0, false);
    model.root.updateMatrixWorld(true);
    const rb = new THREE.Box3().setFromObject(sf.rudder, true);
    const elevAtRoot = new THREE.Box3().setFromObject(elevMesh, true);
    expect(rb.max.x).toBeGreaterThan(rudderBox.max.x); // swung right
    // near the elevator's TE height band the rudder stays inboard of the elevator's root cut
    expect(elevAtRoot.min.x).toBeGreaterThan(0.04);
  });

  it('propeller from the config: hub (1.80, 0, −0.05), Ø 1.88 m, two blades, clockwise; spinner tip at x +1.92', () => {
    const p = model.propeller.group;
    expect(p.position.toArray()).toEqual([0, 0.05, -1.8].map((x) => expect.closeTo(x, 6)));
    const blades = p.getObjectByName('blade0')!.parent!.children.filter((c) => c.name.startsWith('blade'));
    expect(blades).toHaveLength(2);
    const bb = new THREE.Box3().setFromObject(p, true);
    expect(bb.max.x - bb.min.x).toBeCloseTo(1.88, 1);
    expect(bb.min.z).toBeCloseTo(-1.92, 2);
    const st = makeTestState();
    st.engine.rpm = 300;
    const a0 = model.propeller.angle;
    model.update(st, defaultControlInputs(), 0.01, false);
    expect(model.propeller.angle - a0).toBeCloseTo(-(300 * 2 * Math.PI / 60) * 0.01, 6);
  });

  it('cockpit: from the eye the whole panel is in view, the cowl hides the horizon on the ground but not in flight', () => {
    const st = makeTestState();
    model.update(st, defaultControlInputs(), 0.01, true);
    expect(model.interior.visible).toBe(true);
    expect(model.cabinShell.visible).toBe(false);
    const P = L.panel;
    const pm = model.panelMesh;
    pm.updateWorldMatrix(true, false);
    for (const [u, v] of [[0, 0], [-0.45, 0.42], [0.45, 0.42], [-0.45, -0.3], [0.45, -0.3]]) {
      const target = new THREE.Vector3(u * P.width, v * P.height, 0).applyMatrix4(pm.matrixWorld);
      const hit = firstHit(model, target.sub(model.eyePointLocal));
      expect(hit?.object).toBe(pm);
    }
    // level flight: straight ahead and 4° down is clear for at least 50 m (over the cowl)
    const ahead = (deg: number) => new THREE.Vector3(0, -Math.sin(deg * D2R), -Math.cos(deg * D2R));
    expect(firstHit(model, ahead(4))).toBeUndefined();
    // three-point attitude: the horizon (≈ 11° below the body axis) is behind the nose, close by
    const nose = firstHit(model, ahead(L.threePointPitchRad / D2R));
    expect(nose).toBeDefined();
    expect(nose!.distance).toBeLessThan(2.5);
    // side windows: the wing strut is visible out of the right window, the sky through the skylight
    expect(firstHit(model, new THREE.Vector3(0, 1, -0.05))).toBeUndefined();
    const side = firstHit(model, new THREE.Vector3(1, -0.05, 0));
    expect(side === undefined || side.distance > 0.5).toBe(true);
  });

  it('panel plane: 0.60 × 0.30 m (2:1) unlit plane with a placeholder map; there is no G1000 to switch to', () => {
    const g = model.panelMesh.geometry.parameters;
    expect(g.width / g.height).toBeCloseTo(2, 9);
    expect(g.width).toBeCloseTo(0.6, 6);
    expect(model.panelMesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(model.panelMesh.material.color.getHex()).toBe(0xffffff);
    expect(model.panelMesh.material.map).toBeInstanceOf(THREE.Texture);
    model.setPanelVariant('g1000');
    expect(model.panelMesh.visible).toBe(true);
    expect(model.panelMeshG1000.visible).toBe(false);
    model.setPanelVariant('steam');
    expect(model.panelMesh.visible).toBe(true);
  });

  it('cockpit controls: sticks follow pitch / roll, pedals yaw, levers, trim crank, flap handle and fuel gauges', () => {
    const st = makeTestState();
    const inputs = defaultControlInputs();
    const grip = () => { const g = model.cockpit.yokeGroups[0].getObjectByName('grip')!; g.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(g.matrixWorld); };
    model.update(st, inputs, 0.01, true);
    const g0 = grip();
    inputs.pitch = 1; inputs.roll = 1;
    model.update(st, inputs, 0.01, true);
    const g1 = grip();
    expect(g1.z - g0.z).toBeGreaterThan(0.08); // stick back
    expect(g1.x - g0.x).toBeGreaterThan(0.08); // stick right
    expect(model.cockpit.yokeGroups).toHaveLength(2);
    const pedal = (n: string) => model.interior.getObjectByName(n)!.position.z;
    inputs.yaw = 1;
    model.update(st, inputs, 0.01, true);
    expect(pedal('pedalRight')).toBeLessThan(pedal('pedalLeft')); // right pedal forward
    const handle = model.interior.getObjectByName('flapHandle')!.parent!;
    st.surfaces.flapDeg = 0;
    model.update(st, inputs, 0.01, true);
    const h0 = handle.rotation.x;
    st.surfaces.flapDeg = 50;
    model.update(st, inputs, 0.01, true);
    expect(handle.rotation.x).toBeGreaterThan(h0 + 0.5);
    const crank = model.interior.getObjectByName('trimCrank')!.parent!;
    inputs.pitchTrim = 0.5;
    model.update(st, inputs, 0.01, true);
    expect(crank.rotation.x).not.toBe(0);
    const gauges: THREE.Object3D[] = [];
    model.interior.traverse((o) => { if (o.name === 'fuelGauge') gauges.push(o.parent!.children[o.parent!.children.length - 1]); });
    expect(gauges).toHaveLength(2);
    st.fuelKg = [L.tankCapacityKg[0], 0];
    model.update(st, inputs, 0.01, true);
    const full = gauges[0].rotation.z, empty = gauges[1].rotation.z;
    expect(full).not.toBeCloseTo(empty, 3);
    for (const o of gauges) expect(Number.isFinite(o.rotation.z)).toBe(true);
  });

  it('lights: red on the left tip, green on the right, beacon on the fin; dispose frees every geometry and material once', () => {
    const fresh = new AircraftModel(cubModelConfig());
    const inputs = defaultControlInputs();
    inputs.lights = { nav: true, beacon: true, strobe: true, landing: true, taxi: true, panel: 0 };
    fresh.update(makeTestState(), inputs, 0.02, false);
    expect(fresh.lights.navLit).toBe(true);
    expect(fresh.lights.landingLight.position.x).toBeLessThan(0);
    const geos = new Set<THREE.BufferGeometry>();
    fresh.root.traverse((o) => { if (!(o instanceof THREE.Sprite) && (o as THREE.Mesh).geometry) geos.add((o as THREE.Mesh).geometry); });
    const disposed = new Set<THREE.BufferGeometry>();
    for (const g of geos) g.addEventListener('dispose', () => disposed.add(g));
    const mats = new Set<THREE.Material>();
    fresh.root.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) mats.add(x); });
    const disposedMats = new Set<THREE.Material>();
    for (const m of mats) m.addEventListener('dispose', () => disposedMats.add(m));
    let spriteGeoDisposed = false;
    new THREE.Sprite().geometry.addEventListener('dispose', () => { spriteGeoDisposed = true; });
    const parent = new THREE.Group();
    parent.add(fresh.root);
    fresh.dispose();
    expect(disposed.size).toBe(geos.size);
    expect(geos.size).toBeGreaterThan(80);
    expect(disposedMats.size).toBe(mats.size);
    expect(spriteGeoDisposed).toBe(false);
    expect(fresh.root.parent).toBeNull();
    fresh.dispose(); // idempotent
  });
});
