/**
 * OpenMapTiles 3.x layers → scenery primitives in the tile-local frame (metres, x = east,
 * y = south in the 2-D arrays). Geometry is clipped to the exact tile square first so that
 * features repeated in neighbouring tiles' buffers are drawn once.
 *
 * Layers: building (render_height, render_min_height, colour, hide_3d), aeroway (apron,
 * taxiway, runway, helipad polygons; taxiway / runway centre lines; gate points), landcover
 * (wood, grass subclasses), park, landuse (residential, cemetery …), transportation (roads),
 * water (occupancy only).
 */
import { GEOM_LINESTRING, GEOM_POINT, GEOM_POLYGON, boolProp, classifyRings, numProp, strProp, type VectorTile, type VtLayer } from './mvt';
import { cleanRing, clipPolylineToRect, clipRingToRect, reverseRing, signedArea, type Rect } from './polygon';
import type { BuildingInput } from './buildings';
import type { RoadLine } from './lights';
import type { TreeArea } from './vegetation';
import { TileProjector } from './tileMath';

export interface Poly {
  outer: number[];
  holes: number[][];
  /** aprons: per outer-ring vertex, the tile edges it lies on (see `BuildingInput.outerEdge`) */
  outerEdge?: Uint8Array;
}
export interface WidthLine { line: number[]; width: number; cls: string; ref: string }

export interface TileFeatures {
  buildings: BuildingInput[];
  aprons: Poly[];
  taxiwayPolys: Poly[];
  helipads: Poly[];
  runwayPolys: Poly[];
  taxiwayLines: WidthLine[];
  runwayLines: WidthLine[];
  gates: { x: number; z: number; ref: string }[];
  positions: { x: number; z: number; ref: string }[];
  treeAreas: TreeArea[];
  roads: RoadLine[];
  water: Poly[];
  /** projector of the first layer extent (for conversions back to lon/lat) */
  projector: TileProjector;
}

export interface ExtractOptions {
  minBuildingAreaM2: number;
}

/** CSS colour names that occur in OSM building:colour (sRGB 0..1). */
const NAMED: Record<string, [number, number, number]> = {
  white: [0.93, 0.93, 0.91], black: [0.15, 0.15, 0.15], grey: [0.55, 0.55, 0.55], gray: [0.55, 0.55, 0.55], silver: [0.75, 0.75, 0.75],
  red: [0.62, 0.25, 0.2], maroon: [0.45, 0.18, 0.15], brown: [0.48, 0.34, 0.24], tan: [0.82, 0.71, 0.55], beige: [0.88, 0.84, 0.72],
  yellow: [0.9, 0.82, 0.45], orange: [0.88, 0.58, 0.3], pink: [0.9, 0.72, 0.72], blue: [0.4, 0.5, 0.65], green: [0.45, 0.58, 0.42],
  lightgrey: [0.78, 0.78, 0.78], lightgray: [0.78, 0.78, 0.78], darkgrey: [0.35, 0.35, 0.35], darkgray: [0.35, 0.35, 0.35], cream: [0.95, 0.92, 0.82],
};

const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** OSM / OpenMapTiles colour string ("#rgb", "#rrggbb", or a CSS name) → linear RGB, or null. */
export function parseColour(s: string): [number, number, number] | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  let rgb: [number, number, number] | null = null;
  const m6 = /^#?([0-9a-f]{6})$/.exec(t);
  const m3 = /^#?([0-9a-f]{3})$/.exec(t);
  if (m6) { const v = parseInt(m6[1], 16); rgb = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
  else if (m3) { const v = m3[1]; rgb = [parseInt(v[0] + v[0], 16) / 255, parseInt(v[1] + v[1], 16) / 255, parseInt(v[2] + v[2], 16) / 255]; }
  else if (NAMED[t]) rgb = NAMED[t];
  if (!rgb) return null;
  return [toLin(rgb[0]), toLin(rgb[1]), toLin(rgb[2])];
}

interface LayerCtx { proj: TileProjector; rect: Rect; extent: number }

function ctxFor(layer: VtLayer, cache: Map<number, LayerCtx>, z: number, x: number, y: number): LayerCtx {
  let c = cache.get(layer.extent);
  if (!c) {
    c = { proj: new TileProjector(z, x, y, layer.extent), rect: { x0: 0, y0: 0, x1: layer.extent, y1: layer.extent }, extent: layer.extent };
    cache.set(layer.extent, c);
  }
  return c;
}

const tmp2 = [0, 0];

/** Project a ring/line from tile coordinates to local metres. */
function project(c: LayerCtx, pts: readonly number[]): number[] {
  const out: number[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    c.proj.toLocal(pts[i], pts[i + 1], tmp2, 0);
    out[i] = tmp2[0]; out[i + 1] = tmp2[1];
  }
  return out;
}

/** Bit mask of the tile edges a tile-coordinate point lies on. */
function edgeCode(px: number, py: number, e: number): number {
  return (px <= 0 ? 1 : 0) | (px >= e ? 2 : 0) | (py <= 0 ? 4 : 0) | (py >= e ? 8 : 0);
}

/** Clip, project and orient one polygon; null when nothing is left. Optionally returns tile-edge codes. */
function polyToLocal(c: LayerCtx, outer: number[], holes: number[][], withCodes: boolean): { poly: Poly; outerEdge?: Uint8Array; holesEdge?: Uint8Array[] } | null {
  const conv = (ring: number[], wantPositive: boolean): { ring: number[]; codes: Uint8Array | undefined } | null => {
    const clipped = clipRingToRect(ring, c.rect);
    if (clipped.length < 6) return null;
    // drop consecutive duplicates (keep codes aligned)
    const pts: number[] = [];
    const codes: number[] = [];
    for (let i = 0; i < clipped.length; i += 2) {
      const px = clipped[i], py = clipped[i + 1];
      const m = pts.length;
      if (m >= 2 && Math.abs(pts[m - 2] - px) < 1e-7 && Math.abs(pts[m - 1] - py) < 1e-7) continue;
      pts.push(px, py);
      codes.push(edgeCode(px, py, c.extent));
    }
    while (pts.length >= 6 && Math.abs(pts[0] - pts[pts.length - 2]) < 1e-7 && Math.abs(pts[1] - pts[pts.length - 1]) < 1e-7) { pts.length -= 2; codes.pop(); }
    if (pts.length < 6) return null;
    let local = project(c, pts);
    let cd = codes;
    if ((signedArea(local) > 0) !== wantPositive) {
      local = reverseRing(local);
      cd = codes.slice().reverse();
    }
    if (Math.abs(signedArea(local)) < 0.5) return null;
    return { ring: local, codes: withCodes ? Uint8Array.from(cd) : undefined };
  };
  const o = conv(outer, true);
  if (!o) return null;
  const hs: number[][] = [];
  const hc: Uint8Array[] = [];
  for (const h of holes) {
    const r = conv(h, false);
    if (r) { hs.push(r.ring); if (r.codes) hc.push(r.codes); }
  }
  return { poly: { outer: o.ring, holes: hs }, outerEdge: o.codes, holesEdge: withCodes ? hc : undefined };
}

function linesToLocal(c: LayerCtx, parts: number[][]): number[][] {
  const out: number[][] = [];
  for (const p of parts) for (const piece of clipPolylineToRect(p, c.rect)) if (piece.length >= 4) out.push(project(c, piece));
  return out;
}

function pointsToLocal(c: LayerCtx, parts: number[][], cb: (x: number, z: number) => void): void {
  for (const p of parts) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      const px = p[i], py = p[i + 1];
      if (px < 0 || py < 0 || px >= c.extent || py >= c.extent) continue;
      c.proj.toLocal(px, py, tmp2, 0);
      cb(tmp2[0], tmp2[1]);
    }
  }
}

const PARK_GRASS = new Set(['park', 'garden', 'village_green', 'recreation_ground', 'golf_course', 'cemetery', 'grave_yard', 'allotments']);
const LIT_TAXI = new Set(['taxiway']);

/** Extract every primitive the scenery uses from a decoded tile. */
export function extractFeatures(tile: VectorTile, z: number, x: number, y: number, opts: ExtractOptions): TileFeatures {
  const cache = new Map<number, LayerCtx>();
  const f: TileFeatures = {
    buildings: [], aprons: [], taxiwayPolys: [], helipads: [], runwayPolys: [], taxiwayLines: [], runwayLines: [],
    gates: [], positions: [], treeAreas: [], roads: [], water: [],
    projector: new TileProjector(z, x, y, 4096),
  };
  const firstLayer = Object.values(tile.layers)[0];
  if (firstLayer) f.projector = ctxFor(firstLayer, cache, z, x, y).proj;

  const building = tile.layers.building;
  if (building) {
    const c = ctxFor(building, cache, z, x, y);
    let idx = 0;
    for (const feat of building.features) {
      idx++;
      if (feat.type !== GEOM_POLYGON || boolProp(feat.properties, 'hide_3d')) continue;
      const h = Math.min(600, Math.max(2.5, numProp(feat.properties, 'render_height', 5)));
      const mh = Math.max(0, numProp(feat.properties, 'render_min_height', 0));
      if (mh >= h - 0.5) continue;
      const colour = parseColour(strProp(feat.properties, 'colour'));
      for (const p of classifyRings(feat.geometry)) {
        const r = polyToLocal(c, p.outer, p.holes, true);
        if (!r) continue;
        const area = Math.abs(signedArea(r.poly.outer));
        if (area < opts.minBuildingAreaM2) continue;
        f.buildings.push({ outer: r.poly.outer, holes: r.poly.holes, outerEdge: r.outerEdge, holesEdge: r.holesEdge, height: h, minHeight: mh, colour, id: feat.id || idx });
      }
    }
  }

  const aeroway = tile.layers.aeroway;
  if (aeroway) {
    const c = ctxFor(aeroway, cache, z, x, y);
    for (const feat of aeroway.features) {
      const cls = strProp(feat.properties, 'class');
      const ref = strProp(feat.properties, 'ref');
      if (feat.type === GEOM_POLYGON) {
        const target = cls === 'apron' ? f.aprons : cls === 'taxiway' || cls === 'taxilane' ? f.taxiwayPolys : cls === 'runway' ? f.runwayPolys : cls === 'helipad' ? f.helipads : null;
        if (!target) continue;
        const apron = target === f.aprons;
        for (const p of classifyRings(feat.geometry)) {
          const r = polyToLocal(c, p.outer, p.holes, apron);
          if (r) target.push(apron ? { ...r.poly, outerEdge: r.outerEdge } : r.poly);
        }
      } else if (feat.type === GEOM_LINESTRING) {
        if (cls === 'taxiway' || cls === 'taxilane') {
          const width = numProp(feat.properties, 'width', cls === 'taxilane' ? 10 : 18);
          for (const l of linesToLocal(c, feat.geometry)) f.taxiwayLines.push({ line: l, width: Math.max(4, Math.min(60, width)), cls: LIT_TAXI.has(cls) ? 'taxiway' : 'taxilane', ref });
        } else if (cls === 'runway') {
          for (const l of linesToLocal(c, feat.geometry)) f.runwayLines.push({ line: l, width: numProp(feat.properties, 'width', 0), cls, ref });
        }
      } else if (feat.type === GEOM_POINT) {
        if (cls === 'gate') pointsToLocal(c, feat.geometry, (px, pz) => f.gates.push({ x: px, z: pz, ref }));
        else if (cls === 'parking_position') pointsToLocal(c, feat.geometry, (px, pz) => f.positions.push({ x: px, z: pz, ref }));
      }
    }
  }

  const addTreePolys = (layer: VtLayer | undefined, pick: (cls: string, sub: string) => TreeArea['kind'] | null, conifer: (sub: string) => number) => {
    if (!layer) return;
    const c = ctxFor(layer, cache, z, x, y);
    for (const feat of layer.features) {
      if (feat.type !== GEOM_POLYGON) continue;
      const cls = strProp(feat.properties, 'class'), sub = strProp(feat.properties, 'subclass');
      const kind = pick(cls, sub);
      if (!kind) continue;
      for (const p of classifyRings(feat.geometry)) {
        const r = polyToLocal(c, p.outer, p.holes, false);
        if (r) f.treeAreas.push({ outer: r.poly.outer, holes: r.poly.holes, kind, conifer: conifer(sub) });
      }
    }
  };
  addTreePolys(tile.layers.landcover, (cls, sub) => (cls === 'wood' ? 'forest' : cls === 'grass' && PARK_GRASS.has(sub) ? 'park' : cls === 'wetland' && sub === 'swamp' ? 'scrub' : null),
    (sub) => (sub === 'forest' ? 0.55 : 0.35));
  addTreePolys(tile.layers.park, (cls) => (cls === 'park' || cls === 'garden' ? 'park' : null), () => 0.2);
  addTreePolys(tile.layers.landuse, (cls) => (cls === 'residential' || cls === 'suburb' || cls === 'neighbourhood' ? 'garden' : cls === 'cemetery' ? 'park' : null), () => 0.18);

  const tr = tile.layers.transportation;
  if (tr) {
    const c = ctxFor(tr, cache, z, x, y);
    for (const feat of tr.features) {
      if (feat.type !== GEOM_LINESTRING) continue;
      const cls = strProp(feat.properties, 'class');
      const brunnel = strProp(feat.properties, 'brunnel');
      const ramp = boolProp(feat.properties, 'ramp');
      for (const l of linesToLocal(c, feat.geometry)) f.roads.push({ line: l, cls, ramp, tunnel: brunnel === 'tunnel', bridge: brunnel === 'bridge' });
    }
  }

  const water = tile.layers.water;
  if (water) {
    const c = ctxFor(water, cache, z, x, y);
    for (const feat of water.features) {
      if (feat.type !== GEOM_POLYGON) continue;
      for (const p of classifyRings(feat.geometry)) {
        const r = polyToLocal(c, p.outer, p.holes, false);
        if (r) f.water.push(r.poly);
      }
    }
  }
  return f;
}

/** Remove near-duplicate points from a projected line (keeps ends). */
export function cleanLine(line: readonly number[], eps = 0.05): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i += 2) {
    const m = out.length;
    if (m >= 2 && Math.hypot(out[m - 2] - line[i], out[m - 1] - line[i + 1]) < eps) continue;
    out.push(line[i], line[i + 1]);
  }
  return out;
}

export { cleanRing };
