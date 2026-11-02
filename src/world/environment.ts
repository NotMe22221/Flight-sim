/**
 * Adapter that presents terrain, wind and atmosphere to the flight model through the
 * `Environment` contract. The World owns one instance and keeps it pointed at the current
 * LocalFrame; terrain and weather systems plug in via callbacks so this file stays free of Three.js.
 */
import type { Environment, LocalFrameInfo, TurbulenceIntensity, Vec3 } from '../core/types';

export interface EnvironmentSources {
  /** ground height (local up, m) at a NED position, or null when no data is loaded */
  groundHeight(north: number, east: number): number | null;
  /** NED unit normal at a NED position, or null */
  groundNormal?(north: number, east: number, out: Vec3): Vec3 | null;
  /** wind velocity NED (m/s) at a NED position */
  windNED?(north: number, east: number, down: number, out: Vec3): Vec3;
  surface?(north: number, east: number): Environment['surface'];
}

export class SimEnvironment implements Environment {
  frame: LocalFrameInfo;
  turbulence: { w20Kt: number; intensity: TurbulenceIntensity; seed: number } = { w20Kt: 0, intensity: 0, seed: 1 };
  deltaTisaK = 0;
  qnhPa = 101325;
  surface: Environment['surface'] = 'paved';
  /** fallback ground height (local up) used before terrain data arrives, e.g. the spawn runway elevation */
  fallbackGroundUp = 0;
  private lastGoodHeight: number | null = null;

  constructor(frame: LocalFrameInfo, private sources: EnvironmentSources) {
    this.frame = frame;
  }

  setSources(sources: EnvironmentSources): void { this.sources = sources; }

  /** Call on floating-origin rebase: ground heights are relative to the frame's alt0. */
  setFrame(frame: LocalFrameInfo, fallbackGroundUp: number): void {
    this.frame = frame;
    this.fallbackGroundUp = fallbackGroundUp;
    this.lastGoodHeight = null;
  }

  groundHeight(north: number, east: number): number {
    const h = this.sources.groundHeight(north, east);
    if (h !== null && Number.isFinite(h)) { this.lastGoodHeight = h; return h; }
    return this.lastGoodHeight ?? this.fallbackGroundUp;
  }

  groundNormal(north: number, east: number, out: Vec3): Vec3 {
    const n = this.sources.groundNormal?.(north, east, out);
    if (n && Number.isFinite(n[0]) && Number.isFinite(n[1]) && Number.isFinite(n[2])) return n;
    out[0] = 0; out[1] = 0; out[2] = -1;
    return out;
  }

  windNED(north: number, east: number, down: number, out: Vec3): Vec3 {
    if (this.sources.windNED) return this.sources.windNED(north, east, down, out);
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }
}
