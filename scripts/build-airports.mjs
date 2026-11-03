#!/usr/bin/env node
/**
 * Bake OurAirports data (public domain, https://ourairports.com/data/) into compact JSON for the client.
 *
 *   node scripts/build-airports.mjs [--src <dir-with-csvs>] [--out public/data]
 *
 * Without --src the four CSVs are downloaded from
 * https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/.
 *
 * Outputs
 *   public/data/airports.json        large + medium airports with runways & frequencies (~1.5 MB)
 *   public/data/navaids.json         VOR/DME/NDB/TACAN navaids (~0.7 MB)
 *   public/data/small/<cell>.json    small airports sharded by 10°×10° cell: cell = `${floor(lat/10)}_${floor(lon/10)}`
 *   public/data/index.json           version, counts, list of small cells
 *
 * Compact airport record (keys kept short on purpose; decoded by src/nav/airportsData.ts):
 *   { i: icao/ident, n: name, t: 'L'|'M'|'S'|'H'|'W', la, lo, e: elevation m, c: country, m: municipality, ia: iata,
 *     r: [ { id: "10L/28R", le: [ident, lat, lon, elevM, headingTrue, displacedM], he: [...same...], l: lengthM, w: widthM, s: surface code, lit: 0|1 } ],
 *     f: [ [type, mhz], ... ] }
 * Compact navaid record:
 *   [ident, name, type, freqKHz, lat, lon, elevM, slavedVariationDeg, associatedAirport]
 *   slavedVariationDeg is null when OurAirports has no slaved variation; the client then uses the current
 *   WMM declination (OurAirports' magnetic_variation_deg is an old-epoch local value, so it is not used).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const SRC = opt('--src', null);
const OUT = opt('--out', 'public/data');
const BASE = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/';
const FT = 0.3048;

async function loadCsv(name) {
  if (SRC) return readFileSync(join(SRC, `${name}.csv`), 'utf8');
  const res = await fetch(BASE + `${name}.csv`);
  if (!res.ok) throw new Error(`fetch ${name}.csv → ${res.status}`);
  return await res.text();
}

/** RFC4180-ish CSV parser → array of objects keyed by header. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (s) => (s === '' || s == null ? null : Number(s));
const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const typeCode = { large_airport: 'L', medium_airport: 'M', small_airport: 'S', heliport: 'H', seaplane_base: 'W' };
const surfaceCode = (s) => {
  const u = (s || '').toUpperCase();
  if (/ASP|ASPH|BIT|TAR|MAC/.test(u)) return 'ASP';
  if (/CON|PEM|CEM/.test(u)) return 'CON';
  if (/GRS|GRASS|TURF|SOD/.test(u)) return 'GRS';
  if (/GRE|GRAVEL|GVL/.test(u)) return 'GRE';
  if (/WATER|WAT/.test(u)) return 'WAT';
  if (/DIRT|SAND|CLAY|EARTH|UNK/.test(u)) return 'DIRT';
  return u ? u.slice(0, 4) : 'UNK';
};
const FREQ_PRIORITY = ['TWR', 'GND', 'ATIS', 'CTAF', 'UNICOM', 'CLD', 'APP', 'DEP', 'AWOS', 'ASOS', 'A/D', 'RDO', 'FSS', 'MULTICOM'];
const FREQ_TYPES = new Set(FREQ_PRIORITY);

const [airportsCsv, runwaysCsv, navaidsCsv, freqCsv] = await Promise.all(['airports', 'runways', 'navaids', 'airport-frequencies'].map(loadCsv));
const airports = parseCsv(airportsCsv);
const runways = parseCsv(runwaysCsv);
const navaids = parseCsv(navaidsCsv);
const freqs = parseCsv(freqCsv);

const runwaysByAirport = new Map();
for (const r of runways) {
  if (r.closed === '1') continue;
  const leLat = num(r.le_latitude_deg), leLon = num(r.le_longitude_deg), heLat = num(r.he_latitude_deg), heLon = num(r.he_longitude_deg);
  if (leLat == null || leLon == null || heLat == null || heLon == null) continue;
  const lengthFt = num(r.length_ft);
  if (lengthFt == null || lengthFt < 1200) continue;
  const rec = {
    id: `${r.le_ident}/${r.he_ident}`,
    le: [r.le_ident, round(leLat, 6), round(leLon, 6), round((num(r.le_elevation_ft) ?? 0) * FT, 1), round(num(r.le_heading_degT), 1), round((num(r.le_displaced_threshold_ft) ?? 0) * FT, 0)],
    he: [r.he_ident, round(heLat, 6), round(heLon, 6), round((num(r.he_elevation_ft) ?? 0) * FT, 1), round(num(r.he_heading_degT), 1), round((num(r.he_displaced_threshold_ft) ?? 0) * FT, 0)],
    l: round(lengthFt * FT, 0),
    w: round((num(r.width_ft) ?? 100) * FT, 0),
    s: surfaceCode(r.surface),
    lit: r.lighted === '1' ? 1 : 0,
  };
  if (!runwaysByAirport.has(r.airport_ident)) runwaysByAirport.set(r.airport_ident, []);
  runwaysByAirport.get(r.airport_ident).push(rec);
}

const freqsByAirport = new Map();
for (const f of freqs) {
  const t = (f.type || '').toUpperCase();
  if (!FREQ_TYPES.has(t)) continue;
  const mhz = num(f.frequency_mhz);
  if (mhz == null) continue;
  if (!freqsByAirport.has(f.airport_ident)) freqsByAirport.set(f.airport_ident, []);
  freqsByAirport.get(f.airport_ident).push([t, round(mhz, 3)]);
}
// Keep the 8 most useful frequencies per airport, most useful types first, stable within a type.
for (const [k, list] of freqsByAirport) {
  list.sort((a, b) => FREQ_PRIORITY.indexOf(a[0]) - FREQ_PRIORITY.indexOf(b[0]));
  freqsByAirport.set(k, list.slice(0, 8));
}

const toRecord = (a) => {
  const r = runwaysByAirport.get(a.ident) ?? [];
  const rec = {
    i: a.ident, n: a.name, t: typeCode[a.type],
    la: round(num(a.latitude_deg), 6), lo: round(num(a.longitude_deg), 6),
    e: round((num(a.elevation_ft) ?? 0) * FT, 1), c: a.iso_country,
  };
  if (a.municipality) rec.m = a.municipality;
  if (a.iata_code) rec.ia = a.iata_code;
  if (r.length) rec.r = r;
  const f = freqsByAirport.get(a.ident);
  if (f) rec.f = f;
  return rec;
};

const main = [], small = new Map();
let heliports = 0;
for (const a of airports) {
  const t = typeCode[a.type];
  if (!t) continue;
  if (num(a.latitude_deg) == null || num(a.longitude_deg) == null) continue;
  if (t === 'L' || t === 'M') { main.push(toRecord(a)); continue; }
  if (t === 'H') { heliports++; continue; }
  const rws = runwaysByAirport.get(a.ident);
  if (!rws || !rws.length) continue; // small airports need a usable runway
  const cell = `${Math.floor(num(a.latitude_deg) / 10)}_${Math.floor(num(a.longitude_deg) / 10)}`;
  if (!small.has(cell)) small.set(cell, []);
  small.get(cell).push(toRecord(a));
}

const NAV_TYPES = new Set(['VOR', 'VOR-DME', 'VORTAC', 'DME', 'NDB', 'NDB-DME', 'TACAN']);
const navOut = [];
for (const n of navaids) {
  if (!NAV_TYPES.has(n.type)) continue;
  const lat = num(n.latitude_deg), lon = num(n.longitude_deg);
  if (lat == null || lon == null) continue;
  navOut.push([n.ident, n.name, n.type, num(n.frequency_khz) ?? 0, round(lat, 5), round(lon, 5), round((num(n.elevation_ft) ?? 0) * FT, 0), round(num(n.slaved_variation_deg), 1), n.associated_airport || '']);
}

mkdirSync(join(OUT, 'small'), { recursive: true });
const generated = new Date().toISOString().slice(0, 10);
const meta = { version: 1, generated, source: 'OurAirports (public domain) — https://ourairports.com/data/' };
writeFileSync(join(OUT, 'airports.json'), JSON.stringify({ ...meta, airports: main }));
writeFileSync(join(OUT, 'navaids.json'), JSON.stringify({ ...meta, navaids: navOut }));
for (const [cell, list] of small) writeFileSync(join(OUT, 'small', `${cell}.json`), JSON.stringify({ ...meta, airports: list }));
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ ...meta, counts: { large_medium: main.length, small: [...small.values()].reduce((s, l) => s + l.length, 0), navaids: navOut.length, heliports_skipped: heliports }, smallCells: [...small.keys()].sort() }));
console.log(`airports.json: ${main.length} airports; small shards: ${small.size} cells; navaids: ${navOut.length}`);
