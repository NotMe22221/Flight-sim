/**
 * A tiny recording Canvas-2D mock so draw code can be exercised in Node without a DOM. Every
 * method call is appended to `calls`; state properties (fillStyle, font, …) are plain fields.
 * `measureText` returns a width proportional to the font size so layout code stays sane.
 */
import type { CanvasFactory, CanvasSurface, Ctx2D } from '../canvas';

export interface RecordedCall { name: string; args: unknown[] }

export class MockContext2D {
  readonly calls: RecordedCall[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  miterLimit = 10;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  imageSmoothingEnabled = true;
  shadowBlur = 0;
  shadowColor = 'rgba(0,0,0,0)';
  lineDashOffset = 0;
  private dash: number[] = [];
  private saveDepth = 0;
  maxSaveDepth = 0;

  constructor(public readonly canvas: MockCanvas) {}

  /** Number of recorded calls with this method name. */
  count(name: string): number { let n = 0; for (const c of this.calls) if (c.name === name) n++; return n; }
  /** All recorded text strings passed to fillText/strokeText. */
  texts(): string[] { const out: string[] = []; for (const c of this.calls) if (c.name === 'fillText' || c.name === 'strokeText') out.push(String(c.args[0])); return out; }
  /** True when save/restore calls are balanced. */
  get balanced(): boolean { return this.saveDepth === 0; }
  clear(): void { this.calls.length = 0; }

  private rec(name: string, args: unknown[]): void { this.calls.push({ name, args }); }

  save(): void { this.saveDepth++; this.maxSaveDepth = Math.max(this.maxSaveDepth, this.saveDepth); this.rec('save', []); }
  restore(): void { this.saveDepth--; this.rec('restore', []); if (this.saveDepth < 0) throw new Error('restore without save'); }
  scale(x: number, y: number): void { this.rec('scale', [x, y]); }
  rotate(a: number): void { this.rec('rotate', [a]); }
  translate(x: number, y: number): void { this.rec('translate', [x, y]); }
  transform(...a: number[]): void { this.rec('transform', a); }
  setTransform(...a: unknown[]): void { this.rec('setTransform', a); }
  resetTransform(): void { this.rec('resetTransform', []); }
  getTransform(): DOMMatrix { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } as DOMMatrix; }
  beginPath(): void { this.rec('beginPath', []); }
  closePath(): void { this.rec('closePath', []); }
  moveTo(x: number, y: number): void { this.assertFinite(x, y); this.rec('moveTo', [x, y]); }
  lineTo(x: number, y: number): void { this.assertFinite(x, y); this.rec('lineTo', [x, y]); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void {
    this.assertFinite(x, y, r, a0, a1);
    if (r < 0) throw new Error(`arc: negative radius ${r}`);
    this.rec('arc', [x, y, r, a0, a1, ccw]);
  }
  arcTo(...a: number[]): void { this.rec('arcTo', a); }
  ellipse(...a: unknown[]): void { this.rec('ellipse', a); }
  rect(x: number, y: number, w: number, h: number): void { this.assertFinite(x, y, w, h); this.rec('rect', [x, y, w, h]); }
  roundRect(...a: unknown[]): void { this.rec('roundRect', a); }
  quadraticCurveTo(...a: number[]): void { this.rec('quadraticCurveTo', a); }
  bezierCurveTo(...a: number[]): void { this.rec('bezierCurveTo', a); }
  fill(...a: unknown[]): void { this.rec('fill', a); }
  stroke(...a: unknown[]): void { this.rec('stroke', a); }
  clip(...a: unknown[]): void { this.rec('clip', a); }
  fillRect(x: number, y: number, w: number, h: number): void { this.assertFinite(x, y, w, h); this.rec('fillRect', [x, y, w, h]); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.assertFinite(x, y, w, h); this.rec('strokeRect', [x, y, w, h]); }
  clearRect(x: number, y: number, w: number, h: number): void { this.rec('clearRect', [x, y, w, h]); }
  fillText(text: string, x: number, y: number, maxWidth?: number): void { this.assertFinite(x, y); this.rec('fillText', [text, x, y, maxWidth]); }
  strokeText(text: string, x: number, y: number, maxWidth?: number): void { this.assertFinite(x, y); this.rec('strokeText', [text, x, y, maxWidth]); }
  measureText(text: string): TextMetrics {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const px = m ? parseFloat(m[1]) : 10;
    const width = text.length * px * 0.6;
    return { width, actualBoundingBoxAscent: px * 0.75, actualBoundingBoxDescent: px * 0.25 } as TextMetrics;
  }
  drawImage(...a: unknown[]): void { this.rec('drawImage', a); }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    this.rec('createLinearGradient', [x0, y0, x1, y1]);
    return { addColorStop: () => undefined } as unknown as CanvasGradient;
  }
  createRadialGradient(...a: number[]): CanvasGradient {
    this.rec('createRadialGradient', a);
    return { addColorStop: () => undefined } as unknown as CanvasGradient;
  }
  createPattern(): CanvasPattern | null { return null; }
  setLineDash(d: number[]): void { this.dash = d.slice(); this.rec('setLineDash', [d]); }
  getLineDash(): number[] { return this.dash.slice(); }
  getImageData(): ImageData { return { width: 1, height: 1, data: new Uint8ClampedArray(4) } as unknown as ImageData; }
  putImageData(): void { this.rec('putImageData', []); }
  createImageData(): ImageData { return { width: 1, height: 1, data: new Uint8ClampedArray(4) } as unknown as ImageData; }
  isPointInPath(): boolean { return false; }
  getContextAttributes(): CanvasRenderingContext2DSettings { return {}; }

  private assertFinite(...v: number[]): void {
    for (const x of v) if (!Number.isFinite(x)) throw new Error(`non-finite coordinate in canvas call: ${v.join(',')}`);
  }
}

export class MockCanvas {
  readonly ctx: MockContext2D;
  constructor(public width = 300, public height = 150) { this.ctx = new MockContext2D(this); }
  getContext(_id: string, _opts?: unknown): MockContext2D { return this.ctx; }
  toDataURL(): string { return 'data:,'; }
}

/** A factory that records every canvas it creates (so tests can inspect cached layers). */
export class MockCanvasFactory implements CanvasFactory {
  readonly created: MockCanvas[] = [];
  create(width: number, height: number): CanvasSurface {
    const c = new MockCanvas(width, height);
    this.created.push(c);
    return c as unknown as CanvasSurface;
  }
}

/** Convenience: a mock canvas + its context typed as the real thing. */
export function mockCanvas(width = 1024, height = 512): { canvas: MockCanvas; ctx: MockContext2D; surface: CanvasSurface; ctx2d: Ctx2D } {
  const canvas = new MockCanvas(width, height);
  return { canvas, ctx: canvas.ctx, surface: canvas as unknown as CanvasSurface, ctx2d: canvas.ctx as unknown as Ctx2D };
}
