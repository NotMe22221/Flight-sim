/**
 * Decoders for the compact JSON produced by `scripts/build-airports.mjs` into the shared
 * `Airport` / `Runway` / `Navaid` contracts (plus the module's widened records).
 *
 * Compact airport: `{ i, n, t, la, lo, e, c, m?, ia?, r?: [{ id, le, he, l, w, s, lit }], f?: [[type, mhz]] }`
 *   runway end tuple: `[ident, lat, lon, elevM, headingTrueDeg | null, displacedM]`
 * Compact navaid: `[ident, name, type, freqKHz, lat, lon, elevM, slavedVariationDeg, associatedAirport]`
 */
import type { Airport, Geodetic, Navaid, Runway } from '../core/types';
import { wrap360 } from '../core/math';
import { initialBearingDeg } from '../geo/wgs84';
import { magneticDeclinationDeg } from '../geo/magvar';
import { synthesizeIls } from './ils';
import type { AirportRecord, NavaidRecord, RunwayEnd, RunwayRecord } from './navTypes';

// ── Compact record shapes (as written by the build script) ───────────────────────────────
export type CompactRunwayEnd = [ident: string, lat: number, lon: number, elevM: number | null, headingTrue: number | null, displacedM: number | null];
export interface CompactRunway { id: string; le: CompactRunwayEnd; he: CompactRunwayEnd; l: number; w: number; s: string; lit: 0 | 1 }
export interface CompactAirport {
  i: string; n: string; t: 'L' | 'M' | 'S' | 'H' | 'W'; la: number; lo: number; e: number; c: string;
  m?: string; ia?: string; r?: CompactRunway[]; f?: [string, number][];
}
export type CompactNavaid = [ident: string, name: string, type: string, freqKHz: number, lat: number, lon: number, elevM: number | null, variationDeg: number | null, airport: string];
export interface AirportsFile { version: number; generated: string; source: string; airports: CompactAirport[] }
export interface NavaidsFile { version: number; generated: string; source: string; navaids: CompactNavaid[] }
export interface IndexFile { version: number; generated: string; counts: Record<string, number>; smallCells: string[] }

const AIRPORT_TYPE: Record<CompactAirport['t'], Airport['type']> = { L: 'large', M: 'medium', S: 'small', H: 'heliport', W: 'seaplane' };

/** Map an OurAirports surface code to the contract's surface enum. */
export function decodeSurface(code: string): Runway['surface'] {
  const u = code.toUpperCase();
  if (u === 'ASP' || u === 'PAVE' || u === 'HARD' || u === 'PSP' || u === 'BRI') return 'asphalt';
  if (u === 'CON' || u === 'COM' || u === 'COP' || u === 'COR' || u === 'COMP' || u === 'PEM') return 'concrete';
  if (u === 'GRS') return 'grass';
  if (u === 'GRE' || u === 'GRVL' || u === 'GRV') return 'gravel';
  if (u === 'WAT') return 'water';
  return 'other';
}

/** Paved surfaces (eligible for a synthetic ILS and treated as 'paved' by the FDM). */
export const isPaved = (s: Runway['surface']): boolean => s === 'asphalt' || s === 'concrete';

function decodeEnd(t: CompactRunwayEnd, oppositeT: CompactRunwayEnd, index: 0 | 1, airportElevM: number, lengthM: number): RunwayEnd {
  const threshold: Geodetic = { lat: t[1], lon: t[2], alt: t[3] == null || t[3] === 0 ? airportElevM : t[3] };
  const opposite: Geodetic = { lat: oppositeT[1], lon: oppositeT[2], alt: 0 };
  // OurAirports headings are occasionally missing; fall back to the geometric bearing to the far end.
  const headingDeg = t[4] == null || Number.isNaN(t[4]) ? initialBearingDeg(threshold, opposite) : wrap360(t[4]);
  return {
    ident: t[0],
    threshold,
    headingDeg,
    displacedThresholdM: t[5] ?? 0,
    oppositeIdent: oppositeT[0],
    index,
    lengthM,
  };
}

/** Decode one compact runway into a physical `RunwayRecord` oriented to its low-numbered end. */
export function decodeRunway(r: CompactRunway, airportElevM: number): RunwayRecord {
  const le = decodeEnd(r.le, r.he, 0, airportElevM, r.l);
  const he = decodeEnd(r.he, r.le, 1, airportElevM, r.l);
  return {
    id: r.id,
    ident: le.ident,
    threshold: le.threshold,
    end: he.threshold,
    headingDeg: le.headingDeg,
    lengthM: r.l,
    widthM: r.w,
    surface: decodeSurface(r.s),
    lighted: r.lit === 1,
    displacedThresholdM: le.displacedThresholdM,
    ends: [le, he],
  };
}

/** Decode a compact airport record; synthesises ILSs for eligible large/medium runways. */
export function decodeAirport(a: CompactAirport): AirportRecord {
  const runways = (a.r ?? []).map((r) => decodeRunway(r, a.e));
  if (a.t === 'L' || a.t === 'M') synthesizeIls(a.i, runways);
  const ap: AirportRecord = {
    icao: a.i,
    name: a.n,
    position: { lat: a.la, lon: a.lo, alt: a.e },
    elevationM: a.e,
    type: AIRPORT_TYPE[a.t] ?? 'small',
    country: a.c,
    runways,
  };
  if (a.ia) ap.iata = a.ia;
  if (a.m) ap.municipality = a.m;
  if (a.f && a.f.length) ap.frequencies = a.f.map(([type, mhz]) => ({ type, mhz }));
  return ap;
}

/** Default published service range by navaid type, nm (OurAirports' power class is not baked yet). */
export const DEFAULT_NAVAID_RANGE_NM: Record<Navaid['type'], number> = {
  VOR: 40, 'VOR-DME': 40, DME: 40, VORTAC: 130, TACAN: 130, NDB: 50,
};

const NAVAID_TYPE: Record<string, Navaid['type']> = {
  VOR: 'VOR', 'VOR-DME': 'VOR-DME', VORTAC: 'VORTAC', DME: 'DME', TACAN: 'TACAN', NDB: 'NDB', 'NDB-DME': 'NDB',
};

/** Decode a compact navaid row. 'NDB-DME' maps to type 'NDB' with `hasDme: true`. */
export function decodeNavaid(n: CompactNavaid): NavaidRecord {
  const rawType = n[2];
  const type = NAVAID_TYPE[rawType] ?? 'VOR';
  return {
    id: n[0],
    type,
    name: n[1],
    position: { lat: n[4], lon: n[5], alt: n[6] ?? 0 },
    frequencyKHz: n[3] > 0 ? n[3] : 0,
    magneticVariationDeg: n[7] ?? 0,
    rangeNm: DEFAULT_NAVAID_RANGE_NM[type],
    associatedAirport: n[8] ?? '',
    hasDme: rawType === 'VOR-DME' || rawType === 'VORTAC' || rawType === 'DME' || rawType === 'TACAN' || rawType === 'NDB-DME',
  };
}

/** Both landing directions of a runway. Works for plain `Runway` objects too (ends derived). */
export function runwayEnds(rw: Runway): [RunwayEnd, RunwayEnd] {
  if ('ends' in rw && Array.isArray((rw as RunwayRecord).ends)) return (rw as RunwayRecord).ends;
  const back = wrap360(rw.headingDeg + 180);
  const a: RunwayEnd = { ident: rw.ident, threshold: rw.threshold, headingDeg: rw.headingDeg, displacedThresholdM: rw.displacedThresholdM, oppositeIdent: reciprocalIdent(rw.ident), index: 0, lengthM: rw.lengthM };
  const b: RunwayEnd = { ident: a.oppositeIdent, threshold: rw.end, headingDeg: back, displacedThresholdM: 0, oppositeIdent: rw.ident, index: 1, lengthM: rw.lengthM };
  if (rw.ils) a.ils = { ...rw.ils, synthetic: false, frequencyKHz: Math.round(rw.ils.frequencyMHz * 1000) };
  return [a, b];
}

/** "28R" → "10L", "08" → "26", "36" → "18". Non-standard idents are returned unchanged. */
export function reciprocalIdent(ident: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident.trim());
  if (!m) return ident;
  const n = ((Number(m[1]) + 17) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return `${String(n).padStart(2, '0')}${side}`;
}

/** Find a runway end by ident at an airport (case-insensitive, '08' and '8' both match). */
export function findRunwayEnd(airport: Airport, ident: string): { runway: RunwayRecord; end: RunwayEnd } | undefined {
  const want = normaliseIdent(ident);
  for (const rw of airport.runways as RunwayRecord[]) {
    for (const end of runwayEnds(rw)) if (normaliseIdent(end.ident) === want) return { runway: rw, end };
  }
  return undefined;
}

const normaliseIdent = (s: string): string => s.trim().toUpperCase().replace(/^0+(\d)/, '$1');

/**
 * A `Runway` view oriented to the given end: `threshold`/`ident`/`headingDeg`/`ils` describe
 * that landing direction and `end` is the opposite pavement end. Allocates a new object.
 */
export function runwayForEnd(rw: RunwayRecord, endIndex: 0 | 1): RunwayRecord {
  if (endIndex === 0) return rw;
  const [le, he] = rw.ends;
  const view: RunwayRecord = {
    ...rw,
    ident: he.ident,
    threshold: he.threshold,
    end: le.threshold,
    headingDeg: he.headingDeg,
    displacedThresholdM: he.displacedThresholdM,
    ends: rw.ends,
  };
  if (he.ils) view.ils = he.ils; else delete view.ils;
  return view;
}

/** Magnetic heading of a runway end at the given UTC time, deg (0..360). */
export function runwayEndHeadingMag(end: RunwayEnd, utcMs: number): number {
  return wrap360(end.headingDeg - magneticDeclinationDeg(end.threshold.lat, end.threshold.lon, end.threshold.alt, utcMs));
}
