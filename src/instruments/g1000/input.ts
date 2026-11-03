/**
 * The G1000's pure input API (no DOM): bezel softkeys, hard keys and concentric knobs, the
 * requests it sends to systems it does not own (radios, autopilot, altimeter, transponder) and
 * the conversion of mouse-wheel deltas into knob detents.
 *
 * Knob convention: positive steps turn clockwise (increase); a wheel scrolled up (deltaY < 0)
 * turns clockwise. Dual knobs have an `inner` and an `outer` ring.
 */
import type { SimAction } from '../../core/types';
import type { CdiSource } from './palette';

export type G1000Display = 'pfd' | 'mfd';

/** Hard keys of the GDU bezel (NRST is not a bezel key on the 172's GDUs; it is API/keyboard only). */
export type G1000Button =
  | 'DIRECT' | 'MENU' | 'FPL' | 'PROC' | 'CLR' | 'ENT' | 'NRST'
  | 'NAV_SWAP' | 'COM_SWAP'
  | 'AP' | 'FD' | 'HDG' | 'ALT' | 'NAV' | 'VNV' | 'APR' | 'BC' | 'VS' | 'FLC' | 'NOSE_UP' | 'NOSE_DN';

/** Knobs of the GDU bezel. NAV, COM, ALT, CRS_BARO and FMS are dual (inner + outer ring). */
export type G1000Knob = 'NAV_VOL' | 'NAV' | 'HDG' | 'ALT' | 'COM_VOL' | 'COM' | 'CRS_BARO' | 'RANGE' | 'FMS';

export type KnobRing = 'inner' | 'outer';

export const DUAL_KNOBS: ReadonlySet<G1000Knob> = new Set<G1000Knob>(['NAV', 'COM', 'ALT', 'CRS_BARO', 'FMS']);

/** One user input. `display` defaults to the MFD for keys/knobs and to the editing display for chars. */
export type G1000Input =
  | { type: 'softkey'; display: G1000Display; index: number }
  | { type: 'button'; display?: G1000Display; id: G1000Button }
  /** turn by whole detents; `ring` defaults to inner (single knobs ignore it) */
  | { type: 'knob'; display?: G1000Display; id: G1000Knob; ring?: KnobRing; steps: number }
  | { type: 'push'; display?: G1000Display; id: G1000Knob }
  /** raw wheel event; accumulated into detents (see {@link WheelAccumulator}) */
  | { type: 'wheel'; display?: G1000Display; id: G1000Knob; ring?: KnobRing; deltaY: number; deltaMode?: number }
  /** typed character for ident entry: A–Z, 0–9, '\b' (backspace) */
  | { type: 'char'; display?: G1000Display; char: string };

/**
 * Requests for systems outside the instruments. Delivered through `G1000Options.onCommand`, or
 * queued for {@link G1000.takeCommands} when no callback is set.
 */
export type G1000Command =
  /** set the NAV standby frequency (kHz) */
  | { kind: 'navStandby'; radio: 1 | 2; kHz: number }
  /** set the NAV active frequency (kHz) — approach loading */
  | { kind: 'navActive'; radio: 1 | 2; kHz: number }
  | { kind: 'navSwap'; radio: 1 | 2 }
  /** selected course (OBS) of a NAV receiver, deg magnetic */
  | { kind: 'navCourse'; radio: 1 | 2; courseDeg: number }
  /** COM standby (kHz); the G1000's own `com1`/`com2` already show it */
  | { kind: 'comStandby'; radio: 1 | 2; kHz: number }
  | { kind: 'comSwap'; radio: 1 | 2 }
  /** the CDI source changed: the autopilot's NAV/APR modes follow it (`navSource` for `setNavSource`) */
  | { kind: 'cdiSource'; source: CdiSource; navSource: 'gps' | 'nav1' | 'nav2' }
  /** a simulator action, `count` times (AFCS keys, HDG/ALT/BARO knobs) */
  | { kind: 'action'; action: SimAction; count: number }
  /** STD BARO: set the altimeter to 29.92 inHg / 1013 hPa */
  | { kind: 'baroStd' }
  /** transponder code / mode / IDENT changed */
  | { kind: 'xpdr'; code: number; mode: string; ident: boolean };

/** Wheel distance of one detent per `WheelEvent.deltaMode` (pixels, lines, pages). */
export const WHEEL_DETENT = Object.freeze([100, 3, 1] as const);
/** A single wheel event of at least this fraction of a detent always turns one detent. */
export const WHEEL_MIN_FRACTION = 0.3;
/** At most this many detents from one wheel event. */
export const WHEEL_MAX_STEPS = 10;

/**
 * Converts wheel deltas into knob detents. Fractional deltas (trackpads, high-resolution wheels)
 * accumulate per control; a classic notch (100 px in Chromium, 3 lines in Firefox) is one detent,
 * and a single event worth ≥ 0.3 detent always turns one, so slow scrolling never feels dead.
 * Scrolling up (negative deltaY) is clockwise (+).
 */
export class WheelAccumulator {
  private key = '';
  private acc = 0;

  /** Detents for a wheel event over control `key` (positive = clockwise). */
  steps(key: string, deltaY: number, deltaMode = 0): number {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    if (key !== this.key) { this.key = key; this.acc = 0; }
    const unit = WHEEL_DETENT[deltaMode === 1 || deltaMode === 2 ? deltaMode : 0];
    const d = -deltaY / unit;
    // reversing direction drops what was left over the other way
    if (this.acc !== 0 && Math.sign(this.acc) !== Math.sign(d)) this.acc = 0;
    this.acc += d;
    let n = Math.trunc(this.acc);
    if (n === 0 && Math.abs(d) >= WHEEL_MIN_FRACTION) n = Math.sign(d);
    this.acc = n !== 0 && Math.abs(this.acc) < 1 ? 0 : this.acc - n;
    return Math.max(-WHEEL_MAX_STEPS, Math.min(WHEEL_MAX_STEPS, n));
  }

  reset(): void { this.key = ''; this.acc = 0; }
}

/** The `navSource` value the autopilot expects for a CDI source. */
export const navSourceFor = (src: CdiSource): 'gps' | 'nav1' | 'nav2' => (src === 'GPS' ? 'gps' : src === 'NAV1' ? 'nav1' : 'nav2');
