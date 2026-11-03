/** Flat-ground Environment for flight-model tests (no curvature, constant wind). */
import type { Environment, LocalFrameInfo, TurbulenceIntensity, Vec3 } from '../core/types';

export interface FlatEnvOptions {
  /** ground elevation (geodetic), m */
  groundAltM?: number;
  /** wind velocity NED (direction the air moves toward), m/s */
  windNED?: Vec3;
  turbulence?: { w20Kt: number; intensity: TurbulenceIntensity; seed: number };
  deltaTisaK?: number;
  qnhPa?: number;
  surface?: Environment['surface'];
  /** optional slope: ground rises toward +north at this gradient (m/m) */
  slopeNorth?: number;
}

export function flatEnvironment(frame: LocalFrameInfo, o: FlatEnvOptions = {}): Environment {
  const g = (o.groundAltM ?? 0) - frame.alt0;
  const wind: Vec3 = o.windNED ?? [0, 0, 0];
  const slope = o.slopeNorth ?? 0;
  const nlen = Math.hypot(slope, 1);
  return {
    frame,
    groundHeight: (n: number) => g + slope * n,
    groundNormal: (_n: number, _e: number, out: Vec3) => { out[0] = -slope / nlen; out[1] = 0; out[2] = -1 / nlen; return out; },
    windNED: (_n: number, _e: number, _d: number, out: Vec3) => { out[0] = wind[0]; out[1] = wind[1]; out[2] = wind[2]; return out; },
    turbulence: o.turbulence ?? { w20Kt: 0, intensity: 0, seed: 1 },
    deltaTisaK: o.deltaTisaK ?? 0,
    qnhPa: o.qnhPa ?? 101325,
    surface: o.surface ?? 'paved',
  };
}
