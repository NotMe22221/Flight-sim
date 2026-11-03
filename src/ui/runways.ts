/** Runway helpers: the nav database stores one record per runway, the UI offers both ends. */
import type { Airport, Geodetic, Runway } from '../core/types';
import type { RunwayEndChoice, UiHost } from './UiHost';
import { formatHeading } from './format';
import { trueToMagnetic } from './geoMath';

/**
 * Per-end data the nav database carries on its runway records (`RunwayRecord.ends`: real
 * idents such as 'NE'/'SW' or '13W', each end's own heading, threshold and ILS). Feature-
 * detected so a plain core `Runway` still works (ends derived from the primary end).
 */
interface RecordEnd { ident: string; headingDeg?: number; threshold?: Geodetic; ils?: { frequencyMHz: number } }

function recordEnds(rwy: Runway): [RecordEnd, RecordEnd] | null {
  const ends = (rwy as Runway & { ends?: unknown }).ends;
  if (!Array.isArray(ends) || ends.length !== 2) return null;
  const ok = (e: unknown): e is RecordEnd => typeof e === 'object' && e !== null && typeof (e as RecordEnd).ident === 'string' && (e as RecordEnd).ident !== '';
  return ok(ends[0]) && ok(ends[1]) ? [ends[0], ends[1]] : null;
}

const finiteOr = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const validGeo = (g: Geodetic | undefined): g is Geodetic => !!g && Number.isFinite(g.lat) && Number.isFinite(g.lon);

/** '28R' → '10L', '09' → '27', '18C' → '36C', '36' → '18'. Non-numeric idents get '/R' appended. */
export function reciprocalIdent(ident: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident.trim().toUpperCase());
  if (!m) return `${ident}/R`;
  let n = (parseInt(m[1], 10) + 18) % 36;
  if (n === 0) n = 36;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return `${n.toString().padStart(2, '0')}${side}`;
}

/**
 * Both ends of a runway as spawn choices (primary end first). Uses the record's own end data
 * when the nav database provides it, so the chosen `endIdent` is exactly what the simulator
 * looks up (a derived 'NE/R' would not match and spawn somewhere else).
 */
export function runwayEnds(rwy: Runway): RunwayEndChoice[] {
  const rec = recordEnds(rwy);
  const a = rec?.[0], b = rec?.[1];
  const primary: RunwayEndChoice = {
    runwayIdent: rwy.ident, endIdent: a?.ident ?? rwy.ident,
    threshold: validGeo(a?.threshold) ? a.threshold : rwy.threshold,
    headingDeg: finiteOr(a?.headingDeg, rwy.headingDeg), lengthM: rwy.lengthM,
  };
  const recip: RunwayEndChoice = {
    runwayIdent: rwy.ident, endIdent: b?.ident ?? reciprocalIdent(rwy.ident),
    threshold: validGeo(b?.threshold) ? b.threshold : rwy.end,
    headingDeg: finiteOr(b?.headingDeg, (rwy.headingDeg + 180) % 360), lengthM: rwy.lengthM,
  };
  const ilsA = a ? a.ils?.frequencyMHz : rwy.ils?.frequencyMHz;
  const ilsB = b?.ils?.frequencyMHz;
  if (typeof ilsA === 'number' && ilsA > 0) primary.ilsMHz = ilsA;
  if (typeof ilsB === 'number' && ilsB > 0) recip.ilsMHz = ilsB;
  return [primary, recip];
}

/** All runway ends of an airport, longest runway first. */
export function airportRunwayEnds(ap: Airport): RunwayEndChoice[] {
  return [...ap.runways].sort((a, b) => b.lengthM - a.lengthM).flatMap(runwayEnds);
}

/** Finds an end by ident ('28R'), checking both ends of every runway. */
export function findRunwayEnd(ap: Airport, endIdent: string): RunwayEndChoice | null {
  const want = endIdent.trim().toUpperCase();
  for (const r of ap.runways) for (const e of runwayEnds(r)) if (e.endIdent.toUpperCase() === want) return e;
  return null;
}

/** 'Runway 28R/10L · 11,870 ft · asphalt' style helper pieces. */
export function runwayPairLabel(rwy: Runway): string {
  const [a, b] = runwayEnds(rwy);
  return `${a.endIdent}/${b.endIdent}`;
}

/** Headwind component (kt) on a runway end for wind FROM `windDirDeg` at `windKt`; negative = tailwind. */
export function headwindKt(end: RunwayEndChoice, windDirDeg: number, windKt: number): number {
  return Math.cos((windDirDeg - end.headingDeg) * Math.PI / 180) * windKt;
}

/** Best end into wind (ties → longest), or the longest runway's primary end when calm (< 5 kt). */
export function activeRunwayEnd(ap: Airport, windDirDeg: number, windKt: number): RunwayEndChoice | null {
  const ends = airportRunwayEnds(ap);
  if (ends.length === 0) return null;
  if (windKt < 5) return ends[0];
  let best = ends[0], bestHw = -Infinity;
  for (const e of ends) {
    const hw = headwindKt(e, windDirDeg, windKt);
    if (hw > bestHw + 1e-9 || (Math.abs(hw - bestHw) < 1e-9 && e.lengthM > best.lengthM)) { best = e; bestHw = hw; }
  }
  return best;
}

/** The host's magnetic variation at a place (deg, east +), or null when it does not provide one. */
export function magneticVariationAt(host: Pick<UiHost, 'magneticVariationDeg'>, lat: number, lon: number): number | null {
  if (typeof host.magneticVariationDeg !== 'function') return null;
  try { const v = host.magneticVariationDeg(lat, lon); return Number.isFinite(v) ? v : null; } catch { return null; }
}

/**
 * A runway end's heading as pilots read it: magnetic when the variation is known ('284°', matching
 * the runway number and the compass), otherwise explicitly true ('298°T').
 */
export function runwayHeadingLabel(headingTrueDeg: number, variationDeg: number | null): string {
  if (variationDeg === null || !Number.isFinite(variationDeg)) return `${formatHeading(headingTrueDeg)}T`;
  return formatHeading(trueToMagnetic(headingTrueDeg, variationDeg));
}

/** Hard-coded default (DESIGN.md): KSFO 28R, used when the nav DB has not loaded yet. */
export const FALLBACK_KSFO: Airport = {
  icao: 'KSFO', iata: 'SFO', name: 'San Francisco International Airport',
  position: { lat: 37.618972, lon: -122.374889, alt: 4 }, elevationM: 4, type: 'large',
  municipality: 'San Francisco', country: 'US',
  runways: [
    { ident: '28R', threshold: { lat: 37.613538, lon: -122.35716, alt: 4 }, end: { lat: 37.628693, lon: -122.393242, alt: 4 },
      headingDeg: 298, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0,
      ils: { frequencyMHz: 111.7, ident: 'ISFO', glideslopeDeg: 3, locCourseDeg: 298 } },
    { ident: '28L', threshold: { lat: 37.61276, lon: -122.357956, alt: 4 }, end: { lat: 37.626486, lon: -122.390616, alt: 4 },
      headingDeg: 298, lengthM: 3231, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 },
    { ident: '01R', threshold: { lat: 37.608726, lon: -122.377, alt: 4 }, end: { lat: 37.6286, lon: -122.368, alt: 4 },
      headingDeg: 28, lengthM: 2636, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 },
    { ident: '01L', threshold: { lat: 37.607, lon: -122.3809, alt: 4 }, end: { lat: 37.6253, lon: -122.3726, alt: 4 },
      headingDeg: 28, lengthM: 2286, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 },
  ],
  frequencies: [{ type: 'ATIS', mhz: 118.85 }, { type: 'GND', mhz: 121.8 }, { type: 'TWR', mhz: 120.5 }, { type: 'APP', mhz: 135.65 }],
};
