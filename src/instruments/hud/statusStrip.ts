/**
 * Bottom-centre HUD controls strip (throttle, mixture, flaps, trim, gear, brakes), the centre
 * warning flags (stall, overspeed, over-G, flap/gear overspeed, low fuel, crash, pause/slew) and
 * the bottom-left status line with the terrain-loading progress bar.
 */
import type { Ctx2D } from '../canvas';
import { LabelCache } from '../labelCache';
import { HUD_COLORS as C, label, panel, roundedRectPath, value, vbar } from './primitives';
import type { HudValues } from './values';

/** Controls-strip width for a scale `k` (CSS px). */
export const controlsWidth = (k: number): number => 430 * k;

const pct = new LabelCache((v) => `${v}%`);
const degs = new LabelCache((v) => `${v}°`);
const pctTerrain = new LabelCache((v) => `${v}%`);

/** Flaps text: "UP" at zero, else the actual deflection in degrees. */
export function flapsText(deg: number): string { return Math.round(deg) <= 0 ? 'UP' : degs.get(deg); }

/** Gear state from the mean extension: DOWN / UP / TRANSIT. */
export function gearText(ext: number): { text: string; color: string } {
  if (ext >= 0.99) return GEAR_DOWN;
  if (ext <= 0.01) return GEAR_UP;
  return GEAR_TRANSIT;
}
const GEAR_DOWN = Object.freeze({ text: 'DOWN', color: C.green });
const GEAR_UP = Object.freeze({ text: 'UP', color: C.text });
const GEAR_TRANSIT = Object.freeze({ text: 'TRANSIT', color: C.amber });

/** Controls strip at the bottom centre of a `widthCss` × `heightCss` viewport. */
export function drawControls(ctx: Ctx2D, widthCss: number, heightCss: number, k: number, v: HudValues): void {
  const w = controlsWidth(k), h = 58 * k, x = widthCss / 2 - w / 2, y = heightCss - h - 14 * k;
  panel(ctx, x, y, w, h, k);
  const col = w / 6, top = y + 13 * k, mid = y + h / 2 + 6 * k;
  // throttle and mixture: bar + percentage
  label(ctx, 'THR', x + col * 0.5, top, 11 * k, C.dim, 'center');
  vbar(ctx, x + 10 * k, y + 22 * k, 7 * k, h - 30 * k, v.throttle, C.text);
  value(ctx, pct.get(v.throttle * 100), x + col - 6 * k, mid, 15 * k, C.text);
  label(ctx, 'MIX', x + col * 1.5, top, 11 * k, C.dim, 'center');
  vbar(ctx, x + col + 10 * k, y + 22 * k, 7 * k, h - 30 * k, v.mixture, C.red);
  value(ctx, pct.get(v.mixture * 100), x + col * 2 - 6 * k, mid, 15 * k, C.text);
  // flaps
  label(ctx, 'FLAPS', x + col * 2.5, top, 11 * k, C.dim, 'center');
  label(ctx, flapsText(v.flapsDeg), x + col * 2.5, mid, 16 * k, v.flapOverspeed ? C.amber : C.text, 'center', true);
  // trim: centred bar, + = nose up
  label(ctx, 'TRIM', x + col * 3.5, top, 11 * k, C.dim, 'center');
  vbar(ctx, x + col * 3.5 - 3.5 * k, y + 22 * k, 7 * k, h - 30 * k, v.trim, C.cyan, true);
  label(ctx, v.trim > 0.02 ? 'UP' : v.trim < -0.02 ? 'DN' : '', x + col * 3.5 + 10 * k, mid, 10 * k, C.dim);
  // gear
  const g = gearText(v.gearExt);
  label(ctx, 'GEAR', x + col * 4.5, top, 11 * k, C.dim, 'center');
  label(ctx, g.text, x + col * 4.5, mid, 15 * k, v.gearOverspeed ? C.amber : g.color, 'center', true);
  // brakes
  label(ctx, 'BRAKE', x + col * 5.5, top, 11 * k, C.dim, 'center');
  if (v.parkingBrake) {
    roundedRectPath(ctx, x + col * 5 + 6 * k, mid - 10 * k, col - 12 * k, 20 * k, 4 * k);
    ctx.fillStyle = C.red; ctx.fill();
    label(ctx, 'PARK', x + col * 5.5, mid, 13 * k, C.text, 'center', true);
  } else label(ctx, v.braking ? 'ON' : 'OFF', x + col * 5.5, mid, 15 * k, v.braking ? C.amber : C.dim, 'center', true);
}

/** Draw flag number `n` (stacked downward from `yTop`). */
function flag(ctx: Ctx2D, cx: number, yTop: number, k: number, n: number, text: string, color: string, fg: string = C.text): number {
  const y = yTop + n * 34 * k, w = 190 * k, h = 28 * k;
  roundedRectPath(ctx, cx - w / 2, y, w, h, 6 * k);
  ctx.fillStyle = color; ctx.fill();
  label(ctx, text, cx, y + h / 2, 17 * k, fg, 'center', true);
  return n + 1;
}

/**
 * Centre flags under the strip. `blinkOn` drives the flashing of the STALL flag. Returns the
 * number of flags drawn.
 */
export function drawFlags(ctx: Ctx2D, widthCss: number, yTop: number, k: number, v: HudValues, blinkOn: boolean): number {
  const cx = widthCss / 2;
  let n = 0;
  if (v.crashed) n = flag(ctx, cx, yTop, k, n, 'CRASHED', C.red);
  if (v.stall && blinkOn) n = flag(ctx, cx, yTop, k, n, 'STALL', C.red);
  if (v.overspeed) n = flag(ctx, cx, yTop, k, n, 'OVERSPEED', C.red);
  if (v.overG) n = flag(ctx, cx, yTop, k, n, 'OVER-G', C.red);
  if (v.flapOverspeed) n = flag(ctx, cx, yTop, k, n, 'FLAP SPEED', C.amber, '#111');
  if (v.gearOverspeed) n = flag(ctx, cx, yTop, k, n, 'GEAR SPEED', C.amber, '#111');
  if (v.lowFuel) n = flag(ctx, cx, yTop, k, n, 'LOW FUEL', C.amber, '#111');
  if (v.paused) n = flag(ctx, cx, yTop, k, n, 'PAUSED', C.panelStrong);
  if (v.slew) n = flag(ctx, cx, yTop, k, n, 'SLEW', C.panelStrong);
  return n;
}

/**
 * Bottom-left status: terrain loading progress while `terrainReady` < 1, then an optional custom
 * status text (the integrator's hook for "Loading imagery…" and similar).
 */
export function drawStatus(ctx: Ctx2D, widthCss: number, heightCss: number, k: number, terrainReady: number, status: string | null, avoidControls: boolean): void {
  const x = 14 * k, w = 210 * k, h = 30 * k;
  let y = heightCss - h - 14 * k;
  // on narrow viewports stack the status above the controls strip instead of beside it
  if (avoidControls && x + w > widthCss / 2 - controlsWidth(k) / 2 - 6 * k) y -= 72 * k;
  if (terrainReady < 0.995) {
    panel(ctx, x, y, w, h, k, C.panelStrong);
    label(ctx, 'LOADING TERRAIN', x + 10 * k, y + 11 * k, 11 * k, C.dim);
    value(ctx, pctTerrain.get(terrainReady * 100), x + w - 10 * k, y + 11 * k, 12 * k, C.text);
    ctx.fillStyle = C.barBg; ctx.fillRect(x + 10 * k, y + 21 * k, w - 20 * k, 4 * k);
    ctx.fillStyle = C.cyan; ctx.fillRect(x + 10 * k, y + 21 * k, (w - 20 * k) * Math.max(0, Math.min(1, terrainReady)), 4 * k);
    y -= h + 6 * k;
  }
  if (status) {
    panel(ctx, x, y, w, h, k, C.panelStrong);
    label(ctx, status, x + 10 * k, y + h / 2, 12 * k, C.text);
  }
}
