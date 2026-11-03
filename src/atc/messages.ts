/**
 * Transmission templates (FAA style, docs/research/05 §9.2). `cs` is the callsign form to use
 * (full on first contact, abbreviated afterwards); every function returns a Spoken pair.
 */
import { say } from './compose';
import type { Facility } from './field';
import type { PatternEntry, PatternLeg, TrafficSide } from './geometry';
import {
  altimeter, altitude, atisLetter, compassWord, frequency, miles, runway, spoken, squawk, type Spoken,
} from './phraseology';
import type { DepartureIntent, LandingClearance, LandingIntent } from './types';

const EMPTY = spoken('');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const withInfo = (letter: string | null): Spoken => (letter ? say`, with information ${atisLetter(letter)}` : EMPTY);
const intentWords = (i: LandingIntent): string => (i === 'full-stop' ? 'full stop' : 'touch and go');

/** "10 miles east" (from the field, true bearing), optionally "of San Francisco". */
export function positionFrom(nm: number, bearingFromFieldDeg: number, ofName?: string): Spoken {
  const where = say`${miles(nm)} ${compassWord(bearingFromFieldDeg)}`;
  return ofName ? say`${where} of ${ofName}` : where;
}

/** Leg phrase for reports: "midfield right downwind runway 28R", "left base runway 30", "final runway 30". */
export function legPhrase(leg: PatternLeg, side: TrafficSide, rwy: string, midfield = true): Spoken {
  const r = runway(rwy);
  switch (leg) {
    case 'downwind': return say`${midfield ? 'midfield ' : ''}${side} downwind runway ${r}`;
    case 'base': return say`${side} base runway ${r}`;
    case 'crosswind': return say`${side} crosswind runway ${r}`;
    case 'upwind': return say`upwind runway ${r}`;
    default: return say`final runway ${r}`;
  }
}

/** Entry phrase: "enter right downwind runway 28R", "enter left base runway 30", "make straight-in runway 28R". */
export function entryPhrase(entry: PatternEntry, side: TrafficSide, rwy: string): Spoken {
  const r = runway(rwy);
  if (entry === 'straight-in') return say`make straight-in runway ${r}`;
  return say`enter ${side} ${entry} runway ${r}`;
}

/** What the tower asks the arrival to report for an entry. */
export function entryReport(entry: PatternEntry): Spoken {
  if (entry === 'straight-in') return spoken('3 mile final', 'three mile final');
  return spoken(entry === 'base' ? 'base' : 'midfield downwind');
}

// ───────────────────────────── Pilot → towered facilities ─────────────────────────────

export const pilot = {
  taxiRequest: (f: Facility, cs: Spoken, letter: string | null, intent: DepartureIntent): Spoken =>
    say`${f.name}, ${cs}, at the ramp${withInfo(letter)}, request taxi${intent === 'closed-traffic' ? ' for closed traffic' : ', VFR departure'}.`,
  clearanceRequest: (f: Facility, cs: Spoken, type: string, letter: string | null): Spoken =>
    say`${f.name}, ${cs}, ${type}, VFR departure${withInfo(letter)}, request clearance.`,
  readyForDeparture: (f: Facility, cs: Spoken, rwy: string, intent: DepartureIntent): Spoken =>
    say`${f.name}, ${cs}, holding short runway ${runway(rwy)}, ready for departure${intent === 'closed-traffic' ? ', remaining in the pattern' : ''}.`,
  unableTakeoff: (f: Facility, cs: Spoken, rwy: string): Spoken => say`${f.name}, ${cs}, unable, holding short runway ${runway(rwy)}.`,
  requestFrequencyChange: (f: Facility, cs: Spoken): Spoken => say`${f.name}, ${cs}, request frequency change.`,
  requestClosedTraffic: (f: Facility, cs: Spoken): Spoken => say`${f.name}, ${cs}, request closed traffic.`,
  flightFollowing: (f: Facility, cs: Spoken, type: string, where: Spoken, altFt: number): Spoken =>
    say`${f.name}, ${cs}, ${type}, ${where}, ${altitude(altFt)}, request VFR flight following.`,
  cancelFlightFollowing: (f: Facility, cs: Spoken): Spoken => say`${f.name}, ${cs}, cancel flight following.`,
  inbound: (f: Facility, cs: Spoken, where: Spoken, altFt: number, intent: LandingIntent, letter: string | null): Spoken =>
    say`${f.name}, ${cs}, ${where}, ${altitude(altFt)}, inbound for landing, ${intentWords(intent)}${withInfo(letter)}.`,
  positionReport: (f: Facility, cs: Spoken, leg: PatternLeg, side: TrafficSide, rwy: string): Spoken =>
    say`${f.name}, ${cs}, ${legPhrase(leg, side, rwy)}.`,
  goingAround: (f: Facility, cs: Spoken): Spoken => say`${f.name}, ${cs}, going around.`,
  requestOption: (f: Facility, cs: Spoken, intent: LandingIntent): Spoken => say`${f.name}, ${cs}, request ${intentWords(intent)}.`,
  clearOfRunway: (f: Facility, cs: Spoken, rwy: string): Spoken => say`${f.name}, ${cs}, clear of runway ${runway(rwy)}, request taxi to parking.`,
};

// ───────────────────────────── Pilot self-announce on CTAF ─────────────────────────────

/** CTAF calls: "<Field> traffic, <cs>, …, <Field>." No replies. */
export const ctaf = {
  taxi: (f: Facility, cs: Spoken, field: string, rwy: string, intent: DepartureIntent): Spoken =>
    say`${f.name}, ${cs}, taxiing to runway ${runway(rwy)}${intent === 'closed-traffic' ? ' for closed traffic' : ''}, ${field}.`,
  departing: (f: Facility, cs: Spoken, field: string, rwy: string, intent: DepartureIntent): Spoken =>
    say`${f.name}, ${cs}, departing runway ${runway(rwy)}${intent === 'closed-traffic' ? ', remaining in the pattern' : ''}, ${field}.`,
  leavingArea: (f: Facility, cs: Spoken, field: string, bearingDeg: number, altFt: number): Spoken =>
    say`${f.name}, ${cs}, departing the area to the ${compassWord(bearingDeg)}, ${altitude(altFt)}, ${field}.`,
  inbound: (f: Facility, cs: Spoken, field: string, where: Spoken, altFt: number, entry: PatternEntry, side: TrafficSide, rwy: string, intent: LandingIntent): Spoken =>
    say`${f.name}, ${cs}, ${where}, ${altitude(altFt)}, inbound, will ${entry === 'straight-in' ? say`make straight-in runway ${runway(rwy)}` : say`enter ${side} ${entry} runway ${runway(rwy)}`}, ${intentWords(intent)}, ${field}.`,
  leg: (f: Facility, cs: Spoken, field: string, leg: PatternLeg, side: TrafficSide, rwy: string): Spoken =>
    say`${f.name}, ${cs}, ${leg === 'base' ? 'turning ' : ''}${legPhrase(leg, side, rwy, false)}, ${field}.`,
  goingAround: (f: Facility, cs: Spoken, field: string, rwy: string): Spoken => say`${f.name}, ${cs}, going around runway ${runway(rwy)}, ${field}.`,
  clear: (f: Facility, cs: Spoken, field: string, rwy: string): Spoken => say`${f.name}, ${cs}, clear of runway ${runway(rwy)}, ${field}.`,
};

// ───────────────────────────── Controller ─────────────────────────────

export const atc = {
  taxi: (cs: Spoken, f: Facility, rwy: string, extra: Spoken): Spoken =>
    say`${cs}, ${f.name}, taxi to runway ${runway(rwy)}, hold short of runway ${runway(rwy)}. ${extra}`,
  clearance: (cs: Spoken, f: Facility, maxAltFt: number, dep: Facility | undefined, code: number): Spoken =>
    say`${cs}, ${f.name}, maintain VFR at or below ${altitude(maxAltFt)}${dep ? say`, departure frequency ${frequency(dep.mhz)}` : EMPTY}, squawk ${squawk(code)}.`,
  takeoff: (cs: Spoken, f: Facility, wind: Spoken, rwy: string, closedSide: TrafficSide | null): Spoken =>
    say`${cs}, ${f.name}, ${closedSide ? `make ${closedSide} closed traffic, ` : ''}wind ${wind}, runway ${runway(rwy)}, cleared for takeoff.`,
  holdShort: (cs: Spoken, rwy: string): Spoken => say`${cs}, roger, hold short runway ${runway(rwy)}.`,
  handoff: (cs: Spoken, to: Facility): Spoken => say`${cs}, contact ${to.name} ${frequency(to.mhz)}.`,
  frequencyChange: (cs: Spoken): Spoken => say`${cs}, frequency change approved.`,
  closedTraffic: (cs: Spoken, side: TrafficSide, rwy: string): Spoken => say`${cs}, make ${side} closed traffic runway ${runway(rwy)}, report downwind.`,
  radarContact: (cs: Spoken, f: Facility, code: number, where: Spoken, inHg: number): Spoken =>
    say`${cs}, ${f.name}, squawk ${squawk(code)}, radar contact ${where}, altimeter ${altimeter(inHg)}, maintain VFR.`,
  radarTerminated: (cs: Spoken, next: Facility | null): Spoken =>
    next ? say`${cs}, radar service terminated, squawk VFR, contact ${next.name} ${frequency(next.mhz)}.`
      : say`${cs}, radar service terminated, squawk VFR, frequency change approved.`,
  patternEntry: (cs: Spoken, f: Facility, entry: PatternEntry, side: TrafficSide, rwy: string, extra: Spoken): Spoken =>
    say`${cs}, ${f.name}, ${entryPhrase(entry, side, rwy)}, report ${entryReport(entry)}. ${extra}`,
  roger: (cs: Spoken, next: Spoken | null): Spoken => say`${cs}, roger${next ? say`, report ${next}` : EMPTY}.`,
  landing: (cs: Spoken, wind: Spoken, rwy: string, kind: Exclude<LandingClearance, 'none'>): Spoken =>
    say`${cs}, wind ${wind}, runway ${runway(rwy)}, ${kind === 'land' ? 'cleared to land' : 'cleared touch and go'}.`,
  goAround: (cs: Spoken, altFt: number, side: TrafficSide, rwy: string): Spoken =>
    say`${cs}, go around, fly runway heading, climb and maintain ${altitude(altFt)}, make ${side} traffic runway ${runway(rwy)}.`,
  goAroundAck: (cs: Spoken, side: TrafficSide, rwy: string): Spoken => say`${cs}, roger, make ${side} traffic runway ${runway(rwy)}, report downwind.`,
  optionAck: (cs: Spoken, intent: LandingIntent): Spoken => say`${cs}, roger, ${intentWords(intent)}.`,
  exitRunway: (cs: Spoken, ground: Facility): Spoken => say`${cs}, exit runway when able, contact Ground ${frequency(ground.mhz)}.`,
  taxiToParking: (cs: Spoken, f: Facility): Spoken => say`${cs}, ${f.name}, taxi to parking.`,
  /** Weather remark appended when the pilot lacks the current ATIS. */
  weatherRemark: (fieldName: string, currentLetter: string | null, pilotLetter: string | null, inHg: number): Spoken => {
    if (currentLetter && pilotLetter === currentLetter) return EMPTY;
    if (currentLetter && pilotLetter) return say` Information ${atisLetter(currentLetter)} now current, altimeter ${altimeter(inHg)}.`;
    return say` ${fieldName} altimeter ${altimeter(inHg)}.`;
  },
};

// ───────────────────────────── Pilot readbacks ─────────────────────────────

export const readback = {
  taxi: (cs: Spoken, rwy: string): Spoken => say`Taxi to runway ${runway(rwy)}, hold short of runway ${runway(rwy)}, ${cs}.`,
  clearance: (cs: Spoken, maxAltFt: number, dep: Facility | undefined, code: number): Spoken =>
    say`Maintain VFR at or below ${altitude(maxAltFt)}${dep ? say`, departure frequency ${frequency(dep.mhz)}` : EMPTY}, squawk ${squawk(code)}, ${cs}.`,
  takeoff: (cs: Spoken, rwy: string): Spoken => say`Runway ${runway(rwy)}, cleared for takeoff, ${cs}.`,
  holdShort: (cs: Spoken, rwy: string): Spoken => say`Hold short runway ${runway(rwy)}, ${cs}.`,
  handoff: (cs: Spoken, to: Facility): Spoken => say`${frequency(to.mhz)}, ${cs}.`,
  goodDay: (cs: Spoken): Spoken => say`Good day, ${cs}.`,
  closedTraffic: (cs: Spoken, side: TrafficSide, rwy: string): Spoken => say`${cap(side)} closed traffic runway ${runway(rwy)}, ${cs}.`,
  squawk: (cs: Spoken, code: number): Spoken => say`Squawk ${squawk(code)}, maintain VFR, ${cs}.`,
  squawkVfr: (cs: Spoken, next: Facility | null): Spoken => (next ? say`Squawk VFR, ${frequency(next.mhz)}, ${cs}.` : say`Squawk VFR, ${cs}.`),
  patternEntry: (cs: Spoken, entry: PatternEntry, side: TrafficSide, rwy: string): Spoken =>
    entry === 'straight-in' ? say`Straight-in runway ${runway(rwy)}, report three mile final, ${cs}.`
      : say`${cap(side)} ${entry} runway ${runway(rwy)}, ${cs}.`,
  landing: (cs: Spoken, rwy: string, kind: Exclude<LandingClearance, 'none'>): Spoken =>
    say`Runway ${runway(rwy)}, ${kind === 'land' ? 'cleared to land' : 'cleared touch and go'}, ${cs}.`,
  goAround: (cs: Spoken, altFt: number): Spoken => say`Going around, runway heading, climb and maintain ${altitude(altFt)}, ${cs}.`,
  traffic: (cs: Spoken, side: TrafficSide): Spoken => say`${cap(side)} traffic, ${cs}.`,
  exitRunway: (cs: Spoken, ground: Facility): Spoken => say`Exit runway, Ground ${frequency(ground.mhz)}, ${cs}.`,
  taxiToParking: (cs: Spoken): Spoken => say`Taxi to parking, ${cs}.`,
};
