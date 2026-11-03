import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { qConj, qFromEuler } from '../core/math';
import { makeAircraftState } from '../core/fakeState';
import type { AircraftState, InputSnapshot, Quat, SimAction, Vec3 } from '../core/types';
import { bodyQuatToThree, nedToThreeVec } from '../aircraft3d/frames';
import { CameraController } from './CameraController';
import { autoFovDeg } from './modes/tower';
import { quatFromYawPitch } from './modes/util';

const D2R = Math.PI / 180;
const EYE = new THREE.Vector3(-0.25, 0.55, -0.15);

export function makeInput(over: Partial<InputSnapshot> = {}, axes: Partial<InputSnapshot['axes']> = {}): InputSnapshot {
  return {
    axes: { pitch: 0, roll: 0, yaw: 0, throttle: 0, mixture: 1, propeller: 1, brakeLeft: 0, brakeRight: 0, lookYaw: 0, lookPitch: 0, cameraZoom: 0, ...axes },
    actions: [], held: new Set<SimAction>(), pointerDx: 0, pointerDy: 0, mouseYoke: false, ...over,
  };
}

/** Kinematic aircraft: straight and level (or along a given attitude) at constant velocity. */
export class TestAircraft {
  readonly state: AircraftState;
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  constructor(headingDeg = 0, speedMs = 50, pitchDeg = 0, rollDeg = 0, posNED: Vec3 = [0, 0, -300]) {
    const h = headingDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
    const qNB = qConj(qFromEuler(r, p, h)) as Quat;
    const velNED: Vec3 = [speedMs * Math.cos(h) * Math.cos(p), speedMs * Math.sin(h) * Math.cos(p), -speedMs * Math.sin(p)];
    this.state = makeAircraftState({
      posNED: [...posNED] as Vec3, qNB, euler: [r, p, h], headingTrueRad: h, velNED, onGround: false,
      altitudeAglM: -posNED[2], loadFactor: [0, 0, 1],
    });
    this.sync();
  }
  sync(): void {
    nedToThreeVec(this.state.posNED, this.pos);
    bodyQuatToThree(this.state.qNB, this.quat);
  }
  advance(dt: number): void {
    const s = this.state;
    for (let i = 0; i < 3; i++) s.posNED[i] += s.velNED[i] * dt;
    this.sync();
  }
}

/** Run `seconds` of frames at `hz`, advancing the aircraft and the camera. */
export function run(cam: CameraController, ac: TestAircraft, seconds: number, hz: number, input: InputSnapshot = makeInput()): void {
  const dt = 1 / hz;
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    ac.advance(dt);
    cam.update(dt, ac.state, ac.pos, ac.quat, input, EYE);
    input.actions = [];
    input.pointerDx = 0; input.pointerDy = 0;
  }
}

const viewDir = (cam: CameraController): THREE.Vector3 => cam.camera.getWorldDirection(new THREE.Vector3());

describe('quaternion mapping', () => {
  it('quatFromYawPitch: compass yaw clockwise from north (−Z), pitch up = +Y', () => {
    const q = new THREE.Quaternion();
    const fwd = (yawDeg: number, pitchDeg: number) => new THREE.Vector3(0, 0, -1).applyQuaternion(quatFromYawPitch(yawDeg * D2R, pitchDeg * D2R, q));
    expect(fwd(0, 0).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
    expect(fwd(90, 0).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(fwd(180, 0).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(fwd(0, 30).y).toBeCloseTo(0.5, 9);
    // the camera's right vector stays horizontal (no roll)
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(quatFromYawPitch(0.7, 0.4, q)).y).toBeCloseTo(0, 9);
  });

  it('cockpit view looks along the nose for heading 090 and pitch +10°, and free-look turns toward the right wing', () => {
    const cam = new CameraController(16 / 9, { cockpitNeutralPitchRad: 0 });
    const ac = new TestAircraft(90, 50, 10);
    cam.update(1 / 60, ac.state, ac.pos, ac.quat, makeInput(), EYE);
    const d = viewDir(cam);
    expect(d.x).toBeCloseTo(Math.cos(10 * D2R), 6);
    expect(d.y).toBeCloseTo(Math.sin(10 * D2R), 6);
    expect(d.z).toBeCloseTo(0, 6);
    // camera sits at the eye point: the pilot's left is north (−Z) when heading east
    expect(cam.camera.position.z).toBeLessThan(ac.pos.z);
    cam.state.lookYaw = 90 * D2R;
    cam.update(1 / 60, ac.state, ac.pos, ac.quat, makeInput(), EYE);
    const r = viewDir(cam);
    expect(r.z).toBeCloseTo(1, 3); // right wing of an east-bound aircraft points south (+Z)
    expect(cam.camera.near).toBeCloseTo(0.05, 9);
    expect(cam.camera.far).toBeCloseTo(600_000, 3);
  });

  it('the default cockpit head pose looks 3.5° below the nose; free-look pitch is relative to it', () => {
    const cam = new CameraController(16 / 9);
    const ac = new TestAircraft(0, 50, 0);
    cam.update(1 / 60, ac.state, ac.pos, ac.quat, makeInput(), EYE);
    expect(Math.asin(viewDir(cam).y) / D2R).toBeCloseTo(-3.5, 6);
    cam.state.lookPitch = 10 * D2R;
    cam.update(1 / 60, ac.state, ac.pos, ac.quat, makeInput(), EYE);
    expect(Math.asin(viewDir(cam).y) / D2R).toBeCloseTo(6.5, 6);
  });

  it('roll right banks the cockpit view right (camera right vector points down)', () => {
    const cam = new CameraController(1.5);
    const ac = new TestAircraft(0, 50, 0, 30);
    cam.update(1 / 60, ac.state, ac.pos, ac.quat, makeInput(), EYE);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.camera.quaternion);
    expect(right.y).toBeCloseTo(-Math.sin(30 * D2R), 6);
  });
});

describe('chase camera', () => {
  const settle = (hz: number) => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    run(cam, ac, 0.1, hz); // cockpit first: the chase starts from inside the cabin
    cam.setMode('chase');
    run(cam, ac, 2.0, hz);
    return { cam, ac, rel: cam.camera.position.clone().sub(ac.pos) };
  };

  it('converges behind and above the aircraft within 2 s (critically damped, τ 0.35 s)', () => {
    const { cam, ac, rel } = settle(60);
    const d = cam.options.chaseDistanceM, el = cam.options.chaseElevationRad;
    // flying north (−Z) ⇒ behind is +Z
    expect(rel.x).toBeCloseTo(0, 1);
    expect(rel.y).toBeCloseTo(d * Math.sin(el), 1);
    expect(rel.z).toBeCloseTo(d * Math.cos(el), 1);
    const toAc = ac.pos.clone().sub(cam.camera.position).normalize();
    expect(viewDir(cam).angleTo(toAc)).toBeLessThan(1 * D2R);
    expect(cam.camera.near).toBeCloseTo(cam.options.nearExternalM, 9);
  });

  it('is frame-rate independent (30 Hz vs 144 Hz)', () => {
    const a = settle(30).rel, b = settle(144).rel;
    expect(a.distanceTo(b)).toBeLessThan(0.05);
  });

  it('follows 30 % of the aircraft roll', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50, 0, 40);
    cam.setMode('chase');
    run(cam, ac, 2, 60);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.camera.quaternion);
    // banked right by ≈ 0.3 × 40° (the 15° look-down adds a small cosine factor)
    expect(Math.asin(-right.y) / D2R).toBeCloseTo(12, 0);
  });
});

describe('external orbit camera', () => {
  it('clamps the distance to 8..200 m for both zoom axis and zoom actions', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 0);
    cam.setMode('external-orbit');
    run(cam, ac, 30, 60, makeInput({}, { cameraZoom: 1 }));
    expect(cam.state.orbitDistanceM).toBeCloseTo(8, 9);
    run(cam, ac, 60, 60, makeInput({}, { cameraZoom: -1 }));
    expect(cam.state.orbitDistanceM).toBeCloseTo(200, 9);
    for (let i = 0; i < 100; i++) run(cam, ac, 1 / 60, 60, makeInput({ actions: ['zoomIn'] }));
    expect(cam.state.orbitDistanceM).toBeCloseTo(8, 9);
    const rel = cam.camera.position.clone().sub(ac.pos);
    expect(rel.length()).toBeGreaterThan(7.9);
    expect(rel.length()).toBeLessThan(8.5);
  });

  it('one zoom action changes the distance by ×1.1 and the distance persists', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 0);
    cam.setMode('external-orbit');
    run(cam, ac, 0.1, 60);
    const d0 = cam.state.orbitDistanceM;
    run(cam, ac, 1 / 60, 60, makeInput({ actions: ['zoomOut'] }));
    run(cam, ac, 1, 60);
    expect(cam.state.orbitDistanceM).toBeCloseTo(d0 * 1.1, 6);
  });

  it('drag rotates the view and inertia coasts the same total angle at any frame rate', () => {
    const coast = (hz: number) => {
      const cam = new CameraController(1.6);
      const ac = new TestAircraft(0, 0);
      cam.setMode('external-orbit');
      run(cam, ac, 0.2, hz);
      // drag at 1 rad/s for 0.5 s, then release
      const n = Math.round(0.5 * hz);
      for (let i = 0; i < n; i++) run(cam, ac, 1 / hz, hz, makeInput({ pointerDx: 1 / hz / cam.options.pointerSensitivity }));
      const atRelease = cam.state.orbitYaw;
      expect(atRelease).toBeCloseTo(0.5, 6);
      run(cam, ac, 4, hz);
      return cam.state.orbitYaw - atRelease;
    };
    const c30 = coast(30), c144 = coast(144);
    expect(c144).toBeCloseTo(0.4, 2); // v·τ with τ = 0.4 s
    expect(Math.abs(c30 - c144)).toBeLessThan(1e-3);
  });
});

describe('drone camera', () => {
  /** enter the drone looking north, level, at the aircraft's position + 20 m up */
  const setup = (throttle = 0) => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 0);
    cam.setMode('drone');
    run(cam, ac, 1 / 60, 60, makeInput({}, { throttle }));
    cam.state.droneYaw = 0; cam.state.dronePitch = 0;
    cam.drone.setPosition(ac.pos.clone().add(new THREE.Vector3(0, 20, 0)));
    return { cam, ac, p0: () => cam.drone.position.clone() };
  };

  it('stick forward (pitch −1, docs/research/06: nose down = −pitch) flies forward along the view', () => {
    const { cam, ac } = setup();
    const start = cam.drone.position.clone();
    run(cam, ac, 1, 60, makeInput({}, { pitch: -1 }));
    const d = cam.drone.position.clone().sub(start);
    expect(d.z).toBeCloseTo(-cam.options.droneBaseSpeedMs, 6); // north = −Z
    expect(Math.abs(d.x) + Math.abs(d.y)).toBeLessThan(1e-9);
    expect(viewDir(cam).z).toBeCloseTo(-1, 9);
  });

  it('roll +1 strafes right (east when looking north)', () => {
    const { cam, ac } = setup();
    const start = cam.drone.position.clone();
    run(cam, ac, 1, 60, makeInput({}, { roll: 1 }));
    const d = cam.drone.position.clone().sub(start);
    expect(d.x).toBeCloseTo(cam.options.droneBaseSpeedMs, 6);
    expect(Math.abs(d.z)).toBeLessThan(1e-9);
  });

  it('throttle is measured from its value when the drone was entered: idle throttle does not sink the drone', () => {
    const { cam, ac } = setup(0);
    const start = cam.drone.position.clone();
    run(cam, ac, 1, 60, makeInput({}, { throttle: 0 }));
    expect(cam.drone.position.distanceTo(start)).toBeLessThan(1e-9);
    run(cam, ac, 1, 60, makeInput({}, { throttle: 0.5 }));
    expect(cam.drone.position.y - start.y).toBeGreaterThan(0.5 * cam.options.droneBaseSpeedMs);
    const mid = cam.drone.position.clone();
    run(cam, ac, 1, 60, makeInput({}, { throttle: 0.5 }));
    expect(cam.drone.position.y).toBeGreaterThan(mid.y);
  });

  it('pointer right yaws the view right; pointer up pitches it up; NED position is published', () => {
    const { cam, ac } = setup();
    const px = (30 * D2R) / cam.options.pointerSensitivity;
    run(cam, ac, 1 / 60, 60, makeInput({ pointerDx: px, pointerDy: -px }));
    expect(cam.state.droneYaw).toBeCloseTo(30 * D2R, 9);
    expect(cam.state.dronePitch).toBeCloseTo(30 * D2R, 9);
    const d = viewDir(cam);
    expect(d.x).toBeGreaterThan(0.3);
    expect(d.y).toBeGreaterThan(0.3);
    const p = cam.drone.position;
    expect(cam.state.dronePosNED[0]).toBeCloseTo(-p.z, 9);
    expect(cam.state.dronePosNED[1]).toBeCloseTo(p.x, 9);
    expect(cam.state.dronePosNED[2]).toBeCloseTo(-p.y, 9);
  });

  it('follow mode keeps the offset in the aircraft heading frame and turns the view with it', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    cam.setMode('drone');
    cam.setDroneFollow(true);
    run(cam, ac, 1 / 60, 60);
    const rel0 = cam.drone.position.clone().sub(ac.pos);
    const yaw0 = cam.state.droneYaw;
    run(cam, ac, 2, 60);
    expect(cam.drone.position.clone().sub(ac.pos).distanceTo(rel0)).toBeLessThan(1e-6);
    // aircraft turns to heading 090: offset and view rotate by +90°
    const turned = new TestAircraft(90, 50, 0, 0, ac.state.posNED);
    run(cam, turned, 1 / 60, 60);
    const rel1 = cam.drone.position.clone().sub(turned.pos);
    const expected = rel0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -90 * D2R);
    expect(rel1.distanceTo(expected)).toBeLessThan(1e-3);
    expect(cam.state.droneYaw - yaw0).toBeCloseTo(90 * D2R, 6);
  });
});

describe('tower camera', () => {
  it('auto-FOV is monotonically non-increasing with distance and clamped to 2°..60°', () => {
    let prev = Infinity;
    for (let d = 1; d < 100_000; d *= 1.05) {
      const f = autoFovDeg(d, 8.28, 0.04, 2, 60);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThanOrEqual(60);
      prev = f;
    }
  });

  it('keeps the aircraft at 2–6 % of the frame height in the unclamped range', () => {
    for (const d of [400, 1000, 3000]) {
      const fov = autoFovDeg(d, 8.28, 0.04, 2, 60);
      const angular = 2 * Math.atan(4.14 / d) / D2R;
      expect(angular / fov).toBeGreaterThanOrEqual(0.02);
      expect(angular / fov).toBeLessThanOrEqual(0.06);
    }
  });

  it('looks at the aircraft from the tower position and settles the FOV', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 0);
    const tower = ac.pos.clone().add(new THREE.Vector3(1000, 30, 0));
    cam.setTowerPosition(tower);
    cam.setMode('tower');
    run(cam, ac, 5, 60);
    expect(cam.camera.position.distanceTo(tower)).toBeLessThan(1e-9);
    const toAc = ac.pos.clone().sub(tower).normalize();
    expect(viewDir(cam).angleTo(toAc)).toBeLessThan(0.1 * D2R);
    expect(cam.camera.fov).toBeCloseTo(autoFovDeg(tower.distanceTo(ac.pos), 8.28, cam.options.towerFrameFraction, 2, 60), 3);
  });
});

describe('robustness', () => {
  it('a floating-origin shift moves world-anchored camera state with the world (no swing)', () => {
    for (const mode of ['chase', 'tower', 'flyby', 'drone', 'external-orbit'] as const) {
      const cam = new CameraController(1.6);
      const ac = new TestAircraft(0, 50);
      cam.setMode(mode);
      run(cam, ac, 3, 60);
      const rel = cam.camera.position.clone().sub(ac.pos);
      const dir = viewDir(cam);
      // the world rebases 20 km north: every render-frame position gains +20 000 on z
      const shift = new THREE.Vector3(0, 0, 20_000);
      ac.state.posNED[0] -= 20_000; ac.sync();
      cam.shiftOrigin(shift);
      run(cam, ac, 1 / 60, 60);
      const rel2 = cam.camera.position.clone().sub(ac.pos);
      expect(rel2.distanceTo(rel)).toBeLessThan(2); // only one frame of normal motion
      expect(viewDir(cam).angleTo(dir)).toBeLessThan(2 * D2R);
    }
  });

  it('snapToAircraft re-seeds the tower after a teleport', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 0);
    cam.setMode('tower');
    run(cam, ac, 1, 60);
    const far = new TestAircraft(0, 0, 0, 0, [500_000, 0, -300]);
    cam.snapToAircraft();
    run(cam, far, 1 / 60, 60);
    expect(cam.camera.position.distanceTo(far.pos)).toBeLessThan(1000);
  });

  it('non-finite dt and aspect do not poison the camera', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    for (const mode of ['cockpit', 'chase', 'external-orbit', 'drone', 'tower', 'flyby', 'wing'] as const) {
      cam.setMode(mode);
      cam.update(Number.NaN, ac.state, ac.pos, ac.quat, makeInput(), EYE);
      cam.handleResize(Number.POSITIVE_INFINITY);
      cam.handleResize(0);
      run(cam, ac, 0.5, 60);
      expect(Number.isFinite(cam.camera.position.x + cam.camera.position.y + cam.camera.position.z)).toBe(true);
      expect(Number.isFinite(cam.camera.quaternion.w)).toBe(true);
      expect(Number.isFinite(cam.camera.projectionMatrix.elements[0])).toBe(true);
    }
    expect(cam.camera.aspect).toBeCloseTo(1.6, 9);
  });

  it('one non-finite aircraft sample (pose, heading, velocity) does not break any mode for good', () => {
    for (const mode of ['cockpit', 'chase', 'external-orbit', 'drone', 'tower', 'flyby', 'wing'] as const) {
      const cam = new CameraController(1.6);
      const ac = new TestAircraft(0, 50);
      cam.setDroneFollow(true);
      cam.setMode(mode);
      run(cam, ac, 1, 60);
      const bad = new TestAircraft(0, 50);
      bad.pos.set(Number.NaN, 0, 0);
      bad.quat.set(Number.NaN, 0, 0, 1);
      bad.state.headingTrueRad = Number.NaN;
      bad.state.euler[0] = Number.NaN;
      bad.state.velNED[0] = Number.NaN;
      bad.state.loadFactor[2] = Number.NaN;
      cam.update(1 / 60, bad.state, bad.pos, bad.quat, makeInput(), EYE);
      run(cam, ac, 0.5, 60);
      const p = cam.camera.position, q = cam.camera.quaternion;
      expect(Number.isFinite(p.x + p.y + p.z), mode).toBe(true);
      expect(Number.isFinite(q.x + q.y + q.z + q.w), mode).toBe(true);
      expect(Number.isFinite(cam.camera.fov), mode).toBe(true);
    }
  });
});

describe('cockpit head model', () => {
  it('g bob: 2 cm per g of (nz − 1), head sinks under positive g, clamped to ±5 cm', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    run(cam, ac, 0.1, 60);
    ac.state.loadFactor[2] = 2;
    run(cam, ac, 3, 60);
    expect(cam.cockpit.headOffset.y).toBeCloseTo(-0.02, 4);
    ac.state.loadFactor[2] = 6;
    run(cam, ac, 3, 60);
    expect(cam.cockpit.headOffset.y).toBeCloseTo(-0.05, 4);
    ac.state.loadFactor[2] = -9;
    let max = 0;
    for (let i = 0; i < 180; i++) { run(cam, ac, 1 / 60, 60); max = Math.max(max, cam.cockpit.headOffset.y); }
    expect(max).toBeLessThanOrEqual(0.05 + 1e-12);
  });

  it('the head spring is underdamped (ζ ≈ 0.7): a g step overshoots slightly, then settles', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    run(cam, ac, 0.1, 120);
    ac.state.loadFactor[2] = 2;
    let min = 0;
    for (let i = 0; i < 240; i++) { run(cam, ac, 1 / 120, 120); min = Math.min(min, cam.cockpit.headOffset.y); }
    expect(min).toBeLessThan(-0.0202);
    expect(min).toBeGreaterThan(-0.0215);
  });

  it('recentre returns free-look to straight ahead smoothly', () => {
    const cam = new CameraController(1.6);
    const ac = new TestAircraft(0, 50);
    run(cam, ac, 0.5, 60, makeInput({}, { lookYaw: 1 }));
    expect(cam.state.lookYaw).toBeGreaterThan(0.5);
    cam.recentre();
    run(cam, ac, 0.05, 60);
    expect(cam.state.lookYaw).toBeGreaterThan(0.05);
    run(cam, ac, 1.5, 60);
    expect(cam.state.lookYaw).toBe(0);
  });
});
