/**
 * Wing camera: fixed to the airframe above the left wing root, looking at the cabin and nose.
 * Fully follows the attitude (up = aircraft up).
 */
import * as THREE from 'three';
import type { CameraFrame, CameraModeHandler } from '../types';

export class WingMode implements CameraModeHandler {
  private readonly offsetLocal = new THREE.Vector3(-4.0, 1.5, 0.6);
  private readonly lookLocal = new THREE.Vector3(0.3, 0.4, -1.0);
  private readonly target = new THREE.Vector3();

  enter(): void { /* nothing to initialise */ }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    camera.position.copy(this.offsetLocal).applyQuaternion(frame.quat).add(frame.pos);
    this.target.copy(this.lookLocal).applyQuaternion(frame.quat).add(frame.pos);
    camera.up.copy(frame.up);
    camera.lookAt(this.target);
    return undefined;
  }
}
