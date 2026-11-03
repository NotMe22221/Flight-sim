/**
 * Mutable state of one ATC session plus the helpers every part of the state machine uses:
 * radio transmissions with callsign abbreviation rules, deterministic reply delays and squawk
 * codes, per-airport contexts (facilities, ATIS letter, runways in use, declination) and phase
 * bookkeeping. Pilot actions (`actions.ts`), automatic detection (`monitors.ts`) and the
 * options menu (`menu.ts`) all operate on an `AtcSession`.
 */
import type { AircraftState, Airport, NavDatabase, WeatherState } from '../core/types';
import { mulberry32 } from '../core/math';
import { fnv1a, magneticDeclinationDeg } from '../nav';
import { buildAtis, type AtisReport } from './atis';
import { AtisLetterTracker, atisContentKey } from './atisTracker';
import { makeCallsign, type Callsign } from './callsign';
import { fieldInfo, runwaysInUse, type Facility, type FieldInfo, type RunwaysInUse } from './field';
import { makeRelativeState, type PatternEntry, type PatternLeg, type RunwayFrame, type TrafficSide } from './geometry';
import { wind, type Spoken } from './phraseology';
import { REPLY_DELAY_MAX_S, REPLY_DELAY_MIN_S, RadioQueue, type RadioSink } from './radio';
import { observeSurface } from './surfaceObs';
import type { AtcPhase, AtcTuning, DepartureIntent, LandingClearance, LandingIntent } from './types';

/** ATC context of one airport. */
export interface FieldCtx {
  info: FieldInfo;
  tracker: AtisLetterTracker;
  /** current broadcast (null until weather is known) */
  report: AtisReport | null;
  inUse: RunwaysInUse | null;
  /** declination at the field, deg East positive (winds are given magnetic) */
  magVarDeg: number;
}

/** An instruction the pilot should read back. */
export interface PendingReadback {
  facility: Facility;
  /** menu label, e.g. "Read back: taxi to runway 28R, hold short of runway 28R" */
  label: string;
  build: (cs: Spoken) => Spoken;
  then: (() => void) | null;
}

/** Per-phase scratch state, reset on every phase change. */
export interface PhaseFlags {
  /** seconds in the current phase */
  timeS: number;
  /** unsolicited call already made in this phase (handoff, exit, …) */
  callIssued: boolean;
  /** go-around watch: lowest height above the field since the landing clearance, m */
  minHeightM: number;
  /** go-around watch: continuous climb time, s */
  climbS: number;
  /** touched down during a touch-and-go */
  touchedDown: boolean;
  /** continuous time outside the pattern, s */
  outsideS: number;
  /** a landing clearance may be issued on final (false right after a go-around / touch-and-go) */
  armed: boolean;
  /** the aircraft has been on a pattern leg in this phase */
  joined: boolean;
}

const DEFAULT_UTC_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

export class AtcSession {
  readonly callsign: Callsign;
  readonly radio: RadioQueue;
  private readonly rnd: () => number;
  private readonly fields = new Map<string, FieldCtx>();

  utcMs: number;
  ac: AircraftState | null = null;
  weather: WeatherState | null = null;

  phase: AtcPhase = 'PARKED';
  /** airport of the current operation (departure, then destination) */
  field: FieldCtx | null = null;
  /** facility the pilot is talking to (COM1) */
  facility: Facility | null = null;
  /** the controller has abbreviated our callsign on the current facility */
  abbreviated = false;
  /** runway of the current operation */
  runway: RunwayFrame | null = null;
  side: TrafficSide = 'left';
  leg: PatternLeg = 'outside';
  /** aircraft relative to `runway`, refreshed every frame */
  readonly rel = makeRelativeState();
  intent: DepartureIntent = 'departure';
  landingIntent: LandingIntent = 'full-stop';
  landingClearance: LandingClearance = 'none';
  entry: PatternEntry | null = null;
  clearanceReceived = false;
  squawk = 1200;
  flightFollowing: Facility | null = null;
  pendingReadback: PendingReadback | null = null;
  /** ATIS letter the pilot has heard, per airport ICAO */
  readonly atisHeard = new Map<string, string>();
  /** airport whose automatic INBOUND detection is suppressed until the aircraft leaves its area */
  inboundSuppressed: string | null = null;
  /**
   * An arrival not yet in the pattern is abandoned beyond this range of its field, m (the tuning
   * value, or farther for a destination picked from the menu beyond it).
   */
  inboundCancelM: number;
  readonly flags: PhaseFlags = { timeS: 0, callIssued: false, minHeightM: Infinity, climbS: 0, touchedDown: false, outsideS: 0, armed: true, joined: false };
  /** kinematic timers (not reset on phase change) */
  stoppedS = 0;
  airborneS = 0;
  groundS = 0;
  /** the options list must be rebuilt */
  menuDirty = true;

  constructor(
    registration: string,
    aircraftType: string,
    readonly nav: NavDatabase,
    sink: RadioSink,
    readonly tuning: AtcTuning,
    utcMs: number | undefined,
    seed: number | undefined,
  ) {
    this.callsign = makeCallsign(registration, aircraftType);
    this.radio = new RadioQueue(sink);
    this.rnd = mulberry32(seed ?? fnv1a(this.callsign.registration));
    this.utcMs = utcMs ?? DEFAULT_UTC_MS;
    this.inboundCancelM = tuning.inboundCancelRangeM;
  }

  /** Change phase (no-op when unchanged); resets the per-phase flags and marks the menu dirty. */
  setPhase(p: AtcPhase): void {
    if (p === this.phase) return;
    this.phase = p;
    const f = this.flags;
    f.timeS = 0; f.callIssued = false; f.minHeightM = Infinity; f.climbS = 0; f.touchedDown = false; f.outsideS = 0; f.armed = true; f.joined = false;
    this.menuDirty = true;
  }

  /** ATC context of an airport (cached; ATIS refreshed — allocates, call on events or at 1 Hz). */
  fieldCtx(airport: Airport): FieldCtx {
    const ctx = this.peekField(airport);
    this.refreshAtis(ctx);
    return ctx;
  }

  /** Cached ATC context of an airport without refreshing its ATIS (for menus). */
  peekField(airport: Airport): FieldCtx {
    let ctx = this.fields.get(airport.icao);
    if (!ctx) {
      ctx = {
        info: fieldInfo(airport),
        tracker: new AtisLetterTracker(airport.icao, this.utcMs),
        report: null,
        inUse: null,
        magVarDeg: magneticDeclinationDeg(airport.position.lat, airport.position.lon, airport.elevationM, this.utcMs),
      };
      this.fields.set(airport.icao, ctx);
    }
    return ctx;
  }

  /** Recompute observation, runways in use and the ATIS letter of a field (allocates; ~1 Hz). */
  refreshAtis(ctx: FieldCtx): void {
    const w = this.weather;
    if (!w) return;
    const ap = ctx.info.airport;
    const obs = observeSurface(w, ap.elevationM);
    ctx.inUse = runwaysInUse(ap, obs.windDirTrueDeg, obs.windSpeedKt);
    const idents = ctx.inUse ? ctx.inUse.all.map((r) => r.ident) : [];
    const changed = ctx.tracker.update(this.utcMs, atisContentKey(obs, idents));
    if (!changed && ctx.report) return;
    const ils = ctx.inUse?.primary.end.ils ? ctx.inUse.primary.ident : undefined;
    const lowWx = obs.visibilitySM < 5 || obs.layers.some((l) => (l.cover === 'BKN' || l.cover === 'OVC') && l.baseFtAgl <= 3000);
    ctx.report = buildAtis({
      airport: ap, weather: w, letter: ctx.tracker.letter, utcMs: ctx.tracker.issuedUtcMs, runways: idents,
      magVarDeg: ctx.magVarDeg, ilsRunway: lowWx ? ils : undefined, automated: !ctx.info.atis && !!ctx.info.awos,
    });
    this.menuDirty = true;
  }

  /** Callsign form the pilot uses now: full until the controller abbreviates it. */
  pilotCallsign(): Spoken {
    return this.abbreviated ? this.callsign.short : this.callsign.full;
  }

  /** Switch COM to a facility; a new facility means a new first contact. */
  tune(f: Facility): void {
    if (this.facility && this.facility.mhz === f.mhz && this.facility.kind === f.kind) return;
    this.facility = f;
    this.abbreviated = false;
    this.menuDirty = true;
  }

  /** Pilot transmission on a facility (tunes it first). Any readback still pending is dropped (its moment has passed). */
  pilotSays(f: Facility, build: (cs: Spoken) => Spoken): void {
    this.pendingReadback = null;
    this.tune(f);
    this.radio.transmit('pilot', build(this.pilotCallsign()), f.mhz);
    this.menuDirty = true;
  }

  /** CTAF self-announcement (type + last three; nobody abbreviates on CTAF). */
  announce(f: Facility, build: (cs: Spoken) => Spoken): void {
    this.pendingReadback = null;
    this.tune(f);
    this.radio.transmit('pilot', build(this.callsign.short), f.mhz);
    this.menuDirty = true;
  }

  /** Controller reply after the deterministic 1.5–2.75 s latency; `then` runs when it goes out. */
  atcReplies(f: Facility, build: (cs: Spoken) => Spoken, then: (() => void) | null = null): void {
    this.radio.schedule('atc', build(this.callsign.short), f.mhz, this.replyDelayS(), () => {
      if (this.facility === f) this.abbreviated = true;
      then?.();
      this.menuDirty = true;
    });
  }

  /** Unsolicited controller call, now. */
  atcCalls(f: Facility, build: (cs: Spoken) => Spoken): void {
    this.radio.transmit('atc', build(this.callsign.short), f.mhz);
    if (this.facility === f) this.abbreviated = true;
    this.menuDirty = true;
  }

  /** Ask the pilot to read an instruction back (offered as the first menu option). */
  expectReadback(f: Facility, label: string, build: (cs: Spoken) => Spoken, then: (() => void) | null = null): void {
    this.pendingReadback = { facility: f, label, build, then };
    this.menuDirty = true;
  }

  /** Deterministic controller latency, s. */
  replyDelayS(): number {
    return REPLY_DELAY_MIN_S + (REPLY_DELAY_MAX_S - REPLY_DELAY_MIN_S) * this.rnd();
  }

  /** New discrete transponder code (octal digits; avoids 1200/7500/7600/7700 by starting at 2–6). */
  newSquawk(): number {
    const d = (n: number): number => Math.floor(this.rnd() * n);
    return (2 + d(5)) * 1000 + d(8) * 100 + d(8) * 10 + d(8);
  }

  /** Current surface wind of a field as the tower says it (magnetic). */
  windOf(ctx: FieldCtx): Spoken {
    const r = ctx.report;
    return r ? wind(r.windDirDeg, r.obs.windSpeedKt, r.obs.windGustKt) : wind(0, 0);
  }

  /** Altimeter setting of a field, inHg (standard when the weather is unknown). */
  altimeterOf(ctx: FieldCtx): number {
    return ctx.report?.obs.altimeterInHg ?? 29.92;
  }

  /** ATIS letter the pilot has for a field, or null. */
  heardLetter(ctx: FieldCtx): string | null {
    return this.atisHeard.get(ctx.info.airport.icao) ?? null;
  }

  /** Current ATIS letter of a field (null for AWOS / no ATIS). */
  currentLetter(ctx: FieldCtx): string | null {
    return ctx.info.atis && ctx.report ? ctx.report.letter : null;
  }

  /** Forget everything flight-specific (keeps per-airport ATIS trackers and the clock). */
  resetFlight(): void {
    this.radio.clear();
    this.atisHeard.clear();
    this.field = null; this.facility = null; this.abbreviated = false; this.runway = null;
    this.side = 'left'; this.leg = 'outside'; this.intent = 'departure'; this.landingIntent = 'full-stop';
    this.landingClearance = 'none'; this.entry = null; this.clearanceReceived = false; this.squawk = 1200;
    this.flightFollowing = null; this.pendingReadback = null; this.inboundSuppressed = null;
    this.inboundCancelM = this.tuning.inboundCancelRangeM;
    this.stoppedS = 0; this.airborneS = 0; this.groundS = 0;
    this.phase = 'PARKED';
    const f = this.flags;
    f.timeS = 0; f.callIssued = false; f.minHeightM = Infinity; f.climbS = 0; f.touchedDown = false; f.outsideS = 0; f.armed = true; f.joined = false;
    this.menuDirty = true;
  }
}
