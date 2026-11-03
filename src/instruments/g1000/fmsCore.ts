/**
 * Core types of the G1000 FMS user interface: the context every window works through (nav
 * database, flight planner, aircraft position, command sink), the window base class, the
 * cursor-edited ident field (spell'n'find) and waypoint helpers. Pure logic, no drawing.
 */
import type { Airport, FlightPlan, Geodetic, Navaid, Waypoint } from '../../core/types';
import type { ApproachInfo, FlightPlanner, IdentMatch } from '../../nav';
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import type { G1000Command, G1000Display } from './input';

/** The parts of the nav database the G1000 uses (structurally satisfied by `NavDb`). */
export interface G1000NavDb {
  getAirport(icao: string): Airport | undefined;
  nearestAirports(pos: Geodetic, maxCount: number, maxNm: number): readonly Airport[];
  nearestNavaids(pos: Geodetic, maxCount: number, maxNm: number): readonly Navaid[];
  searchIdents?(prefix: string, pos: Geodetic, limit?: number): readonly IdentMatch[];
}

/** The flight-planner operations the G1000 uses (structurally satisfied by `FlightPlanner`). */
export type G1000Planner = Pick<FlightPlanner,
  'waypoints' | 'activeLeg' | 'version' | 'isDirectTo' | 'offRouteTarget' | 'obsCourseDeg' | 'activeWaypoint'
  | 'insert' | 'remove' | 'directToWaypoint' | 'cancelDirectTo' | 'activateLeg' | 'clear' | 'setObs' | 'indexOfId'>;

/** Something a window can go direct to or show: a database match, a plan waypoint, … */
export interface FmsTarget {
  ident: string;
  kind: 'airport' | 'vor' | 'ndb' | 'fix' | 'user';
  name: string;
  position: Geodetic;
  /** navaid frequency, kHz (0 when none) */
  frequencyKHz: number;
  /** the flight-plan waypoint this target was picked from (FPL cursor), so D→ goes to that very one */
  waypoint?: Waypoint;
}

export const targetFromMatch = (m: IdentMatch): FmsTarget => ({ ident: m.ident, kind: m.kind, name: m.name, position: m.position, frequencyKHz: m.frequencyKHz });
export const targetFromAirport = (a: Airport): FmsTarget => ({ ident: a.icao, kind: 'airport', name: a.name, position: a.position, frequencyKHz: 0 });
export const targetFromNavaid = (n: Navaid): FmsTarget => ({ ident: n.id, kind: n.type === 'NDB' ? 'ndb' : 'vor', name: n.name, position: n.position, frequencyKHz: n.frequencyKHz });
export const targetFromWaypoint = (w: Waypoint): FmsTarget => ({ ident: w.id, kind: w.type === 'airport' ? 'airport' : w.type === 'navaid' ? 'vor' : w.type, name: '', position: w.position, frequencyKHz: 0, waypoint: w });
export const waypointFromTarget = (t: FmsTarget): Waypoint => ({
  id: t.ident, position: { lat: t.position.lat, lon: t.position.lon, alt: t.position.alt },
  type: t.kind === 'airport' ? 'airport' : t.kind === 'vor' || t.kind === 'ndb' ? 'navaid' : t.kind,
});

/** Inputs a window receives (FMS knob rings, its push, the hard keys, typed characters). */
export interface FmsEvent {
  key: 'inner' | 'outer' | 'push' | 'ENT' | 'CLR' | 'MENU' | 'char';
  /** detents for inner/outer (signed) */
  steps: number;
  /** the typed character for 'char' ('\b' = backspace) */
  char: string;
}

/** Shared services and live data for windows; implemented by `G1000Fms`. */
export interface FmsContext {
  readonly nav: G1000NavDb | null;
  readonly planner: G1000Planner | null;
  /** the snapshot's flight plan at the last update (live DIS/ETE, D→ origin) */
  readonly plan: FlightPlan | null;
  /** aircraft position at the last update */
  readonly pos: Geodetic;
  readonly gsKt: number;
  /** magnetic variation, deg east (true = magnetic + var) */
  readonly magVarDeg: number;
  emit(c: G1000Command): void;
  open(display: G1000Display, w: FmsWindow): void;
  close(w: FmsWindow): void;
  /** something visible changed (redraw) */
  touch(): void;
  /** load a COM standby frequency (kHz): the G1000's own COM box shows it and a request goes out */
  comStandby(radio: 1 | 2, kHz: number): void;
  /** activate a direct-to (through the planner); returns false without a planner */
  directTo(t: FmsTarget): boolean;
  /** identifier search (exact first, then nearest) */
  search(prefix: string, limit: number): readonly IdentMatch[];
  /** load (or load and activate) an approach: fixes into the plan, LOC into NAV1, CDI handling */
  loadApproach(a: ApproachInfo, activate: boolean): void;
  /** the airport PROC starts with: destination, else the D→ airport, else the nearest */
  procAirport(): Airport | null;
}

/** Everything a window may read while drawing. */
export interface WindowDrawData {
  readonly ctx: FmsContext;
  readonly r: InstrumentReadings;
  /** PFD windows use a smaller type scale */
  readonly compact: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** A popup window or MFD page with its own cursor handling. */
export abstract class FmsWindow {
  abstract readonly kind: 'direct' | 'fpl' | 'nrst' | 'proc' | 'tmrref' | 'alerts' | 'menu' | 'confirm';
  /** the display that owns the window (set by `FmsContext.open`) */
  display: G1000Display = 'mfd';
  /** shows values that change as the aircraft moves (redraw on position changes) */
  live = false;
  constructor(protected readonly fms: FmsContext) {}
  /** handle an FMS event; true when consumed */
  abstract input(e: FmsEvent): boolean;
  abstract draw(ctx: Ctx2D, rect: Rect, d: WindowDrawData): void;
  /** the cursor-selected item, used to prefill D→ */
  selection(): FmsTarget | null { return null; }
  /** true while an ident field is being edited (keyboard routing) */
  editing(): boolean { return false; }
  /** true when ENT / CLR (keyboard Enter / Escape) act on the window; passive windows leave them to the simulator */
  takesKeys(): boolean { return true; }
  /** called every update while open with the elapsed time, s */
  refresh(_dt: number): void {}
}

/** Characters the small FMS knob cycles through in an ident field. */
export const IDENT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Cursor-edited identifier (G1000 "spell'n'find"): the inner knob changes the character under
 * the cursor (and clears the ones after it), the outer knob moves the cursor, typed characters
 * are entered at the cursor and advance it. `completion` is the best database match for the
 * entered prefix; ENT accepts it.
 */
export class IdentField {
  private chars: string[] = [];
  /** cursor position (0 … maxLen − 1) */
  pos = 0;
  /** text entered so far (cached string) */
  text = '';
  /** best matching ident for `text` ('' when none) */
  completion = '';
  /** true between the first change and ENT/CLR */
  active = false;

  constructor(readonly maxLen = 6) {}

  /** Start fresh with `initial` shown (not yet editing). */
  reset(initial = ''): void {
    this.chars = initial.toUpperCase().slice(0, this.maxLen).split('');
    this.pos = 0; this.active = false; this.sync(); this.completion = this.text;
  }

  /** Inner knob: step the character at the cursor; the following characters are cleared. */
  turn(steps: number): void {
    if (!steps) return;
    const n = IDENT_CHARS.length;
    const cur = this.chars[this.pos];
    let idx = cur === undefined ? (steps > 0 ? -1 : 0) : IDENT_CHARS.indexOf(cur);
    if (!this.active && this.pos === 0) {
      // the first turn of a fresh field starts a new ident from its first character
      this.chars.length = 1;
      if (cur === undefined) idx = steps > 0 ? -1 : 0;
    }
    idx = (((idx + steps) % n) + n) % n;
    this.chars[this.pos] = IDENT_CHARS[idx];
    this.chars.length = this.pos + 1;
    this.active = true;
    this.sync();
  }

  /** Outer knob: move the cursor (to at most one past the last character). */
  move(steps: number): void {
    const comp = this.shown;
    const max = Math.min(Math.max(this.chars.length, comp.length), this.maxLen - 1);
    const p = Math.max(0, Math.min(max, this.pos + steps));
    if (p === this.pos) return;
    // moving right over auto-completed characters adopts them as entered
    for (let i = this.chars.length; i <= p && i < comp.length; i++) this.chars.push(comp[i]);
    this.pos = p;
    this.active = true;
    this.sync();
  }

  /** A typed character (A–Z, 0–9) or '\b' for backspace. Returns false for other characters. */
  type(ch: string): boolean {
    if (ch === '\b') {
      // a field not yet edited (prefilled, cursor on its first character) is erased from the end
      if (!this.active) this.pos = this.chars.length;
      if (this.pos >= this.chars.length && this.chars.length) { this.chars.pop(); this.pos = Math.max(0, this.chars.length); }
      else if (this.chars.length) { this.chars.splice(this.pos, 1); }
      this.active = true; this.sync();
      return true;
    }
    const c = ch.toUpperCase();
    if (c.length !== 1 || IDENT_CHARS.indexOf(c) < 0) return false;
    if (!this.active) { this.chars.length = 0; this.pos = 0; }
    this.chars[this.pos] = c;
    this.chars.length = this.pos + 1;
    this.pos = Math.min(this.pos + 1, this.maxLen - 1);
    this.active = true;
    this.sync();
    return true;
  }

  /** What the field shows: the completion when it extends the entered text, else the text. */
  get shown(): string { return this.completion && this.completion.startsWith(this.text) ? this.completion : this.text; }

  private sync(): void { this.text = this.chars.join(''); }
}

/** Great-circle helpers in nm/deg that do not allocate. */
const D2R = Math.PI / 180, R_NM = 6371008.8 / 1852;
export function distanceNmGeo(a: Geodetic, b: Geodetic): number {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dp = p2 - p1, dl = (b.lon - a.lon) * D2R;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
export function bearingDegGeo(a: Geodetic, b: Geodetic): number {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}
