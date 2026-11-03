/**
 * Test harness: drives an `AtcController` with a fake aircraft that moves in straight segments
 * expressed in a runway frame (along / cross / height), records every transmission, option
 * list and phase change with its sim time, and selects options by label.
 */
import type { AircraftState, Geodetic, WeatherState } from '../../core/types';
import { makeAircraftState } from '../../core/fakeState';
import { DEG, RAD } from '../../core/units';
import { destinationPoint } from '../../geo/wgs84';
import { AtcController } from '../AtcController';
import type { RadioMessage, RadioVoice } from '../radio';
import type { AtcPhase } from '../types';
import type { NavDatabase } from '../../core/types';

export interface LoggedMessage extends RadioMessage { t: number }
export interface LoggedSpeech { t: number; text: string; voice: RadioVoice }
export interface Point { along: number; cross: number; h: number }

/** Runway frame for positioning: threshold, true heading, threshold elevation. */
export interface Frame { threshold: Geodetic; headingDeg: number; elevationM: number }

export class Harness {
  t = 0;
  readonly messages: LoggedMessage[] = [];
  readonly speech: LoggedSpeech[] = [];
  readonly optionLists: { t: number; options: string[] }[] = [];
  readonly phases: AtcPhase[] = [];
  updates = 0;
  emptyOptionFrames = 0;
  readonly atc: AtcController;
  pos: Point;
  private onGround = true;
  private engineRunning = false;
  private gs = 0;
  private vs = 0;
  private trackDeg: number;

  constructor(nav: NavDatabase, private readonly weather: WeatherState, private readonly frame: Frame, start: Point, utcMs: number) {
    this.trackDeg = frame.headingDeg;
    this.pos = { ...start };
    this.atc = new AtcController({
      callsign: 'N172FS', aircraftType: 'Cessna', nav, utcMs,
      emit: (m) => this.messages.push({ ...m, t: this.t }),
      speak: (text, voice) => this.speech.push({ t: this.t, text, voice }),
      emitOptions: (options) => this.optionLists.push({ t: this.t, options }),
    });
  }

  /** Geodetic position of a frame point. */
  geo(p: Point): Geodetic {
    const f = this.frame;
    const a = destinationPoint(f.threshold, f.headingDeg, p.along, f.elevationM + p.h);
    return p.cross === 0 ? a : destinationPoint(a, f.headingDeg + 90, p.cross, f.elevationM + p.h);
  }

  state(): AircraftState {
    const geo = this.geo(this.pos);
    const base = makeAircraftState();
    return makeAircraftState({
      t: this.t, geo, altitudeMslM: geo.alt, altitudeAglM: this.pos.h, altitudeIndicatedM: geo.alt,
      onGround: this.onGround, groundSpeedMs: this.gs, verticalSpeedMs: this.vs,
      trackRad: this.trackDeg * DEG, headingTrueRad: this.trackDeg * DEG, euler: [0, 0, this.trackDeg * DEG],
      engine: { ...base.engine, running: this.engineRunning, rpm: this.engineRunning ? 2300 : 0 },
    });
  }

  /** One controller update of `dt` seconds with the current kinematic state. */
  tick(dt = 0.1): void {
    this.t = Math.round((this.t + dt) * 1000) / 1000;
    this.atc.update(dt, this.state(), this.weather);
    this.updates++;
    if (this.atc.options.length === 0) this.emptyOptionFrames++;
    this.recordPhase();
  }

  private recordPhase(): void {
    const p = this.atc.phase;
    if (this.phases[this.phases.length - 1] !== p) this.phases.push(p);
  }

  /** Hold still (or keep the current velocities if `moving`) for `seconds`. */
  wait(seconds: number, dt = 0.1): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this.tick(dt);
  }

  setEngine(running: boolean): void { this.engineRunning = running; }

  /** Move in a straight line to `to` at `speedMs` (ground speed), on the ground or airborne. */
  move(to: Point, speedMs: number, onGround: boolean, dt = 0.1): void {
    const from = { ...this.pos };
    const dAlong = to.along - from.along, dCross = to.cross - from.cross;
    const dist = Math.hypot(dAlong, dCross);
    const duration = Math.max(dist / speedMs, dt);
    const n = Math.max(1, Math.round(duration / dt));
    if (dist > 1) this.trackDeg = (this.frame.headingDeg + Math.atan2(dCross, dAlong) * RAD + 360) % 360;
    this.onGround = onGround;
    this.gs = dist > 1 ? speedMs : 0;
    this.vs = (to.h - from.h) / (n * dt);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      this.pos = { along: from.along + dAlong * k, cross: from.cross + dCross * k, h: from.h + (to.h - from.h) * k };
      this.tick(dt);
    }
    this.gs = 0;
    this.vs = 0;
  }

  /** Set kinematics without moving (e.g. stop). */
  setMotion(gs: number, vs: number, onGround: boolean): void { this.gs = gs; this.vs = vs; this.onGround = onGround; }

  /** Index (0-based) of the first option matching. */
  optionIndex(match: RegExp): number {
    return this.atc.options.findIndex((o) => match.test(o));
  }

  /**
   * Select the option matching `match`. Returns the index of the pilot message it produced in
   * `messages` (or −1 when the option transmits nothing, e.g. listening to the ATIS).
   */
  select(match: RegExp): number {
    const i = this.optionIndex(match);
    if (i < 0) throw new Error(`no option ${match} in [${this.atc.options.join(' | ')}] (phase ${this.atc.phase})`);
    const before = this.messages.length;
    const ok = this.atc.select(i === 9 ? 0 : i + 1);
    if (!ok) throw new Error(`select ${match} refused (phase ${this.atc.phase})`);
    this.recordPhase();
    const first = this.messages.findIndex((m, k) => k >= before && m.from === 'pilot');
    return first;
  }

  /** Messages after index `from` (exclusive) from a voice. */
  after(from: number, voice: RadioVoice): LoggedMessage[] {
    return this.messages.slice(from + 1).filter((m) => m.from === voice);
  }

  /** Last message text containing `needle`, if any. */
  find(needle: RegExp): LoggedMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) if (needle.test(this.messages[i].text)) return this.messages[i];
    return undefined;
  }
}
