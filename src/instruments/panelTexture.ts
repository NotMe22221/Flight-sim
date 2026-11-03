/**
 * Integrator helpers for turning instrument canvases into textures. This module never imports
 * Three.js: it only fixes the canvas sizes and the texture settings the integrator should apply
 * to the `THREE.CanvasTexture` that wraps each canvas (docs/research/05 §3.2).
 */
import type { CanvasSurface } from './canvas';

/** Backing-store sizes of the instrument canvases, px. */
export const PANEL_TEXTURE_SIZE = Object.freeze({
  /** C172 steam panel (`SteamPanel`, 2:1) */
  steam: Object.freeze({ width: 1024, height: 512 }),
  /** one G1000 display unit (GDU 1040 native resolution, 4:3) */
  g1000: Object.freeze({ width: 1024, height: 768 }),
});

/**
 * Texture settings for display canvases, expressed without Three.js types:
 * `colorSpace: SRGBColorSpace`, no mipmaps (every upload would rebuild them), linear filtering,
 * high anisotropy for oblique viewing, and an unlit, non-tone-mapped material.
 */
export const CANVAS_TEXTURE_SETTINGS = Object.freeze({
  colorSpace: 'srgb' as const,
  generateMipmaps: false,
  minFilter: 'linear' as const,
  magFilter: 'linear' as const,
  /** clamp to `renderer.capabilities.getMaxAnisotropy()` */
  anisotropy: 8,
  toneMapped: false,
});

/**
 * Create a canvas of the given size: an `HTMLCanvasElement` when a DOM is present, otherwise an
 * `OffscreenCanvas` (workers). Throws when neither exists — Node tests pass the mock factory from
 * `testing/mockCanvas.ts` to the display constructors instead.
 */
export function createCanvas(width: number, height: number): CanvasSurface {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('instruments: no canvas implementation (no document and no OffscreenCanvas); pass createCanvas');
}
