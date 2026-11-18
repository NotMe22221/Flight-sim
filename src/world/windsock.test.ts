import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Windsock, windsockDroopRad, yawForBearingRad } from './windsock';

const KT = 0.514444;

/** world direction the sock's tail points, as a true bearing (deg) and elevation (deg) */
function tail(w: Windsock): { bearing: number; elev: number } {
  w.group.updateMatrixWorld(true);
  const droop = (w.group.children[1] as THREE.Group).children[0];
  const a = new THREE.Vector3(0, 0, 0).applyMatrix4(droop.matrixWorld), b = new THREE.Vector3(1, 0, 0).applyMatrix4(droop.matrixWorld);
  const d = b.sub(a);
  // render frame: x east, y up, z south
  return { bearing: ((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) % 360, elev: (Math.asin(d.y) * 180) / Math.PI };
}

describe('Windsock', () => {
  it('droops in calm air, streams level at 15 kt', () => {
    expect(windsockDroopRad(0) * 180 / Math.PI).toBeCloseTo(80);
    expect(windsockDroopRad(15 * KT)).toBe(0);
    expect(windsockDroopRad(5 * KT)).toBeGreaterThan(windsockDroopRad(10 * KT));
  });

  it('points downwind: a wind from 270° streams the sock toward 090°', () => {
    const w = new Windsock(new THREE.Vector3());
    // wind from the west blows east: velocity (N 0, E +10 m/s)
    for (let i = 0; i < 300; i++) w.update(0.05, 0, 10);
    const t = tail(w);
    expect(Math.abs(t.bearing - 90)).toBeLessThan(6);
    expect(t.elev).toBeGreaterThan(-8); // near level (flutter only)
    // calm: hangs down
    for (let i = 0; i < 300; i++) w.update(0.05, 0, 0);
    expect(tail(w).elev).toBeLessThan(-70);
  });

  it('a wind from 360° streams it south', () => {
    const w = new Windsock(new THREE.Vector3());
    for (let i = 0; i < 300; i++) w.update(0.05, -6, 0);
    expect(Math.abs(tail(w).bearing - 180)).toBeLessThan(6);
    expect(yawForBearingRad(Math.PI / 2)).toBeCloseTo(0);
  });
});
