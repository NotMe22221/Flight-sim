/** Canvas moving map: track-up/north-up, range 2–80 nm, plan legs, nearby airports (1 Hz), runways when zoomed in, wind arrow. */
import type { Airport, SimSnapshot } from '../../core/types';
import type { UiHost, UnitsSettings } from '../UiHost';
import { Txt, button, h } from '../dom';
import { KT_PER_MS, formatDistance, formatWind, normalizeHeading } from '../format';
import { localOffsetM } from '../geoMath';

const RANGES = [2, 5, 10, 20, 40, 80];
const NM = 1852;
const R2D = 180 / Math.PI;

export class VfrMap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private rangeIdx = 2;
  private trackUp = true;
  private airports: Airport[] = [];
  private lastFetch = 0;
  private lastDraw = 0;
  private rangeTxt: Txt;
  private infoTxt: Txt;
  private orientBtn: HTMLButtonElement;
  private selected: Airport | null = null;
  private directBtn: HTMLButtonElement | null = null;
  private lastSnap: SimSnapshot | null = null;
  private dpr = 1;

  constructor(container: HTMLElement, private readonly host: UiHost, private readonly units: () => UnitsSettings) {
    this.canvas = h('canvas', { aria: { label: 'VFR moving map' } });
    this.wrap = h('div', { class: 'vfr-canvas-wrap' }, this.canvas);
    this.rangeTxt = new Txt(h('span', { class: 'vfr-range' }), `${RANGES[this.rangeIdx]} nm`);
    this.infoTxt = new Txt(h('span', { class: 'muted', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }), '');
    this.orientBtn = button('TRK UP', () => { this.trackUp = !this.trackUp; this.orientBtn.querySelector('.btn-label')!.textContent = this.trackUp ? 'TRK UP' : 'NORTH UP'; this.lastDraw = 0; }, { cls: 'btn-sm', icon: 'north', title: 'Toggle track-up / north-up' });
    const controls = h('div', { class: 'vfr-controls' },
      button('', () => this.setRange(this.rangeIdx - 1), { icon: 'plus', cls: 'btn-icon btn-sm', title: 'Zoom in (shorter range)', aria: { label: 'Zoom in' } }),
      this.rangeTxt.el,
      button('', () => this.setRange(this.rangeIdx + 1), { icon: 'minus', cls: 'btn-icon btn-sm', title: 'Zoom out (longer range)', aria: { label: 'Zoom out' } }),
      this.orientBtn, this.infoTxt.el);
    if (host.addWaypoint) {
      this.directBtn = button('Direct to', () => { if (this.selected) { host.addWaypoint!({ id: this.selected.icao, position: this.selected.position, type: 'airport' }); this.infoTxt.set(`Direct to ${this.selected.icao} added to plan`); } }, { cls: 'btn-sm', icon: 'target', disabled: true });
      controls.appendChild(this.directBtn);
    }
    this.el = h('div', { class: 'vfrmap' }, this.wrap, controls);
    container.appendChild(this.el);
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.setRange(this.rangeIdx + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });
  }

  get rangeNm(): number { return RANGES[this.rangeIdx]; }
  setRange(i: number): void { this.rangeIdx = Math.max(0, Math.min(RANGES.length - 1, i)); this.rangeTxt.set(`${this.rangeNm} nm`); this.lastDraw = 0; this.lastFetch = 0; }

  private resize(): boolean {
    const w = this.wrap.clientWidth, hgt = this.wrap.clientHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.max(1, Math.round(w * this.dpr)), ph = Math.max(1, Math.round(hgt * this.dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; return true; }
    return false;
  }

  /**
   * Called every frame while visible; redraws at ≤ 10 Hz, airports refreshed at 1 Hz. The canvas size
   * is read only when about to draw (reading clientWidth every frame forces a layout per frame).
   */
  update(s: SimSnapshot, nowMs: number): void {
    this.lastSnap = s;
    if (nowMs - this.lastDraw < 100) return;
    this.lastDraw = nowMs;
    this.resize();
    if (nowMs - this.lastFetch > 1000) {
      this.lastFetch = nowMs;
      try { this.airports = this.host.nav.nearestAirports(s.aircraft.geo, 80, this.rangeNm * 1.6); } catch { this.airports = []; }
    }
    this.draw(s);
  }

  private geometry(s: SimSnapshot) {
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2;
    const scale = (Math.min(W, H) / 2 - 12 * this.dpr) / (this.rangeNm * NM); // px per metre
    const theta = this.trackUp ? (s.aircraft.groundSpeedMs > 2 ? s.aircraft.trackRad : s.aircraft.headingTrueRad) : 0;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const origin = { lat: s.aircraft.geo.lat, lon: s.aircraft.geo.lon };
    const toPx = (lat: number, lon: number) => {
      const o = localOffsetM(origin, { lat, lon });
      const e = o.east * cosT - o.north * sinT;
      const n = o.east * sinT + o.north * cosT;
      return { x: cx + e * scale, y: cy - n * scale };
    };
    return { W, H, cx, cy, scale, theta, toPx };
  }

  private draw(s: SimSnapshot): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { W, H, cx, cy, scale, theta, toPx } = this.geometry(s);
    const dpr = this.dpr;
    const font = (px: number) => `${Math.round(px * dpr)}px system-ui, sans-serif`;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0c1a2b'; ctx.fillRect(0, 0, W, H);

    // range rings
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1 * dpr; ctx.setLineDash([]);
    for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, this.rangeNm * NM * scale * f, 0, Math.PI * 2); ctx.stroke(); }
    // compass ticks on the outer ring
    const R = this.rangeNm * NM * scale;
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 30) {
      const a = (d * Math.PI / 180) - theta;
      const x = cx + Math.sin(a) * R, y = cy - Math.cos(a) * R;
      ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * (R - 6 * dpr), cy - Math.cos(a) * (R - 6 * dpr)); ctx.lineTo(x, y); ctx.stroke();
      const lx = cx + Math.sin(a) * (R - 16 * dpr), ly = cy - Math.cos(a) * (R - 16 * dpr);
      ctx.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), lx, ly);
    }

    // airports + runways
    const showRunways = this.rangeNm <= 10;
    for (const ap of this.airports) {
      const p = toPx(ap.position.lat, ap.position.lon);
      if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) continue;
      const big = ap.type === 'large', med = ap.type === 'medium';
      const r = (big ? 5 : med ? 4 : 3) * dpr;
      const sel = this.selected?.icao === ap.icao;
      ctx.fillStyle = sel ? '#4cc3ff' : big ? 'rgba(76,195,255,0.9)' : med ? 'rgba(170,200,230,0.85)' : 'rgba(170,200,230,0.55)';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (showRunways) {
        ctx.strokeStyle = sel ? '#4cc3ff' : 'rgba(220,230,240,0.8)'; ctx.lineWidth = 2.5 * dpr;
        for (const rw of ap.runways) {
          const a = toPx(rw.threshold.lat, rw.threshold.lon), b = toPx(rw.end.lat, rw.end.lon);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.lineWidth = 1 * dpr;
      }
      if (big || med || this.rangeNm <= 20 || sel) {
        ctx.fillStyle = sel ? '#4cc3ff' : 'rgba(233,238,245,0.8)'; ctx.font = font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(ap.icao, p.x + r + 3 * dpr, p.y);
      }
    }

    // flight plan
    const plan = s.plan;
    if (plan && plan.waypoints.length) {
      ctx.strokeStyle = 'rgba(255,0,255,0.85)'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
      ctx.beginPath();
      const start = plan.activeLeg >= 0 && plan.activeLeg < plan.waypoints.length ? plan.activeLeg : 0;
      ctx.moveTo(cx, cy);
      for (let i = start; i < plan.waypoints.length; i++) { const p = toPx(plan.waypoints[i].position.lat, plan.waypoints[i].position.lon); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,0,255,0.35)'; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.beginPath();
      for (let i = 0; i < start; i++) { const p = toPx(plan.waypoints[i].position.lat, plan.waypoints[i].position.lon); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ff5cff'; ctx.font = font(11); ctx.textAlign = 'left';
      for (const wp of plan.waypoints) {
        const p = toPx(wp.position.lat, wp.position.lon);
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 5 * dpr); ctx.lineTo(p.x + 5 * dpr, p.y); ctx.lineTo(p.x, p.y + 5 * dpr); ctx.lineTo(p.x - 5 * dpr, p.y); ctx.closePath(); ctx.fill();
        ctx.fillText(wp.id, p.x + 7 * dpr, p.y - 7 * dpr);
      }
    }

    // aircraft symbol
    const hdg = s.aircraft.headingTrueRad - theta;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(hdg);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0c1a2b'; ctx.lineWidth = 1.5 * dpr;
    const k = 1.2 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, -11 * k); ctx.lineTo(2 * k, -4 * k); ctx.lineTo(11 * k, 1 * k); ctx.lineTo(11 * k, 3 * k); ctx.lineTo(2 * k, 1 * k); ctx.lineTo(1.5 * k, 7 * k); ctx.lineTo(5 * k, 9 * k); ctx.lineTo(5 * k, 10.5 * k);
    ctx.lineTo(0, 9 * k); ctx.lineTo(-5 * k, 10.5 * k); ctx.lineTo(-5 * k, 9 * k); ctx.lineTo(-1.5 * k, 7 * k); ctx.lineTo(-2 * k, 1 * k); ctx.lineTo(-11 * k, 3 * k); ctx.lineTo(-11 * k, 1 * k); ctx.lineTo(-2 * k, -4 * k);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    // wind arrow (top-right): points where the wind blows TO, in map orientation
    const wn = s.aircraft.windNED[0], we = s.aircraft.windNED[1];
    const wkt = Math.hypot(wn, we) * KT_PER_MS;
    const wx = W - 34 * dpr, wy = 34 * dpr;
    ctx.fillStyle = 'rgba(10,14,22,0.7)'; ctx.beginPath(); ctx.arc(wx, wy, 24 * dpr, 0, Math.PI * 2); ctx.fill();
    if (wkt >= 1) {
      const blowTo = Math.atan2(we, wn) - theta; // direction the air moves toward, map-relative
      ctx.save(); ctx.translate(wx, wy); ctx.rotate(blowTo);
      ctx.strokeStyle = '#4cc3ff'; ctx.fillStyle = '#4cc3ff'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(0, 12 * dpr); ctx.lineTo(0, -8 * dpr); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -14 * dpr); ctx.lineTo(5 * dpr, -6 * dpr); ctx.lineTo(-5 * dpr, -6 * dpr); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#e9eef5'; ctx.font = font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const wdir = normalizeHeading(Math.atan2(-we, -wn) * R2D);
    ctx.fillText(formatWind(wdir, wkt), wx, wy + 26 * dpr);

    // north arrow when track-up
    if (this.trackUp) {
      const nx = 22 * dpr, ny = 22 * dpr, a = -theta;
      ctx.save(); ctx.translate(nx, ny); ctx.rotate(a);
      ctx.fillStyle = '#ffc857'; ctx.beginPath(); ctx.moveTo(0, -12 * dpr); ctx.lineTo(5 * dpr, 6 * dpr); ctx.lineTo(0, 2 * dpr); ctx.lineTo(-5 * dpr, 6 * dpr); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#ffc857'; ctx.font = font(9); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N', nx, ny + 10 * dpr);
    }

    // scale text bottom-left
    ctx.fillStyle = 'rgba(233,238,245,0.7)'; ctx.font = font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`Ring ${formatDistance(this.rangeNm * NM / 2, this.units())} · ${this.trackUp ? 'Track up' : 'North up'}`, 8 * dpr, H - 6 * dpr);
  }

  private onClick(e: MouseEvent): void {
    const s = this.lastSnap;
    if (!s) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * this.dpr, y = (e.clientY - rect.top) * this.dpr;
    const { toPx } = this.geometry(s);
    let best: Airport | null = null, bestD = 14 * this.dpr;
    for (const ap of this.airports) {
      const p = toPx(ap.position.lat, ap.position.lon);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { best = ap; bestD = d; }
    }
    this.selected = best;
    if (best) {
      const rw = best.runways.map((r) => r.ident).join('/');
      this.infoTxt.set(`${best.icao} ${best.name}${rw ? ' · RWY ' + rw : ''}`);
    } else this.infoTxt.set('');
    if (this.directBtn) this.directBtn.disabled = !best;
    this.lastDraw = 0;
  }
}
