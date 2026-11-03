/**
 * Keyboard-synthesised axes (§B3): a "virtual stick" per axis that ramps while a direction
 * key is held and returns to centre when released, so discrete keys never step the control.
 */
import { clamp } from '../core/math';

export interface KeyAxisTuning {
  /** seconds from centre to full deflection while a key is held (default 0.6) */
  rampTime: number;
  /** seconds from full deflection back to centre after release (default 0.3) */
  centreTime: number;
  /** immediate step applied on a fresh press (default 0 — pure ramp) */
  tapStep: number;
  /** return to centre on release; false = "sticky" keyboard axis */
  autoCentre: boolean;
  /** lower bound of the axis (−1 bipolar, 0 for brakes) */
  min: number;
  /** upper bound of the axis */
  max: number;
}

export const STICK_KEY_TUNING: Readonly<KeyAxisTuning> = { rampTime: 0.6, centreTime: 0.3, tapStep: 0, autoCentre: true, min: -1, max: 1 };
/** Brake keys: full in 0.25 s, release in ~0.17 s (§B3). */
export const BRAKE_KEY_TUNING: Readonly<KeyAxisTuning> = { rampTime: 0.25, centreTime: 1 / 6, tapStep: 0, autoCentre: true, min: 0, max: 1 };
/** Look keys: snappy. */
export const LOOK_KEY_TUNING: Readonly<KeyAxisTuning> = { rampTime: 0.15, centreTime: 0.1, tapStep: 0, autoCentre: true, min: -1, max: 1 };

const EPS = 1e-9;

/**
 * One keyboard axis. Call `setDirection` from key state each frame (or on change) and
 * `step(dt)` once per poll. Linear ramps; a reversal first returns to centre at the
 * (faster) centring rate, then ramps out at the ramp rate.
 */
export class KeyAxis {
  /** current value */
  value = 0;
  private dir = 0;
  private prevDir = 0;
  /** keyboard sensitivity multiplier on the ramp rate (0.5..2) */
  sensitivity = 1;

  constructor(public tuning: KeyAxisTuning = { ...STICK_KEY_TUNING }) {}

  /** −1, 0 or +1: which way the held key(s) push the axis. */
  setDirection(dir: number): void { this.dir = dir > 0 ? 1 : dir < 0 ? -1 : 0; }

  /** Current held direction. */
  get direction(): number { return this.dir; }

  /** Jumps to a value (e.g. "centre controls"). */
  set(v: number): void { this.value = clamp(v, this.tuning.min, this.tuning.max); }

  /** Advances the ramp by dt seconds and returns the new value. */
  step(dt: number): number {
    const t = this.tuning;
    const rampRate = (1 / Math.max(1e-3, t.rampTime)) * this.sensitivity;
    const centreRate = 1 / Math.max(1e-3, t.centreTime);
    let v = this.value;
    if (this.dir !== 0) {
      if (this.prevDir !== this.dir && t.tapStep > 0) v += this.dir * t.tapStep;
      const target = this.dir > 0 ? t.max : t.min;
      // moving back towards centre (reversal) uses the faster of the two rates
      const towardsCentre = (v > 0 && this.dir < 0) || (v < 0 && this.dir > 0);
      const rate = towardsCentre ? Math.max(rampRate, centreRate) : rampRate;
      v += this.dir * rate * dt;
      if (towardsCentre && Math.sign(v) === this.dir) {
        // crossed centre: spend the remainder at the ramp rate (exact enough for one frame)
        v = this.dir * Math.abs(v) * (rampRate / rate);
      }
      if ((this.dir > 0 && v >= target - EPS) || (this.dir < 0 && v <= target + EPS)) v = target;
    } else if (t.autoCentre && v !== 0) {
      const d = centreRate * dt;
      v = Math.abs(v) <= d + EPS ? 0 : v - Math.sign(v) * d;
    }
    this.prevDir = this.dir;
    this.value = clamp(v, t.min, t.max);
    return this.value;
  }

  /** Releases and recentres immediately (focus loss). */
  reset(): void { this.value = 0; this.dir = 0; this.prevDir = 0; }
}

// ───────────────────────────────── Hold / repeat tracking ─────────────────────────────────

export interface RepeatTuning {
  /** delay before the first repeat, s (default 0.3) */
  delay: number;
  /** repeat rate, Hz (default 10) */
  rate: number;
  /** for 'knob' actions: hold time after which the rate doubles, s (default 1.0) */
  accelAfter: number;
  /** accelerated rate, Hz (default 20) */
  accelRate: number;
  /** cap on repeats emitted in one poll (long frames) */
  maxPerPoll: number;
}

export const DEFAULT_REPEAT: Readonly<RepeatTuning> = { delay: 0.3, rate: 10, accelAfter: 1.0, accelRate: 20, maxPerPoll: 4 };

/** How an action behaves while held. */
export interface HoldSpec {
  repeat: 'none' | 'step' | 'knob';
  held: boolean;
}

interface HoldState<A> {
  action: A;
  /** number of physical inputs currently holding this action */
  count: number;
  /** pressed since the last poll and not yet reported */
  fresh: boolean;
  /** was held at some point since the last poll (taps shorter than a frame still count) */
  latched: boolean;
  holdTime: number;
  nextRepeat: number;
  spec: HoldSpec;
}

/**
 * Tracks press/release of actions from one device, producing edge events on the first
 * press, auto-repeats while held (from poll time, never from OS key repeat) and the held
 * level set. Press/release may happen between polls; `poll` reports them deterministically.
 */
export class HoldTracker<A extends string> {
  private states = new Map<A, HoldState<A>>();
  /** same states as an array so poll() iterates without allocating */
  private list: HoldState<A>[] = [];
  repeat: RepeatTuning;

  constructor(private specOf: (a: A) => HoldSpec, repeat: Partial<RepeatTuning> = {}) {
    this.repeat = { ...DEFAULT_REPEAT, ...repeat };
  }

  /** A physical input bound to `action` went down. */
  press(action: A): void {
    let s = this.states.get(action);
    if (!s) {
      s = { action, count: 0, fresh: false, latched: false, holdTime: 0, nextRepeat: 0, spec: this.specOf(action) };
      this.states.set(action, s);
      this.list.push(s);
    }
    s.count++;
    if (s.count === 1) { s.fresh = true; s.latched = true; s.holdTime = 0; s.nextRepeat = this.repeat.delay; }
  }

  /** A physical input bound to `action` went up. */
  release(action: A): void {
    const s = this.states.get(action);
    if (s && s.count > 0) s.count--;
  }

  /** Releases everything (focus loss). Pending edges are dropped too. */
  releaseAll(): void {
    for (let i = 0; i < this.list.length; i++) { const s = this.list[i]; s.count = 0; s.fresh = false; s.latched = false; }
  }

  /** True while any input holds the action. */
  isHeld(action: A): boolean { return (this.states.get(action)?.count ?? 0) > 0; }

  /**
   * Advances repeat timers and reports: `emit(action)` for each edge/repeat (in order),
   * `hold(action)` for every action held during this poll interval.
   */
  poll(dt: number, emit: (a: A) => void, hold: (a: A) => void): void {
    const r = this.repeat;
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i];
      // hold time starts at the poll that reports the edge, so the first repeat comes `delay` after it
      const edge = s.fresh;
      if (edge) { s.fresh = false; emit(s.action); }
      if (s.count > 0 || s.latched) hold(s.action);
      s.latched = s.count > 0;
      if (s.count === 0 || s.spec.repeat === 'none') continue;
      if (!edge) s.holdTime += dt;
      let n = 0;
      while (s.holdTime >= s.nextRepeat - 1e-9 && n < r.maxPerPoll) {
        emit(s.action);
        n++;
        const accel = s.spec.repeat === 'knob' && s.nextRepeat >= r.accelAfter;
        s.nextRepeat += 1 / (accel ? r.accelRate : r.rate);
      }
      if (n === r.maxPerPoll && s.holdTime > s.nextRepeat) s.nextRepeat = s.holdTime; // drop the backlog
    }
  }
}
