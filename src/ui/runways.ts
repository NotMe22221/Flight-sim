/** Runway helpers: the nav database stores one record per runway, the UI offers both ends. */
import type { Airport, Runway } from '../core/types';
import type { RunwayEndChoice } from './UiHost';

/** '28R' → '10L', '09' → '27', '18C' → '36C', '36' → '18'. Non-numeric idents get '/R' appended. */
export function reciprocalIdent(ident: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident.trim().toUpperCase());
  if (!m) return `${ident}/R`;
  let n = (parseInt(m[1], 10) + 18) % 36;
  if (n === 0) n = 36;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return `${n.toString().padStart(2, '0')}${side}`;
}

/** Both ends of a runway as spawn choices (primary end first). */
export function runwayEnds(rwy: Runway): RunwayEndChoice[] {
  const primary: RunwayEndChoice = {
    runwayIdent: rwy.ident, endIdent: rwy.ident, threshold: rwy.threshold, headingDeg: rwy.headingDeg, lengthM: rwy.lengthM,
  };
  const recip: RunwayEndChoice = {
    runwayIdent: rwy.ident, endIdent: reciprocalIdent(rwy.ident), threshold: rwy.end,
    headingDeg: (rwy.headingDeg + 180) % 360, lengthM: rwy.lengthM,
  };
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
export function runwayPairLabel(rwy: Runway): string { return `${rwy.ident}/${reciprocalIdent(rwy.ident)}`; }

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
