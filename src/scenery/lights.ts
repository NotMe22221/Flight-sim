/**
 * Night light points: streetlights along roads (spacing, side offset and brightness by road
 * class) and airport lights (blue taxiway edge, green centre line, apron floodlight masts).
 * Points are (x, z, height above ground, linear RGB with the brightness baked in).
 */
import { ByteList, FloatList } from './meshBuilder';
import type { PointsData } from './protocol';
import { polylineLength } from './polygon';
import { hash01, hash2 } from './tileMath';
import type { ZoneFn } from './drape';

export interface RoadLine {
  line: number[];
  cls: string;
  ramp: boolean;
  tunnel: boolean;
  bridge: boolean;
}

interface LightClass { spacing: number; offset: number; both: boolean; height: number; bright: number; sodium: number }

/** Lit road classes (OpenMapTiles transportation.class). */
export const ROAD_LIGHTS: Record<string, LightClass> = {
  motorway: { spacing: 52, offset: 14, both: true, height: 12, bright: 1, sodium: 0.75 },
  trunk: { spacing: 44, offset: 11, both: true, height: 11, bright: 0.95, sodium: 0.7 },
  primary: { spacing: 36, offset: 9, both: true, height: 10, bright: 0.9, sodium: 0.6 },
  secondary: { spacing: 38, offset: 7.5, both: false, height: 9, bright: 0.8, sodium: 0.5 },
  tertiary: { spacing: 40, offset: 6.5, both: false, height: 8, bright: 0.7, sodium: 0.45 },
  minor: { spacing: 44, offset: 5.5, both: false, height: 7, bright: 0.58, sodium: 0.4 },
  service: { spacing: 58, offset: 4, both: false, height: 6, bright: 0.42, sodium: 0.3 },
};

/** Road half widths (m) by class, for the occupancy raster. */
export const ROAD_HALF_WIDTH: Record<string, number> = {
  motorway: 14, trunk: 11, primary: 9, secondary: 7.5, tertiary: 6.5, minor: 5, service: 3.5, track: 2, path: 1.2, rail: 3, transit: 3,
};

export class PointsBuilder {
  readonly xz = new FloatList(512);
  readonly height = new FloatList(256);
  readonly color = new ByteList(768);
  count = 0;
  push(x: number, z: number, h: number, r: number, g: number, b: number): void {
    this.xz.push2(x, z);
    this.height.push(h);
    this.color.push3(Math.round(Math.min(1, r) * 255), Math.round(Math.min(1, g) * 255), Math.round(Math.min(1, b) * 255));
    this.count++;
  }
  finish(): PointsData | null {
    if (this.count === 0) return null;
    return { xz: this.xz.finish(), height: this.height.finish(), color: this.color.finish(), count: this.count };
  }
}

const SODIUM: readonly [number, number, number] = [1, 0.56, 0.22];
const WARM_WHITE: readonly [number, number, number] = [1, 0.84, 0.62];

/** Walk a polyline and call `at(x, z, nx, nz)` every `spacing` metres starting at `phase`. */
export function walkPolyline(line: readonly number[], spacing: number, phase: number, at: (x: number, z: number, nx: number, nz: number, k: number) => void): void {
  let next = phase;
  let dist = 0;
  let k = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    while (next <= dist + len) {
      const t = next - dist;
      at(ax + dx * t, az + dz * t, dz, -dx, k++);
      next += spacing;
    }
    dist += len;
  }
}

/** Streetlights along lit roads, capped at `maxLights` by stretching the spacing uniformly. */
export function buildStreetlights(roads: readonly RoadLine[], maxLights: number, seed: number): PointsData | null {
  let demand = 0;
  for (const r of roads) {
    const c = ROAD_LIGHTS[r.cls];
    if (!c || r.tunnel) continue;
    demand += (polylineLength(r.line) / c.spacing) * (c.both ? 2 : 1);
  }
  if (demand <= 0 || maxLights <= 0) return null;
  const stretch = Math.max(1, demand / maxLights);
  const pb = new PointsBuilder();
  roads.forEach((r, ri) => {
    const c = ROAD_LIGHTS[r.cls];
    if (!c || r.tunnel) return;
    const sp = c.spacing * stretch * (r.ramp ? 0.9 : 1);
    const hs = hash2(seed, ri * 7919 + Math.round(r.line[0] * 7));
    const phase = hash01(hs, 1) * sp;
    const sodium = hash01(hs, 2) < c.sodium;
    const col = sodium ? SODIUM : WARM_WHITE;
    const off = r.ramp ? c.offset * 0.6 : c.offset;
    walkPolyline(r.line, sp, phase, (x, z, nx, nz, k) => {
      if (pb.count >= maxLights) return;
      const flick = 0.85 + 0.3 * hash01(hs, k + 3);
      const b = c.bright * flick;
      if (c.both) {
        pb.push(x + nx * off, z + nz * off, c.height, col[0] * b, col[1] * b, col[2] * b);
        if (pb.count < maxLights) pb.push(x - nx * off, z - nz * off, c.height, col[0] * b, col[1] * b, col[2] * b);
      } else {
        const side = k % 2 === 0 ? 1 : -1;
        pb.push(x + nx * off * side, z + nz * off * side, c.height, col[0] * b, col[1] * b, col[2] * b);
      }
    });
  });
  return pb.finish();
}

export interface TaxiwayLine { line: number[]; halfWidth: number; lit: boolean }

const BLUE: readonly [number, number, number] = [0.12, 0.3, 1];
const GREEN: readonly [number, number, number] = [0.1, 1, 0.32];
const FLOOD: readonly [number, number, number] = [1, 0.88, 0.68];

/** Height of light points above the ground (m): above the draped ribbon + centre line (0.27 m). */
export const TAXI_EDGE_LIGHT_H = 0.35;
export const TAXI_CENTRE_LIGHT_H = 0.3;

/**
 * Taxiway edge (blue, 30 m) and centre-line (green, 15 m) lights, skipped on runways
 * (`onRunway`) and inside aprons (`onApron`), plus floodlight masts along apron edges.
 * Real centre-line lights are flush with the pavement; the sprites stand just above the draped
 * surfaces so the depth test keeps them.
 */
export function buildAirportLights(taxiways: readonly TaxiwayLine[], apronRings: readonly number[][], onRunway: ZoneFn, onApron: ZoneFn, pb: PointsBuilder,
  floodMasts: { x: number; z: number; nx: number; nz: number }[]): void {
  for (const t of taxiways) {
    if (!t.lit) continue;
    const off = t.halfWidth + 0.8;
    walkPolyline(t.line, 30, 6, (x, z, nx, nz) => {
      for (const s of [1, -1]) {
        const px = x + nx * off * s, pz = z + nz * off * s;
        if (onRunway(px, pz) || onApron(px, pz)) continue;
        pb.push(px, pz, TAXI_EDGE_LIGHT_H, BLUE[0], BLUE[1], BLUE[2]);
      }
    });
    walkPolyline(t.line, 15, 3, (x, z) => {
      if (onRunway(x, z) || onApron(x, z)) return;
      pb.push(x, z, TAXI_CENTRE_LIGHT_H, GREEN[0], GREEN[1], GREEN[2]);
    });
  }
  for (const ring of apronRings) {
    const closed = ring.concat(ring.slice(0, 2));
    if (polylineLength(closed) < 200) continue;
    walkPolyline(closed, 110, 40, (x, z, nx, nz) => {
      // exterior rings are clockwise from above: the left normal of travel points outward
      const ix = -nx, iz = -nz;
      const mx = x + nx * 4, mz = z + nz * 4;
      if (onRunway(mx, mz)) return;
      pb.push(mx, mz, 22, FLOOD[0], FLOOD[1], FLOOD[2]);
      floodMasts.push({ x: mx, z: mz, nx: ix, nz: iz });
    });
  }
}
