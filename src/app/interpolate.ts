/**
 * Render-side interpolation of the aircraft state between two physics steps.
 * Only the pose (position, attitude) and a few smooth scalars are interpolated; everything
 * else is taken from the newest state.
 */
import { lerp, qSlerp } from '../core/math';
import type { AircraftState } from '../core/types';

/** Deep-copy the fields that interpolation needs (pose + smooth scalars). Cheap; no nested object allocation. */
export function copyPose(src: AircraftState, dst: AircraftState): void {
  dst.posNED[0] = src.posNED[0]; dst.posNED[1] = src.posNED[1]; dst.posNED[2] = src.posNED[2];
  dst.qNB[0] = src.qNB[0]; dst.qNB[1] = src.qNB[1]; dst.qNB[2] = src.qNB[2]; dst.qNB[3] = src.qNB[3];
  dst.euler[0] = src.euler[0]; dst.euler[1] = src.euler[1]; dst.euler[2] = src.euler[2];
  dst.altitudeMslM = src.altitudeMslM;
  dst.altitudeAglM = src.altitudeAglM;
  dst.engine.rpm = src.engine.rpm;
  dst.surfaces.elevatorRad = src.surfaces.elevatorRad;
  dst.surfaces.aileronLeftRad = src.surfaces.aileronLeftRad;
  dst.surfaces.aileronRightRad = src.surfaces.aileronRightRad;
  dst.surfaces.rudderRad = src.surfaces.rudderRad;
  dst.surfaces.flapDeg = src.surfaces.flapDeg;
  for (let i = 0; i < src.gear.length && i < dst.gear.length; i++) dst.gear[i].compressionM = src.gear[i].compressionM;
}

/**
 * Write into `out` the state interpolated between `prev` and `cur` by `alpha` (0 = prev, 1 = cur).
 * `out` keeps its own posNED/qNB/euler arrays (allocation-free after the first call); every other
 * field is a shallow reference into `cur`, so callers must not mutate nested objects of `out`.
 */
export function interpolateState(prev: AircraftState, cur: AircraftState, alpha: number, out: AircraftState): void {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  // keep out's own pose arrays (allocated once), then shallow-copy everything else from cur
  let pos = out.posNED, q = out.qNB, eu = out.euler;
  if (pos === cur.posNED) pos = [0, 0, 0];
  if (q === cur.qNB) q = [1, 0, 0, 0];
  if (eu === cur.euler) eu = [0, 0, 0];
  Object.assign(out, cur);
  out.posNED = pos; out.qNB = q; out.euler = eu;
  pos[0] = lerp(prev.posNED[0], cur.posNED[0], a);
  pos[1] = lerp(prev.posNED[1], cur.posNED[1], a);
  pos[2] = lerp(prev.posNED[2], cur.posNED[2], a);
  qSlerp(prev.qNB, cur.qNB, a, q);
  // Euler: interpolate roll/pitch linearly, yaw along the shortest arc
  eu[0] = lerp(prev.euler[0], cur.euler[0], a);
  eu[1] = lerp(prev.euler[1], cur.euler[1], a);
  let dyaw = cur.euler[2] - prev.euler[2];
  if (dyaw > Math.PI) dyaw -= 2 * Math.PI; else if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  eu[2] = prev.euler[2] + dyaw * a;
  out.altitudeMslM = lerp(prev.altitudeMslM, cur.altitudeMslM, a);
  out.altitudeAglM = lerp(prev.altitudeAglM, cur.altitudeAglM, a);
}
