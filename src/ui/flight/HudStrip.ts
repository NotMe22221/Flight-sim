/** Top-centre flight info strip (shown outside the cockpit, doc 05 §6). Values quantised; change-only writes. */
import type { SimSnapshot } from '../../core/types';
import type { UnitsSettings } from '../UiHost';
import { Cls, Txt, h } from '../dom';
import { KT_PER_MS, formatAltitude, formatHeading, formatSpeed, formatVerticalSpeed, formatWind, normalizeHeading } from '../format';

const R2D = 180 / Math.PI;

export class HudStrip {
  readonly el: HTMLElement;
  enabled = true;
  private cells: Record<string, Txt> = {};
  private visible: Cls;
  private apCls: Cls; private stallCls: Cls;

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

  update(s: SimSnapshot, units: UnitsSettings): void {
    const show = this.enabled && s.camera.mode !== 'cockpit';
    this.visible.set(show);
    if (!show) return;
    const a = s.aircraft;
    this.cells.ias.set(formatSpeed(Math.round(a.aero.ias * KT_PER_MS) / KT_PER_MS, units));
    this.cells.alt.set(formatAltitude(a.altitudeIndicatedM, units, units.altitude === 'ft' ? 10 : 5));
    this.cells.hdg.set(formatHeading(a.headingMagRad * R2D));
    this.cells.vs.set(formatVerticalSpeed(Math.round(a.verticalSpeedMs * 2) / 2, units));
    const wn = a.windNED[0], we = a.windNED[1];
    const wkt = Math.hypot(wn, we) * KT_PER_MS;
    const wdir = normalizeHeading(Math.atan2(-we, -wn) * R2D);
    this.cells.wind.set(formatWind(Math.round(wdir / 5) * 5, Math.round(wkt)));
    this.cells.thr.set(`${Math.round(s.inputs.throttle * 20) * 5}%`);
    this.cells.flaps.set(`${Math.round(a.surfaces.flapDeg)}°`);
    const ap = s.autopilot;
    const apOn = ap.engaged || ap.flightDirector;
    this.apCls.set(!apOn);
    if (apOn) this.cells.ap.set(`${ap.engaged ? 'AP' : 'FD'} ${ap.lateral !== 'OFF' ? ap.lateral : ''} ${ap.vertical !== 'OFF' ? ap.vertical : ''}`.replace(/\s+/g, ' ').trim());
    const w = a.warnings;
    const warnTxt = w.stall ? 'STALL' : w.overspeed ? 'OVERSPEED' : w.overG ? 'OVER-G' : w.flapOverspeed ? 'FLAPS' : w.gearOverspeed ? 'GEAR' : w.lowFuel ? 'LOW FUEL' : '';
    this.stallCls.set(warnTxt === '');
    if (warnTxt) this.cells.warn.set(warnTxt);
  }
}
