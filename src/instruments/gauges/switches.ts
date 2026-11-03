/**
 * Panel switches and lights drawn as gauges (Super Cub panel): the magneto key switch, the
 * master / radio rocker pair, push-pull knobs (carburettor heat, primer) and a row of warning
 * lights. They read `InstrumentReadings.switches` / `annunciators`; nothing here changes state
 * (clicks go through the simulator's actions).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { dialRad } from '../scales';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

/** Key positions, deg clockwise from 12 o'clock: OFF, R, L, BOTH, START. */
export const MAG_KEY_DEG: readonly [number, number, number, number, number] = [-75, -40, -5, 30, 65];
const MAG_LABELS = ['OFF', 'R', 'L', 'BOTH', 'START'] as const;

/** Angle of the key for a magneto selection (0 off, 1 right, 2 left, 3 both) or the starter. */
export function magKeyDeg(magnetos: number, starter: boolean): number {
  if (starter) return MAG_KEY_DEG[4];
  const i = Math.max(0, Math.min(3, Math.round(magnetos)));
  return MAG_KEY_DEG[i];
}

function plate(ctx: Ctx2D, w: number, h: number, r = 6): void {
  ctx.fillStyle = '#1b1b1e';
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r); ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#3c3c42'; ctx.lineWidth = 1; ctx.stroke();
}

/** Magneto / starter key switch (OFF · R · L · BOTH · START). */
export class MagnetoSwitch extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    plate(ctx, size, size, size * 0.08);
    const cx = size / 2, cy = size * 0.5, R = size * 0.24;
    ctx.fillStyle = '#0c0c0e';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a8a90'; ctx.lineWidth = Math.max(1, size * 0.02); ctx.stroke();
    const font = gaugeFont(size * 0.075, true);
    for (let i = 0; i < MAG_LABELS.length; i++) {
      const a = dialRad(MAG_KEY_DEG[i]), rr = R + size * 0.12;
      drawText(ctx, MAG_LABELS[i], cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, font, i === 4 ? GAUGE_COLORS.yellow : GAUGE_COLORS.white);
    }
    drawText(ctx, 'MAGNETO', cx, size * 0.92, gaugeFont(size * 0.08, true), GAUGE_COLORS.grey);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const s = r.switches;
    ctx.save();
    ctx.rotate((magKeyDeg(s.magnetos, s.starter) * Math.PI) / 180);
    const w = size * 0.1, l = size * 0.42;
    ctx.fillStyle = '#c9cbd0';
    ctx.fillRect(-w / 2, -l / 2, w, l);
    ctx.fillStyle = '#7d8087';
    ctx.fillRect(-w / 2, -l / 2, w, l * 0.18);
    ctx.restore();
    ctx.fillStyle = '#4a4c52';
    ctx.beginPath(); ctx.arc(0, 0, size * 0.035, 0, Math.PI * 2); ctx.fill();
  }
}

/** Master and radio master rockers side by side (top half pressed = ON). */
export class MasterSwitches extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    plate(ctx, size, size, size * 0.08);
    const f = gaugeFont(size * 0.085, true);
    drawText(ctx, 'MASTER', size * 0.29, size * 0.12, f, GAUGE_COLORS.white);
    drawText(ctx, 'RADIO', size * 0.71, size * 0.12, f, GAUGE_COLORS.white);
    drawText(ctx, 'ON', size * 0.5, size * 0.33, gaugeFont(size * 0.075), GAUGE_COLORS.grey);
    drawText(ctx, 'OFF', size * 0.5, size * 0.78, gaugeFont(size * 0.075), GAUGE_COLORS.grey);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const s = r.switches;
    rocker(ctx, -size * 0.21, size, s.master);
    rocker(ctx, size * 0.21, size, s.avionicsMaster);
  }
}

function rocker(ctx: Ctx2D, cx: number, size: number, on: boolean): void {
  const w = size * 0.24, h = size * 0.6, top = -size * 0.24;
  ctx.fillStyle = '#060607';
  ctx.fillRect(cx - w / 2 - 2, top - 2, w + 4, h + 4);
  // the half pressed in is red (ON at the top), the other half is the dark rocker body
  ctx.fillStyle = on ? '#c43a2e' : '#2b2c30';
  ctx.fillRect(cx - w / 2, top, w, h / 2);
  ctx.fillStyle = on ? '#2b2c30' : '#c43a2e';
  ctx.fillRect(cx - w / 2, top + h / 2, w, h / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(cx - w / 2, on ? top : top + h / 2, w, h * 0.08);
}

/** Push-pull knob (carb heat: pulled = hot; primer: locked in). */
export class PushPullKnob extends Gauge {
  constructor(private readonly title: string, private readonly pulled: (r: InstrumentReadings) => boolean, private readonly knobColor = '#16161a', factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    plate(ctx, size, size, size * 0.1);
    drawText(ctx, this.title, size / 2, size * 0.88, gaugeFont(size * 0.12, true), GAUGE_COLORS.white);
  }

  protected override staticVariant(r: InstrumentReadings): number { return this.pulled(r) ? 1 : 0; }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const out = this.pulled(r);
    const R = size * 0.24, y = -size * 0.08;
    if (out) {
      // the shaft shows below the knob when it is pulled out
      ctx.fillStyle = '#9ea1a8';
      ctx.fillRect(-size * 0.05, y, size * 0.1, size * 0.2);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(out ? 3 : 1, y + (out ? 4 : 1), R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.knobColor;
    ctx.beginPath(); ctx.arc(0, y, out ? R * 1.06 : R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#55575e'; ctx.lineWidth = Math.max(1, size * 0.02); ctx.stroke();
    if (out) drawText(ctx, 'ON', 0, y, gaugeFont(size * 0.13, true), GAUGE_COLORS.yellow);
  }
}

interface Light { label: string; color: string; lit: (r: InstrumentReadings) => boolean }

/** A row of panel warning lights (lit: bright with dark text; unlit: dim legend). */
export class WarningLights extends Gauge {
  override readonly aspect = 0.3;
  constructor(private readonly lights: readonly Light[], factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, size, size * this.aspect);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect, pad = size * 0.03, n = Math.max(1, this.lights.length);
    const cw = (size - pad * (n + 1)) / n, ch = h - 2 * pad;
    const font = gaugeFont(ch * 0.3, true);
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const x = -size / 2 + pad + i * (cw + pad), y = -h / 2 + pad;
      const on = L.lit(r);
      ctx.fillStyle = on ? L.color : '#141416';
      ctx.fillRect(x, y, cw, ch);
      drawText(ctx, L.label, x + cw / 2, y + ch / 2, font, on ? '#111' : '#4a4a50');
    }
  }
}

/** The Super Cub's two panel lights: LOW VOLTS (14 V bus below its threshold) and the stall warning. */
export const CUB_WARNING_LIGHTS: readonly Light[] = [
  { label: 'LOW VOLTS', color: GAUGE_COLORS.yellow, lit: (r) => r.annunciators.lowVolts },
  { label: 'STALL', color: GAUGE_COLORS.red, lit: (r) => r.annunciators.stallWarn },
];
