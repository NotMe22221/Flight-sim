/**
 * `NavDb` — the navigation database behind the world map, radios and GPS.
 *
 * Loads `data/airports.json` (large + medium airports) and `data/navaids.json` once, and lazily
 * loads `data/small/<cell>.json` shards (10°×10° cells of small airports) around a region on
 * `loadRegion`. Every loaded record is inserted into a 1° spatial grid, so nearest queries,
 * frequency lookups and runway-in-use selection are independent of the dataset size.
 */
import type { Airport, Geodetic, NavDatabase, Runway } from '../core/types';
import { deltaDeg } from '../core/math';
import { NM } from '../core/units';
import { EARTH_RADIUS, greatCircleDistance } from '../geo/wgs84';
import { decodeAirport, decodeNavaid, runwayForEnd, type AirportsFile, type IndexFile, type NavaidsFile } from './airportsData';
import { buildIlsGeometry, type IlsGeometry } from './ils';
import { memoizeLoader } from './loaders';
import type { AirportRecord, NavDataLoader, NavaidRecord, RunwayEnd, RunwayRecord } from './navTypes';
import { M_PER_DEG, SpatialGrid, capLonHalfWidthDeg } from './spatialGrid';

/** Maximum distance at which a localizer can be tuned, nm. */
export const ILS_TUNE_RANGE_NM = 40;

/** An ILS-equipped runway end with its receiver geometry. */
export interface IlsEntry { airport: AirportRecord; runway: RunwayRecord; endIndex: 0 | 1; geometry: IlsGeometry }

export interface NavDbOptions {
  /** directory of the data files relative to the site root (default 'data/') */
  dataDir?: string;
}

export class NavDb implements NavDatabase {
  private readonly loader: NavDataLoader & { readonly calls: number };
  private readonly dataDir: string;
  private readonly airportsByIcao = new Map<string, AirportRecord>();
  private readonly airportGrid = new SpatialGrid<AirportRecord>();
  private readonly navaidGrid = new SpatialGrid<NavaidRecord>();
  private readonly navaidsByKHz = new Map<number, NavaidRecord[]>();
  private readonly ilsByKHz = new Map<number, IlsEntry[]>();
  private readonly ilsGeometryCache = new WeakMap<RunwayEnd, IlsGeometry>();
  private smallCells: Set<string> | null = null;
  private readonly loadedCells = new Map<string, Promise<void>>();
  private basePromise: Promise<void> | null = null;
  private airportList: AirportRecord[] = [];
  private navaidList: NavaidRecord[] = [];

  constructor(loader: NavDataLoader, options: NavDbOptions = {}) {
    this.loader = memoizeLoader(loader);
    this.dataDir = options.dataDir ?? 'data/';
  }

  /** Number of raw loader calls so far (each path is fetched at most once). */
  get loaderCalls(): number { return this.loader.calls; }
  /** Airports currently in memory (large/medium + loaded small shards). */
  get airports(): readonly AirportRecord[] { return this.airportList; }
  /** Navaids in memory. */
  get navaids(): readonly NavaidRecord[] { return this.navaidList; }
  /** True once airports.json / navaids.json / index.json have been loaded. */
  get ready(): boolean { return this.smallCells !== null; }

  /** Load the base files (airports, navaids, index). Idempotent; concurrent calls share the work. */
  load(): Promise<void> {
    if (!this.basePromise) {
      this.basePromise = (async () => {
        const [airports, navaids, index] = await Promise.all([
          this.loader(`${this.dataDir}airports.json`) as Promise<AirportsFile>,
          this.loader(`${this.dataDir}navaids.json`) as Promise<NavaidsFile>,
          this.loader(`${this.dataDir}index.json`) as Promise<IndexFile>,
        ]);
        for (const a of airports.airports) this.addAirport(decodeAirport(a));
        for (const n of navaids.navaids) this.addNavaid(decodeNavaid(n));
        this.smallCells = new Set(index.smallCells);
      })().catch((err: unknown) => { this.basePromise = null; throw err; });
    }
    return this.basePromise;
  }

  /** Load the base files plus every small-airport shard intersecting the circle. Never re-fetches. */
  async loadRegion(center: Geodetic, radiusNm: number): Promise<void> {
    await this.load();
    const cells = this.smallCells!;
    const pending: Promise<void>[] = [];
    for (const cell of shardCellsAround(center, radiusNm * NM)) {
      if (!cells.has(cell)) continue;
      let p = this.loadedCells.get(cell);
      if (!p) {
        p = (this.loader(`${this.dataDir}small/${cell}.json`) as Promise<AirportsFile>)
          .then((file) => { for (const a of file.airports) this.addAirport(decodeAirport(a)); })
          .catch((err: unknown) => { this.loadedCells.delete(cell); throw err; });
        this.loadedCells.set(cell, p);
      }
      pending.push(p);
    }
    await Promise.all(pending);
  }

  /** Shards already loaded (cell ids like "3_-13"). */
  get loadedShards(): string[] { return [...this.loadedCells.keys()]; }

  getAirport(icao: string): AirportRecord | undefined {
    return this.airportsByIcao.get(icao.trim().toUpperCase());
  }

  nearestAirports(pos: Geodetic, maxCount: number, maxNm: number): AirportRecord[] {
    return this.airportGrid.nearest(pos, maxCount, maxNm * NM).map((n) => n.item);
  }

  nearestNavaids(pos: Geodetic, maxCount: number, maxNm: number): NavaidRecord[] {
    return this.navaidGrid.nearest(pos, maxCount, maxNm * NM).map((n) => n.item);
  }

  /**
   * Airports matching `query`, best first: exact ICAO/IATA, then ICAO/IATA prefix, then
   * name/municipality substring (case-insensitive). Larger airports rank higher within a tier.
   */
  searchAirports(query: string, limit = 20): AirportRecord[] {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const ql = q.toLowerCase();
    const scored: { a: AirportRecord; score: number }[] = [];
    for (const a of this.airportList) {
      let score = 0;
      const iata = a.iata?.toUpperCase();
      if (a.icao === q || iata === q) score = 400;
      else if (a.icao.startsWith(q) || (iata !== undefined && iata.startsWith(q))) score = 300;
      else {
        const name = a.name.toLowerCase();
        const muni = a.municipality?.toLowerCase() ?? '';
        if (name.startsWith(ql) || muni.startsWith(ql)) score = 200;
        else if (name.includes(ql) || muni.includes(ql)) score = 100;
      }
      if (score) scored.push({ a, score: score + TYPE_RANK[a.type] });
    }
    scored.sort((x, y) => y.score - x.score || x.a.icao.localeCompare(y.a.icao));
    return scored.slice(0, limit).map((s) => s.a);
  }

  /**
   * Waypoint identifiers starting with `prefix` (airport ICAO/IATA codes and navaid idents),
   * for the G1000 ident entry: exact matches within 300 nm first, then the nearest to `pos`
   * (NDB idents repeat worldwide, so a far-away exact "KS" must not hide KSFO). A linear scan
   * of the loaded records (~1 ms), meant for keystrokes, not for every frame.
   */
  searchIdents(prefix: string, pos: Geodetic, limit = 8): IdentMatch[] {
    const q = prefix.trim().toUpperCase();
    const out: IdentMatch[] = [];
    if (!q || limit <= 0) return out;
    const consider = (m: IdentMatch): void => {
      // keep `out` sorted (exact first, then by distance) and at most `limit` long
      let i = out.length;
      while (i > 0 && rankAfter(out[i - 1], m)) i--;
      if (i >= limit) return;
      out.splice(i, 0, m);
      if (out.length > limit) out.pop();
    };
    for (const a of this.airportList) {
      const iata = a.iata?.toUpperCase();
      const byIcao = a.icao.startsWith(q), byIata = !byIcao && iata !== undefined && iata.startsWith(q);
      if (!byIcao && !byIata) continue;
      consider({ ident: a.icao, kind: 'airport', subtype: a.type, name: a.name, position: a.position, distanceM: greatCircleDistance(pos, a.position), exact: a.icao === q || iata === q, frequencyKHz: 0, airport: a });
    }
    for (const n of this.navaidList) {
      if (!n.id.startsWith(q)) continue;
      consider({ ident: n.id, kind: n.type === 'NDB' ? 'ndb' : 'vor', subtype: n.type, name: n.name, position: n.position, distanceM: greatCircleDistance(pos, n.position), exact: n.id === q, frequencyKHz: n.frequencyKHz, navaid: n });
    }
    return out;
  }

  /** Nearest navaid on `khz` within its published range of `pos`, or undefined. */
  findNavaidByFrequency(khz: number, pos: Geodetic): NavaidRecord | undefined {
    const list = this.navaidsByKHz.get(khz);
    if (!list) return undefined;
    let best: NavaidRecord | undefined, bestD = Infinity;
    for (const n of list) {
      const d = greatCircleDistance(pos, n.position);
      if (d <= n.rangeNm * NM && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /** Nearest ILS on `khz` within {@link ILS_TUNE_RANGE_NM} of `pos`; `runway` is oriented to the served end. */
  findIlsByFrequency(khz: number, pos: Geodetic): { airport: AirportRecord; runway: RunwayRecord } | undefined {
    const e = this.findIlsEntry(khz, pos);
    return e ? { airport: e.airport, runway: runwayForEnd(e.runway, e.endIndex) } : undefined;
  }

  /** Like {@link findIlsByFrequency} but returns the full entry including receiver geometry. */
  findIlsEntry(khz: number, pos: Geodetic): IlsEntry | undefined {
    const list = this.ilsByKHz.get(khz);
    if (!list) return undefined;
    let best: IlsEntry | undefined, bestD = Infinity;
    for (const e of list) {
      const d = greatCircleDistance(pos, e.geometry.threshold);
      if (d <= ILS_TUNE_RANGE_NM * NM && d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  /** Receiver geometry for a runway end's ILS (cached), or undefined when it has none. */
  ilsGeometry(airport: Airport, runway: Runway, endIndex: 0 | 1): IlsGeometry | undefined {
    const rw = runway as RunwayRecord;
    if (!rw.ends) return undefined;
    const end = rw.ends[endIndex];
    let g = this.ilsGeometryCache.get(end);
    if (!g) {
      g = buildIlsGeometry(airport.icao, rw, endIndex);
      if (g) this.ilsGeometryCache.set(end, g);
    }
    return g;
  }

  /**
   * Runway end to use for the given wind direction (true deg the wind blows FROM): the end with
   * the largest headwind component; among near-equal candidates the longest runway wins.
   */
  runwayInUse(airport: Airport, windFromDeg: number): RunwayEnd | undefined {
    return runwayInUse(airport, windFromDeg);
  }

  private addAirport(a: AirportRecord): void {
    if (this.airportsByIcao.has(a.icao)) return;
    this.airportsByIcao.set(a.icao, a);
    this.airportList.push(a);
    this.airportGrid.insert(a, a.position.lat, a.position.lon);
    for (const rw of a.runways) {
      for (const endIndex of [0, 1] as const) {
        const end = rw.ends[endIndex];
        if (!end.ils) continue;
        const geometry = buildIlsGeometry(a.icao, rw, endIndex);
        if (!geometry) continue;
        this.ilsGeometryCache.set(end, geometry);
        const entry: IlsEntry = { airport: a, runway: rw, endIndex, geometry };
        const list = this.ilsByKHz.get(end.ils.frequencyKHz);
        if (list) list.push(entry); else this.ilsByKHz.set(end.ils.frequencyKHz, [entry]);
      }
    }
  }

  private addNavaid(n: NavaidRecord): void {
    this.navaidList.push(n);
    this.navaidGrid.insert(n, n.position.lat, n.position.lon);
    if (n.frequencyKHz > 0) {
      const list = this.navaidsByKHz.get(n.frequencyKHz);
      if (list) list.push(n); else this.navaidsByKHz.set(n.frequencyKHz, [n]);
    }
  }
}

const TYPE_RANK: Record<Airport['type'], number> = { large: 5, medium: 4, small: 3, seaplane: 2, heliport: 1 };

/** One result of {@link NavDb.searchIdents}. */
export interface IdentMatch {
  ident: string;
  /** 'airport', 'vor' (VOR, VOR-DME, VORTAC, DME, TACAN) or 'ndb' */
  kind: 'airport' | 'vor' | 'ndb';
  /** airport type ('large' …) or navaid type ('VOR-DME' …) */
  subtype: string;
  name: string;
  position: Geodetic;
  /** great-circle distance from the search position, m */
  distanceM: number;
  /** the ident equals the query (an IATA code counts for airports) */
  exact: boolean;
  /** navaid frequency, kHz (0 for airports) */
  frequencyKHz: number;
  airport?: AirportRecord;
  navaid?: NavaidRecord;
}

/** Exact ident matches closer than this rank before nearer prefix matches, m (300 nm). */
const EXACT_PRIORITY_M = 300 * NM;
const priority = (m: IdentMatch): boolean => m.exact && m.distanceM <= EXACT_PRIORITY_M;
/** True when `a` should be listed after `b`: nearby exact matches first, then nearer first. */
const rankAfter = (a: IdentMatch, b: IdentMatch): boolean => (priority(a) !== priority(b) ? priority(b) : a.distanceM > b.distanceM);

/**
 * Headwind-component tolerance (cosine units) within which the longer runway wins: 0.02 is
 * ≈ 11° of wind angle near a direct headwind (and ≈ 1° near a direct crosswind), so parallel
 * and nearly parallel runways compete on length.
 */
const HEADWIND_TIE_EPS = 0.02;

/** Standalone runway-in-use selection (see `NavDb.runwayInUse`). */
export function runwayInUse(airport: Airport, windFromDeg: number): RunwayEnd | undefined {
  let best: RunwayEnd | undefined, bestHead = -Infinity;
  for (const rw of airport.runways as RunwayRecord[]) {
    const ends = rw.ends ?? [];
    for (const end of ends) {
      const head = Math.cos(deltaDeg(windFromDeg, end.headingDeg) * (Math.PI / 180));
      if (!best || head > bestHead + HEADWIND_TIE_EPS || (Math.abs(head - bestHead) <= HEADWIND_TIE_EPS && end.lengthM > best.lengthM)) {
        best = end; bestHead = Math.max(head, bestHead);
      }
    }
  }
  return best;
}

/** 10°×10° shard ids (`${floor(lat/10)}_${floor(lon/10)}`) covering a circle (exact spherical cap; poles and the antimeridian included). */
export function shardCellsAround(center: Geodetic, radiusM: number): string[] {
  const dLat = radiusM / M_PER_DEG;
  const r0 = Math.floor(Math.max(center.lat - dLat, -90) / 10);
  const r1 = Math.floor(Math.min(center.lat + dLat, 90) / 10);
  // Longitude: the cap's true half-width asin(sin δ / cos φ), or every column when it holds a pole.
  const halfLon = capLonHalfWidthDeg(center.lat, radiusM / EARTH_RADIUS);
  let c0 = -18, c1 = 17;
  if (halfLon < 180) {
    c0 = Math.floor((center.lon - halfLon) / 10);
    c1 = Math.floor((center.lon + halfLon) / 10);
    if (c1 - c0 + 1 >= 36) { c0 = -18; c1 = 17; }
  }
  const out = new Set<string>();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.add(`${r}_${(((c + 18) % 36) + 36) % 36 - 18}`);
  }
  return [...out];
}
