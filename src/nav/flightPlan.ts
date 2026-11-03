/**
 * Flight planner: an ordered list of waypoints with automatic leg sequencing.
 *
 * `activeLeg` is the index of the active (TO) waypoint; the FROM point is the previous
 * waypoint, or the position where a direct-to was activated. Sequencing is fly-by: the next
 * leg becomes active when the remaining along-track distance drops below the turn-anticipation
 * distance for the upcoming course change (r·tan(Δ/2) at the current ground speed and 25°
 * bank), or when the waypoint has been passed abeam. The final waypoint is never sequenced
 * past; `complete` becomes true once it has been passed.
 *
 * Editing follows the G1000: `insert` / `remove` keep the active waypoint (except that a waypoint
 * inserted into the active leg becomes its TO waypoint), `activateLeg` flies the leg into a
 * waypoint from its predecessor, `directToWaypoint` goes direct to a waypoint of the plan (the
 * occurrence ahead when an ident appears twice) or, for one that is not in it, "off-route" — the stored plan is kept, inactive, until
 * a leg is activated again or the direct-to is cancelled. `setObs` is the GPS OBS mode: a
 * selected course through the active waypoint with sequencing suspended. `version` increments on
 * every change so displays can detect edits cheaply.
 */
import type { Geodetic, Waypoint } from '../core/types';
import { deltaDeg, wrap360 } from '../core/math';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import type { FlightPlanEx } from './navTypes';
import { legGeometry, turnAnticipationM, type LegGeometry } from './radio';

/** Minimum ground speed for ETE computation, m/s. */
const MIN_GS_MS = 1;
/** Distance from the waypoint to the synthetic FROM point of a GPS OBS course, m. */
const OBS_ORIGIN_M = 50_000;
/** Two waypoints with the same id closer than this are the same waypoint, m. */
const SAME_WAYPOINT_M = 2_000;

/** How `directToWaypoint` resolved its target. */
export type DirectToKind = 'in-plan' | 'off-route' | 'new-plan';

export class FlightPlanner {
  readonly waypoints: Waypoint[] = [];
  private activeIndex = 0;
  /** origin of the active leg when it was started by direct-to (else the previous waypoint) */
  private directOrigin: Geodetic | null = null;
  /** off-route direct-to target (not in `waypoints`), or null */
  private offRoute: Waypoint | null = null;
  private readonly offRouteList: Waypoint[] = [];
  private obsTrueDeg: number | null = null;
  private obsOrigin: Geodetic | null = null;
  private readonly obsKey = { course: NaN, lat: NaN, lon: NaN };
  private versionCounter = 0;
  private readonly geo: LegGeometry = legGeometry({ lat: 0, lon: 0, alt: 0 }, { lat: 1, lon: 0, alt: 0 }, { lat: 0, lon: 0, alt: 0 });
  private readonly plan: FlightPlanEx = {
    waypoints: this.waypoints,
    activeLeg: 0,
    desiredTrackDeg: 0,
    crossTrackM: 0,
    distanceToActiveM: 0,
    bearingToActiveDeg: 0,
    eteS: Infinity,
    totalDistanceM: 0,
    remainingDistanceM: 0,
    eteTotalS: Infinity,
    complete: false,
    directTo: false,
    offRoute: false,
    legFrom: { lat: 0, lon: 0, alt: 0 },
    obsCourseDeg: null,
    version: 0,
  };
  private lastPos: Geodetic | null = null;

  constructor(waypoints: Waypoint[] = [], public bankDeg = 25) {
    for (const w of waypoints) this.waypoints.push(w);
    this.resetActive();
  }

  /** Index of the active (TO) waypoint in `waypoints` (meaningless while an off-route D→ is active). */
  get activeLeg(): number { return this.activeIndex; }

  /** The waypoint being flown to: the off-route D→ target or the active plan waypoint. */
  get activeWaypoint(): Waypoint | undefined { return this.offRoute ?? this.waypoints[this.activeIndex]; }

  /** Latest computed plan state (same object every update). */
  get state(): FlightPlanEx { return this.plan; }

  /** Increments on every edit, activation, direct-to, OBS change and automatic sequencing. */
  get version(): number { return this.versionCounter; }

  /** True while the active leg is a direct-to (in-plan or off-route). */
  get isDirectTo(): boolean { return this.offRoute !== null || this.directOrigin !== null; }

  /** Off-route direct-to target, or null. */
  get offRouteTarget(): Waypoint | null { return this.offRoute; }

  /** GPS OBS course (deg true) or null when OBS mode is off. */
  get obsCourseDeg(): number | null { return this.obsTrueDeg; }

  /** Index of the first waypoint with this id (case-insensitive), or −1. */
  indexOfId(id: string): number {
    const q = id.trim().toUpperCase();
    for (let i = 0; i < this.waypoints.length; i++) if (this.waypoints[i].id.toUpperCase() === q) return i;
    return -1;
  }

  /** Replace all waypoints (cancels any direct-to and OBS). */
  setWaypoints(waypoints: Waypoint[]): void {
    this.waypoints.length = 0;
    for (const w of waypoints) this.waypoints.push(w);
    this.directOrigin = null;
    this.offRoute = null;
    this.obsTrueDeg = null;
    this.resetActive();
    this.bump();
  }

  /** Append a waypoint. */
  add(w: Waypoint): void {
    this.waypoints.push(w);
    if (this.waypoints.length === 2 && this.activeIndex === 0 && !this.directOrigin) this.activeIndex = 1;
    this.plan.complete = false;
    this.bump();
  }

  /**
   * Insert before `index` (clamped). Inserted into the active leg — between its FROM and TO
   * waypoints, no direct-to — the new waypoint becomes the TO waypoint (A → X → B is flown A → X,
   * as on the G1000); anywhere else the active waypoint stays the same waypoint object.
   */
  insert(index: number, w: Waypoint): void {
    const i = Math.max(0, Math.min(Math.trunc(index), this.waypoints.length));
    this.waypoints.splice(i, 0, w);
    const intoActiveLeg = i === this.activeIndex && i > 0 && this.directOrigin === null && this.offRoute === null;
    if (i <= this.activeIndex && this.waypoints.length > 1 && !intoActiveLeg) this.activeIndex++;
    this.plan.complete = false;
    this.bump();
  }

  /** Remove the waypoint at `index`. Removing the active one activates the next. */
  remove(index: number): void {
    if (index < 0 || index >= this.waypoints.length) return;
    // Decide before re-indexing: only removing the active waypoint cancels a direct-to.
    const removedActive = index === this.activeIndex;
    this.waypoints.splice(index, 1);
    if (index < this.activeIndex) this.activeIndex--;
    if (this.activeIndex >= this.waypoints.length) this.activeIndex = Math.max(0, this.waypoints.length - 1);
    if (this.offRoute) {
      // the D→ keeps flying; an emptied plan adopts the D→ target so the planner stays non-empty
      if (this.waypoints.length === 0) { this.waypoints.push(this.offRoute); this.activeIndex = 0; this.offRoute = null; }
    } else if (removedActive) this.directOrigin = null;
    this.plan.complete = false;
    this.bump();
  }

  /** Remove everything. */
  clear(): void { this.setWaypoints([]); }

  /**
   * Direct-to the waypoint at `index` (or a new user waypoint appended to the plan) from the
   * aircraft's current position.
   */
  directTo(target: number | Waypoint, from: Geodetic): void {
    let index: number;
    if (typeof target === 'number') index = target;
    else {
      index = this.waypoints.indexOf(target);
      if (index < 0) { this.waypoints.push(target); index = this.waypoints.length - 1; }
    }
    if (index < 0 || index >= this.waypoints.length) return;
    this.offRoute = null;
    this.activeIndex = index;
    this.directOrigin = { lat: from.lat, lon: from.lon, alt: from.alt };
    this.plan.complete = false;
    this.bump();
  }

  /**
   * G1000 direct-to: to the plan's own waypoint when one has the same id (and position), else
   * off-route — the stored plan is kept, inactive, and `state.waypoints` becomes `[w]`. With an
   * empty plan the waypoint becomes the plan.
   */
  directToWaypoint(w: Waypoint, from: Geodetic): DirectToKind {
    const i = this.findSame(w);
    if (i >= 0) { this.directTo(i, from); return 'in-plan'; }
    if (this.waypoints.length === 0) { this.directTo(w, from); return 'new-plan'; }
    this.offRoute = w;
    this.directOrigin = { lat: from.lat, lon: from.lon, alt: from.alt };
    this.plan.complete = false;
    this.bump();
    return 'off-route';
  }

  /**
   * Cancel a direct-to: an off-route D→ returns to the stored plan's active leg, an in-plan D→
   * flies the leg into the same waypoint from its predecessor.
   */
  cancelDirectTo(): void {
    if (!this.isDirectTo) return;
    this.offRoute = null;
    this.directOrigin = null;
    this.plan.complete = false;
    this.bump();
  }

  /** Activate the leg into waypoint `index` (FROM = the previous waypoint); cancels any D→. */
  activateLeg(index: number): void {
    if (index < 0 || index >= this.waypoints.length) return;
    this.activeIndex = index;
    this.directOrigin = null;
    this.offRoute = null;
    this.plan.complete = false;
    this.bump();
  }

  /** Alias of {@link activateLeg}. */
  activate(index: number): void { this.activateLeg(index); }

  /** GPS OBS mode: fly `courseTrueDeg` through the active waypoint without sequencing; null resumes. */
  setObs(courseTrueDeg: number | null): void {
    const v = courseTrueDeg === null || !Number.isFinite(courseTrueDeg) ? null : wrap360(courseTrueDeg);
    if (v === this.obsTrueDeg) return;
    this.obsTrueDeg = v;
    this.bump();
  }

  /** Sum of all leg lengths of the stored plan, m. */
  totalDistanceM(): number {
    let d = 0;
    for (let i = 1; i < this.waypoints.length; i++) d += greatCircleDistance(this.waypoints[i - 1].position, this.waypoints[i].position);
    return d;
  }

  /**
   * Update from the aircraft's position and ground speed. Sequences legs automatically and
   * returns the (reused) `FlightPlan` object, or null when the plan is empty.
   */
  update(pos: Geodetic, groundSpeedMs: number): FlightPlanEx | null {
    const n = this.waypoints.length;
    if (n === 0 && !this.offRoute) return null;
    this.lastPos = pos;
    if (this.activeIndex >= n) this.activeIndex = Math.max(0, n - 1);
    const p = this.plan;

    // Direct-to with no origin yet (single-waypoint plan): fly direct from the current position.
    if (!this.offRoute && this.activeIndex === 0 && !this.directOrigin) { this.directOrigin = { lat: pos.lat, lon: pos.lon, alt: pos.alt }; this.bump(); }

    if (this.offRoute || this.obsTrueDeg !== null) {
      // a single leg, never sequenced: off-route D→ and/or OBS course through the target
      const to = this.offRoute ?? this.waypoints[this.activeIndex];
      const from = this.obsTrueDeg !== null ? this.obsFrom(to) : this.legOrigin();
      legGeometry(from, to.position, pos, this.geo);
      if (this.obsTrueDeg !== null) this.geo.desiredTrackDeg = this.obsTrueDeg;
      p.complete = this.geo.remainingM < 0 && (this.offRoute !== null || this.activeIndex === n - 1);
      if (this.offRoute) { this.offRouteList.length = 0; this.offRouteList.push(this.offRoute); }
      p.waypoints = this.offRoute ? this.offRouteList : this.waypoints;
      p.activeLeg = this.offRoute ? 0 : this.activeIndex;
      this.copyFrom(from);
    } else {
      for (let guard = 0; guard < n; guard++) {
        const to = this.waypoints[this.activeIndex];
        const from = this.legOrigin();
        legGeometry(from, to.position, pos, this.geo);
        const hasNext = this.activeIndex + 1 < n;
        if (!hasNext) {
          if (this.geo.remainingM < 0) p.complete = true;
          break;
        }
        const next = this.waypoints[this.activeIndex + 1];
        const courseChange = deltaDeg(initialBearingDeg(to.position, next.position), this.geo.desiredTrackDeg);
        const anticipation = turnAnticipationM(groundSpeedMs, courseChange, this.bankDeg);
        const passedAbeam = this.geo.remainingM <= 0;
        if (passedAbeam || (this.geo.remainingM <= anticipation && this.geo.distanceToEndM <= Math.max(anticipation * 1.5, 1))) {
          this.activeIndex++;
          this.directOrigin = null;
          this.bump();
          continue;
        }
        break;
      }
      p.waypoints = this.waypoints;
      p.activeLeg = this.activeIndex;
      this.copyFrom(this.legOrigin());
    }

    p.directTo = this.isDirectTo;
    p.offRoute = this.offRoute !== null;
    p.obsCourseDeg = this.obsTrueDeg;
    p.desiredTrackDeg = this.geo.desiredTrackDeg;
    p.crossTrackM = this.geo.crossTrackM;
    p.distanceToActiveM = this.geo.distanceToEndM;
    p.bearingToActiveDeg = this.geo.bearingToEndDeg;
    let remaining = this.geo.distanceToEndM;
    if (!this.offRoute) for (let i = this.activeIndex + 1; i < n; i++) remaining += greatCircleDistance(this.waypoints[i - 1].position, this.waypoints[i].position);
    p.remainingDistanceM = remaining;
    p.totalDistanceM = this.offRoute ? this.geo.legLengthM : this.totalDistanceM();
    const gs = groundSpeedMs > MIN_GS_MS ? groundSpeedMs : 0;
    p.eteS = gs ? p.distanceToActiveM / gs : Infinity;
    p.eteTotalS = gs ? remaining / gs : Infinity;
    p.version = this.versionCounter;
    return p;
  }

  /** The FROM point of the active leg. */
  legOrigin(): Geodetic {
    if (this.directOrigin) return this.directOrigin;
    if (this.activeIndex > 0) return this.waypoints[this.activeIndex - 1].position;
    return this.lastPos ?? this.waypoints[0].position;
  }

  private obsFrom(to: Waypoint): Geodetic {
    const k = this.obsKey, course = this.obsTrueDeg ?? 0, g = to.position;
    if (!this.obsOrigin || k.course !== course || k.lat !== g.lat || k.lon !== g.lon) {
      this.obsOrigin = destinationPoint(g, course + 180, OBS_ORIGIN_M);
      k.course = course; k.lat = g.lat; k.lon = g.lon;
    }
    return this.obsOrigin;
  }

  private copyFrom(g: Geodetic): void {
    const f = this.plan.legFrom;
    f.lat = g.lat; f.lon = g.lon; f.alt = g.alt;
  }

  /**
   * Index of `w` in the plan: the very object, else a waypoint with the same id and position —
   * the first one from the active leg on (a round trip's destination, not its departure), else
   * the first one behind it. −1 when there is none.
   */
  private findSame(w: Waypoint): number {
    const wps = this.waypoints, n = wps.length;
    const i0 = this.indexOf(w);
    if (i0 >= 0) return i0;
    const id = w.id.toUpperCase(), start = Math.min(Math.max(this.activeIndex, 0), n);
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n, c = wps[i];
      if (c.id.toUpperCase() === id && greatCircleDistance(c.position, w.position) < SAME_WAYPOINT_M) return i;
    }
    return -1;
  }

  private indexOf(w: Waypoint): number {
    for (let i = 0; i < this.waypoints.length; i++) if (this.waypoints[i] === w) return i;
    return -1;
  }

  private bump(): void { this.versionCounter = (this.versionCounter + 1) | 0; }

  private resetActive(): void {
    this.activeIndex = this.waypoints.length >= 2 ? 1 : 0;
    this.plan.complete = false;
  }
}

/** Convenience: a waypoint from an airport-like object. */
export const waypointFromAirport = (a: { icao: string; position: Geodetic }): Waypoint => ({ id: a.icao, position: a.position, type: 'airport' });

/** Convenience: a waypoint from a navaid-like object. */
export const waypointFromNavaid = (n: { id: string; position: Geodetic }): Waypoint => ({ id: n.id, position: n.position, type: 'navaid' });
