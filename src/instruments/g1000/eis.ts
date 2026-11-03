/**
 * MFD engine indication strip for the 172S (docs/research/05 §2.3, markings §1.3): RPM arc with
 * digital readout, then horizontal bar gauges for FFLOW GPH, OIL PRES, OIL TEMP, EGT, VAC and
 * FUEL QTY GAL (L/R pointers on one bar), engine hours and the electrical block (bus volts,
 * battery amps). Bars carry POH colour bands; a value in a red band turns its digits red.
 */
import { clamp } from '../../core/math';
import type { Ctx2D } from '../canvas';
import { EGT, FUEL_FLOW, OIL_PRESS, OIL_TEMP, SUCTION, TACH } from '../c172';
import { formatHours } from '../format';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import { G, MFD, cond, condBold } from './palette';
import { num, text } from './widgets';

export interface EisBand { readonly from: number; readonly to: number; readonly color: string }
export interface BarSpec { readonly min: number; readonly max: number; readonly bands: readonly EisBand[]; readonly redlines?: readonly number[] }

const band = (from: number, to: number, color: string): EisBand => Object.freeze({ from, to, color });

/** RPM arc: 0–3 000 over 240°, green 2 100–2 700, red line 2 700. */
export const EIS_RPM = Object.freeze({ min: 0, max: 3000, sweepDeg: 240, green: band(TACH.greenLo, TACH.greenHi, G.green), redline: TACH.redline });

/** Bar gauge scales for the 172S strip. */
export const EIS_BARS = Object.freeze({
  fflow: Object.freeze({ min: FUEL_FLOW.min, max: FUEL_FLOW.max, bands: [band(FUEL_FLOW.greenLo, FUEL_FLOW.greenHi, G.green)] }) as BarSpec,
  oilPress: Object.freeze({
    min: OIL_PRESS.min, max: OIL_PRESS.max,
    bands: [band(0, OIL_PRESS.redLo, G.red), band(OIL_PRESS.redLo, OIL_PRESS.greenLo, G.yellow), band(OIL_PRESS.greenLo, OIL_PRESS.greenHi, G.green), band(OIL_PRESS.greenHi, OIL_PRESS.redHi, G.yellow)],
    redlines: [OIL_PRESS.redHi],
  }) as BarSpec,
  oilTemp: Object.freeze({ min: OIL_TEMP.min, max: OIL_TEMP.max, bands: [band(OIL_TEMP.greenLo, OIL_TEMP.greenHi, G.green), band(OIL_TEMP.redline, OIL_TEMP.max, G.red)], redlines: [OIL_TEMP.redline] }) as BarSpec,
  egt: Object.freeze({ min: EGT.min, max: EGT.max, bands: [] }) as BarSpec,
  vac: Object.freeze({ min: SUCTION.min, max: SUCTION.max, bands: [band(SUCTION.greenLo, SUCTION.greenHi, G.green)] }) as BarSpec,
  fuel: Object.freeze({ min: 0, max: 26, bands: [band(0, 1.5, G.red), band(1.5, 5, G.yellow), band(5, 26, G.green)] }) as BarSpec,
});

/** EIS layout (design units): x 0–150 below the top bar. */
export const EIS = Object.freeze({ x: 0, y: MFD.topBarH, w: MFD.eisW, barX: 12, barW: 126, rpmCy: 128, rpmR: 50, firstBarY: 176, barStep: 44 });

/** True when `v` lies in a red band or beyond a red line of `spec`. */
export function inRedBand(spec: BarSpec, v: number): boolean {
  for (const b of spec.bands) if (b.color === G.red && v >= b.from && v <= b.to) return true;
  if (spec.redlines) for (const r of spec.redlines) if (v >= r) return true;
  return false;
}

const rpmLabels = new LabelCache((v) => String(v), 10);
const oneDec = new LabelCache((v) => v.toFixed(1), 0.1);
const ints = new LabelCache((v) => String(v), 1);
const hoursLabels = new LabelCache(formatHours, 0.1);
const ampsLabels = new LabelCache((v) => (v > 0 ? '+' : '') + String(v), 1);

/** Draw the full strip. */
export function drawEis(ctx: Ctx2D, r: InstrumentReadings): void {
  ctx.fillStyle = G.black; ctx.fillRect(EIS.x, EIS.y, EIS.w, 738 - EIS.y);
  ctx.fillStyle = G.darkGrey; ctx.fillRect(EIS.w, EIS.y, 4, 738 - EIS.y);
  drawRpm(ctx, r.engine.rpm);
  const e = r.engine, B = EIS_BARS;
  let y = EIS.firstBarY;
  drawBar(ctx, y, 'FFLOW GPH', B.fflow, e.fuelFlowGph, oneDec.get(e.fuelFlowGph)); y += EIS.barStep;
  drawBar(ctx, y, 'OIL PRES', B.oilPress, e.oilPressPsi, ints.get(e.oilPressPsi)); y += EIS.barStep;
  drawBar(ctx, y, 'OIL TEMP', B.oilTemp, e.oilTempF, ints.get(e.oilTempF)); y += EIS.barStep;
  drawBar(ctx, y, 'EGT °F', B.egt, e.egtF, ints.get(e.egtF)); y += EIS.barStep;
  drawBar(ctx, y, 'VAC', B.vac, r.suctionInHg, oneDec.get(r.suctionInHg)); y += EIS.barStep;
  drawFuel(ctx, y, r.fuelGal[0], r.fuelGal[1]); y += 78;
  text(ctx, 'ENG HRS', EIS.barX, y, cond.get(13), G.white);
  num(ctx, hoursLabels.get(r.tachHours), EIS.barX + EIS.barW, y, condBold.get(15), G.white, 'right');
  y += 28;
  text(ctx, 'ELECTRICAL', EIS.w / 2, y, condBold.get(13), G.white, 'center');
  y += 20;
  const vColor = r.annunciators.lowVolts ? G.yellow : G.white;
  text(ctx, 'M BUS', EIS.barX, y, cond.get(12), G.white);
  text(ctx, 'E BUS', EIS.barX + EIS.barW, y, cond.get(12), G.white, 'right');
  y += 16;
  num(ctx, oneDec.get(r.voltsV), EIS.barX, y, condBold.get(15), vColor, 'left');
  text(ctx, 'VOLTS', EIS.w / 2, y, cond.get(11), G.grey, 'center');
  num(ctx, oneDec.get(r.voltsV), EIS.barX + EIS.barW, y, condBold.get(15), vColor, 'right');
  y += 22;
  text(ctx, 'M BATT', EIS.barX, y, cond.get(12), G.white);
  text(ctx, 'S BATT', EIS.barX + EIS.barW, y, cond.get(12), G.white, 'right');
  y += 16;
  num(ctx, ampsLabels.get(r.ampsA), EIS.barX, y, condBold.get(15), G.white, 'left');
  text(ctx, 'AMPS', EIS.w / 2, y, cond.get(11), G.grey, 'center');
  num(ctx, ampsLabels.get(0), EIS.barX + EIS.barW, y, condBold.get(15), G.white, 'right');
}

function rpmAngle(rpm: number): number {
  const t = clamp((rpm - EIS_RPM.min) / (EIS_RPM.max - EIS_RPM.min), 0, 1);
  return (-EIS_RPM.sweepDeg / 2 + t * EIS_RPM.sweepDeg - 90) * (Math.PI / 180);
}

function drawRpm(ctx: Ctx2D, rpm: number): void {
  const cx = EIS.w / 2, cy = EIS.rpmCy, R = EIS.rpmR;
  text(ctx, 'RPM', cx, cy - R - 14, condBold.get(14), G.white, 'center');
  ctx.lineWidth = 6;
  ctx.strokeStyle = G.white;
  ctx.beginPath(); ctx.arc(cx, cy, R, rpmAngle(EIS_RPM.min), rpmAngle(EIS_RPM.max)); ctx.stroke();
  ctx.strokeStyle = EIS_RPM.green.color;
  ctx.beginPath(); ctx.arc(cx, cy, R, rpmAngle(EIS_RPM.green.from), rpmAngle(EIS_RPM.green.to)); ctx.stroke();
  const ra = rpmAngle(EIS_RPM.redline);
  ctx.strokeStyle = G.red; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx + Math.cos(ra) * (R - 8), cy + Math.sin(ra) * (R - 8)); ctx.lineTo(cx + Math.cos(ra) * (R + 6), cy + Math.sin(ra) * (R + 6)); ctx.stroke();
  // pointer: white triangle riding inside the arc
  const a = rpmAngle(rpm), c = Math.cos(a), s = Math.sin(a);
  ctx.fillStyle = G.white;
  ctx.beginPath();
  ctx.moveTo(cx + c * (R + 2), cy + s * (R + 2));
  ctx.lineTo(cx + c * (R - 16) - s * 6, cy + s * (R - 16) + c * 6);
  ctx.lineTo(cx + c * (R - 16) + s * 6, cy + s * (R - 16) - c * 6);
  ctx.closePath(); ctx.fill();
  const over = rpm >= EIS_RPM.redline;
  num(ctx, rpmLabels.get(rpm), cx, cy + 12, condBold.get(22), over ? G.red : G.white, 'center');
}

function xOf(spec: BarSpec, v: number): number {
  const t = clamp((v - spec.min) / (spec.max - spec.min), 0, 1);
  return EIS.barX + t * EIS.barW;
}

function drawBarScale(ctx: Ctx2D, y: number, spec: BarSpec): void {
  ctx.fillStyle = G.darkGrey; ctx.fillRect(EIS.barX, y, EIS.barW, 6);
  for (const b of spec.bands) {
    const x0 = xOf(spec, b.from), x1 = xOf(spec, b.to);
    if (x1 > x0) { ctx.fillStyle = b.color; ctx.fillRect(x0, y, x1 - x0, 6); }
  }
  if (spec.redlines) {
    ctx.fillStyle = G.red;
    for (const r of spec.redlines) ctx.fillRect(xOf(spec, r) - 1.5, y - 3, 3, 12);
  }
}

/**
 * Triangular pointer with its tip at (x, yTip); `fromAbove` points down onto the bar. An optional
 * letter (L/R) is drawn inside a larger pointer.
 */
function pointer(ctx: Ctx2D, x: number, yTip: number, fromAbove: boolean, letter?: string): void {
  const d = fromAbove ? 1 : -1, half = letter ? 8 : 6, len = letter ? 15 : 10;
  ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, yTip); ctx.lineTo(x - half, yTip - d * len); ctx.lineTo(x + half, yTip - d * len); ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (letter) text(ctx, letter, x, yTip - d * len * 0.62, condBold.get(10), G.black, 'center');
}

/** One labelled horizontal bar gauge occupying `EIS.barStep` px from `y`. */
export function drawBar(ctx: Ctx2D, y: number, label: string, spec: BarSpec, value: number, valueText: string): void {
  text(ctx, label, EIS.barX, y + 8, cond.get(13), G.white);
  num(ctx, valueText, EIS.barX + EIS.barW, y + 8, condBold.get(15), inRedBand(spec, value) ? G.red : G.white, 'right');
  drawBarScale(ctx, y + 26, spec);
  pointer(ctx, xOf(spec, value), y + 26, true);
}

function drawFuel(ctx: Ctx2D, y: number, leftGal: number, rightGal: number): void {
  const spec = EIS_BARS.fuel, barY = y + 44;
  text(ctx, 'FUEL QTY GAL', EIS.w / 2, y + 8, cond.get(13), G.white, 'center');
  num(ctx, oneDec.get(leftGal), EIS.barX, y + 22, condBold.get(13), inRedBand(spec, leftGal) ? G.red : G.white, 'left');
  num(ctx, oneDec.get(rightGal), EIS.barX + EIS.barW, y + 22, condBold.get(13), inRedBand(spec, rightGal) ? G.red : G.white, 'right');
  drawBarScale(ctx, barY, spec);
  pointer(ctx, xOf(spec, leftGal), barY, true, 'L');
  pointer(ctx, xOf(spec, rightGal), barY + 6, false, 'R');
}
