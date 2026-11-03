/**
 * Cessna 172S steam panel rendered into a single 2D canvas (design size 1024×512) that the
 * integrator uploads as a `THREE.CanvasTexture`. Layout is data (`PanelLayout`) so other aircraft
 * can reuse the gauges; instrument dynamics come from a shared `InstrumentModel`.
 */
import type { SimSnapshot } from '../core/types';
import type { CanvasFactory, CanvasSurface, Ctx2D } from './canvas';
import { OPAQUE_CTX, domCanvasFactory, get2d, releaseSurface, sansBold } from './canvas';
import type { VSpeeds } from './c172';
import { C172S_VSPEEDS } from './c172';
import {
  AirspeedIndicator, Altimeter, Ammeter, Annunciators, AttitudeIndicator, ClockOat, EgtGauge, FlapsIndicator, FuelFlowGauge, FuelQuantityGauge,
  type Gauge, HeadingIndicator, ManifoldFuelFlowGauge, OilPressureGauge, OilTemperatureGauge, SuctionGauge, Tachometer, TrimIndicator, TurnCoordinator,
  VerticalSpeedIndicator, WhiskeyCompassGauge,
} from './gauges';
import { type ComState, drawAutopilotUnit, drawNavCom, drawTransponder } from './radioStack';
import { InstrumentModel } from './readings';

export type GaugeId =
  | 'asi' | 'ai' | 'alt' | 'tc' | 'hi' | 'vsi'
  | 'tach' | 'ff' | 'mapff' | 'fuelL' | 'fuelR' | 'oilT' | 'oilP' | 'egt' | 'suction' | 'amps'
  | 'compass' | 'flaps' | 'trim' | 'annun' | 'clock' | 'radios';

export interface PanelItem { id: GaugeId; x: number; y: number; /** width in design px (gauges are square unless their aspect says otherwise) */ size: number }

export interface PanelLayout {
  width: number;
  height: number;
  background: string;
  items: PanelItem[];
}

/** Default C172S arrangement for a 1024×512 texture: six-pack left, radios centre, engine cluster right. */
export const C172_STEAM_LAYOUT: PanelLayout = {
  width: 1024, height: 512, background: '#2a2c30',
  items: [
    { id: 'asi', x: 16, y: 14, size: 150 }, { id: 'ai', x: 176, y: 14, size: 150 }, { id: 'alt', x: 336, y: 14, size: 150 },
    { id: 'tc', x: 16, y: 174, size: 150 }, { id: 'hi', x: 176, y: 174, size: 150 }, { id: 'vsi', x: 336, y: 174, size: 150 },
    { id: 'clock', x: 16, y: 340, size: 150 }, { id: 'flaps', x: 176, y: 340, size: 60 }, { id: 'trim', x: 246, y: 340, size: 60 },
    { id: 'compass', x: 520, y: 8, size: 200 },
    { id: 'radios', x: 500, y: 100, size: 240 },
    { id: 'tach', x: 752, y: 10, size: 122 }, { id: 'fuelL', x: 884, y: 10, size: 64 }, { id: 'fuelR', x: 950, y: 10, size: 64 },
    { id: 'oilT', x: 752, y: 136, size: 64 }, { id: 'oilP', x: 818, y: 136, size: 64 }, { id: 'egt', x: 884, y: 136, size: 64 }, { id: 'ff', x: 950, y: 136, size: 64 },
    { id: 'suction', x: 752, y: 206, size: 64 }, { id: 'amps', x: 818, y: 206, size: 64 },
    { id: 'annun', x: 752, y: 290, size: 262 },
  ],
};

export interface SteamPanelOptions {
  layout?: PanelLayout;
  factory?: CanvasFactory;
  /** backing-store scale (2 for a crisp pop-out) */
  pixelRatio?: number;
  /** redraw rate; the instrument dynamics always run every update */
  hz?: number;
  model?: InstrumentModel;
  vspeeds?: VSpeeds;
}

export class SteamPanel {
  readonly canvas: CanvasSurface;
  readonly model: InstrumentModel;
  readonly gauges: Partial<Record<GaugeId, Gauge>>;
  /** COM radios are not part of the SimSnapshot; set them from the UI. */
  com1: ComState = { activeKHz: 120500, standbyKHz: 121800 };
  com2: ComState = { activeKHz: 118700, standbyKHz: 119300 };
  squawk = 1200;
  xpdrMode = 'ALT';
  hz: number;
  layout: PanelLayout;
  pixelRatio: number;
  private readonly ctx: Ctx2D;
  private readonly factory: CanvasFactory;
  private acc = Infinity;
  private snapshot: SimSnapshot | null = null;

  constructor(opts: SteamPanelOptions = {}) {
    this.factory = opts.factory ?? domCanvasFactory;
    this.layout = opts.layout ?? C172_STEAM_LAYOUT;
    this.pixelRatio = opts.pixelRatio ?? 1;
    this.hz = opts.hz ?? 30;
    this.model = opts.model ?? new InstrumentModel();
    this.canvas = this.factory.create(this.layout.width * this.pixelRatio, this.layout.height * this.pixelRatio);
    this.ctx = get2d(this.canvas, OPAQUE_CTX);
    const f = this.factory, vs = opts.vspeeds ?? C172S_VSPEEDS;
    this.gauges = {
      asi: new AirspeedIndicator(vs, f), ai: new AttitudeIndicator(f), alt: new Altimeter(f), tc: new TurnCoordinator(f), hi: new HeadingIndicator(f),
      vsi: new VerticalSpeedIndicator(f), tach: new Tachometer(f), ff: new FuelFlowGauge(f), mapff: new ManifoldFuelFlowGauge(f),
      fuelL: new FuelQuantityGauge('left', f), fuelR: new FuelQuantityGauge('right', f), oilT: new OilTemperatureGauge(f), oilP: new OilPressureGauge(f),
      egt: new EgtGauge(f), suction: new SuctionGauge(f), amps: new Ammeter(f), compass: new WhiskeyCompassGauge(f), flaps: new FlapsIndicator(undefined, f),
      trim: new TrimIndicator(f), annun: new Annunciators(f), clock: new ClockOat(f),
    };
    this.applyPixelRatio();
  }

  /** Replace the layout (and optionally the backing-store scale); resizes the canvas. */
  setLayout(layout: Partial<PanelLayout>, pixelRatio = this.pixelRatio): void {
    this.layout = { ...this.layout, ...layout, items: layout.items ?? this.layout.items };
    this.pixelRatio = pixelRatio;
    this.canvas.width = Math.round(this.layout.width * pixelRatio);
    this.canvas.height = Math.round(this.layout.height * pixelRatio);
    this.applyPixelRatio();
    this.acc = Infinity;
  }

  /**
   * Advance the instrument dynamics by `dt` (sim seconds) and redraw when the frame cadence is due.
   * Returns true when the canvas changed (set `texture.needsUpdate`).
   */
  update(snapshot: SimSnapshot, dt: number): boolean {
    this.model.update(snapshot, dt);
    this.snapshot = snapshot;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    const period = 1 / Math.max(this.hz, 1e-3);
    this.acc += d;
    if (this.acc + 5e-4 < period) return false;
    // carry the remainder (at most one period) so the cadence does not depend on the frame rate:
    // resetting to 0 turned 30 Hz into 20 Hz at 40 fps or with ordinary 60 fps frame jitter
    this.acc = Number.isFinite(this.acc) ? Math.min(this.acc - period, period) : 0;
    this.draw();
    return true;
  }

  /** Force an immediate redraw with the last snapshot (or draw into any context). */
  drawNow(): void { this.acc = 0; this.draw(); }

  /** Reset the dynamics (flight reset). */
  reset(snapshot: SimSnapshot): void { this.model.reset(snapshot); this.acc = Infinity; }

  dispose(): void {
    for (const g of Object.values(this.gauges)) g?.dispose();
    releaseSurface(this.canvas);
  }

  private applyPixelRatio(): void {
    for (const g of Object.values(this.gauges)) if (g) g.pixelRatio = this.pixelRatio;
  }

  private draw(): void {
    const s = this.snapshot;
    if (!s) return;
    const ctx = this.ctx, L = this.layout, r = this.model.readings;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = L.background; ctx.fillRect(0, 0, L.width, L.height);
    for (const it of L.items) {
      if (it.id === 'radios') { this.drawRadios(ctx, it.x, it.y, it.size, s); continue; }
      const g = this.gauges[it.id];
      if (g) g.draw(ctx, it.x, it.y, it.size, r);
    }
    ctx.font = sansBold.get(11); ctx.fillStyle = '#8c8f96'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('CESSNA 172S', 320, L.height - 14);
  }

  private drawRadios(ctx: Ctx2D, x: number, y: number, w: number, s: SimSnapshot): void {
    let yy = y;
    yy += drawNavCom(ctx, x, yy, w, s.nav1, this.com1, 1) + 6;
    yy += drawNavCom(ctx, x, yy, w, s.nav2, this.com2, 2) + 6;
    yy += drawTransponder(ctx, x, yy, w, this.squawk, this.xpdrMode, this.model.readings.altimeter.modeCFt) + 6;
    drawAutopilotUnit(ctx, x, yy, w, s.autopilot);
  }
}
