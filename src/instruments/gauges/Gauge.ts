/**
 * Base class for a steam gauge drawn into a 2D context. The static artwork (bezel, dial, scales)
 * is painted once into an offscreen layer at the requested size (× pixelRatio) and blitted every
 * frame; only `paintDynamic` (needles, drums, flags) runs per frame.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { StaticLayer, domCanvasFactory } from '../canvas';
import type { InstrumentReadings } from '../readings';

export abstract class Gauge {
  /** Backing-store scale of the cached static layer (set ≥ 2 for pop-out / hi-DPI panels). */
  pixelRatio = 1;
  /** Height / width ratio of the gauge footprint (1 = square dial). */
  readonly aspect: number = 1;
  protected readonly factory: CanvasFactory;
  private readonly layer: StaticLayer;

  constructor(factory: CanvasFactory = domCanvasFactory) {
    this.factory = factory;
    this.layer = new StaticLayer(factory);
  }

  /** Footprint height for a given width. */
  heightFor(size: number): number { return size * this.aspect; }

  /**
   * Draw the gauge with its top-left corner at (x, y) and the given width `size` in design pixels
   * (height = size × aspect). `r` is the shared readings object produced by `InstrumentModel`.
   */
  draw(ctx: Ctx2D, x: number, y: number, size: number, r: InstrumentReadings): void {
    const pr = this.pixelRatio, h = size * this.aspect;
    const img = this.layer.get(size * pr, h * pr, this.staticVariant(r), (c) => {
      c.scale(pr, pr);
      this.paintStatic(c, size);
    });
    if (img) ctx.drawImage(img, x, y, size, h);
    else { ctx.save(); ctx.translate(x, y); this.paintStatic(ctx, size); ctx.restore(); }
    ctx.save();
    ctx.translate(x + size / 2, y + h / 2);
    this.paintDynamic(ctx, size, r);
    ctx.restore();
  }

  /** Subclasses may key the static layer on a reading (e.g. a mode) so it repaints when it changes. */
  protected staticVariant(_r: InstrumentReadings): number { return 0; }

  /** Paint the static artwork. Origin at the top-left corner of the gauge footprint. */
  protected abstract paintStatic(ctx: Ctx2D, size: number): void;
  /** Paint the moving parts. Origin at the centre of the footprint. */
  protected abstract paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void;

  /** Force the static layer to repaint on the next draw. */
  invalidate(): void { this.layer.invalidate(); }

  dispose(): void { this.layer.dispose(); }
}
