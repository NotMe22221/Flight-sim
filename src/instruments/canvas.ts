/**
 * Canvas-2D plumbing shared by every instrument renderer.
 *
 * The instruments module draws only into 2D contexts and never imports Three.js: the
 * integrator wraps the exported `canvas` in a `THREE.CanvasTexture` (see README). Everything
 * that touches the DOM goes through a `CanvasFactory` so the renderers run in Node against the
 * mock in `testing/mockCanvas.ts`.
 */

/** A 2D context from either an HTMLCanvasElement or an OffscreenCanvas. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** A drawable surface the integrator can upload as a texture. */
export type CanvasSurface = HTMLCanvasElement | OffscreenCanvas;

export interface CanvasFactory {
  /** Create a 2D drawing surface of the given backing-store size in device pixels. */
  create(width: number, height: number): CanvasSurface;
}

/** Default factory: `document.createElement('canvas')`, else `OffscreenCanvas`, else throws. */
export const domCanvasFactory: CanvasFactory = {
  create(width: number, height: number): CanvasSurface {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    throw new Error('instruments: no canvas implementation available; pass a CanvasFactory');
  },
};

/** Context options used for texture canvases (opaque, no compositing copies on Chrome). */
export const OPAQUE_CTX: CanvasRenderingContext2DSettings = { alpha: false, desynchronized: true };

/** Acquire a 2D context or throw a descriptive error. */
export function get2d(surface: CanvasSurface, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = (surface as HTMLCanvasElement).getContext('2d', opts);
  if (!ctx) throw new Error('instruments: 2D context unavailable');
  return ctx as Ctx2D;
}

/** Release the backing store of a surface (GPU memory is freed when a canvas is sized to 0). */
export function releaseSurface(surface: CanvasSurface | null): void {
  if (!surface) return;
  try { surface.width = 0; surface.height = 0; } catch { /* detached OffscreenCanvas */ }
}

/** Current device pixel ratio, 1 outside a browser. */
export function devicePixelRatio(): number {
  const g = globalThis as { devicePixelRatio?: number };
  const r = g.devicePixelRatio;
  return typeof r === 'number' && r > 0 && Number.isFinite(r) ? r : 1;
}

/**
 * Caches a static layer (bezel, dial scale, tape background) in an offscreen surface so the
 * per-frame work is only the moving parts. The layer is repainted when `width`, `height` or the
 * numeric `variant` change. Returns `null` when no surface can be created, in which case the
 * caller paints directly.
 */
export class StaticLayer {
  private surface: CanvasSurface | null = null;
  private width = 0;
  private height = 0;
  private variant = NaN;
  private failed = false;

  constructor(private readonly factory: CanvasFactory) {}

  get(width: number, height: number, variant: number, paint: (ctx: Ctx2D, w: number, h: number) => void): CanvasSurface | null {
    if (this.failed) return null;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (this.surface && this.width === w && this.height === h && this.variant === variant) return this.surface;
    try {
      if (!this.surface) this.surface = this.factory.create(w, h);
      else { this.surface.width = w; this.surface.height = h; }
      const ctx = get2d(this.surface);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      paint(ctx, w, h);
      this.width = w; this.height = h; this.variant = variant;
      return this.surface;
    } catch {
      this.failed = true;
      releaseSurface(this.surface);
      this.surface = null;
      return null;
    }
  }

  /** Force a repaint on the next `get`. */
  invalidate(): void { this.variant = NaN; }

  dispose(): void {
    releaseSurface(this.surface);
    this.surface = null;
    this.variant = NaN;
  }
}

// ───────────────────────────── Fonts & text ─────────────────────────────

/** System font stacks. Glass displays prefer a condensed face; steam dials a plain grotesque. */
export const FONT_SANS = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';
export const FONT_COND = '"Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
export const FONT_MONO = '"Roboto Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

/** Memoises CSS font strings per pixel size so draw loops do not build strings every frame. */
export class FontCache {
  private readonly map = new Map<number, string>();
  constructor(private readonly family: string, private readonly weight: 'normal' | 'bold' = 'normal') {}
  /** Font string for an integer pixel size (fractional sizes are rounded). */
  get(px: number): string {
    const k = Math.max(1, Math.round(px));
    let f = this.map.get(k);
    if (f === undefined) { f = `${this.weight} ${k}px ${this.family}`; this.map.set(k, f); }
    return f;
  }
}

export const sans = new FontCache(FONT_SANS);
export const sansBold = new FontCache(FONT_SANS, 'bold');
export const cond = new FontCache(FONT_COND);
export const condBold = new FontCache(FONT_COND, 'bold');
export const mono = new FontCache(FONT_MONO);
export const monoBold = new FontCache(FONT_MONO, 'bold');

const digitWidthCache = new Map<string, number>();

/** Width of the glyph '0' in the context's current font (cached per font string). */
export function digitWidth(ctx: Ctx2D): number {
  const f = ctx.font;
  let w = digitWidthCache.get(f);
  if (w === undefined) {
    w = ctx.measureText('0').width;
    if (digitWidthCache.size > 256) digitWidthCache.clear();
    digitWidthCache.set(f, w);
  }
  return w;
}

/**
 * Draw text with tabular (fixed-advance) digits so rolling numbers do not jitter. Canvas has no
 * `font-variant-numeric`, so digits advance by the width of '0'; separators advance by half of it.
 * Uses the context's current `fillStyle`, `font` and `textBaseline`; `align` is handled here.
 */
export function fillTabular(ctx: Ctx2D, text: string, x: number, y: number, align: 'left' | 'center' | 'right' = 'left'): void {
  const dw = digitWidth(ctx);
  let total = 0;
  for (let i = 0; i < text.length; i++) total += charAdvance(ctx, text.charCodeAt(i), text[i], dw);
  let cx = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'center';
  for (let i = 0; i < text.length; i++) {
    const adv = charAdvance(ctx, text.charCodeAt(i), text[i], dw);
    ctx.fillText(text[i], cx + adv / 2, y);
    cx += adv;
  }
  ctx.textAlign = prevAlign;
}

function charAdvance(ctx: Ctx2D, code: number, ch: string, dw: number): number {
  if (code >= 48 && code <= 57) return dw; // 0-9
  if (code === 46 || code === 44 || code === 58) return dw * 0.5; // . , :
  if (code === 32) return dw * 0.5;
  if (code === 45 || code === 43) return dw * 0.75; // - +
  return ctx.measureText(ch).width;
}

/** Snap a coordinate to the pixel centre so 1 px strokes are crisp. */
export const crisp = (v: number): number => Math.round(v) + 0.5;
