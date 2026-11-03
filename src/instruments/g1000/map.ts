/**
 * MFD moving map (docs/research/05 §2.3): north-up, track-up or heading-up, aircraft centred
 * (north-up) or low on the pane (track/heading-up), range ring with compass ticks plus a dashed
 * half-range ring, flight-plan legs (active leg magenta, past grey, future white) and waypoint
 * symbols, nearest airports (cyan = large/medium, magenta = small), a 1-minute track vector, wind
 * arrow, north pointer and range / orientation labels. Projection: local equirectangular (geo.ts).
 */
import { clamp, wrap360 } from '../../core/math';
import { DEG, MS_TO_KT, RAD } from '../../core/units';
import type { FlightPlan, SimSnapshot, Waypoint } from '../../core/types';
import type { FlightPlanEx } from '../../nav';
import type { Ctx2D } from '../canvas';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import { MAP_RANGES_NM } from '../scales';
import { LocalProjection, type MapPointNm } from './geo';
import { drawArrow } from './infoBoxes';
import { G, MFD, cond, condBold } from './palette';
import { box, num, text } from './widgets';

export type MapOrientation = 'north-up' | 'track-up' | 'heading-up';

/** An airport symbol for the map (from `G1000.setNearestAirports`). */
export interface MapAirport { icao: string; lat: number; lon: number; type: string }

/** Map pane geometry (design units) and placement of the aircraft symbol. */
export const MAP = Object.freeze({
  x: MFD.mapX, y: MFD.mapY, w: MFD.mapW, h: MFD.mapH,
  /** aircraft symbol height as a fraction of the pane: centred north-up, low for track/heading-up */
  northUpCy: 0.5, rotatedCy: 0.72,
  /** gap between the range ring and the pane edge, px */
  ringMargin: 26,
  /** label airports only at or below this range, nm */
  labelRangeNm: 100,
  /** below this ground speed track-up falls back to heading-up, kt */
  minTrackGsKt: 5,
});

/** Where the map is drawn; `compact` (PFD inset) drops the wind box and shrinks the labels. */
export interface MapViewport { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly compact?: boolean }

/** Optional drawing settings: viewport, declutter level 0–3 (1: no airport labels, 2: no airports, 3: no plan labels). */
export interface MapDrawOptions { viewport?: MapViewport; declutter?: number }

/** Per-frame view transform: screen = centre + k·R(θ)·(east, north). */
export interface MapView { cx: number; cy: number; pxPerNm: number; ringPx: number; upDeg: number; cos: number; sin: number }

export function createMapView(): MapView { return { cx: 0, cy: 0, pxPerNm: 1, ringPx: 1, upDeg: 0, cos: 1, sin: 0 }; }

/**
 * Compute the view for a range (radius of the outer ring, nm) and the true direction that points
 * up on screen (0 for north-up).
 */
export function computeMapView(rangeNm: number, orientation: MapOrientation, upTrueDeg: number, out: MapView, vp: MapViewport = MAP): MapView {
  const rotated = orientation !== 'north-up';
  out.cx = vp.x + vp.w / 2;
  out.cy = vp.y + vp.h * (rotated ? MAP.rotatedCy : MAP.northUpCy);
  out.ringPx = Math.max(8, Math.min(out.cy - vp.y, vp.w / 2) - (vp.compact ? 8 : MAP.ringMargin));
  out.pxPerNm = out.ringPx / Math.max(rangeNm, 1e-3);
  out.upDeg = rotated ? wrap360(upTrueDeg) : 0;
  out.cos = Math.cos(out.upDeg * DEG); out.sin = Math.sin(out.upDeg * DEG);
  return out;
}

/** Map-plane point (nm east/north of the aircraft) → screen. */
export function mapToScreen(v: MapView, p: MapPointNm, out: MapPointNm): MapPointNm {
  const k = v.pxPerNm;
  out.x = v.cx + k * (p.x * v.cos - p.y * v.sin);
  out.y = v.cy - k * (p.y * v.cos + p.x * v.sin);
  return out;
}

/** Map range formatted without float noise: 0.75 → "0.75", 10 → "10". */
export function formatRange(nm: number): string { return String(Number(nm.toFixed(3))); }

const rangeLabels = new LabelCache((v) => formatRange(v), 0.001, 128);
const ktLabels = new LabelCache((v) => `${v}KT`);
const ROSE_LABELS = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
const ORIENTATION_LABEL: Record<MapOrientation, string> = { 'north-up': 'NORTH UP', 'track-up': 'TRACK UP', 'heading-up': 'HDG UP' };

/** Stateful renderer (owns its scratch objects so drawing allocates nothing). */
export class MovingMap {
  readonly view = createMapView();
  private readonly proj = new LocalProjection();
  private readonly p = { x: 0, y: 0 };
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };
  private vp: MapViewport = MAP;

  /** Draw the map pane for snapshot `s`. */
  draw(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings, rangeNm: number, orientation: MapOrientation, airports: readonly MapAirport[], opts?: MapDrawOptions): void {
    const ac = s.aircraft;
    const vp = opts?.viewport ?? MAP, dcl = opts?.declutter ?? 0;
    this.vp = vp;
    const hdgTrue = wrap360(finite(ac.headingTrueRad) * RAD);
    const trackTrue = r.gsKt >= MAP.minTrackGsKt && Number.isFinite(ac.trackRad) ? wrap360(ac.trackRad * RAD) : hdgTrue;
    // without a usable position only the frame, rings and ownship are drawn
    const posOk = Number.isFinite(ac.geo.lat) && Number.isFinite(ac.geo.lon);
    const up = orientation === 'track-up' ? trackTrue : orientation === 'heading-up' ? hdgTrue : 0;
    const v = computeMapView(rangeNm, orientation, up, this.view, vp);
    if (posOk) this.proj.setCentre(ac.geo.lat, ac.geo.lon);
    ctx.save();
    ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
    ctx.fillStyle = '#04080c'; ctx.fillRect(vp.x, vp.y, vp.w, vp.h);
    this.drawRings(ctx, v, rangeNm);
    if (posOk && dcl < 2) this.drawAirports(ctx, v, airports, rangeNm, s.plan, dcl < 1);
    if (posOk && s.plan) this.drawPlan(ctx, v, s.plan, dcl < 3);
    this.drawTrackVector(ctx, v, trackTrue, finite(ac.groundSpeedMs) * MS_TO_KT);
    this.drawOwnship(ctx, v, hdgTrue - v.upDeg);
    ctx.restore();
    this.drawOverlays(ctx, v, r, rangeNm, orientation);
  }

  private drawRings(ctx: Ctx2D, v: MapView, rangeNm: number): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(v.cx, v.cy, v.ringPx, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash(DASH);
    ctx.beginPath(); ctx.arc(v.cx, v.cy, v.ringPx / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash(NO_DASH);
    // compass ticks on the outer ring
    ctx.save();
    ctx.translate(v.cx, v.cy);
    ctx.rotate(-v.upDeg * DEG);
    ctx.beginPath();
    for (let d = 0; d < 360; d += 10) {
      const a = d * DEG, s = Math.sin(a), c = Math.cos(a), len = d % 30 === 0 ? 12 : 6;
      ctx.moveTo(s * v.ringPx, -c * v.ringPx); ctx.lineTo(s * (v.ringPx - len), -c * (v.ringPx - len));
    }
    ctx.stroke();
    const compact = this.vp.compact === true, inset = compact ? 14 : 24;
    ctx.font = condBold.get(compact ? 11 : 15); ctx.fillStyle = G.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      if (compact && i % 3 !== 0) continue;
      const a = i * 30 * DEG;
      ctx.fillText(ROSE_LABELS[i], Math.sin(a) * (v.ringPx - inset), -Math.cos(a) * (v.ringPx - inset));
    }
    ctx.restore();
    const k = Math.SQRT1_2;
    text(ctx, rangeLabels.get(rangeNm / 2), v.cx - (v.ringPx / 2) * k - 4, v.cy - (v.ringPx / 2) * k - 4, cond.get(compact ? 11 : 14), G.white, 'right');
  }

  private drawAirports(ctx: Ctx2D, v: MapView, airports: readonly MapAirport[], rangeNm: number, plan: FlightPlan | null, showLabels: boolean): void {
    const labels = showLabels && rangeNm <= MAP.labelRangeNm, vp = this.vp;
    for (const apt of airports) {
      if (!Number.isFinite(apt.lat) || !Number.isFinite(apt.lon)) continue;
      const q = mapToScreen(v, this.proj.project(apt.lat, apt.lon, this.p), this.a);
      if (q.x < vp.x - 20 || q.x > vp.x + vp.w + 20 || q.y < vp.y - 20 || q.y > vp.y + vp.h + 20) continue;
      const towered = apt.type === 'large' || apt.type === 'medium' || apt.type === 'large_airport' || apt.type === 'medium_airport';
      const color = towered ? G.cyan : apt.type === 'small' || apt.type === 'small_airport' ? G.magenta : G.grey;
      if (apt.type === 'heliport') text(ctx, 'H', q.x, q.y, condBold.get(15), color, 'center');
      else {
        ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.stroke();
        if (towered) {
          ctx.beginPath();
          ctx.moveTo(q.x, q.y - 6); ctx.lineTo(q.x, q.y - 11); ctx.moveTo(q.x, q.y + 6); ctx.lineTo(q.x, q.y + 11);
          ctx.moveTo(q.x - 6, q.y); ctx.lineTo(q.x - 11, q.y); ctx.moveTo(q.x + 6, q.y); ctx.lineTo(q.x + 11, q.y);
          ctx.stroke();
        }
      }
      // flight-plan waypoints carry their own label
      if (labels && !inPlan(plan, apt.icao)) text(ctx, apt.icao, q.x + 12, q.y - 12, cond.get(vp.compact ? 12 : 14), G.white, 'left');
    }
  }

  private drawPlan(ctx: Ctx2D, v: MapView, plan: FlightPlan, labels: boolean): void {
    const wps = plan.waypoints, n = wps.length;
    // a direct-to (or OBS) leg starts at the plan's own FROM point instead of the previous waypoint
    const ex = plan as Partial<Pick<FlightPlanEx, 'directTo' | 'legFrom' | 'obsCourseDeg'>>;
    const custom = !!ex.legFrom && (ex.directTo === true || (ex.obsCourseDeg !== null && ex.obsCourseDeg !== undefined));
    ctx.lineWidth = v.ringPx < 150 ? 2 : 3;
    for (let i = 1; i < n; i++) {
      if (custom && i === plan.activeLeg) continue;
      const pa = this.screenOf(v, wps[i - 1], this.a), pb = this.screenOf(v, wps[i], this.b);
      if (!pa || !pb) continue;
      ctx.strokeStyle = i === plan.activeLeg ? G.magenta : i < plan.activeLeg ? G.grey : G.white;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    const act = wps[plan.activeLeg];
    if (custom && act && ex.legFrom && Number.isFinite(ex.legFrom.lat) && Number.isFinite(ex.legFrom.lon)) {
      const pa = mapToScreen(v, this.proj.project(ex.legFrom.lat, ex.legFrom.lon, this.p), this.a);
      pa.x = clamp(pa.x, -1e5, 1e5); pa.y = clamp(pa.y, -1e5, 1e5);
      const pb = this.screenOf(v, act, this.b);
      if (pb) { ctx.strokeStyle = G.magenta; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke(); }
    }
    const font = condBold.get(v.ringPx < 150 ? 12 : 15);
    for (let i = 0; i < n; i++) {
      const q = this.screenOf(v, wps[i], this.a);
      if (!q) continue;
      const color = i === plan.activeLeg ? G.magenta : G.white;
      waypointSymbol(ctx, wps[i].type, q.x, q.y, color);
      if (labels) text(ctx, wps[i].id, q.x + 10, q.y + 14, font, color, 'left');
    }
  }

  private screenOf(v: MapView, wp: Waypoint, out: MapPointNm): MapPointNm | null {
    const g = wp.position;
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return null;
    const q = mapToScreen(v, this.proj.project(g.lat, g.lon, this.p), out);
    // keep far-away points finite and inside a sane box so the canvas can clip the segment
    q.x = clamp(q.x, -1e5, 1e5); q.y = clamp(q.y, -1e5, 1e5);
    return q;
  }

  private drawTrackVector(ctx: Ctx2D, v: MapView, trackTrueDeg: number, gsKt: number): void {
    if (!(gsKt >= 30)) return;
    const len = (gsKt / 60) * v.pxPerNm, a = (trackTrueDeg - v.upDeg) * DEG;
    ctx.strokeStyle = G.white; ctx.lineWidth = 2; ctx.setLineDash(DASH);
    ctx.beginPath(); ctx.moveTo(v.cx, v.cy); ctx.lineTo(v.cx + Math.sin(a) * len, v.cy - Math.cos(a) * len); ctx.stroke();
    ctx.setLineDash(NO_DASH);
  }

  private drawOwnship(ctx: Ctx2D, v: MapView, relDeg: number): void {
    ctx.save();
    ctx.translate(v.cx, v.cy);
    ctx.rotate(relDeg * DEG);
    ctx.fillStyle = G.white; ctx.strokeStyle = G.black; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -16); ctx.lineTo(3, -6); ctx.lineTo(16, 2); ctx.lineTo(16, 5); ctx.lineTo(3, 2); ctx.lineTo(2, 11);
    ctx.lineTo(7, 15); ctx.lineTo(-7, 15); ctx.lineTo(-2, 11); ctx.lineTo(-3, 2); ctx.lineTo(-16, 5); ctx.lineTo(-16, 2); ctx.lineTo(-3, -6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  private drawOverlays(ctx: Ctx2D, v: MapView, r: InstrumentReadings, rangeNm: number, orientation: MapOrientation): void {
    const vp = this.vp;
    if (vp.compact) {
      // PFD inset: range bottom right and a small north pointer only
      const rx = vp.x + vp.w - 58, ry = vp.y + vp.h - 22;
      box(ctx, rx, ry, 54, 19, G.boxBg, G.grey);
      num(ctx, rangeLabels.get(rangeNm), rx + 34, ry + 10, condBold.get(14), G.white, 'right');
      text(ctx, 'NM', rx + 37, ry + 10, cond.get(10), G.white, 'left');
      if (orientation !== 'north-up') drawArrow(ctx, vp.x + vp.w - 14, vp.y + 18, 18, -v.upDeg * DEG, G.white);
      ctx.strokeStyle = G.grey; ctx.lineWidth = 1.5; ctx.strokeRect(vp.x + 0.75, vp.y + 0.75, vp.w - 1.5, vp.h - 1.5);
      return;
    }
    // wind (top left): arrow shows where the air moves, relative to map up
    const wx = vp.x + 8, wy = vp.y + 8;
    box(ctx, wx, wy, 96, 48, G.boxBg);
    if (r.wind.speedKt >= 1) drawArrow(ctx, wx + 24, wy + 24, 34, (r.wind.fromTrueDeg + 180 - v.upDeg) * DEG, G.white);
    num(ctx, ktLabels.get(r.wind.speedKt), wx + 90, wy + 24, condBold.get(16), G.white, 'right');
    // orientation label and north pointer (top right)
    const ox = vp.x + vp.w - 8;
    text(ctx, ORIENTATION_LABEL[orientation], ox, vp.y + 16, condBold.get(15), G.white, 'right');
    drawArrow(ctx, ox - 14, vp.y + 50, 26, -v.upDeg * DEG, G.white);
    text(ctx, 'N', ox - 30, vp.y + 50, condBold.get(14), G.white, 'right');
    // range (bottom right)
    const rx = vp.x + vp.w - 78, ry = vp.y + vp.h - 32;
    box(ctx, rx, ry, 70, 24, G.boxBg, G.grey);
    num(ctx, rangeLabels.get(rangeNm), rx + 46, ry + 12, condBold.get(16), G.white, 'right');
    text(ctx, 'NM', rx + 50, ry + 12, cond.get(12), G.white, 'left');
  }
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** True when `id` is one of the plan's waypoints. */
function inPlan(plan: FlightPlan | null, id: string): boolean {
  if (!plan) return false;
  for (const w of plan.waypoints) if (w.id === id) return true;
  return false;
}

const DASH = [8, 6];
const NO_DASH: number[] = [];

function waypointSymbol(ctx: Ctx2D, type: Waypoint['type'], x: number, y: number, color: string): void {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  if (type === 'airport') ctx.arc(x, y, 7, 0, Math.PI * 2);
  else if (type === 'navaid') {
    for (let i = 0; i < 6; i++) {
      const a = (i * 60 + 30) * DEG;
      if (i === 0) ctx.moveTo(x + 8 * Math.cos(a), y + 8 * Math.sin(a)); else ctx.lineTo(x + 8 * Math.cos(a), y + 8 * Math.sin(a));
    }
    ctx.closePath();
  } else if (type === 'fix') { ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y + 5); ctx.lineTo(x - 7, y + 5); ctx.closePath(); }
  else ctx.rect(x - 6, y - 6, 12, 12);
  ctx.stroke();
}

/** Clamp an arbitrary range to the G1000 range steps (0.5–2 000 nm). */
export function clampMapRange(nm: number): number {
  return clamp(Number.isFinite(nm) ? nm : 10, MAP_RANGES_NM[0], MAP_RANGES_NM[MAP_RANGES_NM.length - 1]);
}
