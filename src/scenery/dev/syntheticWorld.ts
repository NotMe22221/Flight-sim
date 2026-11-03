/**
 * Dev-only synthetic OpenMapTiles world around KSFO (never imported by the app): aprons,
 * terminal / pier / hangar buildings beside the real runways, parallel taxiways with
 * connectors, gate points, a city grid with varied buildings and roads to the west, a
 * motorway, parks, residential landuse and wood on the hills. Authored in metres around the
 * airport reference point and converted to lon/lat.
 */
import { lonLatToTile } from '../../geo/mercator';
import { encodeTile, orientPolygon, type EncFeature, type EncLayer, type EncValue } from './mvtEncoder';

export interface RunwayInput { ident: string; a: { lat: number; lon: number }; b: { lat: number; lon: number }; widthM: number }

export interface WorldFeature {
  layer: string;
  type: 1 | 2 | 3;
  properties: Record<string, EncValue>;
  /** lon/lat parts: points / line / polygon rings ([lon0, lat0, lon1, lat1, …]) */
  parts: number[][];
  bbox: [number, number, number, number];
}

export interface SyntheticWorld {
  features: WorldFeature[];
  bbox: [number, number, number, number];
  ref: { lat: number; lon: number };
}

/** KSFO runways as in public/data/airports.json (le → he). */
export const KSFO_RUNWAYS: RunwayInput[] = [
  { ident: '10L/28R', a: { lat: 37.628742, lon: -122.39341 }, b: { lat: 37.613538, lon: -122.35716 }, widthM: 61 },
  { ident: '10R/28L', a: { lat: 37.626298, lon: -122.393124 }, b: { lat: 37.61172, lon: -122.358367 }, widthM: 61 },
  { ident: '1L/19R', a: { lat: 37.607898, lon: -122.38295 }, b: { lat: 37.626476, lon: -122.37063 }, widthM: 61 },
  { ident: '1R/19L', a: { lat: 37.606333, lon: -122.381061 }, b: { lat: 37.627346, lon: -122.367124 }, widthM: 61 },
];
export const KSFO_REF = { lat: 37.619806, lon: -122.374821 };

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P = [number, number];

export function buildSyntheticWorld(runways: readonly RunwayInput[] = KSFO_RUNWAYS, ref = KSFO_REF): SyntheticWorld {
  const ky = 111_195, kx = ky * Math.cos((ref.lat * Math.PI) / 180);
  const toLL = (p: P): P => [ref.lon + p[0] / kx, ref.lat + p[1] / ky];
  const toM = (lat: number, lon: number): P => [(lon - ref.lon) * kx, (lat - ref.lat) * ky];
  const features: WorldFeature[] = [];
  const add = (layer: string, type: 1 | 2 | 3, properties: Record<string, EncValue>, partsM: P[][]) => {
    const parts = partsM.map((pts) => pts.flatMap((p) => toLL(p)));
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const pt of parts) for (let i = 0; i < pt.length; i += 2) { w = Math.min(w, pt[i]); e = Math.max(e, pt[i]); s = Math.min(s, pt[i + 1]); n = Math.max(n, pt[i + 1]); }
    features.push({ layer, type, properties, parts, bbox: [w, s, e, n] });
  };
  const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  /** rotated rectangle centred at c, long axis angle a (rad from east), size l × w */
  const orect = (cx: number, cy: number, a: number, l: number, w: number): P[] => {
    const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + (ux * l * i + vx * w * j) / 2, cy + (uy * l * i + vy * w * j) / 2] as P);
  };
  const r = rng(1234);

  // ── runways and their parallel taxiways with connectors ──
  for (const rw of runways) {
    const a = toM(rw.a.lat, rw.a.lon), b = toM(rw.b.lat, rw.b.lon);
    add('aeroway', 2, { class: 'runway', ref: rw.ident }, [[a, b]]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    // right of travel (x east, y north): (dy, −dx); 10/28 taxiways on the outer sides, 1/19 likewise
    const side = rw.ident === '10L/28R' || rw.ident === '1L/19R' ? -1 : 1;
    const nx = dy * side, ny = -dx * side, off = 190;
    const t0: P = [a[0] + nx * off - dx * 60, a[1] + ny * off - dy * 60], t1: P = [b[0] + nx * off + dx * 60, b[1] + ny * off + dy * 60];
    const letter = { '10L/28R': 'B', '10R/28L': 'A', '1L/19R': 'D', '1R/19L': 'C' }[rw.ident] ?? 'Z';
    add('aeroway', 2, { class: 'taxiway', ref: letter }, [[t0, [(t0[0] + t1[0]) / 2, (t0[1] + t1[1]) / 2], t1]]);
    for (let s = 0; s <= len; s += 520) {
      const c: P = [a[0] + dx * s, a[1] + dy * s];
      add('aeroway', 2, { class: 'taxiway', ref: `${letter}${Math.round(s / 520) + 1}` }, [[[c[0] + nx * off, c[1] + ny * off], c]]);
    }
  }

  // ── terminal apron (with a grass island hole), terminal, piers and gates ──
  const apron1: P[] = rect(-1660, -1150, -1000, -250);
  const hole1: P[] = rect(-1420, -800, -1270, -620);
  add('aeroway', 3, { class: 'apron' }, [apron1, hole1]);
  add('aeroway', 2, { class: 'taxiway', ref: 'L1' }, [[[-1000, -700], [-600, -700]]]);
  add('aeroway', 2, { class: 'taxiway', ref: 'L2' }, [[[-1300, -250], [-1300, 345]]]);
  add('aeroway', 2, { class: 'taxilane', ref: 'TL' }, [[[-1600, -560], [-1060, -560], [-1060, -950], [-1600, -950]]]);
  add('building', 3, { render_height: 18, render_min_height: 0, colour: '#d8d4cc' }, [rect(-1900, -1120, -1680, -280)]);
  for (const [y0, name] of [[-470, 'A'], [-860, 'B']] as const) {
    add('building', 3, { render_height: 12, render_min_height: 0 }, [rect(-1680, y0 - 25, -1400, y0 + 25)]);
    for (let k = 0; k < 4; k++) {
      const x = -1640 + k * 70;
      add('aeroway', 1, { class: 'gate', ref: `${name}${k * 2 + 1}` }, [[[x, y0 + 32]]]);
      add('aeroway', 1, { class: 'gate', ref: `${name}${k * 2 + 2}` }, [[[x, y0 - 32]]]);
    }
  }
  for (let k = 0; k < 5; k++) add('aeroway', 1, { class: 'gate', ref: `G${k + 1}` }, [[[-1672, -1080 + k * 50]]]);
  add('building', 3, { render_height: 42, render_min_height: 0 }, [rect(-1960, -700, -1930, -670)]); // tower base
  add('building', 3, { render_height: 50, render_min_height: 42, colour: '#90a0b0' }, [rect(-1968, -708, -1922, -662)]); // tower cab

  // ── GA / maintenance apron, hangars ──
  add('aeroway', 3, { class: 'apron' }, [rect(300, -1650, 800, -1300)]);
  add('aeroway', 2, { class: 'taxiway', ref: 'M' }, [[[300, -1450], [-300, -1450]]]);
  for (let k = 0; k < 4; k++) {
    const x0 = 320 + k * 118;
    add('building', 3, { render_height: 18 + (k % 2) * 4, render_min_height: 0 }, [rect(x0, -1770, x0 + 100, -1660)]);
  }
  add('aeroway', 3, { class: 'helipad' }, [orect(860, -1380, 0, 30, 30)]);

  // ── city grid to the west ──
  const block = 120, street = 18;
  const cityX0 = -5600, cityX1 = -2300, cityY0 = -3400, cityY1 = 2400;
  for (let gx = cityX0; gx <= cityX1; gx += block) {
    const cls = Math.round((gx - cityX0) / block) % 6 === 0 ? 'secondary' : Math.round((gx - cityX0) / block) % 3 === 0 ? 'tertiary' : 'minor';
    add('transportation', 2, { class: cls }, [[[gx, cityY0], [gx, cityY1]]]);
  }
  for (let gy = cityY0; gy <= cityY1; gy += block) {
    const k = Math.round((gy - cityY0) / block);
    const cls = k === 24 ? 'primary' : k % 5 === 0 ? 'tertiary' : 'minor';
    add('transportation', 2, { class: cls }, [[[cityX0, gy], [cityX1, gy]]]);
  }
  // motorway along the airport's west side, with ramps
  add('transportation', 2, { class: 'motorway' }, [[[-2150, -6500], [-2100, -2000], [-2180, 0], [-2120, 2000], [-2200, 6500]]]);
  add('transportation', 2, { class: 'motorway', ramp: 1 }, [[[-2140, -900], [-2220, -700], [-2300, -620]]]);
  add('transportation', 2, { class: 'service' }, [[[-2300, -620], [-1950, -620]]]);
  add('transportation', 2, { class: 'path' }, [[[-7800, -2500], [-6500, -800], [-7200, 1500]]]);
  add('transportation', 2, { class: 'rail' }, [[[-2450, -6000], [-2450, 6000]]]);
  add('landuse', 3, { class: 'residential' }, [rect(cityX0, cityY0, cityX1, cityY1)]);
  const downtown = (x: number, y: number) => Math.hypot(x + 3500, y + 300) < 650;
  const industrial = (x: number) => x > -2900;
  const parks = new Set<string>();
  for (let bx = cityX0; bx < cityX1; bx += block) {
    for (let by = cityY0; by < cityY1; by += block) {
      const x0 = bx + street / 2, x1 = bx + block - street / 2, y0 = by + street / 2, y1 = by + block - street / 2;
      if (r() < 0.04 && !downtown(bx, by)) {
        add('park', 3, { class: 'park' }, [rect(x0, y0, x1, y1)]);
        parks.add(`${bx},${by}`);
        continue;
      }
      if (downtown(bx + block / 2, by + block / 2)) {
        // 2–4 towers per block, varied footprints and heights
        const n = 2 + Math.floor(r() * 3);
        for (let k = 0; k < n; k++) {
          const w = 25 + r() * 30, d = 25 + r() * 30;
          const cx = x0 + w / 2 + r() * Math.max(1, x1 - x0 - w), cy = y0 + d / 2 + r() * Math.max(1, y1 - y0 - d);
          const h = 20 + r() ** 2 * 140;
          add('building', 3, { render_height: Math.round(h), render_min_height: 0 }, [rect(cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2)]);
        }
      } else if (industrial(bx)) {
        add('building', 3, { render_height: 7 + Math.round(r() * 6), render_min_height: 0 }, [rect(x0 + 5, y0 + 5, x1 - 5, y0 + 5 + (y1 - y0 - 10) * (0.4 + r() * 0.5))]);
      } else if (r() < 0.12) {
        // apartment block / L-shaped courtyard building (with a hole)
        const h = 10 + Math.round(r() * 14);
        add('building', 3, { render_height: h, render_min_height: 0 }, [rect(x0 + 6, y0 + 6, x1 - 6, y1 - 6), rect(x0 + 26, y0 + 26, x1 - 26, y1 - 26)]);
      } else {
        // houses on two rows of lots, slightly rotated
        for (const row of [0, 1]) {
          for (let k = 0; k < 6; k++) {
            if (r() < 0.12) continue;
            const lotW = (x1 - x0) / 6;
            const cx = x0 + lotW * (k + 0.5), cy = row === 0 ? y0 + 16 : y1 - 16;
            const w = 9 + r() * 5, d = 11 + r() * 6;
            const h = 5 + r() * 4;
            const colour = r() < 0.15 ? ['#c8b090', '#a05040', '#e8e0d0', '#8090a0'][Math.floor(r() * 4)] : undefined;
            add('building', 3, colour ? { render_height: Math.round(h * 10) / 10, colour } : { render_height: Math.round(h * 10) / 10 }, [orect(cx, cy, (r() - 0.5) * 0.12, w, d)]);
          }
        }
      }
    }
  }

  // ── wood on the hills (irregular polygons, one with a clearing) ──
  const blob = (cx: number, cy: number, rad: number, seed: number): P[] => {
    const q = rng(seed);
    const pts: P[] = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const rr = rad * (0.7 + 0.5 * q());
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
  };
  add('landcover', 3, { class: 'wood', subclass: 'forest' }, [blob(-7000, 600, 1100, 7), blob(-7000, 600, 260, 8)]);
  add('landcover', 3, { class: 'wood', subclass: 'wood' }, [blob(-6600, -1900, 800, 9)]);
  add('landcover', 3, { class: 'wood', subclass: 'forest' }, [blob(-7600, 2300, 700, 10)]);
  add('landcover', 3, { class: 'grass', subclass: 'golf_course' }, [blob(-6200, -400, 300, 11)]);
  add('water', 3, { class: 'lake' }, [blob(-6900, -700, 160, 12)]);

  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) { w = Math.min(w, f.bbox[0]); s = Math.min(s, f.bbox[1]); e = Math.max(e, f.bbox[2]); n = Math.max(n, f.bbox[3]); }
  void parks;
  return { features, bbox: [w, s, e, n], ref };
}

/** Encode the features intersecting tile (z, x, y) (with a 64-unit buffer), or null when none. */
export function encodeWorldTile(world: SyntheticWorld, z: number, x: number, y: number, extent = 4096): Uint8Array | null {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180, east = ((x + 1) / n) * 360 - 180;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  const north = lat(y), south = lat(y + 1);
  const bw = (east - west) * (64 / extent), bh = (north - south) * (64 / extent);
  const layers = new Map<string, EncFeature[]>();
  for (const f of world.features) {
    if (f.bbox[2] < west - bw || f.bbox[0] > east + bw || f.bbox[3] < south - bh || f.bbox[1] > north + bh) continue;
    const parts = f.parts.map((p) => {
      const out: number[] = [];
      for (let i = 0; i < p.length; i += 2) {
        const t = lonLatToTile(p[i], p[i + 1], z);
        out.push(Math.round((t.x - x) * extent), Math.round((t.y - y) * extent));
      }
      return out;
    });
    const geometry = f.type === 3 ? orientPolygon(parts[0], parts.slice(1)) : parts;
    const list = layers.get(f.layer) ?? [];
    list.push({ id: list.length + 1, type: f.type, properties: f.properties, geometry });
    layers.set(f.layer, list);
  }
  if (layers.size === 0) return null;
  const enc: EncLayer[] = [...layers.entries()].map(([name, features]) => ({ name, extent, features }));
  return encodeTile(enc);
}

/** z-level tiles covering the world bbox. */
export function worldTiles(world: SyntheticWorld, z: number): { x: number; y: number }[] {
  const a = lonLatToTile(world.bbox[0], world.bbox[3], z), b = lonLatToTile(world.bbox[2], world.bbox[1], z);
  const out: { x: number; y: number }[] = [];
  for (let ty = Math.floor(a.y); ty <= Math.floor(b.y); ty++) for (let tx = Math.floor(a.x); tx <= Math.floor(b.x); tx++) out.push({ x: tx, y: ty });
  return out;
}
