/**
 * Slew mode (MSFS "Y"): the flight model is frozen and the aircraft is moved directly by the
 * controls, to reposition it anywhere.
 *
 *   stick fore/aft (pitch axis)  move forward / back        (Numpad 8/2, arrows)
 *   stick left/right (roll axis) turn left / right
 *   pedals (yaw axis)            slide sideways
 *   throttle                     climb / descend: the lever is centred on entry, above 50 % climbs,
 *                                below 50 % descends (F2/F3 step it, F1/F4 go to the ends)
 *
 * Speeds grow with height above the ground, so taxi-scale moves are precise and cross-country
 * moves are fast. The aircraft never goes below its resting height on the gear.
 *
 * The controller keeps its pose as geodetic coordinates, so a floating-origin rebase needs no
 * special handling: the NED position is re-derived from the current frame every frame.
 */
import { clamp, qConj, qFromEuler, wrapPi, wrapTwoPi } from '../core/math';
import type { AircraftState, Geodetic, Quat, Vec3 } from '../core/types';
import type { LocalFrame } from '../geo/wgs84';

/** Ground "up" coordinate (−D) under a NED point of the current frame. */
export type GroundUpFn = (n: number, e: number) => number;

export interface SlewInputs { pitch: number; roll: number; yaw: number; throttle: number }

/** Throttle position that means "hold altitude" while slewing. */
export const SLEW_THROTTLE_CENTRE = 0.5;
const THROTTLE_DEADBAND = 0.04;
/** Max turn rate, rad/s. */
const MAX_TURN_RATE = 50 * Math.PI / 180;

/** Signed square: fine control near centre, full rate at the stops. */
const shape = (x: number): number => { const c = clamp(x, -1, 1); return c * Math.abs(c); };

/** Horizontal speed at full stick, m/s, for a height above ground. */
export function slewHorizontalSpeed(aglM: number): number { return clamp(15 + 0.6 * Math.max(aglM, 0), 15, 800); }
/** Vertical speed at full throttle deflection, m/s, for a height above ground. */
export function slewVerticalSpeed(aglM: number): number { return clamp(3 + 0.3 * Math.max(aglM, 0), 3, 200); }

export class SlewController {
  active = false;
  /** CG position */
  readonly geo: Geodetic = { lat: 0, lon: 0, alt: 0 };
  heading = 0;
  pitch = 0;
  roll = 0;
  /** CG height above the ground when the aircraft rests on its wheels */
  restAglM = 1.2;
  /** state at entry, used to restart the flight model on exit */
  entrySpeedMs = 0;
  engineRunning = false;
  entryThrottle = 0;
  /** last frame's motion (for the instruments) */
  groundSpeedMs = 0;
  verticalSpeedMs = 0;
  aglM = 0;

  private readonly ned: Vec3 = [0, 0, 0];
  private readonly qbn: Quat = [1, 0, 0, 0];
  private readonly zero: Vec3 = [0, 0, 0];
  private readonly geoOut: Geodetic = { lat: 0, lon: 0, alt: 0 };

  /** Start slewing from the current flight-model state. */
  enter(s: AircraftState, throttle: number, restAglM?: number): void {
    this.active = true;
    this.geo.lat = s.geo.lat; this.geo.lon = s.geo.lon; this.geo.alt = s.geo.alt;
    this.heading = s.headingTrueRad;
    this.pitch = s.euler[1];
    this.roll = s.euler[0];
    if (restAglM !== undefined) this.restAglM = restAglM;
    else if (s.onGround) this.restAglM = clamp(s.altitudeAglM, 0.3, 5);
    this.entrySpeedMs = s.aero.tas;
    this.engineRunning = s.engine.running;
    this.entryThrottle = throttle;
    this.groundSpeedMs = 0;
    this.verticalSpeedMs = 0;
    this.aglM = Math.max(0, s.altitudeAglM - this.restAglM);
  }

  exit(): void { this.active = false; }

  /** NED position of the CG in `frame` (reused array). */
  positionNED(frame: LocalFrame): Vec3 { return frame.geodeticToNED(this.geo.lat, this.geo.lon, this.geo.alt, this.ned); }

  /** Move by one display frame. `dt` in seconds; nothing moves while dt is 0 (paused). */
  update(dt: number, u: SlewInputs, frame: LocalFrame, groundUp: GroundUpFn): void {
    if (!this.active) return;
    const p = this.positionNED(frame);
    const floorUp = groundUp(p[0], p[1]) + this.restAglM;
    const agl = Math.max(0, -p[2] - floorUp);
    if (dt > 0) {
      const vh = slewHorizontalSpeed(agl);
      const fwd = -shape(u.pitch) * vh; // stick forward (pitch −1) moves forward
      const side = shape(u.yaw) * 0.5 * vh;
      this.heading = wrapPi(this.heading + shape(u.roll) * MAX_TURN_RATE * dt);
      const lever = (u.throttle - SLEW_THROTTLE_CENTRE) / (1 - SLEW_THROTTLE_CENTRE);
      const v = Math.abs(lever) < THROTTLE_DEADBAND ? 0 : shape((lever - Math.sign(lever) * THROTTLE_DEADBAND) / (1 - THROTTLE_DEADBAND));
      const climb = v * slewVerticalSpeed(agl);
      const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
      p[0] += (fwd * ch - side * sh) * dt;
      p[1] += (fwd * sh + side * ch) * dt;
      p[2] -= climb * dt;
      // terrain following: never below the resting height on the gear
      const floor = groundUp(p[0], p[1]) + this.restAglM;
      if (-p[2] < floor) p[2] = -floor;
      this.groundSpeedMs = Math.hypot(fwd, side);
      const g = frame.nedToGeodetic(p[0], p[1], p[2], this.geoOut);
      this.verticalSpeedMs = (g.alt - this.geo.alt) / dt;
      this.geo.lat = g.lat; this.geo.lon = g.lon; this.geo.alt = g.alt;
      this.aglM = Math.max(0, -p[2] - floor);
      // airborne: level the wings so the picture is calm; on the ground keep the resting attitude
      if (this.aglM > 2) { this.roll *= Math.exp(-dt / 0.5); this.pitch *= Math.exp(-dt / 0.5); }
    } else {
      this.groundSpeedMs = 0;
      this.verticalSpeedMs = 0;
      this.aglM = agl;
    }
  }

  /**
   * Write the slew pose into a display state. `out` must own its posNED/qNB/euler arrays (as the
   * interpolation buffer does); nested objects shared with the flight model are replaced, never
   * mutated.
   */
  writeState(out: AircraftState, frame: LocalFrame): void {
    const p = this.positionNED(frame);
    out.posNED[0] = p[0]; out.posNED[1] = p[1]; out.posNED[2] = p[2];
    const q = qFromEuler(this.roll, this.pitch, this.heading, this.qbn);
    qConj(q, out.qNB);
    out.euler[0] = this.roll; out.euler[1] = this.pitch; out.euler[2] = wrapPi(this.heading);
    const g = this.geoOut;
    g.lat = this.geo.lat; g.lon = this.geo.lon; g.alt = this.geo.alt;
    out.geo = g;
    const decl = out.headingTrueRad - out.headingMagRad;
    out.headingTrueRad = wrapTwoPi(this.heading);
    out.headingMagRad = wrapTwoPi(this.heading - decl);
    out.trackRad = out.headingTrueRad;
    out.groundSpeedMs = this.groundSpeedMs;
    out.verticalSpeedMs = this.verticalSpeedMs;
    out.altitudeIndicatedM += this.geo.alt - out.altitudeMslM;
    out.altitudeMslM = this.geo.alt;
    out.altitudeAglM = this.aglM + this.restAglM;
    out.velNED = this.zero;
    out.velBody = this.zero;
    out.rates = this.zero;
    out.onGround = this.aglM < 0.05;
  }
}
