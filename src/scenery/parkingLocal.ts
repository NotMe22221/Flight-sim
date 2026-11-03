/**
 * Parking spots of one tile in its local frame: aeroway gate points (with ref) and apron
 * stands (grid points inside apron polygons, away from the edges, taxi lanes, buildings and
 * runways), each facing the nearest taxiway so the aircraft can taxi straight out.
 */
import type { ParkingSpotLocal } from './protocol';
import { closestOnPolyline, distToRingSq, pointInPolygon, pointInRing, ringBounds } from './polygon';
import { hash2 } from './tileMath';
import type { ZoneFn } from './drape';

export interface ParkingInput {
  gates: { x: number; z: number; ref: string }[];
  /** explicit OSM parking positions (aeroway=parking_position) */
  positions: { x: number; z: number; ref: string }[];
  aprons: { outer: number[]; holes: number[][] }[];
  taxiways: number[][];
  buildings: number[][];
  onRunway: ZoneFn;
}

export interface ParkingOptions {
  /** stand grid spacing (m) */
  spacingM?: number;
  /** minimum distance from the apron edge (m) */
  edgeClearM?: number;
  /** minimum distance from taxiway centre lines (m) */
  taxiClearM?: number;
  /** minimum distance from building outlines (m) */
  buildingClearM?: number;
  maxStands?: number;
  /** salt for stable stand names */
  seed?: number;
}

/** True heading (deg, 0..360) of a local direction (x east, z south). */
export const headingOf = (dx: number, dz: number): number => {
  const h = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
};

const closest = { x: 0, y: 0, d2: 0 };

/** Heading from (x, z) toward the nearest taxiway point within `maxM`, or null. */
function headingToTaxiway(x: number, z: number, taxiways: readonly number[][], maxM: number): { h: number; d: number } | null {
  let best = maxM * maxM, bx = 0, bz = 0, found = false;
  for (const t of taxiways) {
    closestOnPolyline(x, z, t, closest);
    if (closest.d2 < best) { best = closest.d2; bx = closest.x; bz = closest.y; found = true; }
  }
  if (!found || best < 1e-6) return null;
  return { h: headingOf(bx - x, bz - z), d: Math.sqrt(best) };
}

function nearBuilding(x: number, z: number, buildings: readonly number[][], clear: number): boolean {
  const c2 = clear * clear;
  for (const b of buildings) {
    const r = ringBounds(b);
    if (x < r.x0 - clear || x > r.x1 + clear || z < r.y0 - clear || z > r.y1 + clear) continue;
    if (pointInRing(x, z, b) || distToRingSq(x, z, b) < c2) return true;
  }
  return false;
}

export function findParking(input: ParkingInput, opts: ParkingOptions = {}): ParkingSpotLocal[] {
  const spacing = opts.spacingM ?? 42;
  const edgeClear = opts.edgeClearM ?? 16;
  const taxiClear = opts.taxiClearM ?? 28;
  const buildingClear = opts.buildingClearM ?? 12;
  const maxStands = opts.maxStands ?? 60;
  const out: ParkingSpotLocal[] = [];

  const gateLike = [...input.gates.map((g) => ({ ...g, kind: 'gate' as const })), ...input.positions.map((g) => ({ ...g, kind: 'stand' as const }))];
  for (const g of gateLike) {
    let x = g.x, z = g.z;
    const t = headingToTaxiway(x, z, input.taxiways, 600);
    const h = t ? t.h : 0;
    // gate nodes sit at the terminal: step out toward the taxiway until clear of buildings
    const dx = Math.sin((h * Math.PI) / 180), dz = -Math.cos((h * Math.PI) / 180);
    for (let k = 0; k < 10 && nearBuilding(x, z, input.buildings, buildingClear); k++) { x += dx * 5; z += dz * 5; }
    const name = g.kind === 'gate' ? (g.ref ? `Gate ${g.ref}` : 'Gate') : (g.ref ? `Stand ${g.ref}` : 'Stand');
    out.push({ x, z, headingDeg: h, name, kind: g.kind });
  }

  let stands = 0;
  for (const a of input.aprons) {
    const b = ringBounds(a.outer);
    const i0 = Math.ceil(b.x0 / spacing), i1 = Math.floor(b.x1 / spacing);
    const j0 = Math.ceil(b.y0 / spacing), j1 = Math.floor(b.y1 / spacing);
    for (let j = j0; j <= j1 && stands < maxStands; j++) {
      for (let i = i0; i <= i1 && stands < maxStands; i++) {
        const x = i * spacing, z = j * spacing;
        if (!pointInPolygon(x, z, a.outer, a.holes)) continue;
        if (distToRingSq(x, z, a.outer) < edgeClear * edgeClear) continue;
        if (a.holes.some((h) => distToRingSq(x, z, h) < edgeClear * edgeClear)) continue;
        if (input.onRunway(x, z)) continue;
        const t = headingToTaxiway(x, z, input.taxiways, 800);
        if (t && t.d < taxiClear) continue;
        if (nearBuilding(x, z, input.buildings, buildingClear)) continue;
        // keep clear of gates and earlier stands
        if (out.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < (o.kind === 'gate' ? 40 * 40 : (spacing * 0.6) ** 2))) continue;
        const id = hash2(opts.seed ?? 0, hash2(i, j)) % 900 + 100;
        out.push({ x, z, headingDeg: t ? t.h : 0, name: `Apron stand ${id}`, kind: 'stand' });
        stands++;
      }
    }
  }
  return out;
}
