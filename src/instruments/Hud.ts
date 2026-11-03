/**
 * Minimal translucent HUD for the external views (docs/research/05 §6, MSFS-like): a top-centre
 * flight strip (IAS/GS, heading tape with bug, altitude/VS/AGL), the autopilot mode line, a
 * bottom-centre controls strip (throttle, mixture, flaps, trim, gear, brakes), centre warning
 * flags and a bottom-left status line with the terrain-loading indicator.
 *
 * The canvas is a transparent overlay placed above the WebGL canvas (CSS `pointer-events: none`).
 * `resize()` sizes the backing store to CSS size × devicePixelRatio; `update()` redraws at most
 * `hz` times per second and only when something visible changed.
 */
import type { SimSnapshot } from '../core/types';
import type { CanvasSurface, Ctx2D } from './canvas';
import { get2d, releaseSurface } from './canvas';
import { FLASH_PERIOD_S } from './g1000/afcsBox';
import { drawAltitudeBlock, drawApModes, drawHeadingTape, drawSpeedBlock, createStripLayout, layoutStrip } from './hud/flightStrip';
import { hudScale } from './hud/primitives';
import { drawControls, drawFlags, drawStatus } from './hud/statusStrip';
import { HudSmoothing, createHudValues } from './hud/values';
import { createCanvas } from './panelTexture';
import { Signature } from './signature';

export interface HudOptions {
  /** canvas factory; defaults to `createCanvas` (DOM canvas, else OffscreenCanvas) */
  createCanvas?: (width: number, height: number) => CanvasSurface;
  /** extra UI scale multiplier on top of the viewport-derived scale (default 1) */
  uiScale?: number;
  /** redraw cap, Hz (default 30) */
  hz?: number;
  /** also show the flight data in the cockpit camera (default false: flags and status only) */
  showInCockpit?: boolean;
}

export class Hud {
  readonly canvas: CanvasSurface;
  /** Hidden HUDs clear their canvas once and stop drawing (the `toggleHud` action). */
  visible = true;
  showInCockpit: boolean;
  uiScale: number;
  hz: number;
  /** Values shown by the last update (truth from the snapshot, lightly smoothed). */
  readonly values = createHudValues();
  private readonly ctx: Ctx2D;
  private readonly layout = createStripLayout();
  private readonly smoothing = new HudSmoothing();
  private readonly sig = new Signature();
  private statusText: string | null = null;
  private widthCss = 1;
  private heightCss = 1;
  private dpr = 1;
  private k = 1;
  private acc = Infinity;
  private time = 0;
  private lastSig = -1;
  private redrawn = false;
  private disposed = false;

  constructor(options: HudOptions = {}) {
    this.canvas = (options.createCanvas ?? createCanvas)(1, 1);
    this.ctx = get2d(this.canvas);
    this.uiScale = options.uiScale ?? 1;
    this.hz = options.hz ?? 30;
    this.showInCockpit = options.showInCockpit ?? false;
    this.resize(1280, 720, 1);
  }

  /** Size the overlay to the viewport (CSS px) at device pixel ratio `dpr`. */
  resize(widthCss: number, heightCss: number, dpr: number): void {
    this.widthCss = Math.max(1, Number.isFinite(widthCss) ? widthCss : 1);
    this.heightCss = Math.max(1, Number.isFinite(heightCss) ? heightCss : 1);
    this.dpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1;
    this.canvas.width = Math.max(1, Math.round(this.widthCss * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.heightCss * this.dpr));
    const style = (this.canvas as { style?: CSSStyleDeclaration }).style;
    if (style) { style.width = `${this.widthCss}px`; style.height = `${this.heightCss}px`; }
    this.k = hudScale(this.widthCss, this.heightCss, this.uiScale);
    layoutStrip(this.widthCss, this.k, this.layout);
    this.invalidate();
  }

  /** Custom status line (e.g. "Loading imagery…"); null hides it. */
  setStatus(text: string | null): void {
    if (text !== this.statusText) { this.statusText = text; this.invalidate(); }
  }
  get status(): string | null { return this.statusText; }

  setVisible(v: boolean): void { if (v !== this.visible) { this.visible = v; this.invalidate(); } }

  /** True when the last `update()` repainted the canvas. */
  get drawn(): boolean { return this.redrawn; }

  /** Advance the display lags and redraw when due and changed. */
  update(s: SimSnapshot, dt: number): void {
    this.redrawn = false;
    if (this.disposed) return;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    this.time += d;
    this.smoothing.update(s, d, this.values);
    this.acc += d;
    const period = 1 / Math.max(this.hz, 1e-3);
    if (this.acc + 5e-4 < period) return;
    this.acc = Number.isFinite(this.acc) ? Math.min(this.acc - period, period) : 0;
    const sig = this.signature(s);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.draw(s);
    this.redrawn = true;
  }

  /** Force a repaint on the next update. */
  invalidate(): void { this.acc = Infinity; this.lastSig = -1; }

  /** Flight reset: snap the display lags. */
  reset(): void { this.smoothing.reset(); this.invalidate(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    releaseSurface(this.canvas);
  }

  private get blinkOn(): boolean { return (this.time % FLASH_PERIOD_S) < FLASH_PERIOD_S / 2; }

  private get showData(): boolean { return !this.values.cockpit || this.showInCockpit; }

  private draw(s: SimSnapshot): void {
    const ctx = this.ctx, v = this.values, L = this.layout, k = this.k, w = this.widthCss, h = this.heightCss;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.visible) return;
    if (this.showData) {
      drawSpeedBlock(ctx, L, v);
      drawHeadingTape(ctx, L, v);
      drawAltitudeBlock(ctx, L, v);
      drawApModes(ctx, L, s.autopilot);
      drawControls(ctx, w, h, k, v);
    }
    drawFlags(ctx, w, L.apY + L.apH + 12 * k, k, v, this.blinkOn);
    drawStatus(ctx, h, k, v.terrainReady, this.statusText);
  }

  private signature(s: SimSnapshot): number {
    const v = this.values, ap = s.autopilot, h = this.sig.reset();
    h.bool(this.visible).bool(this.showData).str(this.statusText);
    if (!this.visible) return h.value;
    h.num(v.iasKt, 1).num(v.gsKt, 1).num(v.altFt, 10).num(v.aglFt, 10).num(v.vsFpm, 10).bool(v.onGround);
    h.num(v.hdgDeg, 0.1).num(v.bugDeg, 0.5).num(v.throttle, 0.01).num(v.mixture, 0.01).num(v.flapsDeg, 1);
    h.num(v.gearExt, 0.01).num(v.trim, 0.01).bool(v.parkingBrake).bool(v.braking);
    h.bool(v.stall && this.blinkOn).bool(v.overspeed).bool(v.overG).bool(v.flapOverspeed).bool(v.gearOverspeed);
    h.bool(v.lowFuel).bool(v.crashed).bool(v.paused).bool(v.slew).num(v.terrainReady, 0.01);
    h.bool(ap.engaged).bool(ap.flightDirector).bool(ap.yawDamper).str(ap.lateral).str(ap.vertical).str(ap.armedLateral).str(ap.armedVertical);
    h.num(ap.altitudeTargetM, 1).num(ap.verticalSpeedTargetMs, 0.1).num(ap.iasTargetMs, 0.2);
    return h.value;
  }
}
