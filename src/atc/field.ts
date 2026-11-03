/**
 * Per-airport ATC facts: which controllers exist (from the airport's frequency list), their
 * radio names ("San Francisco Ground"), whether the field is towered, pattern altitude and the
 * runway(s) in use for a wind (selection delegated to the nav module's `runwayInUse`).
 */
import type { Airport, Geodetic, Runway } from '../core/types';
import { FT } from '../core/units';
import { runwayEnds, runwayInUse, type RunwayEnd, type RunwayRecord } from '../nav';
import { spoken, type Spoken } from './phraseology';

/** Controller roles the scripted ATC knows. 'CTAF' is the common traffic frequency (self-announce). */
export type FacilityKind = 'ATIS' | 'AWOS' | 'CLD' | 'GND' | 'TWR' | 'DEP' | 'APP' | 'CTAF';

/** One radio facility. */
export interface Facility {
  kind: FacilityKind;
  /** radio name, e.g. "San Francisco Ground"; for CTAF the addressee "Half Moon Bay traffic" */
  name: Spoken;
  mhz: number;
}

/** ATC view of an airport. */
export interface FieldInfo {
  airport: Airport;
  /** short name used in facility names, e.g. "San Francisco" */
  shortName: string;
  /** true when the airport has a tower frequency */
  towered: boolean;
  atis?: Facility;
  awos?: Facility;
  clearance?: Facility;
  ground?: Facility;
  tower?: Facility;
  departure?: Facility;
  approach?: Facility;
  /** common traffic advisory frequency (CTAF/UNICOM, else 122.9 MULTICOM) */
  ctaf: Facility;
  /** traffic pattern altitude MSL, ft, rounded to 100 ft (field elevation + 1 000 ft) */
  patternAltitudeFt: number;
}

/** MULTICOM, used as the CTAF when an untowered field publishes none. */
export const MULTICOM_MHZ = 122.9;
/** Pattern height above the field for piston singles, ft (AC 90-66C). */
export const PATTERN_HEIGHT_FT = 1000;

const isCom = (mhz: number): boolean => mhz >= 118 && mhz <= 137;
/** ATIS can also be broadcast on a VOR voice channel (108–118 MHz). */
const isAtisFreq = (mhz: number): boolean => mhz >= 108 && mhz <= 137;

const SUFFIX = /\s+(International|Intl|Regional|Municipal|County|Executive|Memorial|Metropolitan|Airport|Airfield|Airpark|Field|Aerodrome|Air Terminal)\b.*$/i;

/** Short facility name: municipality when known ("San Francisco"), else the airport name without its suffix. */
export function facilityShortName(airport: Airport): string {
  const m = airport.municipality?.split(/[,/(]/)[0].trim();
  if (m) return m;
  const n = airport.name.replace(SUFFIX, '').trim();
  return n || airport.icao;
}

function pick(airport: Airport, types: readonly string[], valid: (mhz: number) => boolean): number | undefined {
  const fs = airport.frequencies ?? [];
  for (const t of types) {
    for (const f of fs) if (f.type.toUpperCase() === t && valid(f.mhz)) return f.mhz;
  }
  return undefined;
}

const facility = (kind: FacilityKind, name: string, mhz: number | undefined): Facility | undefined =>
  mhz === undefined ? undefined : { kind, name: spoken(name), mhz };

/** Build the ATC view of an airport. Cheap; cache per airport. */
export function fieldInfo(airport: Airport): FieldInfo {
  const short = facilityShortName(airport);
  const tower = facility('TWR', `${short} Tower`, pick(airport, ['TWR'], isCom));
  const ctafMhz = pick(airport, ['CTAF', 'UNICOM', 'UNIC'], isCom) ?? tower?.mhz ?? MULTICOM_MHZ;
  const dep = pick(airport, ['DEP', 'APP', 'A/D'], isCom);
  const app = pick(airport, ['APP', 'A/D', 'DEP'], isCom);
  const elevFt = airport.elevationM / FT;
  return {
    airport,
    shortName: short,
    towered: tower !== undefined,
    atis: facility('ATIS', `${short} ATIS`, pick(airport, ['ATIS'], isAtisFreq)),
    awos: facility('AWOS', `${short} weather`, pick(airport, ['AWOS', 'ASOS'], isAtisFreq)),
    clearance: tower ? facility('CLD', `${short} Clearance`, pick(airport, ['CLD'], isCom)) : undefined,
    // Without a ground frequency the tower handles taxi itself.
    ground: tower ? facility('GND', `${short} Ground`, pick(airport, ['GND'], isCom)) ?? tower : undefined,
    tower,
    departure: facility('DEP', `${short} Departure`, dep),
    approach: facility('APP', `${short} Approach`, app),
    ctaf: { kind: 'CTAF', name: spoken(`${short} traffic`), mhz: ctafMhz },
    patternAltitudeFt: Math.round((elevFt + PATTERN_HEIGHT_FT) / 100) * 100,
  };
}

/** A landing/departure direction with the geometry ATC needs. */
export interface RunwayRef {
  ident: string;
  end: RunwayEnd;
  /** the physical runway (width, surface) */
  runway: Runway;
  headingDeg: number;
  lengthM: number;
  widthM: number;
  /** pavement threshold of this direction */
  threshold: Geodetic;
}

function ref(rw: Runway, end: RunwayEnd): RunwayRef {
  return { ident: end.ident, end, runway: rw, headingDeg: end.headingDeg, lengthM: end.lengthM, widthM: rw.widthM, threshold: end.threshold };
}

/** All landing directions of an airport (works for nav `RunwayRecord`s and plain contract `Runway`s). */
export function allRunwayRefs(airport: Airport): RunwayRef[] {
  const out: RunwayRef[] = [];
  for (const rw of airport.runways) for (const end of runwayEnds(rw)) out.push(ref(rw, end));
  return out;
}

/** Numeric part of a designator: "28R" → 28, "01L" → 1; NaN for non-standard idents. */
export function designatorNumber(ident: string): number {
  const m = /^(\d{1,2})[LRC]?$/i.exec(ident.trim());
  return m ? Number(m[1]) : NaN;
}

/** L/C/R suffix of a designator ('' when none). */
export const designatorSide = (ident: string): 'L' | 'C' | 'R' | '' => {
  const s = ident.trim().slice(-1).toUpperCase();
  return s === 'L' || s === 'C' || s === 'R' ? s : '';
};

const SIDE_ORDER: Readonly<Record<string, number>> = { L: 0, C: 1, '': 1, R: 2 };

/** Runway selection for a wind. */
export interface RunwaysInUse {
  /** the end chosen by `runwayInUse` (greatest headwind, longest on ties) */
  primary: RunwayRef;
  /** the primary plus its parallels in the same direction, ordered L, C, R */
  all: RunwayRef[];
}

/** A plain contract `Runway` widened to a `RunwayRecord` (both ends derived by the nav module). */
function withRunwayEnds(rw: Runway): RunwayRecord {
  const { ils: _ils, ...rest } = rw;
  return { ...rest, id: rw.ident, ends: runwayEnds(rw) };
}

/**
 * Below this wind speed the longest runway is used (calm-wind runway), kt: FAA JO 7110.65
 * §3-5-1 uses the runway most nearly aligned with the wind at 5 kt or more (research 05 §9.1).
 * (Reporting "wind calm" is a different threshold, < 3 kt — phraseology `CALM_WIND_KT`.)
 */
export const CALM_RUNWAY_KT = 5;

/**
 * Runways in use for a wind blowing FROM `windFromTrueDeg` at `windKt`. Uses the nav module's
 * `runwayInUse`; with a calm wind the choice is restricted to the longest runway. Returns null
 * for an airport without runways.
 */
export function runwaysInUse(airport: Airport, windFromTrueDeg: number, windKt: number): RunwaysInUse | null {
  if (!airport.runways.length) return null;
  const withEnds: RunwayRecord[] = airport.runways.map((rw) => ('ends' in rw ? (rw as RunwayRecord) : withRunwayEnds(rw)));
  let candidates = withEnds;
  if (windKt < CALM_RUNWAY_KT) {
    let longest = withEnds[0];
    for (const rw of withEnds) if (rw.lengthM > longest.lengthM) longest = rw;
    candidates = [longest];
  }
  const end = runwayInUse({ ...airport, runways: candidates }, windFromTrueDeg);
  if (!end) return null;
  const owner = withEnds.find((rw) => rw.ends[0] === end || rw.ends[1] === end) ?? withEnds[0];
  const primary = ref(owner, end);
  const num = designatorNumber(end.ident);
  const all: RunwayRef[] = [];
  for (const rw of withEnds) {
    for (const e of rw.ends) {
      if (e === end) all.push(primary);
      else if (!Number.isNaN(num) && designatorNumber(e.ident) === num) all.push(ref(rw, e));
    }
  }
  all.sort((a, b) => SIDE_ORDER[designatorSide(a.ident)] - SIDE_ORDER[designatorSide(b.ident)]);
  return { primary, all };
}

/**
 * Traffic-pattern side for a runway: parallel runways use the outer side (L → left, R → right);
 * otherwise `fallback` (left is standard; a tower may assign the side the aircraft is on).
 */
export function patternSideFor(ident: string, fallback: 'left' | 'right'): 'left' | 'right' {
  const s = designatorSide(ident);
  if (s === 'L') return 'left';
  if (s === 'R') return 'right';
  return fallback;
}
