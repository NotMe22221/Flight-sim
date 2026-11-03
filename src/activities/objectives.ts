/**
 * Objective engine: composable, data-driven objectives evaluated every update against the
 * AircraftState, the pilot's ControlInputs and elapsed time.
 *
 *  - A `ConditionSpec` is an instantaneous test ("altitude 3,000 ft ± 100", "parking brake
 *    released", "within 8 m of the centreline") with a normalised error and a short live hint.
 *  - An `ObjectiveSpec` combines conditions with time: hold them for Z s, reach them, maintain
 *    them until something else happens, fly a turn, rotate between two speeds, stop at an
 *    airport, land with a minimum score, pass a waypoint.
 *
 * Specs are plain data in aviation units (ft, kt, fpm, nm, deg: field names carry the unit) and
 * are compiled once into evaluators that work in SI internally. `update()` does not allocate.
 * Time only advances through `ctx.dt`; there is no wall clock or randomness here.
 */
import { clamp } from '../core/math';
import type { AircraftState, Airport, ControlInputs, Runway } from '../core/types';
import { FPM, FT, KT, NM, RAD } from '../core/units';
import { aimAlongM, relativeToRunway, type RunwayEndRef, type RunwayRelative } from './runwayFrame';
import { ftSpeech, ftText, headingText, ktText, spellHeading, spellNumber } from './speech';

// ───────────────────────────────── shared data types ─────────────────────────────────

/** An instructor line: `text` is the subtitle, `speech` (optional) is spelled for TTS. */
export interface Line { text: string; speech?: string }

/** One runway landing direction, copied from public/data (tests verify the numbers). */
export interface RunwaySpec {
  icao: string;
  /** landing-direction designator, e.g. "30" */
  ident: string;
  /** pavement threshold of this end (deg) — the `alongM` origin of runwayFrame.relativeToRunway */
  lat: number;
  lon: number;
  /** threshold elevation, m */
  elevM: number;
  /** true heading of this landing direction, deg */
  headingDeg: number;
  /** pavement length, m */
  lengthM: number;
  widthM: number;
  /** displaced landing threshold, m past the pavement threshold */
  displacedM: number;
}

/** A landing as reported by TouchdownDetector's 'landing:scored' event. */
export interface LandingResult {
  /** 0..10 000 */
  score: number;
  /** "KHAF 30" or null when the runway was not identified */
  runway: string | null;
  /** touchdown distance past the pavement threshold, m (null when unknown) */
  touchdownFromThresholdM: number | null;
  grade: string | null;
}

/** Everything an objective may look at. The runner reuses one object for every update. */
export interface ObjectiveContext {
  state: AircraftState;
  inputs: ControlInputs;
  /** seconds since the previous update */
  dt: number;
  /** the latest landing scored while the current step was active (null before) */
  landing: LandingResult | null;
  /** increments with every landing so objectives can detect a new one */
  landingSeq: number;
}

// ───────────────────────────────── conditions ─────────────────────────────────

/** Instantaneous tests. Bands may be one-sided (omit min or max). */
export type ConditionSpec =
  /** indicated (default) or MSL altitude within ±tolFt of ft */
  | { c: 'altitude'; ft: number; tolFt: number; ref?: 'indicated' | 'msl' }
  | { c: 'altitudeBand'; minFt?: number; maxFt?: number; ref?: 'indicated' | 'msl' }
  /** height above ground */
  | { c: 'agl'; minFt?: number; maxFt?: number; lowHint?: Line; highHint?: Line }
  /** magnetic (default) heading within ±tolDeg of `deg`, or of the heading at activation + offsetDeg */
  | { c: 'heading'; deg?: number; offsetDeg?: number; tolDeg: number; ref?: 'mag' | 'true' }
  /** indicated airspeed band */
  | { c: 'airspeed'; minKt?: number; maxKt?: number; lowHint?: Line; highHint?: Line }
  | { c: 'verticalSpeed'; minFpm?: number; maxFpm?: number; lowHint?: Line; highHint?: Line }
  /** bank angle band; `abs` (default true) compares |bank| */
  | { c: 'bank'; minDeg?: number; maxDeg?: number; abs?: boolean }
  | { c: 'pitch'; minDeg?: number; maxDeg?: number }
  | { c: 'parkingBrake'; set: boolean }
  /** throttle lever 0..1 */
  | { c: 'throttle'; min?: number; max?: number }
  | { c: 'mixture'; min?: number; max?: number }
  /** actual flap position (deg), so a detent counts once the flaps have run there */
  | { c: 'flaps'; minDeg?: number; maxDeg?: number }
  | { c: 'onGround'; value: boolean }
  | { c: 'groundSpeed'; minKt?: number; maxKt?: number }
  | { c: 'engineRunning'; value: boolean }
  /** lateral offset from the runway centreline (extended), m */
  | { c: 'centreline'; runway: RunwaySpec; maxM: number }
  /** on the approach path to the runway aim point (runwayFrame.aimAlongM), ±tolDeg (with a linear floor of minTolFt) */
  | { c: 'glidepath'; runway: RunwaySpec; angleDeg?: number; tolDeg: number; minTolFt?: number }
  /** distance before the runway threshold along the approach course, nm (negative once past it) */
  | { c: 'runwayDistance'; runway: RunwaySpec; minNm?: number; maxNm?: number }
  /** horizontal distance to a point */
  | { c: 'near'; lat: number; lon: number; radiusM: number }
  /** pilot's pitch (and optionally roll) input near neutral: "trimmed for hands-off flight" */
  | { c: 'controlsNeutral'; maxPitch?: number; maxRoll?: number };

/** A compiled condition. `test` sets `err` (0 = on target, 1 = at the tolerance edge, >1 outside) and `hint`. */
export interface Condition {
  readonly spec: ConditionSpec;
  err: number;
  hint: Line | null;
  /** capture targets relative to the state at activation (relative headings) */
  activate(ctx: ObjectiveContext): void;
  test(ctx: ObjectiveContext): boolean;
}

const R_EARTH = 6371000;
const D2R = Math.PI / 180;

/** Flat-earth horizontal distance, m (exact enough within ~100 km). */
export function flatDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dn = (lat2 - lat1) * D2R * R_EARTH;
  const de = (lon2 - lon1) * D2R * R_EARTH * Math.cos(((lat1 + lat2) / 2) * D2R);
  return Math.sqrt(dn * dn + de * de);
}

/** A RunwayEndRef for runwayFrame's helpers, built from a RunwaySpec (once, at compile time). */
export function runwayEndRef(spec: RunwaySpec): RunwayEndRef {
  const threshold = { lat: spec.lat, lon: spec.lon, alt: spec.elevM };
  const runway: Runway = {
    ident: spec.ident, threshold, end: threshold, headingDeg: spec.headingDeg, lengthM: spec.lengthM, widthM: spec.widthM,
    surface: 'asphalt', lighted: true, displacedThresholdM: spec.displacedM,
  };
  const airport: Airport = {
    icao: spec.icao, name: spec.icao, position: threshold, elevationM: spec.elevM, type: 'small', country: '', runways: [runway],
  };
  return { airport, runway, ident: spec.ident, threshold, headingDeg: spec.headingDeg, lengthM: spec.lengthM, widthM: spec.widthM, displacedM: spec.displacedM };
}

/** Signed difference a − b wrapped to (−180, 180], deg. */
export const angleDiffDeg = (a: number, b: number): number => {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
};

const line = (text: string, speech?: string): Line => (speech ? { text, speech } : { text });

/**
 * Band test shared by the scalar conditions: sets err (0 at the centre, 1 at an edge; one-sided
 * bands are 0 inside and 1 + excess/scale outside) and picks the low/high hint.
 */
class BandCondition implements Condition {
  err = 0;
  hint: Line | null = null;
  private readonly lo: number;
  private readonly hi: number;
  constructor(
    readonly spec: ConditionSpec,
    private readonly read: (ctx: ObjectiveContext) => number,
    lo: number | undefined,
    hi: number | undefined,
    private readonly lowHint: Line | null,
    private readonly highHint: Line | null,
    /** normalising scale for one-sided bands (SI units of the measure) */
    private readonly scale: number,
  ) {
    this.lo = lo ?? -Infinity;
    this.hi = hi ?? Infinity;
  }
  activate(): void { /* absolute targets */ }
  test(ctx: ObjectiveContext): boolean {
    const x = this.read(ctx);
    const { lo, hi } = this;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const half = Math.max((hi - lo) / 2, 1e-9);
      this.err = Math.abs(x - (lo + hi) / 2) / half;
    } else if (x < lo) this.err = 1 + (lo - x) / this.scale;
    else if (x > hi) this.err = 1 + (x - hi) / this.scale;
    else this.err = 0;
    if (x < lo) { this.hint = this.lowHint; return false; }
    if (x > hi) { this.hint = this.highHint; return false; }
    this.hint = null;
    return true;
  }
}

/** Boolean test with one hint when it fails. */
class FlagCondition implements Condition {
  err = 0;
  hint: Line | null = null;
  constructor(readonly spec: ConditionSpec, private readonly ok: (ctx: ObjectiveContext) => boolean, private readonly failHint: Line | null) {}
  activate(): void { /* nothing to capture */ }
  test(ctx: ObjectiveContext): boolean {
    const ok = this.ok(ctx);
    this.err = ok ? 0 : 2;
    this.hint = ok ? null : this.failHint;
    return ok;
  }
}

/** Heading within a tolerance; relative targets are captured at activation. */
class HeadingCondition implements Condition {
  err = 0;
  hint: Line | null = null;
  private target = 0;
  private left: Line = { text: '' };
  private right: Line = { text: '' };
  constructor(readonly spec: Extract<ConditionSpec, { c: 'heading' }>) {
    if (spec.deg !== undefined) this.setTarget(spec.deg);
  }
  private heading(ctx: ObjectiveContext): number {
    return (this.spec.ref === 'true' ? ctx.state.headingTrueRad : ctx.state.headingMagRad) * RAD;
  }
  private setTarget(deg: number): void {
    this.target = ((deg % 360) + 360) % 360;
    const h = headingText(this.target);
    this.left = line(`Turn left to heading ${h}`, `Turn left, ${spellHeading(this.target)}`);
    this.right = line(`Turn right to heading ${h}`, `Turn right, ${spellHeading(this.target)}`);
  }
  activate(ctx: ObjectiveContext): void {
    if (this.spec.deg === undefined) this.setTarget(Math.round(this.heading(ctx) + (this.spec.offsetDeg ?? 0)));
  }
  /** target heading, deg (after activation for relative specs) */
  get targetDeg(): number { return this.target; }
  test(ctx: ObjectiveContext): boolean {
    const d = angleDiffDeg(this.heading(ctx), this.target);
    this.err = Math.abs(d) / Math.max(this.spec.tolDeg, 1e-6);
    if (this.err <= 1) { this.hint = null; return true; }
    this.hint = d > 0 ? this.left : this.right;
    return false;
  }
}

/** Runway-relative conditions (centreline, glidepath, distance to the threshold). */
class RunwayCondition implements Condition {
  err = 0;
  hint: Line | null = null;
  private readonly end: RunwayEndRef;
  private readonly rel: RunwayRelative = { alongM: 0, crossM: 0 };
  private readonly aimM: number;
  private readonly tanG: number;
  private readonly hints: [Line, Line];
  constructor(readonly spec: Extract<ConditionSpec, { c: 'centreline' | 'glidepath' | 'runwayDistance' }>) {
    this.end = runwayEndRef(spec.runway);
    this.aimM = aimAlongM(this.end);
    this.tanG = Math.tan(((spec.c === 'glidepath' ? spec.angleDeg : undefined) ?? 3) * D2R);
    this.hints = spec.c === 'centreline'
      ? [line('Left of the centreline: steer right'), line('Right of the centreline: steer left')]
      : [line('Below the glidepath: add power'), line('Above the glidepath: reduce power')];
  }
  activate(): void { /* absolute */ }
  /** last computed values, for UIs and tests */
  crossM = 0;
  deviationM = 0;
  distanceToThresholdM = 0;
  test(ctx: ObjectiveContext): boolean {
    const s = this.spec;
    relativeToRunway(ctx.state.geo, this.end, this.rel);
    this.crossM = this.rel.crossM;
    this.distanceToThresholdM = -this.rel.alongM;
    if (s.c === 'centreline') {
      this.err = Math.abs(this.rel.crossM) / Math.max(s.maxM, 1e-6);
      const ok = this.err <= 1;
      this.hint = ok ? null : this.rel.crossM < 0 ? this.hints[0] : this.hints[1];
      return ok;
    }
    if (s.c === 'runwayDistance') {
      const nm = this.distanceToThresholdM / NM;
      const ok = (s.minNm === undefined || nm >= s.minNm) && (s.maxNm === undefined || nm <= s.maxNm);
      this.err = ok ? 0 : 2;
      this.hint = null;
      return ok;
    }
    // glidepath: height above the threshold elevation vs the straight path to the aim point
    const toAim = this.aimM - this.rel.alongM;
    if (toAim <= 0) { this.err = 0; this.hint = null; this.deviationM = 0; return true; }
    const pathH = toAim * this.tanG;
    const h = ctx.state.altitudeMslM - s.runway.elevM;
    this.deviationM = h - pathH;
    const tolM = Math.max((s.minTolFt ?? 20) * FT, toAim * Math.abs(Math.tan(Math.atan(this.tanG) + s.tolDeg * D2R) - this.tanG));
    this.err = Math.abs(this.deviationM) / tolM;
    const ok = this.err <= 1;
    this.hint = ok ? null : this.deviationM < 0 ? this.hints[0] : this.hints[1];
    return ok;
  }
}

const ias = (x: ObjectiveContext): number => x.state.aero.ias;
const altInd = (x: ObjectiveContext): number => x.state.altitudeIndicatedM;
const altMsl = (x: ObjectiveContext): number => x.state.altitudeMslM;

/** Compile one condition spec (allocates; call when a step starts, not per frame). */
export function compileCondition(spec: ConditionSpec): Condition {
  switch (spec.c) {
    case 'altitude': {
      const t = spec.ft * FT, tol = spec.tolFt * FT;
      return new BandCondition(spec, spec.ref === 'msl' ? altMsl : altInd, t - tol, t + tol,
        line(`Too low: climb to ${ftText(spec.ft)}`, `Too low. Climb to ${ftSpeech(spec.ft)}`),
        line(`Too high: descend to ${ftText(spec.ft)}`, `Too high. Descend to ${ftSpeech(spec.ft)}`), tol);
    }
    case 'altitudeBand':
      return new BandCondition(spec, spec.ref === 'msl' ? altMsl : altInd,
        spec.minFt === undefined ? undefined : spec.minFt * FT, spec.maxFt === undefined ? undefined : spec.maxFt * FT,
        spec.minFt === undefined ? null : line(`Climb above ${ftText(spec.minFt)}`, `Climb above ${ftSpeech(spec.minFt)}`),
        spec.maxFt === undefined ? null : line(`Descend below ${ftText(spec.maxFt)}`, `Descend below ${ftSpeech(spec.maxFt)}`), 100 * FT);
    case 'agl':
      return new BandCondition(spec, (x) => x.state.altitudeAglM,
        spec.minFt === undefined ? undefined : spec.minFt * FT, spec.maxFt === undefined ? undefined : spec.maxFt * FT,
        spec.lowHint ?? (spec.minFt === undefined ? null : line(`Climb to ${ftText(spec.minFt)} above the ground`, `Climb to ${ftSpeech(spec.minFt)} above the ground`)),
        spec.highHint ?? (spec.maxFt === undefined ? null : line(`Descend below ${ftText(spec.maxFt)} above the ground`, `Descend below ${ftSpeech(spec.maxFt)} above the ground`)), 100 * FT);
    case 'heading':
      return new HeadingCondition(spec);
    case 'airspeed':
      return new BandCondition(spec, ias,
        spec.minKt === undefined ? undefined : spec.minKt * KT, spec.maxKt === undefined ? undefined : spec.maxKt * KT,
        spec.lowHint ?? line('Too slow: add power', 'Too slow. Add power.'),
        spec.highHint ?? line('Too fast: reduce power', 'Too fast. Reduce power.'), 5 * KT);
    case 'verticalSpeed': {
      const lo = spec.minFpm, hi = spec.maxFpm;
      const low = spec.lowHint ?? (lo === undefined ? null : lo > 0 ? line('Climb a little faster: raise the nose', 'Climb a little faster. Raise the nose slightly.') : line('Sinking too fast: raise the nose', 'Sinking too fast. Raise the nose slightly.'));
      const high = spec.highHint ?? (hi === undefined ? null : hi >= 0 ? line('Climbing too fast: lower the nose', 'Climbing too fast. Lower the nose slightly.') : line('Descend a little faster: lower the nose', 'Descend a little faster. Lower the nose slightly.'));
      return new BandCondition(spec, (x) => x.state.verticalSpeedMs, lo === undefined ? undefined : lo * FPM, hi === undefined ? undefined : hi * FPM, low, high, 200 * FPM);
    }
    case 'bank': {
      const abs = spec.abs !== false;
      return new BandCondition(spec, abs ? (x) => Math.abs(x.state.euler[0]) * RAD : (x) => x.state.euler[0] * RAD, spec.minDeg, spec.maxDeg,
        abs ? line('Bank a little more') : line('Roll right'),
        abs ? (spec.maxDeg !== undefined && spec.maxDeg <= 5 ? line('Level the wings', 'Level the wings.') : line('Too steep: reduce the bank', 'Too steep. Reduce the bank.')) : line('Roll left'), 5);
    }
    case 'pitch':
      return new BandCondition(spec, (x) => x.state.euler[1] * RAD, spec.minDeg, spec.maxDeg,
        line('Nose too low: raise the nose', 'Raise the nose a little.'), line('Nose too high: lower the nose', 'Lower the nose a little.'), 2);
    case 'parkingBrake':
      return new FlagCondition(spec, (x) => x.inputs.parkingBrake === spec.set,
        spec.set ? line('Set the parking brake', 'Set the parking brake.') : line('Release the parking brake', 'Release the parking brake.'));
    case 'throttle':
      return new BandCondition(spec, (x) => x.inputs.throttle, spec.min, spec.max,
        spec.min !== undefined && spec.min >= 0.9 ? line('Full power: throttle all the way in', 'Full power. Push the throttle all the way in.') : line('Add power', 'Add some power.'),
        line('Reduce power', 'Reduce power.'), 0.1);
    case 'mixture':
      return new BandCondition(spec, (x) => x.inputs.mixture, spec.min, spec.max,
        line('Mixture full rich', 'Push the mixture full rich.'), line('Lean the mixture', 'Lean the mixture.'), 0.1);
    case 'flaps':
      return new BandCondition(spec, (x) => x.state.surfaces.flapDeg,
        spec.minDeg === undefined ? undefined : spec.minDeg - 0.5, spec.maxDeg === undefined ? undefined : spec.maxDeg + 0.5,
        spec.minDeg === undefined ? null : line(`Flaps down to ${spec.minDeg}°`, `Set flaps ${spec.minDeg}.`),
        spec.maxDeg === undefined ? null : spec.maxDeg <= 0.5 ? line('Flaps up', 'Flaps up.') : line(`Flaps up to ${spec.maxDeg}°`, `Raise the flaps to ${spec.maxDeg}.`), 5);
    case 'onGround':
      return new FlagCondition(spec, (x) => x.state.onGround === spec.value, null);
    case 'groundSpeed':
      return new BandCondition(spec, (x) => x.state.groundSpeedMs,
        spec.minKt === undefined ? undefined : spec.minKt * KT, spec.maxKt === undefined ? undefined : spec.maxKt * KT,
        line('Keep rolling'), line('Slow down: apply the brakes', 'Slow down. Apply the brakes.'), 2 * KT);
    case 'engineRunning':
      return new FlagCondition(spec, (x) => x.state.engine.running === spec.value,
        spec.value ? line('Start the engine', 'Start the engine.') : line('Shut down the engine', 'Shut down the engine.'));
    case 'centreline':
    case 'glidepath':
    case 'runwayDistance':
      return new RunwayCondition(spec);
    case 'near':
      return new BandCondition(spec, (x) => flatDistanceM(x.state.geo.lat, x.state.geo.lon, spec.lat, spec.lon), undefined, spec.radiusM, null, null, spec.radiusM);
    case 'controlsNeutral': {
      const mp = spec.maxPitch ?? 0.05, mr = spec.maxRoll;
      return new FlagCondition(spec, (x) => Math.abs(x.inputs.pitch) <= mp && (mr === undefined || Math.abs(x.inputs.roll) <= mr),
        line('Trim to relieve the control pressure', 'Use the trim wheel until you can let go of the yoke.'));
    }
  }
}

/** A set of conditions tested together: ok when all pass; `hint` is the first failing one's. */
export class ConditionSet {
  ok = true;
  hint: Line | null = null;
  /** largest normalised error of the set */
  maxErr = 0;
  readonly conds: Condition[];
  constructor(specs: readonly ConditionSpec[]) { this.conds = specs.map(compileCondition); }
  activate(ctx: ObjectiveContext): void { for (const c of this.conds) c.activate(ctx); }
  test(ctx: ObjectiveContext): boolean {
    let ok = true, hint: Line | null = null, maxErr = 0;
    for (let i = 0; i < this.conds.length; i++) {
      const c = this.conds[i];
      const pass = c.test(ctx);
      if (c.err > maxErr) maxErr = c.err;
      if (!pass) { ok = false; if (!hint) hint = c.hint; }
    }
    this.ok = ok; this.hint = hint; this.maxErr = maxErr;
    return ok;
  }
}

// ───────────────────────────────── objectives ─────────────────────────────────

export type ObjectiveState = 'pending' | 'active' | 'done' | 'failed';

/** Live, polled view of an objective (mutated in place; UIs may read it every frame). */
export interface ObjectiveView {
  readonly label: string;
  readonly optional: boolean;
  state: ObjectiveState;
  /** 0..1 */
  progress: number;
  /** what to correct right now, or null when on target */
  hint: Line | null;
  /** quality 0..1 so far (final once done; 0 when failed) */
  score: number;
  /** debrief note: why it failed, or a measurement ("Rotated at 56 kt") */
  note: string | null;
}

/** Linear progress from a value at activation (or `from`) to `to`. */
export interface ProgressSpec { metric: 'altitudeFt' | 'aglFt' | 'iasKt'; to: number; from?: number }

interface ObjectiveBase {
  /** objective-list text, e.g. "Hold 3,000 ft ±100 and heading 090° ±10 for 20 s" */
  label: string;
  /** optional objectives add to the score but do not gate the step */
  optional?: boolean;
  /** fail as soon as all of these are true before the objective is done (deadlines: "flaps 30 by 1 nm") */
  failIf?: ConditionSpec[];
  /** debrief reason when `failIf` or `timeoutS` triggers */
  failText?: string;
  /** fail when not done within this many seconds of activation */
  timeoutS?: number;
  /** instructor line when the objective completes */
  doneLine?: Line;
}

export type ObjectiveSpec =
  /** all conditions true for `forS` seconds; excursions shorter than graceS (default 1 s) pause the timer, longer ones reset it */
  | (ObjectiveBase & { type: 'hold'; all: ConditionSpec[]; forS: number; graceS?: number })
  /** all conditions true (for confirmS, default 0.5 s); `during` is coached and scored on the way */
  | (ObjectiveBase & { type: 'reach'; all: ConditionSpec[]; confirmS?: number; during?: ConditionSpec[]; progress?: ProgressSpec })
  /** keep `all` true until `until` is true; fails after failAfterS continuous seconds out of tolerance (if set) */
  | (ObjectiveBase & { type: 'maintain'; all: ConditionSpec[]; until: ConditionSpec[]; failAfterS?: number; progress?: ProgressSpec })
  /** turn by byDeg (+ right, − left) with the bank in band, roll out within tolDeg (default 10) */
  | (ObjectiveBase & { type: 'turn'; byDeg: number; bankMinDeg: number; bankMaxDeg: number; tolDeg?: number; during?: ConditionSpec[] })
  /** lift the nose (pitch ≥ pitchDeg, default 5°) or lift off between minKt and maxKt; strict = outside the band fails */
  | (ObjectiveBase & { type: 'rotate'; minKt: number; maxKt: number; targetKt?: number; strict?: boolean; pitchDeg?: number })
  /** on the ground, stopped (≤ maxKt, default 1) for stopS (default 2 s) within radiusM (default 2 500 m) of the airport, after flying */
  | (ObjectiveBase & { type: 'stopAt'; icao: string; name?: string; lat: number; lon: number; radiusM?: number; maxKt?: number; stopS?: number })
  /** the next 'landing:scored' must reach minScore (0..10 000), on `runway` ("KHAF 30") or `airport`, touching down within `zone` (m past the pavement threshold) */
  | (ObjectiveBase & { type: 'landing'; minScore: number; runway?: string; airport?: string; zone?: { fromM: number; toM: number } })
  /** pass within radiusM (default 1 nm) of a point */
  | (ObjectiveBase & { type: 'waypoint'; name: string; lat: number; lon: number; radiusM?: number });

/** Base class: lifecycle, deadlines, timeouts. Subclasses implement `begin` and `evaluate`. */
export abstract class Objective {
  readonly view: ObjectiveView;
  private readonly failIf: ConditionSet | null;
  protected elapsed = 0;

  constructor(readonly spec: ObjectiveSpec) {
    this.view = { label: spec.label, optional: !!spec.optional, state: 'pending', progress: 0, hint: null, score: 0, note: null };
    this.failIf = spec.failIf && spec.failIf.length > 0 ? new ConditionSet(spec.failIf) : null;
  }

  get finished(): boolean { return this.view.state === 'done' || this.view.state === 'failed'; }

  activate(ctx: ObjectiveContext): void {
    const v = this.view;
    v.state = 'active'; v.progress = 0; v.hint = null; v.score = 0; v.note = null;
    this.elapsed = 0;
    this.failIf?.activate(ctx);
    this.begin(ctx);
  }

  update(ctx: ObjectiveContext): void {
    if (this.view.state !== 'active') return;
    this.elapsed += ctx.dt;
    this.evaluate(ctx);
    if (this.view.state !== 'active') return;
    if (this.failIf && this.failIf.test(ctx)) this.fail(this.spec.failText ?? `${this.spec.label}: not achieved in time`);
    else if (this.spec.timeoutS !== undefined && this.elapsed > this.spec.timeoutS) this.fail(this.spec.failText ?? `${this.spec.label}: ran out of time`);
  }

  /** End an unfinished objective as missed (optional objectives when their step completes). */
  abandon(note: string): void {
    if (!this.finished) this.fail(note);
  }

  protected complete(score: number, note: string | null = null): void {
    const v = this.view;
    v.state = 'done'; v.progress = 1; v.hint = null; v.score = clamp(score, 0, 1); v.note = note;
  }

  protected fail(note: string): void {
    const v = this.view;
    v.state = 'failed'; v.hint = null; v.score = 0; v.note = note;
  }

  protected abstract begin(ctx: ObjectiveContext): void;
  protected abstract evaluate(ctx: ObjectiveContext): void;
}

function readMetric(m: ProgressSpec['metric'], ctx: ObjectiveContext): number {
  const s = ctx.state;
  switch (m) {
    case 'altitudeFt': return s.altitudeIndicatedM / FT;
    case 'aglFt': return s.altitudeAglM / FT;
    case 'iasKt': return s.aero.ias / KT;
  }
}

/** Shared progress-from-metric helper. */
class MetricProgress {
  private from = 0;
  constructor(private readonly spec: ProgressSpec) {}
  begin(ctx: ObjectiveContext): void { this.from = this.spec.from ?? readMetric(this.spec.metric, ctx); }
  value(ctx: ObjectiveContext): number {
    const span = this.spec.to - this.from;
    if (Math.abs(span) < 1e-9) return 1;
    return clamp((readMetric(this.spec.metric, ctx) - this.from) / span, 0, 1);
  }
}

class HoldObjective extends Objective {
  private readonly set: ConditionSet;
  private held = 0;
  private broken = 0;
  private errSum = 0;
  private time = 0;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'hold' }>) { super(s); this.set = new ConditionSet(s.all); }
  protected begin(ctx: ObjectiveContext): void { this.set.activate(ctx); this.held = 0; this.broken = 0; this.errSum = 0; this.time = 0; }
  protected evaluate(ctx: ObjectiveContext): void {
    const ok = this.set.test(ctx);
    this.time += ctx.dt;
    this.errSum += Math.min(this.set.maxErr, 1) * ctx.dt;
    if (ok) { this.held += ctx.dt; this.broken = 0; }
    else { this.broken += ctx.dt; if (this.broken > (this.s.graceS ?? 1)) this.held = 0; }
    const v = this.view;
    v.progress = clamp(this.held / Math.max(this.s.forS, 1e-6), 0, 1);
    v.hint = ok ? null : this.set.hint;
    v.score = 1 - 0.6 * this.errSum / Math.max(this.time, 1e-6);
    if (this.held >= this.s.forS - 1e-9) this.complete(v.score);
  }
}

class ReachObjective extends Objective {
  private readonly set: ConditionSet;
  private readonly during: ConditionSet | null;
  private readonly metric: MetricProgress | null;
  private confirm = 0;
  private time = 0;
  private outTime = 0;
  private best = 0;
  private stuck = 0;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'reach' }>) {
    super(s);
    this.set = new ConditionSet(s.all);
    this.during = s.during && s.during.length > 0 ? new ConditionSet(s.during) : null;
    this.metric = s.progress ? new MetricProgress(s.progress) : null;
  }
  protected begin(ctx: ObjectiveContext): void {
    this.set.activate(ctx); this.during?.activate(ctx); this.metric?.begin(ctx);
    this.confirm = 0; this.time = 0; this.outTime = 0; this.best = 0; this.stuck = 0;
  }
  protected evaluate(ctx: ObjectiveContext): void {
    const ok = this.set.test(ctx);
    const v = this.view;
    this.time += ctx.dt;
    let hint: Line | null = null;
    if (this.during && !ok && !this.during.test(ctx)) { this.outTime += ctx.dt; hint = this.during.hint; }
    v.progress = this.metric ? this.metric.value(ctx) : 0;
    // no headway for a while: remind of the target itself ("Too low: climb to 3,500 ft")
    if (v.progress > this.best + 0.01) { this.best = v.progress; this.stuck = 0; } else this.stuck += ctx.dt;
    if (!hint && !ok && (this.stuck > 15 || !this.metric)) hint = this.set.hint;
    v.hint = hint;
    v.score = 1 - 0.5 * this.outTime / Math.max(this.time, 1e-6);
    if (ok) { this.confirm += ctx.dt; if (this.confirm >= (this.s.confirmS ?? 0.5) - 1e-9) this.complete(v.score); }
    else this.confirm = 0;
  }
}

class MaintainObjective extends Objective {
  private readonly set: ConditionSet;
  private readonly until: ConditionSet;
  private readonly metric: MetricProgress | null;
  private outFor = 0;
  private errSum = 0;
  private time = 0;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'maintain' }>) {
    super(s);
    this.set = new ConditionSet(s.all);
    this.until = new ConditionSet(s.until);
    this.metric = s.progress ? new MetricProgress(s.progress) : null;
  }
  protected begin(ctx: ObjectiveContext): void {
    this.set.activate(ctx); this.until.activate(ctx); this.metric?.begin(ctx);
    this.outFor = 0; this.errSum = 0; this.time = 0;
  }
  protected evaluate(ctx: ObjectiveContext): void {
    const v = this.view;
    if (this.until.test(ctx)) { this.complete(this.time > 0 ? v.score : 1); return; }
    const ok = this.set.test(ctx);
    this.time += ctx.dt;
    this.errSum += Math.min(this.set.maxErr, 1) * ctx.dt;
    this.outFor = ok ? 0 : this.outFor + ctx.dt;
    v.hint = ok ? null : this.set.hint;
    v.score = 1 - this.errSum / Math.max(this.time, 1e-6);
    if (this.metric) v.progress = Math.min(this.metric.value(ctx), 0.99);
    if (this.s.failAfterS !== undefined && this.outFor > this.s.failAfterS) this.fail(this.s.failText ?? `${this.s.label}: out of tolerance for too long`);
  }
}

class TurnObjective extends Objective {
  private readonly during: ConditionSet | null;
  private prev = 0;
  private turned = 0;
  private turning = 0;
  private inBand = 0;
  private duringOut = 0;
  private settle = 0;
  private hints = { start: line(''), shallow: line(''), steep: line(''), rollout: line(''), overshoot: line('') };
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'turn' }>) {
    super(s);
    this.during = s.during && s.during.length > 0 ? new ConditionSet(s.during) : null;
  }
  protected begin(ctx: ObjectiveContext): void {
    this.during?.activate(ctx);
    this.prev = ctx.state.headingTrueRad * RAD;
    this.turned = 0; this.turning = 0; this.inBand = 0; this.duringOut = 0; this.settle = 0;
    const right = this.s.byDeg > 0;
    const target = Math.round(ctx.state.headingMagRad * RAD + this.s.byDeg);
    const h = headingText(target), hs = spellHeading(target);
    const mid = Math.round((this.s.bankMinDeg + this.s.bankMaxDeg) / 2);
    this.hints = {
      start: right ? line(`Roll right to turn to heading ${h}`, `Roll right. Turn to ${hs}.`) : line(`Roll left to turn to heading ${h}`, `Roll left. Turn to ${hs}.`),
      shallow: line(`Bank a little more: about ${mid}°`, `Steepen the bank a little, to about ${spellNumber(mid)} degrees.`),
      steep: line(`Too steep: reduce the bank to about ${mid}°`, `Too steep. Reduce the bank to about ${spellNumber(mid)} degrees.`),
      rollout: line(`Roll out on heading ${h}`, `Roll out now, on ${hs}.`),
      overshoot: line(`Overshot: turn back to heading ${h}`, `You overshot. Turn back to ${hs}.`),
    };
  }
  /** signed heading change still to go, deg (positive = keep turning) */
  get remainingDeg(): number { return (this.s.byDeg - this.turned) * Math.sign(this.s.byDeg); }
  protected evaluate(ctx: ObjectiveContext): void {
    const st = ctx.state, v = this.view, dir = Math.sign(this.s.byDeg) || 1;
    const h = st.headingTrueRad * RAD;
    this.turned += angleDiffDeg(h, this.prev);
    this.prev = h;
    const tol = this.s.tolDeg ?? 10;
    const remaining = this.remainingDeg;
    const bankToward = st.euler[0] * RAD * dir;
    const duringOk = this.during ? this.during.test(ctx) : true;
    if (!duringOk) this.duringOut += ctx.dt;
    v.progress = clamp(this.turned / this.s.byDeg, 0, 1);
    let hint: Line | null = null;
    if (remaining > tol + 10) {
      this.settle = 0;
      this.turning += ctx.dt;
      const inBand = bankToward >= this.s.bankMinDeg && bankToward <= this.s.bankMaxDeg;
      if (inBand) this.inBand += ctx.dt;
      if (bankToward < 3 && this.turned * dir < 5) hint = this.hints.start;
      else if (bankToward < this.s.bankMinDeg) hint = this.hints.shallow;
      else if (bankToward > this.s.bankMaxDeg) hint = this.hints.steep;
      else if (!duringOk && this.during) hint = this.during.hint;
    } else if (remaining >= -tol) {
      if (Math.abs(st.euler[0] * RAD) <= 5) {
        this.settle += ctx.dt;
        if (!duringOk && this.during) hint = this.during.hint;
        if (this.settle >= 1 && remaining <= tol) {
          const bankScore = this.turning > 0 ? this.inBand / this.turning : 1;
          const holdScore = 1 - this.duringOut / Math.max(this.elapsed, 1e-6);
          const accuracy = 1 - Math.min(Math.abs(remaining) / Math.max(tol, 1e-6), 1);
          this.complete(0.6 * bankScore + 0.25 * holdScore + 0.15 * accuracy);
          return;
        }
      } else { this.settle = 0; hint = this.hints.rollout; }
    } else { this.settle = 0; hint = this.hints.overshoot; }
    v.hint = hint;
    v.score = this.turning > 0 ? this.inBand / this.turning : 1;
  }
}

class RotateObjective extends Objective {
  private readonly target: number;
  private readonly now: Line;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'rotate' }>) {
    super(s);
    this.target = s.targetKt ?? (s.minKt + s.maxKt) / 2;
    this.now = line(`Rotate: ease back on the yoke at ${ktText(this.target)}`, `Rotate. Ease back on the yoke.`);
  }
  protected begin(): void { /* nothing to capture */ }
  protected evaluate(ctx: ObjectiveContext): void {
    const st = ctx.state, v = this.view;
    const kt = st.aero.ias / KT;
    const pitch = st.euler[1] * RAD;
    const rotated = kt >= 20 && ((st.onGround && pitch >= (this.s.pitchDeg ?? 5)) || (!st.onGround && st.altitudeAglM > 1));
    if (!rotated) {
      v.progress = clamp(kt / this.target, 0, 0.99);
      v.hint = st.onGround && kt >= this.s.minKt ? this.now : null;
      return;
    }
    const k = Math.round(kt);
    if (kt < this.s.minKt || kt > this.s.maxKt) {
      const note = kt < this.s.minKt ? `Rotated too early at ${k} kt (target ${ktText(this.target)})` : `Rotated late at ${k} kt (target ${ktText(this.target)})`;
      if (this.s.strict) { this.fail(note); return; }
      this.complete(0.3, note);
      return;
    }
    const half = Math.max(this.target - this.s.minKt, this.s.maxKt - this.target, 1e-6);
    this.complete(1 - 0.5 * Math.abs(kt - this.target) / half, `Rotated at ${k} kt`);
  }
}

class StopAtObjective extends Objective {
  private d0 = 1;
  private stopT = 0;
  private airborne = false;
  private readonly brake: Line;
  private readonly wrong: Line;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'stopAt' }>) {
    super(s);
    const name = s.name ?? s.icao;
    this.brake = line(`Brake to a full stop at ${name}`, `Brake to a full stop.`);
    this.wrong = line(`This isn't ${name}: take off and continue to ${s.icao}`, `This is not ${name}. Take off and continue.`);
  }
  private dist(ctx: ObjectiveContext): number { return flatDistanceM(ctx.state.geo.lat, ctx.state.geo.lon, this.s.lat, this.s.lon); }
  /** distance to the destination at the last update, m */
  distanceM = 0;
  protected begin(ctx: ObjectiveContext): void {
    this.d0 = Math.max(this.dist(ctx), 1);
    this.stopT = 0;
    this.airborne = !ctx.state.onGround;
  }
  protected evaluate(ctx: ObjectiveContext): void {
    const st = ctx.state, v = this.view;
    const d = this.dist(ctx);
    this.distanceM = d;
    if (!st.onGround) this.airborne = true;
    const atField = d <= (this.s.radiusM ?? 2500);
    const stopped = st.onGround && st.groundSpeedMs <= (this.s.maxKt ?? 1) * KT;
    v.progress = atField ? 0.95 : clamp(1 - d / this.d0, 0, 0.95);
    v.hint = !this.airborne || !st.onGround ? null : atField ? (stopped ? null : this.brake) : (stopped ? this.wrong : null);
    if (stopped && atField && this.airborne) {
      this.stopT += ctx.dt;
      if (this.stopT >= (this.s.stopS ?? 2) - 1e-9) this.complete(1);
    } else this.stopT = 0;
  }
}

class LandingObjective extends Objective {
  private seq = 0;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'landing' }>) { super(s); }
  protected begin(ctx: ObjectiveContext): void { this.seq = ctx.landingSeq; }
  protected evaluate(ctx: ObjectiveContext): void {
    const L = ctx.landing;
    if (ctx.landingSeq === this.seq || !L) return;
    this.seq = ctx.landingSeq;
    const s = this.s;
    if (s.runway && L.runway !== s.runway) { this.fail(`Landed on ${L.runway ?? 'an unidentified surface'}, not ${s.runway}`); return; }
    if (s.airport && !(L.runway ?? '').startsWith(`${s.airport} `)) { this.fail(`Landed away from ${s.airport}`); return; }
    if (s.zone) {
      const x = L.touchdownFromThresholdM;
      if (x === null || x < s.zone.fromM || x > s.zone.toM) {
        this.fail(x === null ? 'Touchdown point unknown' : `Touched down ${Math.round(x)} m past the threshold, outside the touchdown zone (${Math.round(s.zone.fromM)}–${Math.round(s.zone.toM)} m)`);
        return;
      }
    }
    const grade = L.grade ? ` (${L.grade})` : '';
    if (L.score < s.minScore) { this.fail(`Landing score ${L.score}${grade}, needed ${s.minScore}`); return; }
    this.complete(L.score / 10000, `Landing score ${L.score}${grade}`);
  }
}

class WaypointObjective extends Objective {
  private d0 = 1;
  distanceM = 0;
  constructor(readonly s: Extract<ObjectiveSpec, { type: 'waypoint' }>) { super(s); }
  private dist(ctx: ObjectiveContext): number { return flatDistanceM(ctx.state.geo.lat, ctx.state.geo.lon, this.s.lat, this.s.lon); }
  protected begin(ctx: ObjectiveContext): void { this.d0 = Math.max(this.dist(ctx), 1); }
  protected evaluate(ctx: ObjectiveContext): void {
    const d = this.dist(ctx);
    this.distanceM = d;
    this.view.progress = clamp(1 - d / this.d0, 0, 0.99);
    if (d <= (this.s.radiusM ?? NM)) this.complete(1, `Passed ${this.s.name}`);
  }
}

/** Compile an objective spec into a fresh evaluator (allocates; once per step activation). */
export function compileObjective(spec: ObjectiveSpec): Objective {
  switch (spec.type) {
    case 'hold': return new HoldObjective(spec);
    case 'reach': return new ReachObjective(spec);
    case 'maintain': return new MaintainObjective(spec);
    case 'turn': return new TurnObjective(spec);
    case 'rotate': return new RotateObjective(spec);
    case 'stopAt': return new StopAtObjective(spec);
    case 'landing': return new LandingObjective(spec);
    case 'waypoint': return new WaypointObjective(spec);
  }
}

/** Fresh, reusable context object for a runner or a test. */
export function makeObjectiveContext(state: AircraftState, inputs: ControlInputs): ObjectiveContext {
  return { state, inputs, dt: 0, landing: null, landingSeq: 0 };
}
