/**
 * MSFS flight plans (.pln, the FSX/P3D/MSFS "SimBase.Document" XML that Little Navmap, SimBrief,
 * Plan-G and MSFS itself read and write): import a plan's waypoints, export ours.
 *
 * Only what the planner uses is read: each ATCWaypoint's id, type and WorldPosition
 * (`N37° 37' 8.00",W122° 22' 30.00",+000013.00`, altitude in feet), plus the title and cruising
 * altitude. Parsing is a small tolerant scanner (no DOMParser: it runs in tests and workers too).
 */
import type { Waypoint } from '../core/types';

const FT = 0.3048;

export interface PlnPlan {
  title: string;
  waypoints: Waypoint[];
  /** cruising altitude, m (CruisingAlt, feet in the file) */
  cruiseAltM?: number;
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : null;
};

/** `N37° 37' 8.00"` (also `N37 37 8.00`, `N37° 37.133'`) → signed degrees. */
export function parseDms(s: string): number | null {
  const m = /([NSEW])\s*(\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]?\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|'')?)?/i.exec(s.trim());
  if (!m) return null;
  const v = parseFloat(m[2]) + (m[3] ? parseFloat(m[3]) / 60 : 0) + (m[4] ? parseFloat(m[4]) / 3600 : 0);
  if (!Number.isFinite(v)) return null;
  return /[SW]/i.test(m[1]) ? -v : v;
}

/** WorldPosition string → lat, lon (deg) and altitude (m), or null. */
export function parseWorldPosition(s: string): { lat: number; lon: number; altM: number } | null {
  const parts = s.split(',');
  if (parts.length < 2) return null;
  const lat = parseDms(parts[0]), lon = parseDms(parts[1]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const alt = parts[2] !== undefined ? parseFloat(parts[2]) : 0;
  return { lat, lon, altM: Number.isFinite(alt) ? alt * FT : 0 };
}

function typeFrom(t: string | null): Waypoint['type'] {
  switch ((t ?? '').toLowerCase()) {
    case 'airport': return 'airport';
    case 'vor': case 'ndb': return 'navaid';
    case 'intersection': return 'fix';
    default: return 'user';
  }
}

/** Parse a .pln document. Throws when it has no usable waypoints. */
export function parsePln(xml: string): PlnPlan {
  if (!/<FlightPlan\.FlightPlan/i.test(xml)) throw new Error('Not an MSFS flight plan (.pln)');
  const title = tag(xml, 'Title') ?? 'Flight plan';
  const cruise = parseFloat(tag(xml, 'CruisingAlt') ?? '');
  const waypoints: Waypoint[] = [];
  const re = /<ATCWaypoint(\s[^>]*)?>([\s\S]*?)<\/ATCWaypoint>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const body = m[2];
    const pos = parseWorldPosition(tag(body, 'WorldPosition') ?? '');
    if (!pos) continue;
    const idAttr = /id\s*=\s*"([^"]*)"/i.exec(m[1] ?? '')?.[1];
    const ident = tag(body, 'ICAOIdent') ?? (idAttr ? decode(idAttr) : null) ?? `WP${waypoints.length + 1}`;
    const type = typeFrom(tag(body, 'ATCWaypointType'));
    const wp: Waypoint = { id: ident.slice(0, 12), type, position: { lat: pos.lat, lon: pos.lon, alt: pos.altM } };
    // en-route altitudes are constraints; airports carry their elevation, not a constraint
    if (type !== 'airport' && pos.altM > 0) wp.altConstraintM = pos.altM;
    waypoints.push(wp);
  }
  if (!waypoints.length) throw new Error('The flight plan has no waypoints');
  return { title, waypoints, ...(Number.isFinite(cruise) && cruise > 0 ? { cruiseAltM: cruise * FT } : {}) };
}

/** Signed degrees → `N37° 37' 8.00"`. */
export function formatDms(v: number, isLat: boolean): string {
  const hemi = isLat ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
  let a = Math.abs(v);
  let d = Math.floor(a);
  a = (a - d) * 60;
  let m = Math.floor(a);
  let s = Math.round((a - m) * 60 * 100) / 100;
  if (s >= 60) { s = 0; m++; }
  if (m >= 60) { m = 0; d++; }
  return `${hemi}${d}° ${m}' ${s.toFixed(2)}"`;
}

const altField = (m: number) => { const ft = m / FT; return `${ft < 0 ? '-' : '+'}${Math.abs(ft).toFixed(2).padStart(9, '0')}`; };

const PLN_TYPE: Record<Waypoint['type'], string> = { airport: 'Airport', navaid: 'VOR', fix: 'Intersection', user: 'User' };

/** Write a VFR .pln for these waypoints (first and last airports become departure and destination). */
export function toPln(waypoints: readonly Waypoint[], opts: { title?: string; cruiseAltM?: number } = {}): string {
  const first = waypoints[0], last = waypoints[waypoints.length - 1];
  const pos = (w: Waypoint) => `${formatDms(w.position.lat, true)},${formatDms(w.position.lon, false)},${altField(w.altConstraintM ?? w.position.alt ?? 0)}`;
  const depId = first?.type === 'airport' ? first.id : '';
  const dstId = last?.type === 'airport' ? last.id : '';
  const title = opts.title ?? (depId && dstId ? `${depId} to ${dstId}` : 'Flight plan');
  // cruise: as given, else the highest en-route altitude, else 3,500 ft
  const enRoute = waypoints.map((w) => w.altConstraintM ?? 0).reduce((m, x) => Math.max(m, x), 0);
  const cruiseFt = Math.round((opts.cruiseAltM ?? (enRoute > 0 ? enRoute : 3500 * FT)) / FT);
  const wpXml = waypoints.map((w) => [
    `        <ATCWaypoint id="${encode(w.id)}">`,
    `            <ATCWaypointType>${PLN_TYPE[w.type]}</ATCWaypointType>`,
    `            <WorldPosition>${pos(w)}</WorldPosition>`,
    w.type !== 'user' ? `            <ICAO>\n                <ICAOIdent>${encode(w.id)}</ICAOIdent>\n            </ICAO>` : '',
    '        </ATCWaypoint>',
  ].filter(Boolean).join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
    <Descr>AceXML Document</Descr>
    <FlightPlan.FlightPlan>
        <Title>${encode(title)}</Title>
        <FPType>VFR</FPType>
        <CruisingAlt>${cruiseFt}</CruisingAlt>
        <DepartureID>${encode(depId)}</DepartureID>
        ${first ? `<DepartureLLA>${pos(first)}</DepartureLLA>` : ''}
        <DestinationID>${encode(dstId)}</DestinationID>
        ${last ? `<DestinationLLA>${pos(last)}</DestinationLLA>` : ''}
        <Descr>${encode(title)}</Descr>
        <AppVersion>
            <AppVersionMajor>11</AppVersionMajor>
            <AppVersionBuild>282174</AppVersionBuild>
        </AppVersion>
${wpXml}
    </FlightPlan.FlightPlan>
</SimBase.Document>
`;
}
