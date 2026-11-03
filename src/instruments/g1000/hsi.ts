/**
 * PFD horizontal situation indicator (docs/research/05 §2.1–2.2): heading-up rotating compass
 * rose Ø 300 at (512, 590) with ticks every 5°/10° and labels every 30°, fixed 45° index marks,
 * current-heading box, turn-rate scale (±9°/±18° = half/standard rate over 6 s) with a magenta 6 s
 * trend vector that ends in an arrowhead above 4°/s, cyan heading bug, BRG1 (single line) and BRG2
 * (double line) cyan bearing pointers, course pointer + CDI (2 dots each side) + TO/FROM in the
 * source colour (magenta GPS, green VOR/LOC), HDG and CRS boxes. Red X when the AHRS is invalid.
 */
import { clamp, deltaDeg } from '../../core/math';
import { DEG } from '../../core/units';
import type { Ctx2D } from '../canvas';
import { formatHeadingNum } from '../format';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import type { BearingState, CdiState } from './navData';
import { G, PFD, cond, condBold } from './palette';
import { box, num, redX, text } from './widgets';

/** HSI layout in PFD design units. */
export const HSI = Object.freeze({
  cx: PFD.hsiCx, cy: PFD.hsiCy, r: PFD.hsiR,
  dot: PFD.cdiDotSpacing, dotR: PFD.cdiDotR,
  turnArcR: PFD.hsiR + 8,
  headingBox: Object.freeze({ x: 480, y: 394, w: 64, h: 28 }),
  hdgBox: Object.freeze({ x: 344, y: 404, w: 110, h: 24 }),
  crsBox: Object.freeze({ x: 570, y: 404, w: 110, h: 24 }),
  /** 6 s heading change at standard rate (3°/s) */
  standardArcDeg: 18,
  /** trend vector length limit (4°/s × 6 s); beyond this an arrowhead is drawn */
  trendMaxDeg: 24,
  arrowRateDegS: 4,
});

const CARD_LABELS = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
const TICK_SIN = new Float64Array(72);
const TICK_COS = new Float64Array(72);
for (let i = 0; i < 72; i++) { TICK_SIN[i] = Math.sin(i * 5 * DEG); TICK_COS[i] = Math.cos(i * 5 * DEG); }

const headingLabels = new LabelCache((v) => formatHeadingNum(v) + '°');

/** Screen geometry of the last HSI draw, for tests and pointer hit-testing. */
export interface HsiGeometry {
  drawn: boolean;
  /** screen position of the CDI deviation bar centre */
  cdiBarX: number; cdiBarY: number;
  /** course pointer angle clockwise from the lubber line, deg */
  courseRelDeg: number;
  bugRelDeg: number;
  /** turn-rate trend vector extent along the arc, deg (signed) */
  trendDeg: number;
  trendArrow: boolean;
}

export function createHsiGeometry(): HsiGeometry {
  return { drawn: false, cdiBarX: HSI.cx, cdiBarY: HSI.cy, courseRelDeg: 0, bugRelDeg: 0, trendDeg: 0, trendArrow: false };
}

/** Lateral CDI bar offset in pixels (in the course pointer's frame) for a deviation of −1..1. */
export function cdiOffsetPx(deviation: number): number {
  return clamp(deviation, -1, 1) * 2 * HSI.dot;
}

/**
 * Screen position of the CDI bar centre for a course `courseRelDeg` clockwise from the lubber
 * line: the bar moves along the course pointer's local x axis, so +deviation (fly right) puts the
 * bar right of centre when the course is straight up.
 */
export function cdiBarCentre(cx: number, cy: number, courseRelDeg: number, deviation: number, out: { x: number; y: number }): { x: number; y: number } {
  const a = courseRelDeg * DEG, d = cdiOffsetPx(deviation);
  out.x = cx + d * Math.cos(a);
  out.y = cy + d * Math.sin(a);
  return out;
}

const tmpPt = { x: 0, y: 0 };

/** Draw the HSI. `geo`, when given, receives the screen geometry of what was drawn. */
export function drawHsi(ctx: Ctx2D, r: InstrumentReadings, cdi: CdiState, brg1: BearingState, brg2: BearingState, geo?: HsiGeometry): void {
  const { cx, cy, r: R } = HSI;
  if (!r.ahrs.valid) {
    ctx.fillStyle = G.black; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    redX(ctx, cx - R * 0.7, cy - R * 0.7, R * 1.4, R * 1.4);
    if (geo) geo.drawn = false;
    return;
  }
  const hdg = r.heading.magDeg;
  const courseRel = deltaDeg(cdi.courseDeg, hdg);
  const bugRel = deltaDeg(r.heading.bugDeg, hdg);
  const rate = r.trends.headingDegPer6s / 6;
  const trend = clamp(r.trends.headingDegPer6s, -HSI.trendMaxDeg, HSI.trendMaxDeg);
  const arrow = Math.abs(rate) > HSI.arrowRateDegS;

  drawRose(ctx, hdg);
  drawTurnRate(ctx, trend, arrow);
  ctx.save();
  ctx.translate(cx, cy);
  drawHeadingBug(ctx, bugRel, R);
  if (brg1.valid) drawBearingPointer(ctx, deltaDeg(brg1.bearingDeg, hdg), R, false);
  if (brg2.valid) drawBearingPointer(ctx, deltaDeg(brg2.bearingDeg, hdg), R, true);
  // source label and GPS CDI scale inside the rose
  text(ctx, cdi.label, -R * 0.42, -R * 0.24, condBold.get(16), cdi.color, 'center');
  if (cdi.scaleLabel) text(ctx, cdi.scaleLabel, R * 0.42, -R * 0.24, condBold.get(15), cdi.color, 'center');
  drawCoursePointer(ctx, courseRel, cdi, R);
  drawAircraft(ctx);
  ctx.restore();
  drawHeadingBoxes(ctx, hdg, r.heading.bugDeg, cdi);

  if (geo) {
    cdiBarCentre(cx, cy, courseRel, cdi.valid ? cdi.deviation : 0, tmpPt);
    geo.drawn = true; geo.cdiBarX = tmpPt.x; geo.cdiBarY = tmpPt.y;
    geo.courseRelDeg = courseRel; geo.bugRelDeg = bugRel; geo.trendDeg = trend; geo.trendArrow = arrow;
  }
}

function drawRose(ctx: Ctx2D, hdg: number): void {
  const { cx, cy, r: R } = HSI;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(30,30,30,0.85)';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = G.grey; ctx.lineWidth = 1; ctx.stroke();
  // fixed 45° index marks outside the rose
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 1; i < 8; i++) {
    const s = TICK_SIN[i * 9], c = TICK_COS[i * 9];
    ctx.moveTo(s * (R + 3), -c * (R + 3)); ctx.lineTo(s * (R + 12), -c * (R + 12));
  }
  ctx.stroke();
  // lubber index
  ctx.fillStyle = G.white;
  ctx.beginPath(); ctx.moveTo(0, -R + 12); ctx.lineTo(-7, -R - 1); ctx.lineTo(7, -R - 1); ctx.closePath(); ctx.fill();
  // rotating card
  ctx.rotate(-hdg * DEG);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 72; i++) {
    const s = TICK_SIN[i], c = TICK_COS[i], len = i % 2 === 0 ? 14 : 8;
    ctx.moveTo(s * R, -c * R); ctx.lineTo(s * (R - len), -c * (R - len));
  }
  ctx.stroke();
  ctx.font = condBold.get(20); ctx.fillStyle = G.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 12; i++) {
    ctx.save();
    ctx.rotate(i * 30 * DEG);
    ctx.font = i % 3 === 0 ? condBold.get(22) : condBold.get(18);
    ctx.fillText(CARD_LABELS[i], 0, -(R - 28));
    ctx.restore();
  }
  ctx.restore();
}

function drawTurnRate(ctx: Ctx2D, trendDeg: number, arrow: boolean): void {
  const { cx, cy } = HSI, TR = HSI.turnArcR;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = -2; k <= 2; k++) {
    if (k === 0) continue;
    const a = k * 9 * DEG, s = Math.sin(a), c = Math.cos(a);
    ctx.moveTo(s * TR, -c * TR); ctx.lineTo(s * (TR + 9), -c * (TR + 9));
  }
  ctx.stroke();
  if (Math.abs(trendDeg) > 0.3) {
    const a0 = -Math.PI / 2, a1 = a0 + trendDeg * DEG;
    ctx.strokeStyle = G.magenta; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, TR + 3, Math.min(a0, a1), Math.max(a0, a1)); ctx.stroke();
    if (arrow) {
      const d = Math.sign(trendDeg), s = Math.sin(trendDeg * DEG), c = Math.cos(trendDeg * DEG);
      const tx = s * (TR + 3), ty = -c * (TR + 3);
      // arrowhead pointing along the arc tangent (direction of turn)
      const ux = c * d, uy = s * d;
      ctx.fillStyle = G.magenta;
      ctx.beginPath();
      ctx.moveTo(tx + ux * 10, ty + uy * 10);
      ctx.lineTo(tx - s * 7, ty + c * 7);
      ctx.lineTo(tx + s * 7, ty - c * 7);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

function drawHeadingBug(ctx: Ctx2D, bugRelDeg: number, R: number): void {
  ctx.save();
  ctx.rotate(bugRelDeg * DEG);
  ctx.fillStyle = G.cyan;
  ctx.beginPath();
  ctx.moveTo(-10, -R - 6); ctx.lineTo(10, -R - 6); ctx.lineTo(10, -R + 6); ctx.lineTo(4, -R + 6);
  ctx.lineTo(0, -R); ctx.lineTo(-4, -R + 6); ctx.lineTo(-10, -R + 6); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBearingPointer(ctx: Ctx2D, relDeg: number, R: number, double: boolean): void {
  ctx.save();
  ctx.rotate(relDeg * DEG);
  ctx.strokeStyle = G.cyan; ctx.lineWidth = 2;
  const inner = R * 0.55, outer = R * 0.93, tip = R * 0.97;
  ctx.beginPath();
  if (double) {
    for (const x of DOUBLE_OFFSETS) {
      ctx.moveTo(x, outer - 6); ctx.lineTo(x, inner);
      ctx.moveTo(x, -inner); ctx.lineTo(x, -outer + 12);
    }
    // hollow arrowhead
    ctx.moveTo(-9, -outer + 12); ctx.lineTo(0, -tip); ctx.lineTo(9, -outer + 12);
  } else {
    ctx.moveTo(0, outer); ctx.lineTo(0, inner);
    ctx.moveTo(0, -inner); ctx.lineTo(0, -tip);
    ctx.moveTo(-8, -outer + 10); ctx.lineTo(0, -tip); ctx.lineTo(8, -outer + 10);
  }
  ctx.stroke();
  ctx.restore();
}
const DOUBLE_OFFSETS = [-4, 4];

function drawCoursePointer(ctx: Ctx2D, courseRelDeg: number, cdi: CdiState, R: number): void {
  const dot = HSI.dot;
  ctx.save();
  ctx.rotate(courseRelDeg * DEG);
  // deviation dots (white rings)
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let k = -2; k <= 2; k++) {
    if (k === 0) continue;
    ctx.beginPath(); ctx.arc(k * dot, 0, HSI.dotR, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = cdi.color; ctx.fillStyle = cdi.color; ctx.lineWidth = 5; ctx.lineCap = 'butt';
  // head with arrow, and tail
  ctx.beginPath();
  ctx.moveTo(0, -R * 0.44); ctx.lineTo(0, -R * 0.78);
  ctx.moveTo(0, R * 0.44); ctx.lineTo(0, R * 0.92);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -R * 0.94); ctx.lineTo(-11, -R * 0.76); ctx.lineTo(11, -R * 0.76); ctx.closePath(); ctx.fill();
  if (cdi.valid) {
    const dx = cdiOffsetPx(cdi.deviation);
    ctx.beginPath(); ctx.moveTo(dx, -R * 0.4); ctx.lineTo(dx, R * 0.4); ctx.stroke();
    if (cdi.toFrom !== 'off') {
      const dir = cdi.toFrom === 'to' ? -1 : 1, y = dir * R * 0.27;
      ctx.beginPath(); ctx.moveTo(dx, y + dir * 10); ctx.lineTo(dx - 9, y - dir * 4); ctx.lineTo(dx + 9, y - dir * 4); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = G.black; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  ctx.restore();
}

function drawAircraft(ctx: Ctx2D): void {
  ctx.strokeStyle = G.white; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -16); ctx.lineTo(0, 14);
  ctx.moveTo(-15, -3); ctx.lineTo(15, -3);
  ctx.moveTo(-6, 12); ctx.lineTo(6, 12);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawHeadingBoxes(ctx: Ctx2D, hdg: number, bugDeg: number, cdi: CdiState): void {
  const hb = HSI.headingBox, hd = HSI.hdgBox, cr = HSI.crsBox;
  box(ctx, hb.x, hb.y, hb.w, hb.h, G.black, G.white);
  num(ctx, headingLabels.get(hdg), hb.x + hb.w / 2, hb.y + hb.h / 2 + 1, condBold.get(22), G.white, 'center');
  box(ctx, hd.x, hd.y, hd.w, hd.h, G.boxBg);
  text(ctx, 'HDG', hd.x + 6, hd.y + hd.h / 2, cond.get(16), G.white);
  num(ctx, headingLabels.get(bugDeg), hd.x + hd.w - 6, hd.y + hd.h / 2, condBold.get(18), G.cyan, 'right');
  box(ctx, cr.x, cr.y, cr.w, cr.h, G.boxBg);
  text(ctx, 'CRS', cr.x + 6, cr.y + cr.h / 2, cond.get(16), G.white);
  num(ctx, headingLabels.get(cdi.courseDeg), cr.x + cr.w - 6, cr.y + cr.h / 2, condBold.get(18), cdi.color, 'right');
}
