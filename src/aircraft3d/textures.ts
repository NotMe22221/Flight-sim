/**
 * Procedurally generated textures: the livery (CanvasTexture, browser only), the propeller
 * blur disc and the light halo (DataTextures, so they also work in Node for tests).
 */
import * as THREE from 'three';

/**
 * Paint the livery for the fuselage UVs of skin.ts: u runs along the length (nose → tail),
 * v = 0 at the bottom, 0.25 at mid-height on the right, 0.5 on top and 0.75 at mid-height on
 * the left, so a band at constant v follows a constant fraction of the local section height
 * (the cheat lines narrow and sweep up the tailcone with it).
 * White base, blue cheat line with a thin red pinstripe on both sides, light grey belly and
 * the registration on the tailcone. Returns null without a DOM (tests / workers).
 *
 * @param regUStart/regUEnd u-range (0..1 along the length) of the registration
 * @param scale metres per texel along u and along v (one side spans v 0..0.5) at the
 *        registration, so the letters keep their proportions on the stretched texture
 */
export function createLiveryTexture(registration: string, regUStart: number, regUEnd: number, scale: { uM: number; vM: number } = { uM: 8.4 / 2048, vM: 0.48 / 512 }): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const W = 2048, H = 1024;
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
  // f0..f1: fraction of the section height (0 bottom … 1 top), painted on both sides
  const side = (f0: number, f1: number, color: string) => { band(0.5 * f0, 0.5 * f1, color); band(1 - 0.5 * f1, 1 - 0.5 * f0, color); };
  side(0.0, 0.08, '#d9dad7');   // belly
  side(0.455, 0.535, '#1f4e9c'); // blue cheat line
  side(0.43, 0.447, '#c8202c');  // red pinstripe
  // registration: cap height ≈ 0.4 of the tailcone height, letters squeezed along u (texels
  // there are longer than along v)
  const x0 = regUStart * (W - 1), x1 = regUEnd * (W - 1);
  const capPx = 0.4 * 0.5 * H;
  const fontPx = Math.round(capPx / 0.72);
  const kx = Math.min(1, scale.vM / scale.uM);
  ctx.font = `bold ${fontPx}px "Arial Narrow", Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a2a44';
  const cx = (x0 + x1) / 2;
  const maxW = (x1 - x0) / kx;
  // right side: reads aft→fwd for a viewer on the right, so mirror in x
  ctx.save(); ctx.translate(cx, yOf(0.5 * 0.6)); ctx.scale(-kx, 1); ctx.fillText(registration, 0, 0, maxW); ctx.restore();
  // left side: up on the fuselage is down in the image, so flip in y
  ctx.save(); ctx.translate(cx, yOf(1 - 0.5 * 0.6)); ctx.scale(kx, -1); ctx.fillText(registration, 0, 0, maxW); ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
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

/**
 * 1×1 dark-grey placeholder bound as the instrument-panel `map` until the instruments module
 * assigns its CanvasTexture. Binding *a* map from the start keeps USE_MAP in the shader, so
 * swapping textures later needs no `material.needsUpdate` and the colour stays white.
 */
export function createPanelPlaceholderTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([28, 29, 31, 255]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
