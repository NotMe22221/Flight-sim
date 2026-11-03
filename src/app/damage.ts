/**
 * MSFS "Failure & damage" assists around the flight model.
 *
 * - Crash damage off: the flight model's crash (gear collapse, prop strike, water, impact) is
 *   cleared at once and the aircraft carries on, as with MSFS crash detection disabled. A
 *   numerical failure is never cleared.
 * - Stress damage on: sustained overspeed (> 1.1 Vne for 1 s) or an airborne load factor beyond
 *   the ultimate load (1.5 x the limit load factor, for 0.1 s) breaks the airframe.
 */
import type { AircraftConfig, AircraftState } from '../core/types';
import { KT } from '../core/units';

/** Crash reasons that must never be cleared by the crash-damage assist. */
const UNRECOVERABLE = new Set(['numerical instability']);

export function crashIsRecoverable(reason: string): boolean { return !UNRECOVERABLE.has(reason); }

export class StressMonitor {
  private overspeedS = 0;
  private overGS = 0;

  reset(): void { this.overspeedS = 0; this.overGS = 0; }

  /** Call after each physics step; returns a structural-failure reason, or null. */
  check(h: number, s: AircraftState, limits: AircraftConfig['limits']): string | null {
    const vne = limits.VneKt * KT;
    this.overspeedS = s.aero.ias > 1.1 * vne ? this.overspeedS + h : 0;
    if (this.overspeedS >= 1) return 'structural failure: overspeed';
    const nz = s.loadFactor[2];
    const airborne = !s.onGround && s.altitudeAglM > 3;
    const beyond = airborne && (nz > 1.5 * limits.nzMax || nz < 1.5 * limits.nzMin);
    this.overGS = beyond ? this.overGS + h : 0;
    if (this.overGS >= 0.1) return `structural failure: ${nz > 0 ? 'over-G' : 'negative G'}`;
    return null;
  }
}
