/**
 * What the external-view HUD displays, extracted from the `SimSnapshot` once per update into a
 * reusable object. Unlike the cockpit instruments the HUD shows truth values (no gyro or pitot
 * errors); only airspeed and vertical speed get a short display lag so the digits stay readable
 * in turbulence.
 */
import { clamp, wrap360 } from '../../core/math';
import type { SimSnapshot } from '../../core/types';
import { M_TO_FT, MS_TO_FPM, MS_TO_KT, RAD } from '../../core/units';
import { Lag } from '../filters';

export interface HudValues {
  iasKt: number; gsKt: number; tasKt: number;
  /** barometric (indicated) altitude, ft */ altFt: number;
  aglFt: number; vsFpm: number;
  /** magnetic heading and heading bug, deg */ hdgDeg: number; bugDeg: number;
  throttle: number; mixture: number;
  flapsDeg: number; flapsIndex: number;
  /** mean gear extension 0 (up) .. 1 (down) */ gearExt: number;
  /** pitch trim −1 (nose down) .. +1 (nose up) */ trim: number;
  parkingBrake: boolean; braking: boolean;
  stall: boolean; overspeed: boolean; overG: boolean; flapOverspeed: boolean; gearOverspeed: boolean; lowFuel: boolean; crashed: boolean;
  paused: boolean; slew: boolean; onGround: boolean;
  /** terrain streaming progress 0..1 */ terrainReady: number;
  /** camera is in the cockpit (the flight data is then hidden by default) */ cockpit: boolean;
}

export function createHudValues(): HudValues {
  return {
    iasKt: 0, gsKt: 0, tasKt: 0, altFt: 0, aglFt: 0, vsFpm: 0, hdgDeg: 0, bugDeg: 0, throttle: 0, mixture: 1,
    flapsDeg: 0, flapsIndex: 0, gearExt: 1, trim: 0, parkingBrake: false, braking: false,
    stall: false, overspeed: false, overG: false, flapOverspeed: false, gearOverspeed: false, lowFuel: false, crashed: false,
    paused: false, slew: false, onGround: true, terrainReady: 1, cockpit: false,
  };
}

const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Display lags for the HUD readouts. */
export class HudSmoothing {
  readonly ias = new Lag(0.12);
  readonly vs = new Lag(0.6);
  private primed = false;

  /** Fill `out` from the snapshot, stepping the display lags by `dt`. */
  update(s: SimSnapshot, dt: number, out: HudValues): HudValues {
    const ac = s.aircraft, inp = s.inputs, w = ac.warnings;
    const iasKt = Math.max(0, fin(ac.aero.ias) * MS_TO_KT), vsFpm = fin(ac.verticalSpeedMs) * MS_TO_FPM;
    if (!this.primed) { this.ias.reset(iasKt); this.vs.reset(vsFpm); this.primed = true; }
    out.iasKt = Math.max(0, this.ias.step(iasKt, dt));
    out.vsFpm = this.vs.step(vsFpm, dt);
    out.gsKt = Math.max(0, fin(ac.groundSpeedMs) * MS_TO_KT);
    out.tasKt = Math.max(0, fin(ac.aero.tas) * MS_TO_KT);
    out.altFt = fin(ac.altitudeIndicatedM, fin(ac.altitudeMslM)) * M_TO_FT;
    out.aglFt = Math.max(0, fin(ac.altitudeAglM) * M_TO_FT);
    out.hdgDeg = wrap360(fin(ac.headingMagRad) * RAD);
    out.bugDeg = wrap360(fin(s.autopilot.headingBugDeg));
    out.throttle = clamp(fin(inp.throttle), 0, 1);
    out.mixture = clamp(fin(inp.mixture, 1), 0, 1);
    out.flapsDeg = fin(ac.surfaces.flapDeg);
    out.flapsIndex = inp.flapsIndex;
    let ext = 0;
    for (const g of ac.gear) ext += fin(g.extension, 1);
    out.gearExt = ac.gear.length ? ext / ac.gear.length : 1;
    out.trim = clamp(fin(inp.pitchTrim), -1, 1);
    out.parkingBrake = inp.parkingBrake;
    out.braking = Math.max(fin(inp.brakeLeft), fin(inp.brakeRight)) > 0.05;
    out.stall = w.stall || ac.aero.stallWarning;
    out.overspeed = w.overspeed; out.overG = w.overG; out.flapOverspeed = w.flapOverspeed; out.gearOverspeed = w.gearOverspeed;
    out.lowFuel = w.lowFuel; out.crashed = ac.crashed;
    out.paused = s.paused; out.slew = s.slew; out.onGround = ac.onGround;
    out.terrainReady = clamp(fin(s.terrainReady, 1), 0, 1);
    out.cockpit = s.camera.mode === 'cockpit';
    return out;
  }

  /** Snap the lags to the next snapshot (flight reset). */
  reset(): void { this.primed = false; }
}
