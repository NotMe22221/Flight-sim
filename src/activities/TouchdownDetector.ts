/**
 * Watches the aircraft state every physics step and emits liftoff/touchdown/landing-score
 * events. A landing is: airborne for ≥ 3 s above 3 m AGL, then wheels on the ground. Bounces
 * within 2 s count against the same landing. The rollout ends when ground speed < 1 m/s
 * (scored) or when the aircraft lifts off again (touch-and-go, scored without a stop term).
 */
import type { EventBus } from '../core/events';
import type { AircraftState, Airport } from '../core/types';
import { RAD } from '../core/units';
import { scoreLanding, type LandingScore, type TouchdownRecord } from './landingScore';
import { aimAlongM, matchRunwayEnd, onRunway, relativeToRunway, type RunwayEndRef, type RunwayRelative } from './runwayFrame';

type Phase = 'ground' | 'airborne' | 'rollout';

export interface TouchdownDetectorOptions {
  /** nearby airports to match runways against (refreshed by the caller) */
  airports: () => Airport[];
  minAirborneS: number;
  minAirborneAglM: number;
}

export class TouchdownDetector {
  private phase: Phase = 'ground';
  private airborneTime = 0;
  private maxAgl = 0;
  private sinceTouchdown = 0;
  private td: TouchdownRecord | null = null;
  private tdEnd: RunwayEndRef | null = null;
  private tdAlong = 0;
  private prevOnGround = true;
  private lastVs = 0;
  private readonly rel: RunwayRelative = { alongM: 0, crossM: 0 };
  /** most recent score, for UIs that poll */
  lastScore: LandingScore | null = null;
  private readonly opts: TouchdownDetectorOptions;

  constructor(private readonly events: EventBus, options: Partial<TouchdownDetectorOptions> & Pick<TouchdownDetectorOptions, 'airports'>) {
    this.opts = { minAirborneS: 3, minAirborneAglM: 3, ...options };
  }

  /** Reset after a respawn. */
  reset(onGround: boolean): void {
    this.phase = onGround ? 'ground' : 'airborne';
    this.airborneTime = onGround ? 0 : this.opts.minAirborneS;
    this.maxAgl = onGround ? 0 : this.opts.minAirborneAglM + 1;
    this.td = null;
    this.tdEnd = null;
    this.prevOnGround = onGround;
  }

  step(dt: number, s: AircraftState): void {
    const onGround = s.onGround;
    if (!onGround) this.lastVs = s.verticalSpeedMs;
    switch (this.phase) {
      case 'ground':
        if (!onGround) {
          this.airborneTime += dt;
          this.maxAgl = Math.max(this.maxAgl, s.altitudeAglM);
          if (this.airborneTime > 0.5 && s.altitudeAglM > 1) {
            this.events.emit('aircraft:liftoff', { iasMs: s.aero.ias });
            this.phase = 'airborne';
          }
        } else {
          this.airborneTime = 0;
          this.maxAgl = 0;
        }
        break;
      case 'airborne':
        if (!onGround) {
          this.airborneTime += dt;
          this.maxAgl = Math.max(this.maxAgl, s.altitudeAglM);
        } else if (this.airborneTime >= this.opts.minAirborneS && this.maxAgl >= this.opts.minAirborneAglM) {
          this.beginTouchdown(s);
        } else {
          this.phase = 'ground';
          this.airborneTime = 0;
        }
        break;
      case 'rollout':
        this.sinceTouchdown += dt;
        if (this.td && this.sinceTouchdown < 0.5) this.td.peakG = Math.max(this.td.peakG, s.loadFactor[2]);
        if (this.td && !onGround && this.prevOnGround && this.sinceTouchdown < 2) this.td.bounces++;
        if (!onGround && s.altitudeAglM > 5 && this.sinceTouchdown > 2) {
          // touch and go
          this.finish(s, false);
          this.phase = 'airborne';
          this.airborneTime = this.opts.minAirborneS;
          this.maxAgl = s.altitudeAglM;
        } else if (onGround && s.groundSpeedMs < 1) {
          this.finish(s, true);
          this.phase = 'ground';
          this.airborneTime = 0;
          this.maxAgl = 0;
        }
        break;
    }
    // the simulator reports the crash itself (with the flight model's reason); just end the landing
    if (s.crashed && this.phase !== 'ground') this.phase = 'ground';
    this.prevOnGround = onGround;
  }

  private beginTouchdown(s: AircraftState): void {
    const trackDeg = s.trackRad * RAD;
    const match = matchRunwayEnd(s.geo, trackDeg, this.opts.airports());
    const headingDeg = s.headingTrueRad * RAD;
    let lateralOffsetM = 0, alongTrackM = 0, crabDeg = 0, lateralDriftMs = 0, offRunway = true;
    if (match) {
      relativeToRunway(s.geo, match.end, this.rel);
      lateralOffsetM = this.rel.crossM;
      alongTrackM = this.rel.alongM;
      offRunway = !onRunway(this.rel, match.end);
      crabDeg = ((headingDeg - match.end.headingDeg) % 360 + 540) % 360 - 180;
      const rwyRad = match.end.headingDeg / RAD;
      // velocity across the runway direction (+ right)
      lateralDriftMs = -s.velNED[0] * Math.sin(rwyRad) + s.velNED[1] * Math.cos(rwyRad);
    } else {
      lateralDriftMs = s.velBody[1];
    }
    const vs = Math.min(this.lastVs, s.verticalSpeedMs);
    this.td = { verticalSpeedMs: vs, peakG: s.loadFactor[2], lateralOffsetM, alongTrackM, lateralDriftMs, crabDeg, offRunway, bounces: 0 };
    this.tdEnd = match?.end ?? null;
    this.tdAlong = alongTrackM;
    this.sinceTouchdown = 0;
    this.phase = 'rollout';
    this.events.emit('aircraft:touchdown', {
      verticalSpeedMs: vs,
      gForce: s.loadFactor[2],
      lateralDriftMs,
      centerlineOffsetM: match ? lateralOffsetM : null,
      runway: match ? `${match.end.airport.icao} ${match.end.ident}` : null,
    });
  }

  private finish(s: AircraftState, stopped: boolean): void {
    if (!this.td) return;
    let stopDistanceM = 0;
    if (this.tdEnd) {
      relativeToRunway(s.geo, this.tdEnd, this.rel);
      stopDistanceM = Math.max(0, this.rel.alongM - this.tdAlong);
    }
    const end = this.tdEnd;
    if (end) {
      const result = scoreLanding(this.td, { stopDistanceM, stopped }, { widthM: end.widthM, lengthM: end.lengthM, aimPointM: aimAlongM(end) });
      this.lastScore = result;
      this.events.emit('landing:scored', {
        score: result.score,
        details: {
          grade: result.grade,
          runway: `${end.airport.icao} ${end.ident}`,
          verticalSpeedFpm: Math.round(this.td.verticalSpeedMs * 196.85),
          peakG: Math.round(this.td.peakG * 100) / 100,
          centrelineOffsetM: Math.round(this.td.lateralOffsetM * 10) / 10,
          touchdownFromThresholdM: Math.round(this.td.alongTrackM),
          stopDistanceM: stopped ? Math.round(stopDistanceM) : 'touch-and-go',
          crabDeg: Math.round(this.td.crabDeg * 10) / 10,
          bounces: this.td.bounces,
          centre: Math.round(result.centre * 100),
          smooth: Math.round(result.smooth * 100),
          zone: Math.round(result.zone * 100),
          stop: Math.round(result.stop * 100),
        },
      });
    }
    this.td = null;
    this.tdEnd = null;
  }
}
