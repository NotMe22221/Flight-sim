/**
 * Airliner glass cockpit (`AircraftConfig.panel === 'airliner-pfd'`), Airbus style, drawn into one
 * canvas the integrator maps onto the panel mesh:
 *
 *   ┌───────────────────────── FCU (SPD · HDG · ALT · V/S, AP1 · A/THR · LOC · APPR) ───────────────────────┐
 *   │  PFD (FMA, attitude, speed tape, altitude tape, V/S)  │  ND (ARC, route)  │  E/WD (N1, EGT, FF, FOB, flaps)  │
 *
 * Simplified from the real displays but with their layout, colours and logic: green = current value,
 * cyan = selected target / armed mode, magenta = managed / flight plan, amber = caution. Redrawn at
 * ~15 Hz (`update` returns true when the canvas changed and the texture should be uploaded).
 */
import type { AircraftConfig, SimSnapshot } from '../../core/types';
import { clamp, wrap360 } from '../../core/math';
import { DEG, FT, M_TO_FT, MS_TO_KT, NM, RAD } from '../../core/units';
import { type CanvasFactory, type CanvasSurface, type Ctx2D, domCanvasFactory, get2d, OPAQUE_CTX, releaseSurface } from '../canvas';

export const AIRLINER_W = 1536;
export const AIRLINER_H = 640;
/** FCU strip height; the three 512 × 512 displays sit below it */
export const FCU_H = 112;
const DU = 512;

/** What the displays need that is not in the snapshot: the autothrust. */
export interface AirlinerExtras {
  athrEngaged: boolean;
  athrMode: string;
  /** commanded thrust lever 0..1 (the N1 target) */
  athrLever?: number;
}

const C = {
  bg: '#05070a', green: '#19e05a', cyan: '#3fd8ff', magenta: '#ff4bd8', amber: '#ffa21a', red: '#ff3030',
  white: '#f2f2f2', yellow: '#ffe81a', grey: '#5f6670', sky: '#2f78c8', ground: '#7a4a22', tape: '#38404a',
};

const F = (px: number, bold = true) => `${bold ? 'bold ' : ''}${px}px "Arial Narrow", Arial, sans-serif`;

interface Limits { vmoKt: number; vleKt: number; vfeKt: number[]; vs1Kt: number; vsoKt: number; mtowKg: number; flapDetents: number }

export class AirlinerDisplays {
  readonly canvas: CanvasSurface;
  private readonly ctx: Ctx2D;
  private readonly lim: Limits;
  private acc = 1;
  private lastIas = Number.NaN;
  private trendKt = 0;
  private readonly extras: AirlinerExtras = { athrEngaged: false, athrMode: 'OFF' };

  constructor(config: Pick<AircraftConfig, 'limits' | 'mass' | 'controls'>, factory: CanvasFactory = domCanvasFactory) {
    this.canvas = factory.create(AIRLINER_W, AIRLINER_H);
    this.ctx = get2d(this.canvas, OPAQUE_CTX);
    const l = config.limits;
    this.lim = {
      vmoKt: l.VneKt, vleKt: l.VleKt ?? l.VneKt, vfeKt: l.VfeKt ?? [], vs1Kt: l.Vs1Kt, vsoKt: l.VsoKt,
      mtowKg: config.mass.maxTakeoffKg, flapDetents: config.controls.flaps.detentsDeg.length,
    };
  }

  reset(snap: SimSnapshot): void { this.lastIas = Number.NaN; this.trendKt = 0; this.acc = 1; this.draw(snap); }

  /** Step the displays; returns true when the canvas was redrawn. */
  update(snap: SimSnapshot, dt: number, extras?: AirlinerExtras): boolean {
    if (extras) Object.assign(this.extras, extras);
    const ias = snap.aircraft.aero.ias * MS_TO_KT;
    if (dt > 0 && Number.isFinite(this.lastIas)) {
      // 10 s speed trend arrow, filtered
      const a = (ias - this.lastIas) / dt;
      this.trendKt += (a * 10 - this.trendKt) * (1 - Math.exp(-dt / 1.0));
    }
    this.lastIas = ias;
    this.acc += dt;
    if (this.acc < 1 / 15) return false;
    this.acc = 0;
    this.draw(snap);
    return true;
  }

  /** Draw everything now (tests, reset). */
  draw(snap: SimSnapshot): void {
    const g = this.ctx;
    g.fillStyle = '#000'; g.fillRect(0, 0, AIRLINER_W, AIRLINER_H);
    this.drawFcu(g, snap);
    for (let i = 0; i < 3; i++) {
      const x = i * DU;
      g.save();
      g.translate(x, FCU_H + 8);
      g.beginPath(); g.rect(4, 4, DU - 8, DU - 16); g.clip();
      g.fillStyle = C.bg; g.fillRect(0, 0, DU, DU);
      if (i === 0) this.drawPfd(g, snap); else if (i === 1) this.drawNd(g, snap); else this.drawEwd(g, snap);
      g.restore();
      // bezel
      g.strokeStyle = '#2a2e34'; g.lineWidth = 8; g.strokeRect(x + 4, FCU_H + 12, DU - 8, DU - 16);
    }
  }

  dispose(): void { releaseSurface(this.canvas); }

  // ───────────────────────────── FCU ─────────────────────────────

  private drawFcu(g: Ctx2D, s: SimSnapshot): void {
    const ap = s.autopilot, ac = s.aircraft;
    g.fillStyle = '#2b3036'; g.fillRect(0, 0, AIRLINER_W, FCU_H);
    g.fillStyle = '#1b1f24'; g.fillRect(0, FCU_H - 6, AIRLINER_W, 6);
    const win = (x: number, label: string, value: string, dashed: boolean) => {
      label3(g, label, x + 80, 22);
      g.fillStyle = '#0a0b0c'; g.fillRect(x, 34, 160, 52);
      g.font = F(36); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = dashed ? '#e0a040' : '#ffb84a';
      g.fillText(value, x + 80, 61);
    };
    const spd = ap.iasTargetMs > 0 ? String(Math.round(ap.iasTargetMs * MS_TO_KT)).padStart(3, '0') : '---';
    win(40, 'SPD', spd, ap.iasTargetMs <= 0);
    win(240, 'HDG', String(Math.round(wrap360(ap.headingBugDeg)) || 360).padStart(3, '0'), false);
    win(780, 'ALT', String(Math.round(ap.altitudeTargetM * M_TO_FT / 100) * 100).padStart(5, '0'), false);
    const vsFpm = Math.round(ap.verticalSpeedTargetMs * M_TO_FT * 60 / 100) * 100;
    const vsOn = ap.vertical === 'VS';
    win(980, 'V/S', vsOn ? (vsFpm >= 0 ? '+' : '−') + String(Math.abs(vsFpm)).padStart(4, '0') : '-----', !vsOn);
    // push buttons with their green bars
    const btn = (x: number, label: string, on: boolean) => {
      g.fillStyle = '#3a4048'; g.fillRect(x, 30, 96, 60);
      g.strokeStyle = '#15181c'; g.lineWidth = 3; g.strokeRect(x, 30, 96, 60);
      g.fillStyle = on ? C.green : '#1d2a20'; g.fillRect(x + 28, 40, 40, 6);
      g.font = F(20); g.fillStyle = C.white; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x + 48, 68);
    };
    const loc = ap.lateral === 'LOC' || ap.lateral === 'APR' || ap.armedLateral === 'LOC' || ap.armedLateral === 'APR';
    const appr = ap.vertical === 'GS' || ap.armedVertical === 'GS';
    btn(440, 'LOC', loc && !appr);
    btn(550, 'AP1', ap.engaged);
    btn(660, 'A/THR', this.extras.athrEngaged);
    btn(1180, 'APPR', appr);
    btn(1290, 'FD', ap.flightDirector);
    // baro
    label3(g, 'QNH', 1460, 22);
    g.fillStyle = '#0a0b0c'; g.fillRect(1400, 34, 120, 52);
    const std = Math.abs(ac.qnhSetPa - 101325) < 5;
    g.font = F(30); g.fillStyle = '#ffb84a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(std ? 'Std' : String(Math.round(ac.qnhSetPa / 100)), 1460, 61);
  }

  // ───────────────────────────── PFD ─────────────────────────────

  private drawPfd(g: Ctx2D, s: SimSnapshot): void {
    const ac = s.aircraft, ap = s.autopilot;
    const ias = ac.aero.ias * MS_TO_KT;
    this.drawFma(g, s);
    // attitude
    const cx = 256, cy = 236, phi = ac.euler[0], theta = ac.euler[1] * RAD, k = 7;
    g.save();
    g.beginPath(); g.rect(116, 86, 280, 300); g.clip();
    g.translate(cx, cy); g.rotate(-phi);
    const hy = theta * k;
    g.fillStyle = C.sky; g.fillRect(-400, -600 + hy, 800, 600);
    g.fillStyle = C.ground; g.fillRect(-400, hy, 800, 600);
    g.strokeStyle = C.white; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-400, hy); g.lineTo(400, hy); g.stroke();
    g.font = F(16); g.fillStyle = C.white; g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const y = hy - p * k, major = p % 10 === 0, mid = p % 5 === 0;
      if (Math.abs(y) > 150) continue;
      const w = major ? 50 : mid ? 26 : 12;
      g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
      if (major) { g.textAlign = 'right'; g.fillText(String(Math.abs(p)), -w - 6, y); g.textAlign = 'left'; g.fillText(String(Math.abs(p)), w + 6, y); }
    }
    g.restore();
    // bank scale and pointer
    g.save();
    g.translate(cx, cy);
    g.strokeStyle = C.white; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, 130, (-90 - 45) * DEG, (-90 + 45) * DEG); g.stroke();
    for (const b of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const a = (b - 90) * DEG, r1 = 130, r2 = b % 30 === 0 || b === 0 ? 144 : 138;
      g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); g.stroke();
    }
    g.rotate(-phi);
    g.fillStyle = C.yellow;
    g.beginPath(); g.moveTo(0, -128); g.lineTo(-10, -112); g.lineTo(10, -112); g.closePath(); g.fill();
    // sideslip index
    const beta = clamp(ac.aero.beta * RAD * 3, -24, 24);
    g.fillRect(-10 + beta, -108, 20, 5);
    g.restore();
    // flight-director bars (green)
    if (ap.flightDirector || ap.engaged) {
      const fx = clamp((ap.fdRollRad - phi) * RAD * 3, -90, 90), fy = clamp(-(ap.fdPitchRad * RAD - theta) * k, -120, 120);
      g.strokeStyle = C.green; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx + fx, cy - 90); g.lineTo(cx + fx, cy + 90); g.stroke();
      g.beginPath(); g.moveTo(cx - 90, cy + fy); g.lineTo(cx + 90, cy + fy); g.stroke();
    }
    // aircraft symbol
    g.fillStyle = '#000'; g.strokeStyle = C.yellow; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - 110, cy); g.lineTo(cx - 50, cy); g.lineTo(cx - 50, cy + 14); g.stroke();
    g.beginPath(); g.moveTo(cx + 110, cy); g.lineTo(cx + 50, cy); g.lineTo(cx + 50, cy + 14); g.stroke();
    g.fillStyle = C.yellow; g.fillRect(cx - 5, cy - 5, 10, 10);

    this.drawSpeedTape(g, s, ias);
    this.drawAltTape(g, s);
    this.drawVs(g, s);
    this.drawHeading(g, s);
    // ILS deviation (localizer / glideslope) when tuned
    const n = s.nav1;
    if (n.valid && n.isLocalizer) {
      const loc = clamp(n.cdi * 2.5, -2.5, 2.5), gs = n.gsValid ? clamp(-n.gsDeviation * 2.5, -2.5, 2.5) : null;
      g.fillStyle = C.magenta;
      diamond(g, cx + loc * 40, 392, 9);
      if (gs !== null) diamond(g, 408, cy + gs * 40, 9);
      g.font = F(16); g.fillStyle = C.magenta; g.textAlign = 'left';
      g.fillText(n.ident || 'ILS', 12, 486);
    }
    // altitude above ground (radio altimeter) below 2,500 ft
    const ra = ac.altitudeAglM * M_TO_FT;
    if (ra < 2500 && !ac.onGround) {
      g.font = F(26); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = ra < 400 ? C.amber : C.green;
      g.fillText(String(Math.max(0, Math.round(ra / 10) * 10)), cx, 360);
    }
  }

  private drawFma(g: Ctx2D, s: SimSnapshot): void {
    const ap = s.autopilot, ac = s.aircraft, x = this.extras;
    g.strokeStyle = C.grey; g.lineWidth = 2;
    for (const cx of [100, 200, 300, 400]) { g.beginPath(); g.moveTo(cx, 6); g.lineTo(cx, 70); g.stroke(); }
    g.beginPath(); g.moveTo(8, 74); g.lineTo(504, 74); g.stroke();
    g.font = F(19); g.textAlign = 'center'; g.textBaseline = 'middle';
    const box = (col: number, row: number, text: string, color: string, boxed = false) => {
      if (!text) return;
      const cx = 50 + col * 100, cy = 18 + row * 22;
      g.fillStyle = color; g.fillText(text, cx, cy);
      if (boxed) { g.strokeStyle = C.white; g.lineWidth = 1.5; g.strokeRect(cx - 46, cy - 11, 92, 22); }
    };
    // column 1: A/THR
    if (x.athrMode !== 'OFF') {
      const m = x.athrMode === 'SPEED' ? 'SPEED' : x.athrMode === 'A.FLOOR' ? 'A.FLOOR' : x.athrMode === 'RETARD' ? 'RETARD' : x.athrMode;
      box(0, 0, m, x.athrMode === 'A.FLOOR' ? C.amber : C.green, x.athrMode === 'A.FLOOR');
    }
    // column 2: vertical, armed below in cyan
    const climbing = ap.altitudeTargetM > ac.altitudeMslM;
    const vs = Math.round(ap.verticalSpeedTargetMs * M_TO_FT * 60 / 100) * 100;
    const vert: Record<string, string> = {
      OFF: '', PIT: '', ALT: 'ALT', ALTS: 'ALT*', VS: `V/S ${vs >= 0 ? '+' : ''}${vs}`, FLC: climbing ? 'OP CLB' : 'OP DES', GS: 'G/S',
    };
    if (ap.engaged || ap.flightDirector) box(1, 0, vert[ap.vertical] ?? '', C.green);
    if (ap.armedVertical) box(1, 1, ap.armedVertical === 'GS' ? 'G/S' : 'ALT', C.cyan);
    // column 3: lateral
    const lat: Record<string, string> = { OFF: '', ROL: '', HDG: 'HDG', NAV: 'NAV', GPS: 'NAV', LOC: 'LOC', APR: 'LOC' };
    if (ap.engaged || ap.flightDirector) box(2, 0, lat[ap.lateral] ?? '', C.green);
    if (ap.armedLateral) box(2, 1, lat[ap.armedLateral] || ap.armedLateral, C.cyan);
    // column 4: approach capability
    if (ap.vertical === 'GS' || ap.armedVertical === 'GS') box(3, 0, 'CAT 1', C.white);
    // column 5: engagement
    box(4, 0, ap.engaged ? 'AP1' : '', C.white);
    box(4, 1, ap.flightDirector ? '1 FD 2' : '', C.white);
    box(4, 2, x.athrEngaged ? 'A/THR' : '', C.white);
  }

  private drawSpeedTape(g: Ctx2D, s: SimSnapshot, ias: number): void {
    const ac = s.aircraft, ap = s.autopilot, L = this.lim;
    const x = 16, w = 84, top = 86, bottom = 386, mid = (top + bottom) / 2, k = 3.6;
    const shown = Math.max(30, ias);
    g.fillStyle = C.tape; g.fillRect(x, top, w, bottom - top);
    g.save(); g.beginPath(); g.rect(x, top, w + 20, bottom - top); g.clip();
    const y = (kt: number) => mid - (kt - shown) * k;
    // VMAX barber pole and VLS amber strip
    const flapIdx = s.inputs.flapsIndex;
    const gearDown = ac.gear.some((w0) => w0.extension > 0.05) && L.vleKt < L.vmoKt;
    let vmax = L.vmoKt;
    if (flapIdx > 0 && L.vfeKt.length) vmax = Math.min(vmax, L.vfeKt[Math.min(flapIdx - 1, L.vfeKt.length - 1)]);
    if (gearDown) vmax = Math.min(vmax, L.vleKt);
    for (let v = vmax; v < vmax + 200; v += 8) { g.fillStyle = Math.floor((v - vmax) / 8) % 2 ? '#000' : C.red; g.fillRect(x + w - 10, y(v + 8), 10, 8 * k); }
    const frac = L.flapDetents > 1 ? flapIdx / (L.flapDetents - 1) : 0;
    const vs = (L.vs1Kt + (L.vsoKt - L.vs1Kt) * frac) * Math.sqrt(clamp(ac.totalMassKg / L.mtowKg, 0.4, 1.2));
    if (!ac.onGround) {
      const vls = vs * 1.23;
      g.fillStyle = C.amber; g.fillRect(x + w - 6, y(vls), 4, (vls - vs * 1.1) * k);
      for (let v = vs * 1.1; v > 0; v -= 8) { g.fillStyle = Math.floor(v / 8) % 2 ? '#000' : C.red; g.fillRect(x + w - 10, y(v), 10, 8 * k); }
    }
    g.strokeStyle = C.white; g.lineWidth = 2; g.font = F(20); g.fillStyle = C.white; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = Math.floor((shown - 50) / 10) * 10; v <= shown + 50; v += 10) {
      if (v < 30) continue;
      const yy = y(v);
      g.beginPath(); g.moveTo(x + w - 14, yy); g.lineTo(x + w, yy); g.stroke();
      if (v % 20 === 0) g.fillText(String(v), x + w - 18, yy);
    }
    // selected speed: cyan triangle (magenta would be managed)
    if (ap.iasTargetMs > 0) {
      const ty = clamp(y(ap.iasTargetMs * MS_TO_KT), top + 4, bottom - 4);
      g.strokeStyle = C.cyan; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x + w, ty); g.lineTo(x + w + 14, ty - 9); g.lineTo(x + w + 14, ty + 9); g.closePath(); g.stroke();
    }
    // speed trend arrow
    if (Math.abs(this.trendKt) > 2 && !ac.onGround) {
      const ty = mid - clamp(this.trendKt, -60, 60) * k;
      g.strokeStyle = C.yellow; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x + w - 20, mid); g.lineTo(x + w - 20, ty); g.stroke();
      const d = this.trendKt > 0 ? 8 : -8;
      g.beginPath(); g.moveTo(x + w - 28, ty + d); g.lineTo(x + w - 20, ty); g.lineTo(x + w - 12, ty + d); g.stroke();
    }
    g.restore();
    // reference line
    g.fillStyle = C.yellow; g.fillRect(x + w - 30, mid - 2, 44, 4);
    if (ap.iasTargetMs > 0 && Math.abs(ap.iasTargetMs * MS_TO_KT - shown) > 300 / 2 / k) {
      const ly = ap.iasTargetMs * MS_TO_KT > shown ? top + 14 : bottom - 14;
      g.fillStyle = '#000'; g.fillRect(x + 1, ly - 12, w - 2, 24);
      g.font = F(20); g.fillStyle = C.cyan; g.textAlign = 'center';
      g.fillText(String(Math.round(ap.iasTargetMs * MS_TO_KT)), x + w / 2, ly);
    }
    // Mach below 0.5 is not shown
    if (ac.aero.mach >= 0.5) { g.font = F(20); g.fillStyle = C.green; g.textAlign = 'center'; g.fillText('.' + String(Math.round(ac.aero.mach * 1000)).padStart(3, '0').slice(0, 3), x + w / 2, bottom + 34); }
    g.strokeStyle = C.white; g.lineWidth = 2; g.strokeRect(x, top, w, bottom - top);
  }

  private drawAltTape(g: Ctx2D, s: SimSnapshot): void {
    const ac = s.aircraft, ap = s.autopilot;
    const alt = ac.altitudeIndicatedM * M_TO_FT;
    const x = 404, w = 64, top = 86, bottom = 386, mid = (top + bottom) / 2, k = 0.12;
    g.fillStyle = C.tape; g.fillRect(x, top, w, bottom - top);
    g.save(); g.beginPath(); g.rect(x - 16, top, w + 16, bottom - top); g.clip();
    const y = (ft: number) => mid - (ft - alt) * k;
    g.strokeStyle = C.white; g.lineWidth = 2; g.font = F(20); g.fillStyle = C.white; g.textAlign = 'left'; g.textBaseline = 'middle';
    for (let a = Math.floor((alt - 1400) / 100) * 100; a <= alt + 1400; a += 100) {
      const yy = y(a);
      g.beginPath(); g.moveTo(x, yy); g.lineTo(x + (a % 500 === 0 ? 14 : 8), yy); g.stroke();
      if (a % 500 === 0) g.fillText(String(Math.round(a / 100)).padStart(3, '0'), x + 18, yy);
    }
    // selected altitude (cyan) and ground (red ribbon)
    const tgt = ap.altitudeTargetM * M_TO_FT;
    const ty = clamp(y(tgt), top + 6, bottom - 6);
    g.strokeStyle = C.cyan; g.lineWidth = 3; g.strokeRect(x + 2, ty - 12, 14, 24);
    const gnd = (ac.altitudeIndicatedM - ac.altitudeAglM) * M_TO_FT;
    if (y(gnd) < bottom) { g.fillStyle = C.red; g.fillRect(x, y(gnd), 6, bottom - y(gnd)); }
    g.restore();
    if (Math.abs(tgt - alt) * k > (bottom - top) / 2) {
      const ly = tgt > alt ? top + 14 : bottom - 14;
      g.fillStyle = '#000'; g.fillRect(x + 1, ly - 12, w - 2, 24);
      g.font = F(20); g.fillStyle = C.cyan; g.textAlign = 'center';
      g.fillText(String(Math.round(tgt / 100) * 100), x + w / 2, ly);
    }
    // current altitude window
    g.fillStyle = '#000'; g.fillRect(x - 4, mid - 20, w + 8, 40);
    g.strokeStyle = C.yellow; g.lineWidth = 2; g.strokeRect(x - 4, mid - 20, w + 8, 40);
    g.font = F(26); g.fillStyle = C.green; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(String(Math.round(alt / 20) * 20), x + w, mid);
    g.strokeStyle = C.white; g.lineWidth = 2; g.strokeRect(x, top, w, bottom - top);
    // baro
    const std = Math.abs(ac.qnhSetPa - 101325) < 5;
    g.font = F(18); g.fillStyle = C.cyan; g.textAlign = 'center';
    g.fillText(std ? 'STD' : 'QNH ' + Math.round(ac.qnhSetPa / 100), x + w / 2, bottom + 34);
  }

  private drawVs(g: Ctx2D, s: SimSnapshot): void {
    const fpm = s.aircraft.verticalSpeedMs * M_TO_FT * 60;
    const x = 474, top = 110, bottom = 362, mid = (top + bottom) / 2, h = (bottom - top) / 2;
    g.fillStyle = C.tape; g.fillRect(x, top, 22, bottom - top);
    // non-linear: ±1,000 fpm uses 60 % of the half scale, up to ±6,000
    const pos = (v: number) => { const a = Math.abs(v); const f = a <= 1000 ? 0.6 * a / 1000 : 0.6 + 0.4 * Math.min(1, (a - 1000) / 5000); return mid - Math.sign(v) * f * h; };
    g.strokeStyle = C.white; g.lineWidth = 2;
    for (const v of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) { const yy = pos(v); g.beginPath(); g.moveTo(x, yy); g.lineTo(x + 6, yy); g.stroke(); }
    const color = Math.abs(fpm) > 6000 || (s.aircraft.altitudeAglM < 1000 * FT && fpm < -1200) ? C.amber : C.green;
    g.strokeStyle = color; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x + 22, mid); g.lineTo(x + 4, pos(fpm)); g.stroke();
    if (Math.abs(fpm) >= 200) {
      g.font = F(16); g.fillStyle = color; g.textAlign = 'center';
      g.fillText(String(Math.round(Math.abs(fpm) / 100)), x + 11, fpm > 0 ? top - 10 : bottom + 10);
    }
  }

  private drawHeading(g: Ctx2D, s: SimSnapshot): void {
    const hdg = s.aircraft.headingMagRad * RAD, bug = s.autopilot.headingBugDeg;
    const x0 = 116, x1 = 396, top = 432, cx = (x0 + x1) / 2, k = 7;
    g.fillStyle = C.tape; g.fillRect(x0, top, x1 - x0, 44);
    g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, 60); g.clip();
    g.strokeStyle = C.white; g.lineWidth = 2; g.font = F(18); g.fillStyle = C.white; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let d = Math.floor((hdg - 25) / 5) * 5; d <= hdg + 25; d += 5) {
      const xx = cx + (d - hdg) * k;
      g.beginPath(); g.moveTo(xx, top); g.lineTo(xx, top + (d % 10 === 0 ? 12 : 7)); g.stroke();
      if (d % 10 === 0) g.fillText(String(Math.round(wrap360(d) / 10) % 36), xx, top + 16);
    }
    // selected heading: cyan triangle
    let db = ((bug - hdg) % 360 + 540) % 360 - 180;
    db = clamp(db, -21, 21);
    g.fillStyle = C.cyan;
    g.beginPath(); g.moveTo(cx + db * k, top + 2); g.lineTo(cx + db * k - 8, top - 10 + 2); g.lineTo(cx + db * k + 8, top - 10 + 2); g.closePath(); g.fill();
    // track diamond
    const dt = ((s.aircraft.trackRad * RAD - s.aircraft.headingTrueRad * RAD) % 360 + 540) % 360 - 180;
    if (s.aircraft.groundSpeedMs > 15) { g.strokeStyle = C.green; diamondStroke(g, cx + clamp(dt, -20, 20) * k, top + 34, 6); }
    g.restore();
    g.fillStyle = C.yellow; g.fillRect(cx - 2, top - 8, 4, 22);
    g.strokeStyle = C.white; g.lineWidth = 2; g.strokeRect(x0, top, x1 - x0, 44);
  }

  // ───────────────────────────── ND ─────────────────────────────

  private drawNd(g: Ctx2D, s: SimSnapshot): void {
    const ac = s.aircraft, ap = s.autopilot;
    const cx = 256, cy = 420, R = 330, rangeNm = ac.altitudeAglM > 10_000 * FT ? 80 : 40, k = R / rangeNm;
    const hdgM = ac.headingMagRad * RAD, hdgT = ac.headingTrueRad * RAD, magVar = hdgT - hdgM;
    // compass arc
    g.save();
    g.strokeStyle = C.white; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, -150 * DEG, -30 * DEG); g.stroke();
    g.setLineDash([6, 10]);
    g.beginPath(); g.arc(cx, cy, R / 2, -150 * DEG, -30 * DEG); g.stroke();
    g.setLineDash([]);
    g.font = F(18); g.fillStyle = C.white; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let d = Math.ceil((hdgM - 60) / 5) * 5; d <= hdgM + 60; d += 5) {
      const a = (d - hdgM - 90) * DEG;
      const r2 = d % 10 === 0 ? R + 14 : R + 7;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
      if (d % 30 === 0) g.fillText(String(Math.round(wrap360(d) / 10) % 36), cx + Math.cos(a) * (R + 30), cy + Math.sin(a) * (R + 30));
    }
    g.fillStyle = C.cyan; g.font = F(16);
    g.fillText(String(rangeNm / 2), cx - R / 2 * 0.86 - 14, cy - R / 2 * 0.5);
    // heading bug (cyan) and track (green)
    const bugA = (((ap.headingBugDeg - hdgM) % 360 + 540) % 360 - 180);
    if (Math.abs(bugA) < 60) {
      const a = (bugA - 90) * DEG;
      g.fillStyle = C.cyan;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a - 0.03) * (R + 16), cy + Math.sin(a - 0.03) * (R + 16)); g.lineTo(cx + Math.cos(a + 0.03) * (R + 16), cy + Math.sin(a + 0.03) * (R + 16)); g.closePath(); g.fill();
    }
    // route (green line, TO waypoint white, the rest green)
    const plan = s.plan;
    g.beginPath(); g.rect(4, 70, DU - 8, cy - 70 + 40); g.clip();
    if (plan && plan.waypoints.length) {
      const pts = plan.waypoints.map((w) => project(ac.geo.lat, ac.geo.lon, w.position.lat, w.position.lon, hdgT, k));
      g.strokeStyle = C.green; g.lineWidth = 3;
      g.beginPath();
      for (let i = Math.max(0, plan.activeLeg - 1); i < pts.length; i++) { const p = pts[i]; if (i === Math.max(0, plan.activeLeg - 1)) g.moveTo(cx + p[0], cy + p[1]); else g.lineTo(cx + p[0], cy + p[1]); }
      g.stroke();
      g.font = F(17); g.textAlign = 'left';
      for (let i = Math.max(0, plan.activeLeg); i < pts.length; i++) {
        const p = pts[i], to = i === plan.activeLeg;
        g.strokeStyle = to ? C.white : C.green; g.fillStyle = to ? C.white : C.green;
        diamondStroke(g, cx + p[0], cy + p[1], 7);
        g.fillText(plan.waypoints[i].id, cx + p[0] + 12, cy + p[1] - 10);
      }
    }
    // ILS course when tuned
    const n = s.nav1;
    if (n.valid && n.isLocalizer) {
      const a = ((n.obsDeg - hdgM) - 90) * DEG;
      g.strokeStyle = C.magenta; g.lineWidth = 2; g.setLineDash([12, 8]);
      const off = clamp(n.cdi * 2.5, -2.5, 2.5) * 20;
      const px = -Math.sin(a) * off, py = Math.cos(a) * off;
      g.beginPath(); g.moveTo(cx + px - Math.cos(a) * 60, cy + py - Math.sin(a) * 60); g.lineTo(cx + px + Math.cos(a) * R, cy + py + Math.sin(a) * R); g.stroke();
      g.setLineDash([]);
    }
    g.restore();
    // aircraft symbol
    g.strokeStyle = C.yellow; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx, cy - 22); g.lineTo(cx, cy + 22); g.moveTo(cx - 22, cy - 6); g.lineTo(cx + 22, cy - 6); g.moveTo(cx - 9, cy + 18); g.lineTo(cx + 9, cy + 18); g.stroke();
    // lubber line
    g.fillStyle = C.yellow; g.fillRect(cx - 2, cy - R - 26, 4, 22);
    // top-left: GS, TAS, wind
    g.font = F(18); g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = C.white; g.fillText('GS', 14, 22); g.fillText('TAS', 96, 22);
    g.fillStyle = C.green; g.fillText(String(Math.round(ac.groundSpeedMs * MS_TO_KT)), 44, 22); g.fillText(String(Math.round(ac.aero.tas * MS_TO_KT)), 136, 22);
    const wn = ac.windNED[0], we = ac.windNED[1];
    const wSpd = Math.hypot(wn, we) * MS_TO_KT;
    const wFrom = wrap360(Math.atan2(-we, -wn) * RAD - magVar);
    g.fillText(`${String(Math.round(wFrom)).padStart(3, '0')}°/${Math.round(wSpd)}`, 14, 48);
    if (wSpd >= 2) {
      const a = (wFrom + 180 - hdgM - 90) * DEG;
      g.strokeStyle = C.green; g.lineWidth = 3;
      g.beginPath(); g.moveTo(40 - Math.cos(a) * 14, 80 - Math.sin(a) * 14); g.lineTo(40 + Math.cos(a) * 14, 80 + Math.sin(a) * 14); g.stroke();
    }
    // top-right: TO waypoint
    if (plan && plan.waypoints[plan.activeLeg]) {
      g.textAlign = 'right';
      g.fillStyle = C.white; g.fillText(plan.waypoints[plan.activeLeg].id, 496, 22);
      g.fillStyle = C.green; g.fillText(`${String(Math.round(wrap360(plan.bearingToActiveDeg - magVar))).padStart(3, '0')}°`, 420, 22);
      g.fillText(`${(plan.distanceToActiveM / NM).toFixed(plan.distanceToActiveM < 20 * NM ? 1 : 0)} NM`, 496, 48);
    }
    // bottom: NAV1 (left)
    g.textAlign = 'left'; g.fillStyle = C.white;
    g.fillText(n.isLocalizer ? 'ILS1' : 'VOR1', 14, 450);
    g.fillStyle = n.valid ? C.green : C.grey; g.fillText(n.ident || (n.activeKHz / 1000).toFixed(2), 14, 474);
  }

  // ───────────────────────────── E/WD ─────────────────────────────

  private drawEwd(g: Ctx2D, s: SimSnapshot): void {
    const ac = s.aircraft, en = ac.engine;
    const n1 = (en.n1 ?? 0) * 100;
    for (const cx of [128, 384]) {
      const cy = 110, r = 72;
      // dial: 0..110 % over 210°
      const a0 = 150 * DEG, span = 210 * DEG, ang = (v: number) => a0 + span * clamp(v, 0, 110) / 110;
      g.strokeStyle = C.white; g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, r, a0, ang(101)); g.stroke();
      g.strokeStyle = C.red; g.beginPath(); g.arc(cx, cy, r, ang(101), ang(110)); g.stroke();
      g.font = F(16); g.fillStyle = C.white; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const v of [50, 60, 70, 80, 90, 100]) {
        const a = ang(v);
        g.strokeStyle = C.white; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
        if (v === 50 || v === 100) g.fillText(String(v / 10), cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24));
      }
      // commanded N1 (autothrust lever) as a cyan arc tip
      if (this.extras.athrEngaged && this.extras.athrLever !== undefined) {
        const a = ang(20 + 80 * this.extras.athrLever);
        g.fillStyle = C.cyan; g.beginPath(); g.arc(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6), 5, 0, Math.PI * 2); g.fill();
      }
      const a = ang(n1);
      g.strokeStyle = en.running ? C.green : C.amber; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); g.stroke();
      g.fillStyle = '#000'; g.fillRect(cx - 10, cy + 12, 84, 34);
      g.strokeStyle = C.grey; g.lineWidth = 2; g.strokeRect(cx - 10, cy + 12, 84, 34);
      g.font = F(28); g.fillStyle = C.green; g.textAlign = 'right';
      g.fillText(n1.toFixed(1), cx + 68, cy + 30);
      // EGT
      const egtC = en.egtK - 273.15;
      g.font = F(22); g.textAlign = 'center';
      g.fillStyle = egtC > 950 ? C.red : egtC > 900 ? C.amber : C.green;
      g.fillText(String(Math.round(egtC / 5) * 5), cx, 214);
      // fuel flow per engine (kg/h)
      g.fillStyle = C.green; g.fillText(String(Math.round(en.fuelFlowKgS * 3600 / 2 / 20) * 20), cx, 262);
    }
    g.font = F(18); g.fillStyle = C.white; g.textAlign = 'center';
    g.fillText('N1', 256, 110); g.fillStyle = C.cyan; g.fillText('%', 256, 132);
    g.fillStyle = C.white; g.fillText('EGT', 256, 206); g.fillStyle = C.cyan; g.fillText('°C', 256, 226);
    g.fillStyle = C.white; g.fillText('FF', 256, 254); g.fillStyle = C.cyan; g.fillText('KG/H', 256, 274);
    // thrust limit / mode
    g.textAlign = 'right'; g.font = F(20);
    const lever = s.inputs.throttle;
    const limit = lever > 0.97 ? 'TOGA' : lever > 0.85 ? 'CLB' : '';
    if (limit) { g.fillStyle = C.cyan; g.fillText(limit, 500, 24); }
    // fuel on board
    const fob = ac.fuelKg.reduce((a, b) => a + b, 0);
    g.textAlign = 'left'; g.fillStyle = C.white; g.fillText('FOB :', 16, 316);
    g.fillStyle = C.green; g.fillText(`${Math.round(fob / 10) * 10} KG`, 84, 316);
    // flaps / slats
    const fl = s.inputs.flapsIndex, flapDeg = ac.surfaces.flapDeg;
    g.fillStyle = C.white; g.textAlign = 'center'; g.fillText('S', 300, 300); g.fillText('F', 470, 300);
    g.strokeStyle = C.green; g.lineWidth = 4;
    const ext = clamp(flapDeg / 35, 0, 1);
    g.beginPath(); g.moveTo(370, 300); g.lineTo(370 - 50 * Math.min(1, ext * 2), 300 + 16 * Math.min(1, ext * 2)); g.stroke();
    g.beginPath(); g.moveTo(400, 300); g.lineTo(400 + 60 * ext, 300 + 22 * ext); g.stroke();
    g.fillStyle = C.white; g.fillRect(370, 294, 30, 10);
    const flapLabel = ['', '1', '2', '3', 'FULL'][fl] ?? String(fl);
    if (fl > 0) { g.fillStyle = Math.abs(flapDeg - (this.flapTarget(fl))) > 1 ? C.cyan : C.green; g.font = F(22); g.fillText(flapLabel, 385, 344); }
    // memo: gear, speedbrake, autobrake
    g.font = F(19); g.textAlign = 'left';
    let y = 392;
    const memo = (t: string, c: string) => { g.fillStyle = c; g.fillText(t, 20, y); y += 26; };
    const gearExt = ac.gear.length ? Math.max(...ac.gear.map((w) => w.extension)) : 1;
    if (gearExt > 0.99) memo('LDG GEAR DN', C.green); else if (gearExt > 0.01) memo('LDG GEAR TRANSIT', C.amber); else memo('LDG GEAR UP', C.white);
    if (ac.surfaces.speedbrake > 0.02) memo(ac.onGround ? 'GND SPLRS' : 'SPEED BRK', ac.onGround ? C.green : C.amber);
    if (s.inputs.parkingBrake) memo('PARK BRK', C.green);
    if (!en.running) memo('ENG SHUT DOWN', C.amber);
    if (ac.warnings.overspeed) memo('OVERSPEED', C.red);
    if (ac.warnings.stall) memo('STALL', C.red);
    if (ac.surfaces.speedbrake < 0.02 && s.inputs.speedbrake > 0) memo('SPLRS ARM', C.green);
    // right column: GW, SAT
    g.textAlign = 'right'; g.fillStyle = C.white;
    g.fillText('GW', 430, 392); g.fillText('SAT', 430, 418);
    g.fillStyle = C.green;
    g.fillText(`${Math.round(ac.totalMassKg / 100) * 100}`, 500, 392);
    g.fillText(`${Math.round(ac.atmosphere.temperatureK - 273.15)}°C`, 500, 418);
  }

  private flapTarget(idx: number): number { return [0, 10, 15, 20, 35][idx] ?? 0; }
}

function label3(g: Ctx2D, t: string, x: number, y: number): void {
  g.font = F(18); g.fillStyle = C.white; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y);
}

function diamond(g: Ctx2D, x: number, y: number, r: number): void {
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill();
}

function diamondStroke(g: Ctx2D, x: number, y: number, r: number): void {
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.stroke();
}

/** Waypoint → ND pixels: flat-earth nm from the aircraft, rotated heading-up (x right, y down). */
function project(lat0: number, lon0: number, lat: number, lon: number, hdgTrueDeg: number, pxPerNm: number): [number, number] {
  const n = (lat - lat0) * 60, e = (((lon - lon0 + 540) % 360) - 180) * 60 * Math.cos(lat0 * DEG);
  const h = hdgTrueDeg * DEG, c = Math.cos(h), s = Math.sin(h);
  const right = e * c - n * s, fwd = n * c + e * s;
  return [right * pxPerNm, -fwd * pxPerNm];
}
