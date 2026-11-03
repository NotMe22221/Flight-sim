/**
 * Parking spot selection across tiles: local spots → lat/lon, filtered by radius and sorted
 * nearest first (gates before stands at equal distance), names made unique.
 */
import type { ParkingSpotLocal } from './protocol';
import type { TileProjector } from './tileMath';

export interface ParkingSpot { lat: number; lon: number; headingDeg: number; name: string }

const D2R = Math.PI / 180;

/** Ground distance (m) between two nearby points (equirectangular). */
export function nearDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const ky = 111_195;
  const kx = ky * Math.cos(((lat1 + lat2) / 2) * D2R);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * ky);
}

export function selectParking(tiles: readonly { projector: TileProjector; spots: readonly ParkingSpotLocal[] }[], lat: number, lon: number, radiusM: number): ParkingSpot[] {
  const all: (ParkingSpot & { d: number; gate: boolean })[] = [];
  for (const t of tiles) {
    for (const s of t.spots) {
      const g = t.projector.toLonLat(s.x, s.z);
      const d = nearDistanceM(lat, lon, g.lat, g.lon);
      if (d > radiusM) continue;
      const h = ((s.headingDeg % 360) + 360) % 360;
      all.push({ lat: g.lat, lon: g.lon, headingDeg: h, name: s.name, d, gate: s.kind === 'gate' });
    }
  }
  all.sort((a, b) => a.d - b.d || (a.gate === b.gate ? 0 : a.gate ? -1 : 1));
  // de-duplicate positions closer than 3 m (the same gate seen from two tiles) and names
  const out: ParkingSpot[] = [];
  const names = new Map<string, number>();
  for (const s of all) {
    if (out.some((o) => nearDistanceM(o.lat, o.lon, s.lat, s.lon) < 3)) continue;
    const n = names.get(s.name) ?? 0;
    names.set(s.name, n + 1);
    out.push({ lat: s.lat, lon: s.lon, headingDeg: s.headingDeg, name: n === 0 ? s.name : `${s.name} (${n + 1})` });
  }
  return out;
}
