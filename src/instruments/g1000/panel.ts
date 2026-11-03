/**
 * `G1000Panel` — both GDUs side by side on one canvas (PFD left, MFD right, a dark gap between,
 * as in the 172 panel), for a single cockpit texture. It copies only the display that changed
 * and maps a ray-cast UV on the panel mesh back to a display and its canvas pixels, so clicks,
 * wheel turns and hover tooltips reach the bezel controls.
 */
import type { CanvasSurface, Ctx2D } from '../canvas';
import { OPAQUE_CTX, get2d } from '../canvas';
import { createCanvas } from '../panelTexture';
import type { BezelControl } from './bezel';
import type { G1000 } from './G1000';
import type { G1000Display } from './input';

export interface G1000PanelOptions {
  createCanvas?: (width: number, height: number) => CanvasSurface;
  /** gap between the displays as a fraction of the PFD canvas width (default 0.06) */
  gapFraction?: number;
  /** colour of the gap / background (default the panel's dark grey) */
  background?: string;
}

/** A point on one of the two displays, in that display's canvas pixels. */
export interface PanelPoint { display: G1000Display; x: number; y: number }

export class G1000Panel {
  readonly canvas: CanvasSurface;
  /** gap between the PFD and MFD canvases, px */
  readonly gap: number;
  private readonly ctx: Ctx2D;
  private readonly point: PanelPoint = { display: 'pfd', x: 0, y: 0 };
  private first = true;

  constructor(readonly g1000: G1000, options: G1000PanelOptions = {}) {
    const pfd = g1000.pfdCanvas, mfd = g1000.mfdCanvas;
    this.gap = Math.round(pfd.width * (options.gapFraction ?? 0.06));
    this.canvas = (options.createCanvas ?? createCanvas)(pfd.width + this.gap + mfd.width, Math.max(pfd.height, mfd.height));
    this.ctx = get2d(this.canvas, OPAQUE_CTX);
    this.ctx.fillStyle = options.background ?? '#16191d';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Copy the displays the last `g1000.update()` redrew. Returns true when the panel canvas
   * changed (set the texture's `needsUpdate` then).
   */
  compose(): boolean {
    const ch = this.g1000.changed, all = this.first;
    this.first = false;
    if (ch.pfd || all) this.ctx.drawImage(this.g1000.pfdCanvas as CanvasImageSource, 0, 0);
    if (ch.mfd || all) this.ctx.drawImage(this.g1000.mfdCanvas as CanvasImageSource, this.g1000.pfdCanvas.width + this.gap, 0);
    return ch.pfd || ch.mfd || all;
  }

  /** Redraw both displays into the panel on the next `compose()`. */
  invalidate(): void { this.first = true; }

  /**
   * Panel-mesh UV (Three.js convention: v = 0 at the bottom edge) → display and canvas pixels,
   * or null in the gap / outside. The returned object is reused.
   */
  fromUv(u: number, v: number): PanelPoint | null {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
    return this.fromPixel(u * this.canvas.width, (1 - v) * this.canvas.height);
  }

  /** Panel canvas pixel → display and canvas pixels (reused object), or null in the gap. */
  fromPixel(px: number, py: number): PanelPoint | null {
    const pw = this.g1000.pfdCanvas.width, p = this.point;
    if (px < pw) { p.display = 'pfd'; p.x = px; }
    else if (px >= pw + this.gap) { p.display = 'mfd'; p.x = px - pw - this.gap; }
    else return null;
    p.y = py;
    const h = p.display === 'pfd' ? this.g1000.pfdCanvas.height : this.g1000.mfdCanvas.height;
    return py >= 0 && py <= h ? p : null;
  }

  /** Click at a UV: true when a softkey, key or knob was hit (stop the event). */
  click(u: number, v: number): boolean {
    const p = this.fromUv(u, v);
    return p ? this.g1000.click(p.display, p.x, p.y) : false;
  }

  /** Wheel at a UV: true when a knob was turned (preventDefault the event so the camera does not zoom). */
  wheel(u: number, v: number, deltaY: number, opts: { deltaMode?: number; outer?: boolean } = {}): boolean {
    const p = this.fromUv(u, v);
    return p ? this.g1000.wheel(p.display, p.x, p.y, deltaY, opts) : false;
  }

  /** Hover at a UV: tooltip of the control under it (highlighted on the bezel), or null. */
  hover(u: number, v: number): { title: string; hint: string; control: BezelControl; display: G1000Display } | null {
    const p = this.fromUv(u, v);
    if (!p) { this.g1000.hover('pfd', NaN, NaN); this.g1000.hover('mfd', NaN, NaN); return null; }
    this.g1000.hover(p.display === 'pfd' ? 'mfd' : 'pfd', NaN, NaN);
    const t = this.g1000.hover(p.display, p.x, p.y);
    return t ? { ...t, display: p.display } : null;
  }
}
