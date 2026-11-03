/**
 * Procedural textures made in code (no image files): facade albedo + lit-window emissive,
 * plain industrial cladding, roof gravel, pavement, light sprite and floodlight pool.
 * Pure RGBA generators (testable in Node) plus DataTexture wrappers.
 */
import * as THREE from 'three';
import { FACADE_CELLS } from './buildings';
import { hash01, hash2 } from './tileMath';

export interface Rgba { width: number; height: number; data: Uint8Array }

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function put(img: Rgba, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = clamp255(r); img.data[i + 1] = clamp255(g); img.data[i + 2] = clamp255(b); img.data[i + 3] = clamp255(a);
}

/** Smooth value noise in [0, 1) tiling with period `p` cells. */
function valueNoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const h = (i: number, j: number) => hash01(hash2(((i % p) + p) % p, seed), ((j % p) + p) % p);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Window cell geometry inside one facade cell (fractions of the cell; v from the floor up). */
export const WINDOW_U0 = 0.22, WINDOW_U1 = 0.78, WINDOW_V0 = 0.3, WINDOW_V1 = 0.84;

/**
 * Facade: FACADE_CELLS × FACADE_CELLS cells (one window bay × one storey each). Row 0 is the
 * bottom storey (DataTextures are not flipped). Albedo walls are near-white (tinted per
 * building by vertex colour), panes dark blue-grey; `emissive` lights about a quarter of the windows in
 * warm tones, chosen by hash so every facade cell is deterministic.
 */
export function makeFacadeImages(size = 512): { albedo: Rgba; emissive: Rgba; rough: Rgba } {
  const albedo: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const emissive: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const rough: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const cell = size / FACADE_CELLS;
  const warm: [number, number, number][] = [[255, 196, 120], [255, 214, 150], [250, 228, 190], [255, 180, 100], [225, 232, 255]];
  for (let cy = 0; cy < FACADE_CELLS; cy++) {
    for (let cx = 0; cx < FACADE_CELLS; cx++) {
      const hs = hash2(cx * 31 + 7, cy * 17 + 3);
      const lit = hash01(hs, 1) < 0.24;
      const tone = warm[hs % warm.length];
      const dim = 0.35 + 0.65 * hash01(hs, 2) ** 2;
      const curtain = hash01(hs, 3) < 0.3;
      const glass = 0.85 + 0.3 * hash01(hs, 4);
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          const x = cx * cell + px, y = cy * cell + py;
          const u = (px + 0.5) / cell, v = (py + 0.5) / cell;
          const n = valueNoise(x / 6, y / 6, size / 6, 11) * 0.08 + valueNoise(x / 31, y / 31, size / 31, 5) * 0.06;
          const inWin = u >= WINDOW_U0 && u < WINDOW_U1 && v >= WINDOW_V0 && v < WINDOW_V1;
          const frame = inWin && (u < WINDOW_U0 + 0.035 || u >= WINDOW_U1 - 0.035 || v < WINDOW_V0 + 0.04 || v >= WINDOW_V1 - 0.04 || Math.abs(u - 0.5) < 0.018);
          const slab = v < 0.045; // floor line
          if (inWin && !frame) {
            const grad = (v - WINDOW_V0) / (WINDOW_V1 - WINDOW_V0); // sky reflection brighter at the top
            const g0 = (40 + 34 * grad) * glass + (curtain ? 30 : 0);
            put(albedo, x, y, g0 * 0.85, g0 * 0.95, g0 * 1.08 + 6);
            put(rough, x, y, 0, 70, 0);
            if (lit) {
              const k = dim * (0.75 + 0.25 * (1 - grad)) * (curtain ? 0.8 : 1);
              put(emissive, x, y, tone[0] * k, tone[1] * k, tone[2] * k);
            } else put(emissive, x, y, 0, 0, 0);
          } else {
            const w = (frame ? 200 : slab ? 196 : 236) * (1 - n);
            put(albedo, x, y, w, w, w * 0.99);
            put(rough, x, y, 0, frame ? 150 : 235, 0);
            put(emissive, x, y, 0, 0, 0);
          }
        }
      }
    }
  }
  return { albedo, emissive, rough };
}

/** Plain cladding: vertical panel seams, a fascia band and roller doors on the ground storey. */
export function makePlainImage(size = 256): Rgba {
  const img: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const cellPx = size / FACADE_CELLS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = valueNoise(x / 9, y / 9, size / 9, 21) * 0.07;
      const seam = x % 8 === 0 ? 0.82 : x % 8 === 1 ? 0.92 : 1;
      let w = 228 * seam * (1 - n);
      const cx = Math.floor(x / cellPx), cyc = y / cellPx;
      // roller doors (bottom storey, every third bay): darker with horizontal ribs
      if (cyc < 1.25 && cx % 3 === 1 && (x % cellPx) > cellPx * 0.12 && (x % cellPx) < cellPx * 0.88) w = (y % 3 === 0 ? 150 : 172) * (1 - n);
      // fascia band near the top of every 3rd storey
      if (Math.floor(cyc) % 3 === 2 && cyc % 1 > 0.85) w = 200 * (1 - n);
      put(img, x, y, w, w, w);
    }
  }
  return img;
}

/** Roof: mottled gravel / membrane with a few darker plant boxes. */
export function makeRoofImage(size = 256): Rgba {
  const img: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = valueNoise(x / 4, y / 4, size / 4, 3) * 0.12 + valueNoise(x / 23, y / 23, size / 23, 9) * 0.16;
      let w = 240 * (1 - n);
      const bx = Math.floor(x / 64), by = Math.floor(y / 64);
      const hs = hash2(bx + 101, by + 7);
      const ox = (hs % 40) + 8, oy = ((hs >>> 8) % 40) + 8, bw = 6 + ((hs >>> 16) % 9), bh = 5 + ((hs >>> 20) % 7);
      const lx = x % 64, ly = y % 64;
      if (hash01(hs, 9) < 0.55 && lx >= ox && lx < ox + bw && ly >= oy && ly < oy + bh) w = lx === ox || ly === oy ? 205 : 160;
      put(img, x, y, w, w, w);
    }
  }
  return img;
}

/** Pavement (10 m repeat): fine aggregate noise, stains and faint 5 m slab joints. */
export function makePavementImage(size = 256): Rgba {
  const img: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const joint = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fine = hash01(hash2(x, 77), y) * 0.06;
      const stain = valueNoise(x / 37, y / 37, size / 37, 13) * 0.1 + valueNoise(x / 9, y / 9, size / 9, 17) * 0.04;
      let w = 252 * (1 - fine - stain);
      if (x % joint < 2 || y % joint < 2) w *= 0.84;
      put(img, x, y, w, w, w);
    }
  }
  return img;
}

/** Radial light sprite: bright core and soft halo (alpha in A, colour white). */
export function makeSpriteImage(size = 64): Rgba {
  const img: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const core = Math.max(0, 1 - r / 0.28) ** 1.5;
      const halo = Math.max(0, 1 - r) ** 2.4 * 0.55;
      const a = Math.min(1, core + halo);
      put(img, x, y, 255, 255, 255, a * 255);
    }
  }
  return img;
}

/** Floodlight pool on the apron: smooth falloff to zero at the edge. */
export function makePoolImage(size = 128): Rgba {
  const img: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = (1 - r * r) ** 2;
      put(img, x, y, 255 * a, 236 * a, 205 * a, 255 * a);
    }
  }
  return img;
}

export function toTexture(img: Rgba, opts: { srgb: boolean; repeat: boolean; anisotropy?: number }): THREE.DataTexture {
  const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = opts.anisotropy ?? 4;
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
