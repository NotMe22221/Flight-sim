/** Top-centre flight info strip (shown outside the cockpit, doc 05 §6). Values quantised; change-only writes. */
import type { SimSnapshot } from '../../core/types';
import type { UnitsSettings } from '../UiHost';
import { Cls, Txt, h } from '../dom';
import { KT_PER_MS, altitudeValue, formatAltitude, formatHeading, formatSpeed, formatVerticalSpeed, formatWind, normalizeHeading, speedValue } from '../format';

const R2D = 180 / Math.PI;

export class HudStrip {
  readonly el: HTMLElement;
  enabled = true;
  private cells: Record<string, Txt> = {};
  private visible: Cls;
  private apCls: Cls; private stallCls: Cls;
  /** last displayed quantised values: ias, alt, hdg, vs, wind kt, wind dir, throttle, flaps */
  private q = new Float64Array(8).fill(Number.NaN);
  private lastUnits: UnitsSettings | null = null;
  private lastAp = { engaged: false, lateral: '', vertical: '' };

  constructor(layer: HTMLElement) {
    const mk = (k: string, label: string, cls = '') => {
      const v = h('span', { class: 'hud-v', text: '--' });
      const c = h('div', { class: `hud-cell ${cls}`.trim() }, h('span', { class: 'hud-k', text: label }), v);
      this.cells[k] = new Txt(v, '--');
      return c;
    };
    const ap = mk('ap', 'AP', 'hud-ap');
    const warn = mk('warn', 'WARN', 'hud-warn');
    this.el = h('div', { class: 'panel hud-strip', aria: { label: 'Flight information' } },
      mk('ias', 'IAS'), mk('alt', 'ALT'), mk('hdg', 'HDG'), mk('vs', 'VS'), mk('wind', 'WIND'), mk('thr', 'THR'), mk('flaps', 'FLAPS'), ap, warn);
    this.visible = new Cls(this.el, 'visible');
    this.apCls = new Cls(ap, 'hidden'); this.stallCls = new Cls(warn, 'hidden');
    layer.appendChild(this.el);
  }

  /**
   * Every frame in external views. Values are quantised to what the strip displays and formatted only
   * when that changes, so a steady flight allocates no strings (the HUD plugin may also hide the strip
   * with CSS while this still runs).
   */
  update(s: SimSnapshot, units: UnitsSettings): void {
    const show = this.enabled && s.camera.mode !== 'cockpit';
    this.visible.set(show);
    if (!show) return;
    if (units !== this.lastUnits) { this.lastUnits = units; this.q.fill(Number.NaN); }
    const a = s.aircraft;
    const q = this.q;
    const ias = Math.round(speedValue(a.aero.ias, units));
    if (ias !== q[0]) { q[0] = ias; this.cells.ias.set(formatSpeed(Math.round(a.aero.ias * KT_PER_MS) / KT_PER_MS, units)); }
    const altStep = units.altitude === 'ft' ? 10 : 5;
    const alt = Math.round(altitudeValue(a.altitudeIndicatedM, units) / altStep);
    if (alt !== q[1]) { q[1] = alt; this.cells.alt.set(formatAltitude(a.altitudeIndicatedM, units, altStep)); }
    const hdg = Math.round(normalizeHeading(a.headingMagRad * R2D));
    if (hdg !== q[2]) { q[2] = hdg; this.cells.hdg.set(formatHeading(hdg)); }
    const vsHalf = Math.round(a.verticalSpeedMs * 2);
    if (vsHalf !== q[3]) { q[3] = vsHalf; this.cells.vs.set(formatVerticalSpeed(vsHalf / 2, units)); }
    const wn = a.windNED[0], we = a.windNED[1];
    const wkt = Math.round(Math.hypot(wn, we) * KT_PER_MS);
    const wdir = Math.round(normalizeHeading(Math.atan2(-we, -wn) * R2D) / 5) * 5;
    if (wkt !== q[4] || wdir !== q[5]) { q[4] = wkt; q[5] = wdir; this.cells.wind.set(formatWind(wdir, wkt)); }
    const thr = Math.round(s.inputs.throttle * 20) * 5;
    if (thr !== q[6]) { q[6] = thr; this.cells.thr.set(`${thr}%`); }
    const flaps = Math.round(a.surfaces.flapDeg);
    if (flaps !== q[7]) { q[7] = flaps; this.cells.flaps.set(`${flaps}°`); }
    const ap = s.autopilot;
    const apOn = ap.engaged || ap.flightDirector;
    this.apCls.set(!apOn);
    if (apOn && (ap.engaged !== this.lastAp.engaged || ap.lateral !== this.lastAp.lateral || ap.vertical !== this.lastAp.vertical)) {
      this.lastAp.engaged = ap.engaged; this.lastAp.lateral = ap.lateral; this.lastAp.vertical = ap.vertical;
      this.cells.ap.set(`${ap.engaged ? 'AP' : 'FD'} ${ap.lateral !== 'OFF' ? ap.lateral : ''} ${ap.vertical !== 'OFF' ? ap.vertical : ''}`.replace(/\s+/g, ' ').trim());
    }
    const w = a.warnings;
    const warnTxt = w.stall ? 'STALL' : w.overspeed ? 'OVERSPEED' : w.overG ? 'OVER-G' : w.flapOverspeed ? 'FLAPS' : w.gearOverspeed ? 'GEAR' : w.lowFuel ? 'LOW FUEL' : '';
    this.stallCls.set(warnTxt === '');
    if (warnTxt) this.cells.warn.set(warnTxt);
  }
}
