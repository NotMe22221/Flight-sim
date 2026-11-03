/**
 * Top-centre flight info strip (shown outside the cockpit, doc 05 §6). Values quantised; change-only
 * writes. The AP cell follows the GFC 700 status bar (apAnnunciator.ts): lateral mode · AP · vertical
 * mode, armed modes in white, LVL in both fields, a 5 s flashing AP after a disconnect; the ALT cell
 * carries the altitude alerter (cyan while approaching the selected altitude, amber on a deviation).
 */
import type { SimSnapshot } from '../../core/types';
import type { UnitsSettings } from '../UiHost';
import { ApAnnunciator, annunciationTitle, emptyAnnunciation, type ApAnnunciation } from '../apAnnunciator';
import { Cls, Txt, h } from '../dom';
import { KT_PER_MS, altitudeValue, formatAltitude, formatHeading, formatSpeed, formatVerticalSpeed, formatWind, groupThousands, normalizeHeading, roundTo, speedValue } from '../format';

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
  /** disconnect watch: fed every frame, also while the strip is hidden (cockpit view) */
  readonly annunciator = new ApAnnunciator();
  private ann = emptyAnnunciation();
  private shown = emptyAnnunciation();
  private apCell: HTMLElement;
  private apKey: Txt;
  private apLat: Txt; private apLatArm: Txt; private apStatus: Txt; private apVer: Txt; private apVerArm: Txt;
  private altCell: HTMLElement;
  private altKey: Txt;
  private lastAltAlert = 'none';
  private lastAltTarget = Number.NaN;

  constructor(layer: HTMLElement) {
    const mk = (k: string, label: string, cls = '') => {
      const v = h('span', { class: 'hud-v', text: '--' });
      const c = h('div', { class: `hud-cell ${cls}`.trim() }, h('span', { class: 'hud-k', text: label }), v);
      this.cells[k] = new Txt(v, '--');
      return c;
    };
    const span = (cls: string) => new Txt(h('span', { class: cls }), '');
    this.apKey = new Txt(h('span', { class: 'hud-k' }), 'AP');
    this.apLat = span('ap-mode'); this.apLatArm = span('ap-arm');
    this.apStatus = span('ap-st');
    this.apVer = span('ap-mode'); this.apVerArm = span('ap-arm');
    const ap = h('div', { class: 'hud-cell hud-ap' }, this.apKey.el,
      h('span', { class: 'hud-v ap-row' }, this.apLat.el, this.apLatArm.el, this.apStatus.el, this.apVer.el, this.apVerArm.el));
    this.apCell = ap;
    const warn = mk('warn', 'WARN', 'hud-warn');
    this.altCell = mk('alt', 'ALT');
    this.altKey = new Txt(this.altCell.firstElementChild as HTMLElement, 'ALT');
    this.el = h('div', { class: 'panel hud-strip', aria: { label: 'Flight information' } },
      mk('ias', 'IAS'), this.altCell, mk('hdg', 'HDG'), mk('vs', 'VS'), mk('wind', 'WIND'), mk('thr', 'THR'), mk('flaps', 'FLAPS'), ap, warn);
    this.visible = new Cls(this.el, 'visible');
    this.apCls = new Cls(ap, 'hidden'); this.stallCls = new Cls(warn, 'hidden');
    layer.appendChild(this.el);
  }

  /** A new flight, or the flight view comes back: an older disconnect must not flash. */
  rebase(): void { this.annunciator.rebase(); }

  /**
   * Every frame in external views. Values are quantised to what the strip displays and formatted only
   * when that changes, so a steady flight allocates no strings (the HUD plugin may also hide the strip
   * with CSS while this still runs).
   */
  update(s: SimSnapshot, units: UnitsSettings, nowMs = 0): void {
    this.annunciator.observe(s.autopilot, nowMs);
    const show = this.enabled && s.camera.mode !== 'cockpit';
    this.visible.set(show);
    if (!show) return;
    if (units !== this.lastUnits) { this.lastUnits = units; this.q.fill(Number.NaN); this.lastAltTarget = Number.NaN; }
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
    this.renderAp(this.annunciator.read(s.autopilot, nowMs, this.ann), s.autopilot.altitudeTargetM, units);
    const w = a.warnings;
    const warnTxt = w.stall ? 'STALL' : w.overspeed ? 'OVERSPEED' : w.overG ? 'OVER-G' : w.flapOverspeed ? 'FLAPS' : w.gearOverspeed ? 'GEAR' : w.lowFuel ? 'LOW FUEL' : '';
    this.stallCls.set(warnTxt === '');
    if (warnTxt) this.cells.warn.set(warnTxt);
  }

  /** Change-only DOM writes for the AP cell and the ALT cell's alerter state. */
  private renderAp(a: ApAnnunciation, selectedAltM: number, units: UnitsSettings): void {
    const p = this.shown;
    this.apCls.set(!a.visible);
    if (a.altAlert !== this.lastAltAlert || (a.altAlert !== 'none' && selectedAltM !== this.lastAltTarget)) {
      // a new alert class (re)starts its 5 s flash; the key names the selected altitude meanwhile
      if (a.altAlert !== this.lastAltAlert) {
        this.altCell.classList.remove('alt-approach', 'alt-deviation');
        if (a.altAlert !== 'none') this.altCell.classList.add(`alt-${a.altAlert}`);
      }
      this.lastAltAlert = a.altAlert;
      this.lastAltTarget = selectedAltM;
      // the flashing element is the selected altitude, as on the G1000 (the value below stays the current one)
      this.altKey.set(a.altAlert === 'none' ? 'ALT' : `SEL ${groupThousands(roundTo(altitudeValue(selectedAltM, units), units.altitude === 'm' ? 5 : 10))}`);
    }
    if (!a.visible) { p.visible = false; return; }
    if (p.visible && a.status === p.status && a.statusTone === p.statusTone && a.lateral === p.lateral && a.vertical === p.vertical &&
      a.armedLateral === p.armedLateral && a.armedVertical === p.armedVertical && a.reason === p.reason && a.altAlert === p.altAlert) return;
    const toneChanged = a.statusTone !== p.statusTone || !p.visible;
    Object.assign(p, a);
    this.apLat.set(a.lateral); this.apLatArm.set(a.armedLateral);
    this.apVer.set(a.vertical); this.apVerArm.set(a.armedVertical);
    this.apStatus.set(a.status);
    const disc = a.statusTone === 'disc' || a.statusTone === 'disc-pilot';
    this.apKey.set(disc ? (a.reason ? `AP OFF · ${a.reason}` : 'AP OFF') : 'AP');
    if (toneChanged) this.apStatus.el.className = `ap-st ap-${a.statusTone}`;
    this.apCell.classList.toggle('ap-lvl', a.lvl);
    this.apCell.title = annunciationTitle(a);
  }
}
