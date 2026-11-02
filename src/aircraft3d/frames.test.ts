import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { qConj, qFromEuler } from '../core/math';
import type { Quat, Vec3 } from '../core/types';
import { bodyQuatToThree, bodyVecToThreeLocal, nedToThreeVec, threeLocalToBodyVec, threeQuatToBody, threeVecToNed } from './frames';

const D2R = Math.PI / 180;
/** qNB (NED→body) from Euler roll/pitch/yaw: qFromEuler gives q_bn, so conjugate. */
const qNBFromEuler = (roll: number, pitch: number, yaw: number): Quat => qConj(qFromEuler(roll, pitch, yaw)) as Quat;

const NOSE = new THREE.Vector3(0, 0, -1);
const RIGHT_WING = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

describe('bodyQuatToThree', () => {
  it('identity attitude keeps nose along −Z, up +Y, right wing +X', () => {
    const q = bodyQuatToThree([1, 0, 0, 0], new THREE.Quaternion());
    expect(NOSE.clone().applyQuaternion(q).z).toBeCloseTo(-1, 9);
    expect(UP.clone().applyQuaternion(q).y).toBeCloseTo(1, 9);
    expect(RIGHT_WING.clone().applyQuaternion(q).x).toBeCloseTo(1, 9);
  });

  it('pitch up 10° ⇒ nose direction has +y and still points north (−z)', () => {
    const q = bodyQuatToThree(qNBFromEuler(0, 10 * D2R, 0), new THREE.Quaternion());
    const nose = NOSE.clone().applyQuaternion(q);
    expect(nose.y).toBeCloseTo(Math.sin(10 * D2R), 6);
    expect(nose.z).toBeCloseTo(-Math.cos(10 * D2R), 6);
    expect(nose.x).toBeCloseTo(0, 9);
  });

  it('roll right 20° ⇒ right wing tip goes down (−y)', () => {
    const q = bodyQuatToThree(qNBFromEuler(20 * D2R, 0, 0), new THREE.Quaternion());
    const tip = RIGHT_WING.clone().applyQuaternion(q);
    expect(tip.y).toBeCloseTo(-Math.sin(20 * D2R), 6);
    expect(tip.x).toBeCloseTo(Math.cos(20 * D2R), 6);
  });

  it('heading 90° (east) ⇒ nose points +x', () => {
    const q = bodyQuatToThree(qNBFromEuler(0, 0, 90 * D2R), new THREE.Quaternion());
    const nose = NOSE.clone().applyQuaternion(q);
    expect(nose.x).toBeCloseTo(1, 6);
    expect(nose.y).toBeCloseTo(0, 9);
    expect(nose.z).toBeCloseTo(0, 6);
  });

  it('heading 180° ⇒ nose points +z (south), right wing points west (−x)', () => {
    const q = bodyQuatToThree(qNBFromEuler(0, 0, Math.PI), new THREE.Quaternion());
    expect(NOSE.clone().applyQuaternion(q).z).toBeCloseTo(1, 6);
    expect(RIGHT_WING.clone().applyQuaternion(q).x).toBeCloseTo(-1, 6);
  });

  it('combined attitude matches rotating body axes with the FDM quaternion (qRotate equivalence)', () => {
    // Body forward axis in NED is conj(qNB) ⊗ [1,0,0] ⊗ qNB. Compare with Three mapping of nose (−Z).
    const qNB = qNBFromEuler(30 * D2R, -15 * D2R, 220 * D2R);
    const q = bodyQuatToThree(qNB, new THREE.Quaternion());
    const noseThree = NOSE.clone().applyQuaternion(q);
    // Expected: body x in NED via q_bn
    const qbn = qConj(qNB);
    const w = qbn[0], x = qbn[1], y = qbn[2], z = qbn[3];
    // rotate [1,0,0] by qbn
    const nN = 1 - 2 * (y * y + z * z);
    const nE = 2 * (x * y + w * z);
    const nD = 2 * (x * z - w * y);
    const expected = nedToThreeVec([nN, nE, nD], new THREE.Vector3());
    expect(noseThree.distanceTo(expected)).toBeLessThan(1e-9);
  });

  it('round trip body → three → body is identity', () => {
    const qNB = qNBFromEuler(12 * D2R, -33 * D2R, 77 * D2R);
    const q = bodyQuatToThree(qNB, new THREE.Quaternion());
    const back = threeQuatToBody(q, [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(qNB[i], 12);
  });

  it('round trip three → body → three is identity', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 0.7));
    const body = threeQuatToBody(q, [0, 0, 0, 0]);
    const back = bodyQuatToThree(body, new THREE.Quaternion());
    expect(back.angleTo(q)).toBeLessThan(1e-9);
  });
});

describe('vector mappings', () => {
  it('body FRD offsets map to model-local nose −Z / up +Y / right +X', () => {
    const eye: Vec3 = [0.4, -0.25, -0.55]; // 0.4 fwd, 0.25 left, 0.55 up
    const v = bodyVecToThreeLocal(eye, new THREE.Vector3());
    expect(v.x).toBeCloseTo(-0.25);
    expect(v.y).toBeCloseTo(0.55);
    expect(v.z).toBeCloseTo(-0.4);
    const back = threeLocalToBodyVec(v, [0, 0, 0]);
    expect(back).toEqual(eye);
  });

  it('NED ↔ Three vectors', () => {
    const v = nedToThreeVec([100, 20, -5], new THREE.Vector3());
    expect([v.x, v.y, v.z]).toEqual([20, 5, -100]);
    expect(threeVecToNed(v, [0, 0, 0])).toEqual([100, 20, -5]);
  });
});
