/**
 * Reference wiring of `G1000Command`s onto the simulator's systems, written against structural
 * interfaces (no `src/app` import): the integrator passes the radio stack's tuning objects, the
 * autopilot's `setNavSource` and its own action handler. See README "G1000 interaction".
 */
import type { SimAction } from '../../core/types';
import type { G1000Command } from './input';

/** A NAV receiver's tuning, as in `RadioStack.tuning[i]` (kHz, OBS deg magnetic). */
export interface NavTuningLike { activeKHz: number; standbyKHz: number; obsDeg: number }

/** What the G1000's requests act on. Every member is optional; missing ones ignore their commands. */
export interface G1000Host {
  /** NAV1 / NAV2 tuning (`sim.radios.tuning`) */
  navTuning?: readonly [NavTuningLike, NavTuningLike];
  /** retune an active NAV frequency with an immediate station lookup (`sim.radios.tuneNav`) */
  tuneNavActive?(index: 0 | 1, kHz: number): void;
  /** COM1 in MHz (`sim.radios.state.com1`); COM2 exists only on the G1000 */
  com1?: { activeMHz: number; standbyMHz: number };
  /** the autopilot's NAV/APR source (`sim.autopilot.setNavSource`) */
  setNavSource?(src: 'gps' | 'nav1' | 'nav2'): void;
  /** a discrete simulator action (`sim.handleAction`) */
  action?(a: SimAction): void;
  /** set the altimeter to standard pressure (`sim.fdm.setAltimeter(101325)`) */
  setAltimeterStd?(): void;
  /** transponder state for ATC, optional */
  transponder?(code: number, mode: string, ident: boolean): void;
}

const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

/** Apply one command; returns false when the host has nothing to apply it to. */
export function applyG1000Command(c: G1000Command, host: G1000Host): boolean {
  const nav = host.navTuning;
  switch (c.kind) {
    case 'navStandby': if (!nav) return false; nav[c.radio - 1].standbyKHz = c.kHz; return true;
    case 'navActive':
      if (host.tuneNavActive) host.tuneNavActive((c.radio - 1) as 0 | 1, c.kHz);
      else if (nav) nav[c.radio - 1].activeKHz = c.kHz;
      else return false;
      return true;
    case 'navSwap': {
      if (!nav) return false;
      const t = nav[c.radio - 1], a = t.activeKHz;
      if (host.tuneNavActive) host.tuneNavActive((c.radio - 1) as 0 | 1, t.standbyKHz); else t.activeKHz = t.standbyKHz;
      t.standbyKHz = a;
      return true;
    }
    case 'navCourse': if (!nav) return false; nav[c.radio - 1].obsDeg = wrap360(c.courseDeg); return true;
    case 'comStandby': if (!host.com1 || c.radio !== 1) return false; host.com1.standbyMHz = c.kHz / 1000; return true;
    case 'comSwap': {
      if (!host.com1 || c.radio !== 1) return false;
      const k = host.com1, a = k.activeMHz;
      k.activeMHz = k.standbyMHz; k.standbyMHz = a;
      return true;
    }
    case 'cdiSource': if (!host.setNavSource) return false; host.setNavSource(c.navSource); return true;
    case 'action': if (!host.action) return false; for (let i = 0; i < c.count; i++) host.action(c.action); return true;
    case 'baroStd': if (!host.setAltimeterStd) return false; host.setAltimeterStd(); return true;
    case 'xpdr': if (!host.transponder) return false; host.transponder(c.code, c.mode, c.ident); return true;
  }
  return false;
}

/** Mirror the radio stack's COM1 (MHz) into the G1000's COM1 box (kHz), e.g. after ATC retunes it. */
export function syncCom1(target: { activeKHz: number; standbyKHz: number }, com1: { activeMHz: number; standbyMHz: number }): void {
  target.activeKHz = Math.round(com1.activeMHz * 1000);
  target.standbyKHz = Math.round(com1.standbyMHz * 1000);
}
