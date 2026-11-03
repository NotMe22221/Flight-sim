/**
 * World Map canvas drawing. Stateless functions over a 2D context in CSS pixels (the caller
 * sets the DPR transform). Colours mirror the ui.css tokens.
 */
import type { Airport } from '../../../core/types';
import type { RunwayEndChoice } from '../../UiHost';
import { bearingDeg, destination, distanceM } from '../../geoMath';
import { graticuleStep, metersPerPixel, project, visibleBounds, wrapLon, type MapView } from '../../mapProjection';
import { ZOOM_RUNWAYS, airportDotRadius, airportLabelVisible, airportTypeVisible, runwayLine } from '../../worldMapModel';

const C = {
  bg: '#0b1828', bgEdge: '#08111d', grid: 'rgba(255,255,255,0.06)', gridMajor: 'rgba(76,195,255,0.22)', gridText: 'rgba(233,238,245,0.38)',
  accent: '#4cc3ff', ok: '#5fd68a', fg: 'rgba(233,238,245,0.92)', label: 'rgba(233,238,245,0.72)', outline: 'rgba(4,10,18,0.85)',
  large: '#4cc3ff', medium: 'rgba(160,215,255,0.92)', small: 'rgba(233,238,245,0.62)', minor: 'rgba(233,238,245,0.45)', runway: 'rgba(233,238,245,0.8)',
};
const DOT_COLOR: Record<Airport['type'], string> = { large: C.large, medium: C.medium, small: C.small, heliport: C.minor, seaplane: C.minor };
const MAX_LABELS = 180;

export interface MapScene {
  view: MapView;
  airports: readonly Airport[];
  departure: Airport;
  departureEnd: RunwayEndChoice | null;
  focused: Airport | null;
  arrival: Airport | null;
  hover: Airport | null;
}

export function drawMap(g: CanvasRenderingContext2D, s: MapScene): void {
  const { width: w, height: hgt } = s.view;
  const grad = g.createRadialGradient(w / 2, hgt / 2, 0, w / 2, hgt / 2, Math.hypot(w, hgt) / 1.6);
  grad.addColorStop(0, C.bg); grad.addColorStop(1, C.bgEdge);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, hgt);
  drawGraticule(g, s.view);
  if (s.arrival) drawRoute(g, s.view, s.departure, s.arrival);
  drawAirports(g, s);
  const showRunways = s.view.pxPerDeg >= ZOOM_RUNWAYS;
  if (showRunways && s.focused && s.focused.icao !== s.departure.icao) drawRunways(g, s.view, s.focused);
  if (showRunways) drawRunways(g, s.view, s.departure);
  if (s.departureEnd) drawDepartureEnd(g, s.view, s.departureEnd);
  if (s.arrival) marker(g, s.view, s.arrival, C.ok, 'ARR');
  marker(g, s.view, s.departure, C.accent, 'DEP');
  if (s.focused && s.focused.icao !== s.departure.icao && s.focused.icao !== s.arrival?.icao) marker(g, s.view, s.focused, C.fg, '');
  if (s.hover && s.hover.icao !== s.focused?.icao) ring(g, s.view, s.hover, C.fg, 1);
}

function degLabel(v: number, step: number, pos: string, neg: string): string {
  const d = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const a = Math.abs(v);
  return `${a.toFixed(d)}°${v > 0 ? pos : v < 0 ? neg : ''}`;
}

function drawGraticule(g: CanvasRenderingContext2D, v: MapView): void {
  const step = graticuleStep(v.pxPerDeg, 90);
  const b = visibleBounds(v);
  g.lineWidth = 1;
  g.font = '10px ui-monospace, Menlo, Consolas, monospace';
  g.fillStyle = C.gridText;
  g.textBaseline = 'top';
  for (let lon = Math.ceil(b.minLon / step) * step; lon <= b.maxLon; lon += step) {
    const wl = wrapLon(lon);
    const x = Math.round(project(v, wl, v.centerLat).x) + 0.5;
    g.strokeStyle = Math.abs(wl) < 1e-9 || Math.abs(Math.abs(wl) - 180) < 1e-9 ? C.gridMajor : C.grid;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, v.height); g.stroke();
    g.fillText(degLabel(wl, step, 'E', 'W'), x + 3, 4);
  }
  g.textBaseline = 'bottom';
  for (let lat = Math.ceil(b.minLat / step) * step; lat <= b.maxLat; lat += step) {
    const y = Math.round(project(v, v.centerLon, lat).y) + 0.5;
    g.strokeStyle = Math.abs(lat) < 1e-9 ? C.gridMajor : C.grid;
    g.beginPath(); g.moveTo(0, y); g.lineTo(v.width, y); g.stroke();
    if (y > 26) g.fillText(degLabel(lat, step, 'N', 'S'), 4, y - 2); // not into the longitude labels' row
  }
}

/** Great-circle leg departure → arrival, dashed, broken at the antimeridian. */
function drawRoute(g: CanvasRenderingContext2D, v: MapView, a: Airport, b: Airport): void {
  const from = { lat: a.position.lat, lon: a.position.lon };
  const to = { lat: b.position.lat, lon: b.position.lon };
  const d = distanceM(from, to);
  const brg = bearingDeg(from, to);
  const n = Math.min(64, Math.max(2, Math.ceil(d / 50_000)));
  g.save();
  g.strokeStyle = C.ok; g.lineWidth = 2; g.setLineDash([8, 6]);
  g.beginPath();
  let px = 0;
  for (let i = 0; i <= n; i++) {
    const p = i === 0 ? from : i === n ? to : destination(from, brg, (d * i) / n);
    const q = project(v, p.lon, p.lat);
    if (i === 0 || Math.abs(q.x - px) > v.width / 2) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
    px = q.x;
  }
  g.stroke();
  g.restore();
}

function drawAirports(g: CanvasRenderingContext2D, s: MapScene): void {
  const v = s.view;
  const margin = 24;
  let labels = 0;
  g.font = '11px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'middle';
  g.lineWidth = 1.5;
  g.strokeStyle = C.outline;
  for (const ap of s.airports) {
    if (!airportTypeVisible(ap.type, v.pxPerDeg)) continue;
    const p = project(v, ap.position.lon, ap.position.lat);
    if (p.x < -margin || p.y < -margin || p.x > v.width + margin || p.y > v.height + margin) continue;
    const r = airportDotRadius(ap.type, v.pxPerDeg);
    g.fillStyle = DOT_COLOR[ap.type] ?? C.minor;
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    if (labels < MAX_LABELS && airportLabelVisible(ap.type, v.pxPerDeg)) {
      labels++;
      g.fillStyle = C.label;
      g.fillText(ap.icao, p.x + r + 4, p.y);
    }
  }
}

function drawRunways(g: CanvasRenderingContext2D, v: MapView, ap: Airport): void {
  const mpp = metersPerPixel(v, ap.position.lat);
  g.save();
  g.strokeStyle = C.runway;
  g.lineCap = 'butt';
  for (const r of ap.runways) {
    const a = project(v, r.threshold.lon, r.threshold.lat);
    const b = project(v, r.end.lon, r.end.lat);
    g.lineWidth = Math.min(12, Math.max(1.5, r.widthM / mpp));
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.restore();
}

/** The chosen runway end: thick accent line with a chevron pointing in the take-off direction. */
function drawDepartureEnd(g: CanvasRenderingContext2D, v: MapView, end: RunwayEndChoice): void {
  const { from, to } = runwayLine(end);
  const a = project(v, from.lon, from.lat);
  const b = project(v, to.lon, to.lat);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return; // too far out: the DEP ring says enough
  g.save();
  g.strokeStyle = C.accent; g.fillStyle = C.accent; g.lineCap = 'round';
  g.lineWidth = Math.min(8, Math.max(3, len / 40));
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const cx = a.x + ux * len * 0.35, cy = a.y + uy * len * 0.35;
  const s = Math.min(14, Math.max(6, len / 12));
  g.beginPath();
  g.moveTo(cx + ux * s, cy + uy * s);
  g.lineTo(cx - uy * s * 0.7, cy + ux * s * 0.7);
  g.lineTo(cx + uy * s * 0.7, cy - ux * s * 0.7);
  g.closePath();
  g.strokeStyle = C.outline; g.lineWidth = 1.5;
  g.fill(); g.stroke();
  g.restore();
}

function ring(g: CanvasRenderingContext2D, v: MapView, ap: Airport, color: string, width: number): { x: number; y: number; r: number } {
  const p = project(v, ap.position.lon, ap.position.lat);
  const r = airportDotRadius(ap.type, v.pxPerDeg) + 5;
  g.save();
  g.strokeStyle = color; g.lineWidth = width;
  g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
  g.restore();
  return { x: p.x, y: p.y, r };
}

function marker(g: CanvasRenderingContext2D, v: MapView, ap: Airport, color: string, tag: string): void {
  const { x, y, r } = ring(g, v, ap, color, 2.5);
  if (x < -40 || y < -40 || x > v.width + 40 || y > v.height + 40) return;
  const text = tag ? `${tag} ${ap.icao}` : ap.icao;
  g.save();
  g.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const tw = g.measureText(text).width;
  const bx = x - tw / 2 - 6, by = y - r - 22;
  g.fillStyle = 'rgba(10,14,22,0.88)';
  g.strokeStyle = color; g.lineWidth = 1;
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(bx, by, tw + 12, 17, 8); else g.rect(bx, by, tw + 12, 17);
  g.fill(); g.stroke();
  g.fillStyle = color; g.textBaseline = 'middle';
  g.fillText(text, bx + 6, by + 9);
  g.restore();
}
