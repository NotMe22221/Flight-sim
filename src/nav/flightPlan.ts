/**
 * Flight planner: an ordered list of waypoints with automatic leg sequencing.
 *
 * `activeLeg` is the index of the active (TO) waypoint; the FROM point is the previous
 * waypoint, or the position where a direct-to was activated. Sequencing is fly-by: the next
 * leg becomes active when the remaining along-track distance drops below the turn-anticipation
 * distance for the upcoming course change (r·tan(Δ/2) at the current ground speed and 25°
 * bank), or when the waypoint has been passed abeam. The final waypoint is never sequenced
 * past; `complete` becomes true once it has been passed.
 */
import type { FlightPlan, Geodetic, Waypoint } from '../core/types';
import { deltaDeg } from '../core/math';
import { greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import type { FlightPlanEx } from './navTypes';
import { legGeometry, turnAnticipationM, type LegGeometry } from './radio';

/** Minimum ground speed for ETE computation, m/s. */
const MIN_GS_MS = 1;

export class FlightPlanner {
  readonly waypoints: Waypoint[] = [];
  private activeIndex = 0;
  /** origin of the active leg when it was started by direct-to (else the previous waypoint) */
  private directOrigin: Geodetic | null = null;
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
  };
  private lastPos: Geodetic | null = null;

  constructor(waypoints: Waypoint[] = [], public bankDeg = 25) {
    for (const w of waypoints) this.waypoints.push(w);
    this.resetActive();
  }

  /** Index of the active (TO) waypoint. */
  get activeLeg(): number { return this.activeIndex; }

  /** The active waypoint, if any. */
  get activeWaypoint(): Waypoint | undefined { return this.waypoints[this.activeIndex]; }

  /** Latest computed plan state (same object every update). */
  get state(): FlightPlanEx { return this.plan; }

  /** Replace all waypoints. */
  setWaypoints(waypoints: Waypoint[]): void {
    this.waypoints.length = 0;
    for (const w of waypoints) this.waypoints.push(w);
    this.directOrigin = null;
    this.resetActive();
  }

  /** Append a waypoint. */
  add(w: Waypoint): void {
    this.waypoints.push(w);
    if (this.waypoints.length === 2 && this.activeIndex === 0 && !this.directOrigin) this.activeIndex = 1;
    this.plan.complete = false;
  }

  /** Insert before `index` (clamped). The active waypoint stays the same waypoint object. */
  insert(index: number, w: Waypoint): void {
    const i = Math.max(0, Math.min(index, this.waypoints.length));
    this.waypoints.splice(i, 0, w);
    if (i <= this.activeIndex && this.waypoints.length > 1) this.activeIndex++;
    this.plan.complete = false;
  }

  /** Remove the waypoint at `index`. Removing the active one activates the next. */
  remove(index: number): void {
    if (index < 0 || index >= this.waypoints.length) return;
    this.waypoints.splice(index, 1);
    if (index < this.activeIndex) this.activeIndex--;
    if (this.activeIndex >= this.waypoints.length) this.activeIndex = Math.max(0, this.waypoints.length - 1);
    if (index === this.activeIndex) this.directOrigin = null;
    this.plan.complete = false;
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
    this.activeIndex = index;
    this.directOrigin = { lat: from.lat, lon: from.lon, alt: from.alt };
    this.plan.complete = false;
  }

  /** Manually activate the leg to waypoint `index` (FROM = previous waypoint). */
  activate(index: number): void {
    if (index < 0 || index >= this.waypoints.length) return;
    this.activeIndex = index;
    this.directOrigin = null;
    this.plan.complete = false;
  }

  /** Sum of all leg lengths, m. */
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
    if (n === 0) return null;
    this.lastPos = pos;
    if (this.activeIndex >= n) this.activeIndex = n - 1;

    // Direct-to with no origin yet (single-waypoint plan): fly direct from the current position.
    if (this.activeIndex === 0 && !this.directOrigin) this.directOrigin = { lat: pos.lat, lon: pos.lon, alt: pos.alt };

    for (let guard = 0; guard < n; guard++) {
      const to = this.waypoints[this.activeIndex];
      const from = this.legOrigin();
      legGeometry(from, to.position, pos, this.geo);
      const hasNext = this.activeIndex + 1 < n;
      if (!hasNext) {
        if (this.geo.remainingM < 0) this.plan.complete = true;
        break;
      }
      const next = this.waypoints[this.activeIndex + 1];
      const courseChange = deltaDeg(initialBearingDeg(to.position, next.position), this.geo.desiredTrackDeg);
      const anticipation = turnAnticipationM(groundSpeedMs, courseChange, this.bankDeg);
      const passedAbeam = this.geo.remainingM <= 0;
      if (passedAbeam || (this.geo.remainingM <= anticipation && this.geo.distanceToEndM <= Math.max(anticipation * 1.5, 1))) {
        this.activeIndex++;
        this.directOrigin = null;
        continue;
      }
      break;
    }

    const p = this.plan;
    p.activeLeg = this.activeIndex;
    p.desiredTrackDeg = this.geo.desiredTrackDeg;
    p.crossTrackM = this.geo.crossTrackM;
    p.distanceToActiveM = this.geo.distanceToEndM;
    p.bearingToActiveDeg = this.geo.bearingToEndDeg;
    let remaining = this.geo.distanceToEndM;
    for (let i = this.activeIndex + 1; i < n; i++) remaining += greatCircleDistance(this.waypoints[i - 1].position, this.waypoints[i].position);
    p.remainingDistanceM = remaining;
    p.totalDistanceM = this.totalDistanceM();
    const gs = groundSpeedMs > MIN_GS_MS ? groundSpeedMs : 0;
    p.eteS = gs ? p.distanceToActiveM / gs : Infinity;
    p.eteTotalS = gs ? remaining / gs : Infinity;
    return p;
  }

  /** The FROM point of the active leg. */
  legOrigin(): Geodetic {
    if (this.directOrigin) return this.directOrigin;
    if (this.activeIndex > 0) return this.waypoints[this.activeIndex - 1].position;
    return this.lastPos ?? this.waypoints[0].position;
  }

  private resetActive(): void {
    this.activeIndex = this.waypoints.length >= 2 ? 1 : 0;
    this.plan.complete = false;
  }
}

/** Convenience: a waypoint from an airport-like object. */
export const waypointFromAirport = (a: { icao: string; position: Geodetic }): Waypoint => ({ id: a.icao, position: a.position, type: 'airport' });

/** Convenience: a waypoint from a navaid-like object. */
export const waypointFromNavaid = (n: { id: string; position: Geodetic }): Waypoint => ({ id: n.id, position: n.position, type: 'navaid' });

export type { FlightPlan };
