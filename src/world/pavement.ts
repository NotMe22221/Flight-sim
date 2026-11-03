/**
 * Airport pavement for terrain flattening: the scenery publishes the pavement areas of the tiles
 * it has (aprons, taxiway areas, helipads, taxiway centre lines with their width, in lon/lat);
 * `PavementRegistry` keeps those near the current airports, deduplicates pieces repeated by
 * neighbouring scenery tiles, gives each airport one target plane through its runway thresholds
 * and hands `TerrainSystem.setPavement` the resulting flattening specs. Pure, no Three.js.
 *
 * Target surface (evidence in README.md): a least-squares plane through the runway threshold
 * elevations of the airport, anchored at its reference point. It matches the runway strips (KSFO:
 * thresholds within 0.3 m of the plane), is known from the navigation database before any terrain
 * or scenery tile arrives (so a spawn can push it before the terrain prefetch), never changes as
 * the terrain refines, and is the same for every piece of an apron split across scenery tiles.
 */
import type { Airport } from '../core/types';
import { makePavementSpec, type PavementFlatteningSpec, type PavementPlane } from '../terrain/pavement';

const D2R = Math.PI / 180;
const M_PER_DEG = 6_371_000 * D2R;

/** One pavement piece published by the scenery (degrees). The same key always means the same geometry. */
export interface PavementArea {
  key: string;
  kind: 'apron' | 'taxiway' | 'helipad' | 'taxiline';
  /** polygon rings `[lon, lat, …]` (outer first, then holes); [] for a centre line */
  rings: number[][];
  /** centre line `[lon, lat, …]`; [] for a polygon */
  line: number[];
  /** pavement width of a centre line (m) */
  widthM: number;
}

/** What the scenery offers (SceneryLike.pavementAreas / pavementRevision). */
export interface PavementSource {
  /** changes whenever the published set changes */
  pavementRevision(): number;
  /** the pavement of every scenery tile it has (including tiles loaded for parking only) */
  pavementAreas(): readonly PavementArea[];
}

export interface PavementRegistryOptions {
  /** an area belongs to the nearest airport whose runways (or reference point) are within this (m) */
  assocRadiusM: number;
  /** caps on the flattened set (areas, points) */
  maxAreas: number;
  maxPoints: number;
  /** steepest plane accepted (m/m): bad threshold data cannot tilt the pavement further */
  maxPlaneSlope: number;
}

export const DEFAULT_PAVEMENT_REGISTRY: PavementRegistryOptions = { assocRadiusM: 2500, maxAreas: 6000, maxPoints: 250_000, maxPlaneSlope: 0.02 };

/**
 * Least-squares plane through an airport's runway thresholds (both ends of every runway) at its
 * reference point; level across a single runway (minimum-norm slope); flat at the airport
 * elevation without runways. Slopes are clamped to ±maxSlope.
 */
export function airportPavementPlane(ap: Airport, maxSlope = DEFAULT_PAVEMENT_REGISTRY.maxPlaneSlope): PavementPlane {
  const lat0 = ap.position.lat, lon0 = ap.position.lon;
  const kx = M_PER_DEG * Math.cos(lat0 * D2R);
  const pts: number[] = [];
  for (const rw of ap.runways) {
    for (const g of [rw.threshold, rw.end]) {
      if (![g.lat, g.lon, g.alt].every(Number.isFinite)) continue;
      pts.push((g.lon - lon0) * kx, (g.lat - lat0) * M_PER_DEG, g.alt);
    }
  }
  const flat: PavementPlane = { lat0, lon0, h0: Number.isFinite(ap.elevationM) ? ap.elevationM : 0, dhdE: 0, dhdN: 0 };
  const n = pts.length / 3;
  if (n === 0) return flat;
  // centred coordinates, then [Σee Σen; Σen Σnn]·g = [Σeh; Σnh] with a tiny ridge (collinear thresholds)
  let me = 0, mn = 0, mh = 0;
  for (let i = 0; i < pts.length; i += 3) { me += pts[i]; mn += pts[i + 1]; mh += pts[i + 2]; }
  me /= n; mn /= n; mh /= n;
  let see = 0, snn = 0, sen = 0, seh = 0, snh = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const e = pts[i] - me, nn = pts[i + 1] - mn, h = pts[i + 2] - mh;
    see += e * e; snn += nn * nn; sen += e * nn; seh += e * h; snh += nn * h;
  }
  const ridge = 1e-6 * Math.max(1, see + snn);
  const a = see + ridge, d = snn + ridge, det = a * d - sen * sen;
  let gE = det > 0 ? (d * seh - sen * snh) / det : 0, gN = det > 0 ? (a * snh - sen * seh) / det : 0;
  const lim = Math.max(0, maxSlope);
  gE = Math.max(-lim, Math.min(lim, gE)); gN = Math.max(-lim, Math.min(lim, gN));
  // plane through the centroid: h(0,0) = mh − gE·me − gN·mn
  return { lat0, lon0, h0: mh - gE * me - gN * mn, dhdE: gE, dhdN: gN };
}

/** Distance (m) from a point to an airport's runways (segments), or to its reference point without runways. */
function distanceToAirport(ap: Airport, lat: number, lon: number): number {
  const kx = M_PER_DEG * Math.cos(lat * D2R);
  if (ap.runways.length === 0) return Math.hypot((ap.position.lon - lon) * kx, (ap.position.lat - lat) * M_PER_DEG);
  let best = Infinity;
  for (const rw of ap.runways) {
    const ax = (rw.threshold.lon - lon) * kx, ay = (rw.threshold.lat - lat) * M_PER_DEG;
    const bx = (rw.end.lon - lon) * kx, by = (rw.end.lat - lat) * M_PER_DEG;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Geometry signature: identical pieces (e.g. a line on a tile border kept by both tiles) collapse. */
function signature(a: PavementArea): string {
  const r = (v: number) => Math.round(v * 1e7);
  let h1 = 0x811c9dc5, h2 = 0x01000193, count = 0;
  const mix = (v: number) => {
    h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (v + count++), 0x5bd1e995) >>> 0;
  };
  mix(a.kind.length); mix(Math.round(a.widthM * 100));
  for (const ring of a.rings) { mix(ring.length); for (const v of ring) mix(r(v)); }
  mix(a.line.length);
  for (const v of a.line) mix(r(v));
  return `${a.kind[0]}${h1.toString(36)}${h2.toString(36)}`;
}

interface Accepted { spec: PavementFlatteningSpec; icao: string; points: number }

/**
 * Keeps the flattened pavement: areas near the current airports, deduplicated by geometry,
 * one stable plane per airport. Areas stay while their airport is current even after the
 * scenery evicts their tile (the terrain must not un-flatten behind the aircraft).
 */
export class PavementRegistry {
  private readonly opts: PavementRegistryOptions;
  private readonly planes = new Map<string, PavementPlane>();
  private readonly accepted = new Map<string, Accepted>();
  /** source keys already classified (accepted, duplicate or outside every airport) for the current airport set */
  private readonly seen = new Set<string>();
  private points = 0;
  private lastRev = Number.NaN;
  private lastAirports = '';
  private capped = false;

  constructor(opts: Partial<PavementRegistryOptions> = {}) {
    this.opts = { ...DEFAULT_PAVEMENT_REGISTRY, ...opts };
  }

  get size(): number { return this.accepted.size; }
  /** the cap stopped accepting areas (debugging) */
  get full(): boolean { return this.capped; }

  /** The airport's target plane (computed once per ICAO and cached). */
  planeFor(ap: Airport): PavementPlane {
    let p = this.planes.get(ap.icao);
    if (!p) { p = airportPavementPlane(ap, this.opts.maxPlaneSlope); this.planes.set(ap.icao, p); }
    return p;
  }

  /** Current specs (stable order of acceptance). */
  specs(): PavementFlatteningSpec[] {
    return [...this.accepted.values()].map((a) => a.spec);
  }

  /**
   * Bring the set up to date with the source and the current airports. Returns the new spec list
   * when it changed, null otherwise (cheap when neither the source revision nor the airports changed).
   */
  sync(source: PavementSource | null, airports: readonly Airport[], force = false): PavementFlatteningSpec[] | null {
    const apKey = airports.map((a) => a.icao).sort().join(',');
    const rev = source ? source.pavementRevision() : -1;
    if (!force && rev === this.lastRev && apKey === this.lastAirports) return null;
    let changed = false;
    if (apKey !== this.lastAirports) {
      const keep = new Set(airports.map((a) => a.icao));
      for (const [k, a] of this.accepted) {
        if (keep.has(a.icao)) continue;
        this.accepted.delete(k);
        this.points -= a.points;
        changed = true;
      }
      for (const icao of [...this.planes.keys()]) if (!keep.has(icao)) this.planes.delete(icao);
      this.seen.clear(); // new airports may claim areas skipped before
      this.capped = false;
    }
    this.lastAirports = apKey;
    this.lastRev = rev;
    if (source && airports.length > 0) {
      for (const area of source.pavementAreas()) {
        if (this.seen.has(area.key)) continue;
        this.seen.add(area.key);
        if (this.accept(area, airports)) changed = true;
      }
    }
    return changed ? this.specs() : null;
  }

  private accept(area: PavementArea, airports: readonly Airport[]): boolean {
    const pts = area.rings.length > 0 ? area.rings[0] : area.line;
    if (!pts || pts.length < 4) return false;
    let lon = 0, lat = 0;
    for (let i = 0; i + 1 < pts.length; i += 2) { lon += pts[i]; lat += pts[i + 1]; }
    lon /= pts.length / 2; lat /= pts.length / 2;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    let best: Airport | null = null, bestD = this.opts.assocRadiusM;
    for (const ap of airports) {
      const d = distanceToAirport(ap, lat, lon);
      if (d <= bestD) { bestD = d; best = ap; }
    }
    if (!best) return false;
    const sig = signature(area);
    const key = `${best.icao}:${sig}`;
    if (this.accepted.has(key)) return false; // the same piece from another scenery tile
    const points = area.rings.reduce((s, r) => s + r.length / 2, 0) + area.line.length / 2;
    if (this.accepted.size >= this.opts.maxAreas || this.points + points > this.opts.maxPoints) { this.capped = true; return false; }
    const spec = makePavementSpec(key, { rings: area.rings, line: area.line, halfWidthM: area.widthM / 2 }, this.planeFor(best));
    if (!spec) return false;
    this.accepted.set(key, { spec, icao: best.icao, points });
    this.points += points;
    return true;
  }
}
