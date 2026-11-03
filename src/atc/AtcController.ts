/**
 * Menu-driven scripted ATC (MSFS style). Feed it the aircraft state and weather every frame;
 * it detects flight phases, makes unsolicited controller calls (handoffs, landing clearance,
 * go-around, runway exit), publishes the numbered options for the current situation and, when
 * the user picks one, transmits the pilot's call followed 1.5–2.75 s (sim time) later by the
 * controller's reply. Pure logic: no DOM, no Three.js, no timers or randomness — speech and
 * subtitles go out through callbacks.
 *
 * ```ts
 * const atc = new AtcController({ callsign: 'N172FS', aircraftType: 'Cessna', nav: db,
 *   emit: (m) => bus.emit('atc:message', m), emitOptions: (o) => bus.emit('atc:options', { options: o }),
 *   speak: (t, v) => audio.speak(t, v) });
 * atc.reset(db.getAirport('KSFO') ?? null);
 * // every frame:            atc.update(dt, snapshot.aircraft, snapshot.weather, snapshot.time.utcMs);
 * // on 'atcOption1'..'0':   atc.select(n);   // 1..9, 0 = 10th
 * ```
 */
import type { AircraftState, Airport, WeatherState } from '../core/types';
import { FT, NM } from '../core/units';
import type { PatternLeg } from './geometry';
import { buildMenu, type MenuItem } from './menu';
import { holdShortRunwayAt, monitorPhase, nearestField, onEdge, updateKinematics, updateRunwayGeometry, type InboundWatch } from './monitors';
import { AtcSession } from './session';
import type { AtcControllerOptions, AtcPhase, AtcTuning, LandingClearance } from './types';

/** Default thresholds (FAA-typical VFR operations in a light single). */
export const DEFAULT_ATC_TUNING: Readonly<AtcTuning> = {
  handoffDistanceM: 3 * NM,
  handoffHeightM: 2000 * FT,
  inboundRangeM: 12 * NM,
  inboundCancelRangeM: 15 * NM,
  landingClearanceRangeM: 3.2 * NM,
  goAroundMaxHeightM: 500 * FT,
  goAroundClimbMs: 1.5,
  stoppedSpeedMs: 0.5,
  patternExitRangeM: 5 * NM,
  exitRunwaySpeedMs: 10,
};

/** Range within which the aircraft is considered at an airport when (re)starting, nm. */
const AT_AIRPORT_NM = 3;

export class AtcController {
  private readonly s: AtcSession;
  private readonly emitOptions: (options: string[]) => void;
  private menu: MenuItem[] = [];
  private labels: string[] = [];
  private lastOptionsKey: string | null = null;
  private readonly airborne = { value: false };
  private readonly watch: InboundWatch = { icao: '', lastRangeM: 0, closingS: 0 };
  private slowAccS = 0;
  private started = false;
  private departure: Airport | null = null;

  /**
   * @param opts callsign/type, nav database, output callbacks, optional clock and seed
   * @param tuning overrides of {@link DEFAULT_ATC_TUNING}
   */
  constructor(opts: AtcControllerOptions, tuning: Partial<AtcTuning> = {}) {
    this.s = new AtcSession(opts.callsign, opts.aircraftType, opts.nav, { emit: opts.emit, speak: opts.speak },
      { ...DEFAULT_ATC_TUNING, ...tuning }, opts.utcMs, opts.seed);
    this.emitOptions = opts.emitOptions;
  }

  /** Current flight phase. */
  get phase(): AtcPhase { return this.s.phase; }
  /** Frequency of the facility the pilot is talking to (COM1), MHz, or null before the first call. */
  get frequencyMHz(): number | null { return this.s.facility?.mhz ?? null; }
  /** Labels of the options currently offered (same list last passed to `emitOptions`). */
  get options(): readonly string[] { return this.labels; }
  /** True while a controller reply is pending (selections are ignored meanwhile). */
  get awaitingReply(): boolean { return this.s.radio.busy; }
  /** Transponder code currently assigned (1200 = VFR). */
  get squawk(): number { return this.s.squawk; }
  /** Landing clearance held. */
  get landingClearance(): LandingClearance { return this.s.landingClearance; }
  /** Pattern leg while in PATTERN ('outside' otherwise). */
  get patternLeg(): PatternLeg { return this.s.phase === 'PATTERN' ? this.s.leg : 'outside'; }
  /** ICAO of the airport of the current operation (departure or destination), or null. */
  get airportIcao(): string | null { return this.s.field?.info.airport.icao ?? null; }
  /** Runway of the current operation, e.g. "28R", or null. */
  get runwayIdent(): string | null { return this.s.runway?.ident ?? null; }
  /** Current ATIS letter of the operation's airport (null without ATIS). */
  get atisLetter(): string | null { return this.s.field ? this.s.currentLetter(this.s.field) : null; }
  /** METAR-style line of the operation's airport, or null. */
  get metar(): string | null { return this.s.field?.report?.metar ?? null; }

  /**
   * Advance by `dt` seconds of simulation time. `utcMs` (optional) re-syncs the world clock
   * (pass `snapshot.time.utcMs`); otherwise the clock advances by `dt`.
   */
  update(dt: number, ac: AircraftState, weather: WeatherState, utcMs?: number): void {
    const s = this.s;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    s.utcMs = utcMs !== undefined && Number.isFinite(utcMs) ? utcMs : s.utcMs + step * 1000;
    s.ac = ac;
    s.weather = weather;
    if (!this.started) this.start();
    s.radio.update(step);
    const edge = updateKinematics(s, step, this.airborne);
    if (edge) onEdge(s, edge);
    updateRunwayGeometry(s);
    this.slowAccS += step;
    let slowTickS = 0;
    if (this.slowAccS >= 1) {
      slowTickS = this.slowAccS;
      this.slowAccS = 0;
      if (s.field) s.refreshAtis(s.field);
    }
    monitorPhase(s, step, slowTickS, this.watch);
    this.publishOptions();
  }

  /**
   * Pick option `optionIndex` (1..9, 0 = 10th) of the current list. Returns false when there
   * is no such option or a controller reply is still pending.
   */
  select(optionIndex: number): boolean {
    const i = optionIndex === 0 ? 9 : Math.floor(optionIndex) - 1;
    if (i < 0 || i >= this.menu.length || this.s.radio.busy || !this.started) return false;
    this.menu[i].run();
    this.publishOptions();
    return true;
  }

  /**
   * Start over (new flight). `departure` is the airport the aircraft is at, or null to use the
   * nearest airport within 3 nm (airborne starts begin EN ROUTE). Takes effect on the next update.
   */
  reset(departure: Airport | null): void {
    this.s.resetFlight();
    this.departure = departure;
    this.started = false;
    this.airborne.value = false;
    this.watch.icao = ''; this.watch.closingS = 0;
    this.slowAccS = 0;
    this.menu = [];
    this.labels = [];
    this.lastOptionsKey = null;
  }

  /** First update after construction/reset: place the session at the departure airport or en route. */
  private start(): void {
    const s = this.s, ac = s.ac;
    if (!ac) return;
    this.started = true;
    if (!ac.onGround) {
      this.airborne.value = true;
      s.field = null;
      s.setPhase('ENROUTE');
      s.menuDirty = true;
      return;
    }
    s.field = this.departure ? s.fieldCtx(this.departure) : nearestField(s, AT_AIRPORT_NM);
    s.setPhase('PARKED');
    const onRunway = holdShortRunwayAt(s);
    if (onRunway) { s.runway = onRunway; s.setPhase('HOLDING_SHORT'); }
    s.menuDirty = true;
  }

  private publishOptions(): void {
    const s = this.s;
    if (!s.menuDirty || !this.started) return;
    s.menuDirty = false;
    this.menu = buildMenu(s);
    const labels = this.menu.map((m) => m.label);
    const key = labels.join('\n');
    if (key === this.lastOptionsKey) return;
    this.lastOptionsKey = key;
    this.labels = labels;
    this.emitOptions(labels.slice());
  }
}
