/**
 * Kinematic traffic-pattern aircraft (no flight model): each AI aircraft flies the published
 * rectangular circuit of one runway — take-off roll, upwind climb, crosswind, downwind at pattern
 * altitude, base, final, touch-and-go — as a path follower in runway coordinates.
 *
 * Runway coordinates: x along the runway from the landing threshold (m, + toward the far end),
 * y to the right of the runway direction (m), h height above the threshold (m). Geodetic output
 * is computed from the threshold and the true runway heading (flat-earth offsets: errors are
 * centimetres within the 6 km a circuit spans), so the simulation is independent of the floating
 * origin and survives rebases untouched.
 *
 * Pure TypeScript, no Three.js: deterministic for a given seed and testable in Node.
 */

const D2R = Math.PI / 180;
const G = 9.80665;
const KT = 0.514444;
const FT = 0.3048;

/** One runway end the circuit is flown on. */
export interface PatternRunway {
  /** landing threshold */ lat: number; lon: number; /** threshold elevation, m MSL */ elevM: number;
  /** true heading of the runway direction, deg */ headingDeg: number;
  lengthM: number;
  /** far end elevation (runway slope), m MSL */ endElevM: number;
  /** 'left' (default) or 'right' traffic */ side: 'left' | 'right';
}

/** Performance of the AI type (speeds in kt, rates in fpm). */
export interface PatternPerformance {
  rotateKt: number; climbKt: number; patternKt: number; approachKt: number; touchdownKt: number;
  climbFpm: number; descentFpm: number;
  /** tail-wheel aircraft sit nose-up on the ground (deg) */ groundPitchDeg: number;
}

export const C172_PATTERN: PatternPerformance = { rotateKt: 55, climbKt: 74, patternKt: 90, approachKt: 65, touchdownKt: 55, climbFpm: 700, descentFpm: 600, groundPitchDeg: 0 };
export const CUB_PATTERN: PatternPerformance = { rotateKt: 40, climbKt: 61, patternKt: 75, approachKt: 55, touchdownKt: 42, climbFpm: 900, descentFpm: 550, groundPitchDeg: 11 };

export type PatternLeg = 'takeoff' | 'upwind' | 'crosswind' | 'downwind' | 'base' | 'final' | 'landing' | 'goaround';

/** What the aircraft needs to know about the rest of the airport each step. */
export interface PatternContext {
  /** the runway is occupied (the player on it, or another AI rolling on it) */
  runwayOccupied(self: PatternAircraft): boolean;
  /** another aircraft is ahead in the landing sequence (on base or final, or the player on final) */
  sequenceBusy(self: PatternAircraft): boolean;
}

/** Circuit geometry in runway coordinates (m). Pattern altitude 1,000 ft above the field. */
export interface CircuitGeometry {
  patternH: number; downwindY: number; upwindTurnX: number; downwindEndX: number; baseTurnY: number; touchdownX: number;
}

export function circuitGeometry(rwy: PatternRunway): CircuitGeometry {
  const s = rwy.side === 'right' ? 1 : -1;
  return {
    patternH: 1000 * FT,
    downwindY: s * 1500,
    upwindTurnX: rwy.lengthM + 900,
    downwindEndX: -1400,
    baseTurnY: s * 0,
    touchdownX: Math.min(300, rwy.lengthM * 0.2),
  };
}

/** Geodetic and kinematic snapshot of one AI aircraft for rendering, maps and ATC. */
export interface TrafficTarget {
  id: string; callsign: string; type: string;
  lat: number; lon: number; altMslM: number;
  headingDeg: number; pitchDeg: number; rollDeg: number;
  groundSpeedMs: number; verticalSpeedMs: number;
  onGround: boolean; leg: PatternLeg; flapDeg: number; gearCompressionM: number;
}

/** Small seeded PRNG (mulberry32): deterministic traffic for a given airport. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class PatternAircraft {
  /** runway coordinates (m) and height above the threshold (m) */
  x = 0; y = 0; h = 0;
  /** track relative to the runway direction (deg, + = right) */
  trk = 0;
  /** ground speed (m/s) and vertical speed (m/s) */
  v = 0; vs = 0;
  rollDeg = 0;
  leg: PatternLeg = 'downwind';
  onGround = false;
  /** seconds spent on the current leg (stuck detection, touch-and-go roll) */
  legTime = 0;
  /** extended downwind because of traffic / an occupied runway */
  extending = false;
  readonly geo = { lat: 0, lon: 0, alt: 0 };
  private readonly c: CircuitGeometry;

  constructor(
    readonly id: string,
    readonly callsign: string,
    readonly type: string,
    readonly perf: PatternPerformance,
    readonly rwy: PatternRunway,
    start: { leg: PatternLeg; along: number },
  ) {
    this.c = circuitGeometry(rwy);
    this.place(start.leg, start.along);
  }

  get circuit(): CircuitGeometry { return this.c; }

  /** Put the aircraft on a leg, `along` 0..1 through it, at that leg's height and speed. */
  place(leg: PatternLeg, along: number): void {
    const c = this.c, k = clamp(along, 0, 1);
    this.leg = leg; this.legTime = 0; this.onGround = false; this.extending = false; this.vs = 0; this.rollDeg = 0;
    const side = Math.sign(c.downwindY);
    switch (leg) {
      case 'takeoff': case 'landing':
        this.x = k * this.rwy.lengthM * 0.5; this.y = 0; this.h = 0; this.trk = 0; this.onGround = true;
        this.v = leg === 'takeoff' ? 0 : this.perf.touchdownKt * KT; break;
      case 'upwind': case 'goaround':
        this.x = this.rwy.lengthM * 0.4 + k * (c.upwindTurnX - this.rwy.lengthM * 0.4); this.y = 0; this.h = 60 + k * (c.patternH - 120); this.trk = 0; this.v = this.perf.climbKt * KT; break;
      case 'crosswind':
        this.x = c.upwindTurnX; this.y = k * c.downwindY; this.h = c.patternH * 0.85; this.trk = 90 * side; this.v = this.perf.climbKt * KT; break;
      case 'downwind':
        this.x = c.upwindTurnX - k * (c.upwindTurnX - c.downwindEndX); this.y = c.downwindY; this.h = c.patternH; this.trk = 180; this.v = this.perf.patternKt * KT; break;
      case 'base':
        this.x = c.downwindEndX; this.y = c.downwindY * (1 - k); this.h = c.patternH * 0.75; this.trk = -90 * side; this.v = this.perf.approachKt * KT * 1.1; break;
      case 'final':
        this.x = c.downwindEndX * (1 - k); this.y = 0; this.h = Math.tan(3 * D2R) * (c.touchdownX - this.x); this.trk = 0; this.v = this.perf.approachKt * KT; break;
    }
  }

  /** Advance by `dt` seconds. */
  update(dt: number, ctx: PatternContext): void {
    if (!(dt > 0)) return;
    this.legTime += dt;
    const c = this.c, p = this.perf, L = this.rwy.lengthM;
    let targetTrk = this.trk, targetH = this.h, targetV = this.v;
    let tx = this.x, ty = this.y; // steering point
    switch (this.leg) {
      case 'takeoff': {
        targetV = p.climbKt * KT * 1.05; tx = this.x + 300; ty = 0;
        if (this.v >= p.rotateKt * KT) { this.onGround = false; this.setLeg('upwind'); }
        break;
      }
      case 'upwind': case 'goaround': {
        tx = this.x + 500; ty = 0; targetV = p.climbKt * KT; targetH = c.patternH;
        if (this.x >= c.upwindTurnX) this.setLeg('crosswind');
        break;
      }
      case 'crosswind': {
        tx = c.upwindTurnX + 250; ty = c.downwindY; targetV = p.climbKt * KT; targetH = c.patternH;
        if (Math.abs(this.y - c.downwindY) < 150) this.setLeg('downwind');
        break;
      }
      case 'downwind': {
        tx = this.x - 600; ty = c.downwindY; targetV = p.patternKt * KT; targetH = c.patternH;
        if (this.x <= c.downwindEndX) {
          // extend the downwind while someone is ahead in the sequence or the runway is occupied
          this.extending = ctx.sequenceBusy(this) || ctx.runwayOccupied(this);
          if (!this.extending || this.x < c.downwindEndX - 5000) this.setLeg('base');
        }
        break;
      }
      case 'base': {
        tx = this.x + 150; ty = 0; targetV = p.approachKt * KT * 1.1; targetH = Math.max(Math.tan(3 * D2R) * (c.touchdownX - this.x), c.patternH * 0.45);
        if (Math.abs(this.y) < 120 || Math.sign(this.y) !== Math.sign(c.downwindY)) this.setLeg('final');
        break;
      }
      case 'final': {
        tx = this.x + 700; ty = 0; targetV = p.approachKt * KT;
        targetH = Math.max(0, Math.tan(3 * D2R) * (c.touchdownX - this.x));
        // runway occupied on short final: go around
        if (this.x > -800 && ctx.runwayOccupied(this)) { this.setLeg('goaround'); break; }
        if (this.x >= c.touchdownX - 40 || this.h < 1.5) { this.onGround = true; this.h = 0; this.vs = 0; this.setLeg('landing'); }
        break;
      }
      case 'landing': {
        // roll out, then touch-and-go: full power again once slowed
        tx = this.x + 300; ty = 0; targetV = p.touchdownKt * KT * 0.55;
        if (this.legTime > 6 || this.x > L * 0.6) this.setLeg('takeoff');
        break;
      }
    }
    // ── lateral: steer toward (tx, ty) with a standard-rate-ish turn limit ──
    const want = Math.atan2(ty - this.y, tx - this.x) / D2R;
    targetTrk = want;
    const err = wrap180(targetTrk - this.trk);
    const maxRate = this.onGround ? 3 : 6; // deg/s (6 °/s ≈ 25° bank at 80 kt)
    const rate = clamp(err * 0.8, -maxRate, maxRate);
    this.trk = wrap180(this.trk + rate * dt);
    const omega = rate * D2R;
    const targetRoll = this.onGround ? 0 : clamp(Math.atan2(this.v * omega, G) / D2R, -30, 30);
    this.rollDeg += clamp(targetRoll - this.rollDeg, -15 * dt, 15 * dt);
    // ── speed ──
    const accel = this.leg === 'takeoff' ? 2.2 : this.leg === 'landing' ? -2.0 : 1.0;
    const dv = targetV - this.v;
    this.v += clamp(dv, -Math.abs(accel) * dt, Math.abs(accel) * dt);
    // ── vertical ──
    if (this.onGround) { this.h = 0; this.vs = 0; }
    else {
      const up = p.climbFpm * FT / 60, down = p.descentFpm * FT / 60;
      const wantVs = clamp((targetH - this.h) * 0.25, -down * 1.3, up);
      this.vs += clamp(wantVs - this.vs, -1.5 * dt, 1.5 * dt);
      this.h = Math.max(this.leg === 'final' ? 0 : 1, this.h + this.vs * dt);
    }
    // ── position ──
    const t = this.trk * D2R;
    this.x += Math.cos(t) * this.v * dt;
    this.y += Math.sin(t) * this.v * dt;
  }

  private setLeg(l: PatternLeg): void { this.leg = l; this.legTime = 0; if (l !== 'downwind') this.extending = false; }

  /** Height of the runway surface under (x) above the threshold (runway slope). */
  private groundH(x: number): number {
    const k = clamp(x / Math.max(this.rwy.lengthM, 1), 0, 1);
    return (this.rwy.endElevM - this.rwy.elevM) * k;
  }

  /** Geodetic position (lat/lon deg, alt m MSL of the runway-reference point under the aircraft). */
  geodetic(): { lat: number; lon: number; alt: number } {
    const H = this.rwy.headingDeg * D2R;
    const n = this.x * Math.cos(H) - this.y * Math.sin(H);
    const e = this.x * Math.sin(H) + this.y * Math.cos(H);
    const R = 6378137;
    this.geo.lat = this.rwy.lat + (n / R) / D2R;
    this.geo.lon = this.rwy.lon + (e / (R * Math.cos(this.rwy.lat * D2R))) / D2R;
    this.geo.alt = this.rwy.elevM + (this.onGround ? this.groundH(this.x) : this.h + Math.max(0, this.groundH(Math.min(this.x, this.rwy.lengthM))));
    return this.geo;
  }

  /** Snapshot for rendering, maps and ATC. */
  target(out: TrafficTarget): TrafficTarget {
    const g = this.geodetic();
    out.id = this.id; out.callsign = this.callsign; out.type = this.type;
    out.lat = g.lat; out.lon = g.lon; out.altMslM = g.alt;
    out.headingDeg = ((this.rwy.headingDeg + this.trk) % 360 + 360) % 360;
    const gamma = this.v > 1 ? Math.atan2(this.vs, this.v) / D2R : 0;
    const groundPitch = this.onGround && this.v < this.perf.rotateKt * KT * 0.6 ? this.perf.groundPitchDeg : 0;
    const alphaDeg = this.onGround ? 0 : this.leg === 'final' || this.leg === 'base' ? 4 : 3;
    out.pitchDeg = this.onGround ? groundPitch : gamma + alphaDeg;
    out.rollDeg = this.rollDeg;
    out.groundSpeedMs = this.v; out.verticalSpeedMs = this.vs;
    out.onGround = this.onGround; out.leg = this.leg;
    out.flapDeg = this.leg === 'final' || this.leg === 'landing' ? 20 : this.leg === 'base' ? 10 : this.leg === 'takeoff' ? 10 : 0;
    out.gearCompressionM = this.onGround ? 0.05 : 0;
    return out;
  }

  /** On the runway (rolling or stopped on it), for the occupancy rule. */
  get onRunway(): boolean { return this.onGround && this.x > -50 && this.x < this.rwy.lengthM + 50 && Math.abs(this.y) < 40; }
  /** On base or final: ahead in the landing sequence of anyone still on downwind. */
  get inSequence(): boolean { return this.leg === 'base' || this.leg === 'final' || this.leg === 'landing'; }
}

export const newTarget = (): TrafficTarget => ({ id: '', callsign: '', type: '', lat: 0, lon: 0, altMslM: 0, headingDeg: 0, pitchDeg: 0, rollDeg: 0, groundSpeedMs: 0, verticalSpeedMs: 0, onGround: false, leg: 'downwind', flapDeg: 0, gearCompressionM: 0 });
