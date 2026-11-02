/**
 * Procedurally generated textures: the livery (CanvasTexture, browser only), the propeller
 * blur disc and the light halo (DataTextures, so they also work in Node for tests).
 */
import * as THREE from 'three';

/**
 * Paint the livery: white base, blue cheat line with a thin red companion stripe along both
 * sides, registration decal on the rear fuselage, anti-glare panel on the cowl top.
 * Canvas x = fuselage length (nose → tail), y = around the fuselage (bottom at the bottom).
 * Returns null when there is no DOM (tests / workers); callers fall back to plain paint.
 *
 * @param regUStart/regUEnd u-range (0..1 along the length) of the registration decal
 */
export function createLiveryTexture(registration: string, regUStart: number, regUEnd: number, cowlUEnd: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f6f6f4';
  ctx.fillRect(0, 0, W, H);
  // v → canvas y (flipY: v = 0 is the bottom row)
  const yOf = (v: number) => (1 - v) * H;
  const band = (v0: number, v1: number, color: string) => {
    ctx.fillStyle = color;
    const y0 = yOf(v1), y1 = yOf(v0);
    ctx.fillRect(0, y0, W, y1 - y0);
  };
  // right side (v ≈ 0.25 is the sill): blue stripe just below the sill, red stripe below it
  band(0.205, 0.245, '#1f4e9c');
  band(0.19, 0.203, '#c8202c');
  // left side (v ≈ 0.75)
  band(0.755, 0.795, '#1f4e9c');
  band(0.797, 0.81, '#c8202c');
  // belly: light grey
  band(0.0, 0.06, '#d8d9d6'); band(0.94, 1.0, '#d8d9d6');
  // anti-glare panel on the cowl top (v ≈ 0.5), only over the cowl
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(0, yOf(0.56), cowlUEnd * W, yOf(0.44) - yOf(0.56));
  // registration decal
  const x0 = regUStart * W, x1 = regUEnd * W;
  const fontPx = Math.floor(H * 0.085);
  ctx.font = `bold ${fontPx}px "Arial Narrow", Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a2a44';
  const cx = (x0 + x1) / 2;
  // right side: reads aft→fwd for a viewer on the right, so mirror in x
  ctx.save(); ctx.translate(cx, yOf(0.3)); ctx.scale(-1, 1); ctx.fillText(registration, 0, 0, x1 - x0); ctx.restore();
  // left side: up on the fuselage is down in the image, so flip in y
  ctx.save(); ctx.translate(cx, yOf(0.7)); ctx.scale(1, -1); ctx.fillText(registration, 0, 0, x1 - x0); ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Radial RGBA texture for the spinning-propeller disc: dark translucent, brighter arc toward the tips. */
export function createPropBlurTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c; // 0 centre .. 1 edge
      const i = (y * size + x) * 4;
      let a = 0;
      if (r < 1) {
        // hub region solid-ish, mid translucent, tips a brighter sweep
        a = r < 0.12 ? 0.9 : 0.22 + 0.18 * Math.exp(-((r - 0.92) ** 2) / 0.004);
        // angular variation: faint two-blade smear
        const ang = Math.atan2(y - c, x - c);
        a *= 0.85 + 0.15 * Math.cos(2 * ang);
        // soften the rim
        a *= Math.min(1, (1 - r) * 25);
      }
      const shade = r < 0.12 ? 200 : 40;
      data[i] = shade; data[i + 1] = shade; data[i + 2] = shade; data[i + 3] = Math.round(255 * a);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  return t;
}

/** Soft radial glow for light halos (alpha falls off as a smooth bump). */
export function createHaloTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = Math.pow(1 - r, 2.2);
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.round(255 * a);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  return t;
}
