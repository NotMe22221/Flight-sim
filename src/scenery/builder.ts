/**
 * Tile builder: decoded vector tile → typed-array geometry for one z14 tile (pure, no Three.js
 * objects; runs in the module worker or synchronously on the main thread).
 */
import type { BuildSettings } from './config';
import { decodeTile } from './mvt';
import { buildBuildings } from './buildings';
import { DrapeBuilder, drapeDecal, drapePolygon, drapeRibbon, type DrapeStyle, type ZoneFn } from './drape';
import { cleanLine, extractFeatures, type TileFeatures } from './features';
import { PointsBuilder, ROAD_HALF_WIDTH, buildAirportLights, buildStreetlights, type TaxiwayLine } from './lights';
import { findParking } from './parkingLocal';
import { distToRingSq, distToSegmentSq, pointInPolygon, pointInRing, ringBounds } from './polygon';
import type { TileBuildResult } from './protocol';
import { hash01, sceneryTileKey, tileSeed } from './tileMath';
import { OccupancyGrid, scatterTrees } from './vegetation';

/**
 * Lift of draped airport surfaces above the terrain (m): aprons < taxiway areas < taxiway
 * ribbons < centre lines so overlaps never z-fight; next to runways everything drops below the
 * runway slab (AirportsLayer draws it 0.12 m up) and markings stop. Within a few hundred metres
 * of the camera the material lowers the non-runway tiers by NEAR_DROP_M (materials.ts) so the
 * wheels of an aircraft standing on the ground stay visible.
 */
export const SURFACE_LIFT_M = 0.2;
export const TAXIWAY_AREA_LIFT_M = 0.22;
export const RIBBON_LIFT_M = 0.24;
export const NEAR_RUNWAY_LIFT_M = 0.03;
export const MARKING_LIFT_M = 0.03;
export const POOL_LIFT_M = 0.4;
/** Assumed runway half width when OSM gives no width (m), and the lowering margin around it. */
export const DEFAULT_RUNWAY_HALF_WIDTH_M = 30;
export const RUNWAY_MARGIN_M = 12;

const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin8 = (c: number): number => Math.round(toLin(c) * 255);

interface Capsule { ax: number; az: number; bx: number; bz: number; r2: number; x0: number; x1: number; z0: number; z1: number }

/** Point test "near a runway": centre lines buffered by half width + margin, and runway polygons + margin. */
export function runwayZone(f: Pick<TileFeatures, 'runwayLines' | 'runwayPolys'>, margin: number): ZoneFn {
  const caps: Capsule[] = [];
  for (const r of f.runwayLines) {
    const hw = (r.width > 0 ? r.width / 2 : DEFAULT_RUNWAY_HALF_WIDTH_M) + margin;
    for (let i = 0; i + 3 < r.line.length; i += 2) {
      const ax = r.line[i], az = r.line[i + 1], bx = r.line[i + 2], bz = r.line[i + 3];
      caps.push({ ax, az, bx, bz, r2: hw * hw, x0: Math.min(ax, bx) - hw, x1: Math.max(ax, bx) + hw, z0: Math.min(az, bz) - hw, z1: Math.max(az, bz) + hw });
    }
  }
  const polys = f.runwayPolys.map((p) => ({ p, b: ringBounds(p.outer) }));
  const m2 = margin * margin;
  if (caps.length === 0 && polys.length === 0) return () => false;
  return (x, z) => {
    for (const c of caps) {
      if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) continue;
      if (distToSegmentSq(x, z, c.ax, c.az, c.bx, c.bz) <= c.r2) return true;
    }
    for (const { p, b } of polys) {
      if (x < b.x0 - margin || x > b.x1 + margin || z < b.y0 - margin || z > b.y1 + margin) continue;
      if (pointInRing(x, z, p.outer) || distToRingSq(x, z, p.outer) <= m2) return true;
    }
    return false;
  };
}

function apronZone(f: TileFeatures): ZoneFn {
  const polys = f.aprons.map((p) => ({ p, b: ringBounds(p.outer) }));
  if (polys.length === 0) return () => false;
  return (x, z) => {
    for (const { p, b } of polys) {
      if (x < b.x0 || x > b.x1 || z < b.y0 || z > b.y1) continue;
      if (pointInPolygon(x, z, p.outer, p.holes)) return true;
    }
    return false;
  };
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Build one tile from its vector-tile bytes. Throws only on an undecodable tile. */
export function buildTile(bytes: Uint8Array, z: number, x: number, y: number, s: BuildSettings, parkingOnly = false): TileBuildResult {
  const t0 = nowMs();
  const tile = decodeTile(bytes);
  const f = extractFeatures(tile, z, x, y, { minBuildingAreaM2: s.minBuildingAreaM2 });
  const seed = tileSeed(z, x, y);
  const nearRunway = runwayZone(f, RUNWAY_MARGIN_M);
  const onApron = apronZone(f);
  const taxiLines = f.taxiwayLines.map((t) => ({ ...t, line: cleanLine(t.line) }));
  const parking = findParking({
    gates: f.gates,
    positions: f.positions,
    aprons: f.aprons,
    taxiways: taxiLines.map((t) => t.line),
    buildings: f.buildings.map((b) => b.outer),
    onRunway: runwayZone(f, 25),
  }, { seed });
  const result: TileBuildResult = {
    key: sceneryTileKey(z, x, y), z, x, y,
    buildings: null, surfaces: null, markings: null, trees: null, streetlights: null, airportLights: null, lightPools: null,
    parking,
    stats: { buildings: 0, trees: 0, lights: 0, triangles: 0 },
    decodeErrors: tile.errors,
    buildMs: 0,
  };
  if (parkingOnly) { result.buildMs = nowMs() - t0; return result; }

  // ── airport surfaces ──
  const liftFn = (h: number, nearH: number) => (px: number, pz: number): number => (nearRunway(px, pz) ? nearH : h);
  const apronLift = liftFn(SURFACE_LIFT_M, NEAR_RUNWAY_LIFT_M);
  const areaLift = liftFn(TAXIWAY_AREA_LIFT_M, NEAR_RUNWAY_LIFT_M + 0.01);
  const ribbonLift = liftFn(RIBBON_LIFT_M, NEAR_RUNWAY_LIFT_M + 0.02);
  const surfaces = new DrapeBuilder(10, 4096);
  // weathered concrete (sRGB ≈ 0.5, slightly warm: the sky light adds blue) and dark asphalt
  const concrete = (k: number): DrapeStyle => {
    const v = 0.5 + 0.06 * hash01(seed, k);
    return { r: lin8(v), g: lin8(v * 0.985), b: lin8(v * 0.95), lift: apronLift, drop: null, dropMode: 'all' };
  };
  const asphalt = (lift: (x: number, z: number) => number): DrapeStyle => ({ r: lin8(0.33), g: lin8(0.33), b: lin8(0.33), lift, drop: null, dropMode: 'all' });
  f.aprons.forEach((p, i) => drapePolygon(surfaces, p.outer, p.holes, s.drapeCellM, concrete(i)));
  for (const p of f.helipads) drapePolygon(surfaces, p.outer, p.holes, s.drapeCellM, { ...concrete(97), lift: areaLift });
  for (const p of f.taxiwayPolys) drapePolygon(surfaces, p.outer, p.holes, s.drapeCellM, asphalt(areaLift));
  for (const t of taxiLines) drapeRibbon(surfaces, t.line, t.width / 2, s.ribbonStepM, asphalt(ribbonLift));
  result.surfaces = surfaces.finish();

  const markings = new DrapeBuilder(10, 1024);
  const yellow: DrapeStyle = { r: lin8(0.86), g: lin8(0.66), b: lin8(0.12), lift: (px, pz) => ribbonLift(px, pz) + MARKING_LIFT_M, drop: nearRunway, dropMode: 'any' };
  for (const t of taxiLines) drapeRibbon(markings, t.line, 0.25, s.ribbonStepM, yellow);
  result.markings = markings.finish();

  // ── airport lights and floodlight pools ──
  const apb = new PointsBuilder();
  const masts: { x: number; z: number; nx: number; nz: number }[] = [];
  const lights: TaxiwayLine[] = taxiLines.map((t) => ({ line: t.line, halfWidth: t.width / 2, lit: t.cls === 'taxiway' }));
  buildAirportLights(lights, f.aprons.map((a) => a.outer), nearRunway, onApron, apb, masts);
  result.airportLights = apb.finish();
  if (masts.length) {
    const pools = new DrapeBuilder(0, masts.length * 9);
    for (const m of masts) drapeDecal(pools, m.x + m.nx * 20, m.z + m.nz * 20, 26, POOL_LIFT_M, 255, 226, 180);
    result.lightPools = pools.finish();
  }

  // ── buildings ──
  result.buildings = buildBuildings(f.buildings, { maxTriangles: s.maxBuildingTriangles, pitchedRoofs: s.pitchedRoofs });

  // ── vegetation (occupancy keeps trees off buildings, roads, pavement and water) ──
  if (s.maxTrees > 0 && f.treeAreas.length) {
    const p = f.projector;
    const c0 = [0, 0], c1 = [0, 0];
    p.toLocal(0, 0, c0, 0);
    p.toLocal(p.extent, p.extent, c1, 0);
    const occ = new OccupancyGrid(Math.min(c0[0], c1[0]) - 4, Math.min(c0[1], c1[1]) - 4, Math.max(c0[0], c1[0]) + 4, Math.max(c0[1], c1[1]) + 4, 3);
    for (const b of f.buildings) occ.fillPolygon(b.outer, b.holes, 1.5);
    for (const r of f.roads) occ.strokeLine(r.line, (ROAD_HALF_WIDTH[r.cls] ?? 3) + 1);
    for (const a of f.aprons) occ.fillPolygon(a.outer, a.holes, 2);
    for (const a of f.taxiwayPolys) occ.fillPolygon(a.outer, a.holes, 2);
    for (const a of f.runwayPolys) occ.fillPolygon(a.outer, a.holes, 10);
    for (const t of taxiLines) occ.strokeLine(t.line, t.width / 2 + 3);
    for (const r of f.runwayLines) occ.strokeLine(r.line, (r.width > 0 ? r.width / 2 : DEFAULT_RUNWAY_HALF_WIDTH_M) + 25);
    for (const w of f.water) occ.fillPolygon(w.outer, w.holes, 1);
    result.trees = scatterTrees(f.treeAreas, occ, { maxTrees: s.maxTrees, spacingM: s.forestSpacingM, seed });
  }

  // ── streetlights ──
  if (s.streetlights) result.streetlights = buildStreetlights(f.roads, s.maxStreetlights, seed);

  const tri = (d: { mesh: { index: Uint32Array } } | null) => (d ? d.mesh.index.length / 3 : 0);
  const b = result.buildings;
  result.stats = {
    buildings: b ? b.count : 0,
    trees: result.trees ? result.trees.count : 0,
    lights: (result.streetlights?.count ?? 0) + (result.airportLights?.count ?? 0),
    triangles: (b ? (b.walls.index.length + b.plain.index.length + b.roofs.index.length) / 3 : 0) + tri(result.surfaces) + tri(result.markings) + tri(result.lightPools),
  };
  result.buildMs = nowMs() - t0;
  return result;
}
