/**
 * Public types of the scripted ATC module.
 */
import type { NavDatabase } from '../core/types';
import type { RadioMessage, RadioVoice } from './radio';

/**
 * Flight phases of the scripted ATC state machine (see README for the diagram).
 * Towered and untowered (CTAF) fields share the phases; at untowered fields the pilot
 * self-announces and nobody replies.
 */
export type AtcPhase =
  | 'PARKED'
  | 'TAXI_CLEARED'
  | 'HOLDING_SHORT'
  | 'CLEARED_TAKEOFF'
  | 'DEPARTING'
  | 'ENROUTE'
  | 'INBOUND'
  | 'PATTERN'
  | 'LANDED'
  | 'TAXI_IN';

/** What the pilot asked for on the ground. */
export type DepartureIntent = 'departure' | 'closed-traffic';
/** What the pilot wants at the destination. */
export type LandingIntent = 'full-stop' | 'touch-and-go';
/** Landing clearance currently held. */
export type LandingClearance = 'none' | 'land' | 'touch-and-go';

/** Constructor options of {@link AtcController}. */
export interface AtcControllerOptions {
  /** registration, e.g. "N172FS" */
  callsign: string;
  /** type word used in abbreviated callsigns, e.g. "Cessna" or "Skyhawk" */
  aircraftType: string;
  nav: NavDatabase;
  /** text-to-speech hook (speech text, spelled out) */
  speak?: (text: string, voice: RadioVoice) => void;
  /** transcript hook (display text with digits) — wire to the `atc:message` event */
  emit: (msg: RadioMessage) => void;
  /** options menu hook — wire to the `atc:options` event; called only when the list changes */
  emitOptions: (options: string[]) => void;
  /** initial UTC epoch ms of the world clock (default 2026-01-01T12:00Z); advanced with dt */
  utcMs?: number;
  /** seed for reply delays and squawk codes (default: derived from the callsign) */
  seed?: number;
}

/** Tunable thresholds of the state machine (SI units). */
export interface AtcTuning {
  /** tower hands off departures beyond this distance from the field, m */
  handoffDistanceM: number;
  /** … or above this height above the field, m */
  handoffHeightM: number;
  /** a towered field becomes the destination when the aircraft closes on it inside this range, m */
  inboundRangeM: number;
  /** inbound is abandoned beyond this range, m */
  inboundCancelRangeM: number;
  /** landing clearance is issued when established on final within this distance, m */
  landingClearanceRangeM: number;
  /** go-around is detected below this height above the field, m */
  goAroundMaxHeightM: number;
  /** … when climbing faster than this, m/s */
  goAroundClimbMs: number;
  /** a stopped aircraft: ground speed below this, m/s */
  stoppedSpeedMs: number;
  /** a pattern aircraft that leaves the pattern beyond this range returns to en route, m */
  patternExitRangeM: number;
  /** "exit runway, contact ground" is issued below this ground speed after landing, m/s */
  exitRunwaySpeedMs: number;
}
