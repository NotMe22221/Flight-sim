/**
 * `G1000Fms` — the interactive side of the G1000: routes bezel inputs (softkeys, keys, knobs,
 * typed characters) to the PFD/MFD windows and pages, edits the flight plan through the
 * `FlightPlanner`, and turns knob turns into radio / autopilot requests (`G1000Command`).
 * Display settings live in the PFD/MFD state objects the G1000 draws from; any visible change
 * bumps `version` so the displays redraw. See fmsSoftkeys.ts for the softkey menus.
 */
import { wrap360 } from '../../core/math';
import type { Airport, FlightPlan, Geodetic, SimSnapshot } from '../../core/types';
import { type ApproachInfo, type IdentMatch, approachWaypoints, stepCom, stepNav } from '../../nav';
import type { InstrumentModel, InstrumentReadings } from '../readings';
import { stepMapRange } from '../scales';
import { DirectToWindow } from './directTo';
import { type FmsContext, type FmsEvent, FmsWindow, type FmsTarget, type G1000NavDb, type G1000Planner, waypointFromTarget } from './fmsCore';
import { FplWindow } from './fplWindow';
import { pressMfdSoftkey, pressPfdSoftkey, syncSoftkeys, type MfdMenu, type PfdMenu } from './fmsSoftkeys';
import { type G1000Command, type G1000Display, type G1000Input, type G1000Knob, type KnobRing, WheelAccumulator, navSourceFor } from './input';
import { clampMapRange } from './map';
import type { MfdState } from './mfd';
import { NearestWindow, type NearestKind } from './nearestWindow';
import type { CdiSource } from './palette';
import type { PfdState } from './pfd';
import { ProcWindow } from './procWindow';

export interface G1000FmsOptions {
  pfd: PfdState;
  mfd: MfdState;
  /** elapsed timer (TMR/REF) */
  timer: Pick<InstrumentModel, 'timerIsRunning' | 'startTimer' | 'stopTimer' | 'resetTimer'>;
  nav?: G1000NavDb | null;
  planner?: G1000Planner | null;
  emit: (c: G1000Command) => void;
  /** called whenever something visible changed */
  onChange?: () => void;
}

/** MFD page groups (outer FMS knob) and their pages (inner knob). */
export const MFD_GROUPS: readonly { readonly name: string; readonly pages: readonly string[] }[] = Object.freeze([
  { name: 'MAP', pages: ['NAVIGATION MAP'] },
  { name: 'FPL', pages: ['ACTIVE FLIGHT PLAN'] },
  { name: 'NRST', pages: ['NEAREST AIRPORTS', 'NEAREST VOR', 'NEAREST NDB'] },
]);
const NRST_KINDS: readonly NearestKind[] = ['apt', 'vor', 'ndb'];
/** Distance from the FAF inside which a loaded ILS switches the CDI from GPS to LOC, nm. */
const LOC_SWITCH_NM = 2;

export class G1000Fms implements FmsContext {
  readonly pfd: PfdState;
  readonly mfd: MfdState;
  readonly timer: G1000FmsOptions['timer'];
  nav: G1000NavDb | null;
  planner: G1000Planner | null;
  plan: FlightPlan | null = null;
  readonly pos: Geodetic = { lat: 0, lon: 0, alt: 0 };
  gsKt = 0;
  magVarDeg = 0;
  /** increments on every visible UI change */
  version = 0;
  readonly pfdStack: FmsWindow[] = [];
  readonly mfdStack: FmsWindow[] = [];
  pfdMenu: PfdMenu = 'root';
  mfdMenu: MfdMenu = 'root';
  /** transponder code being entered with the CODE softkeys */
  codeEntry = '';
  mfdGroup = 0;
  mfdPageIndex = 0;
  readonly fplPage: FplWindow;
  readonly nrstPage: NearestWindow;
  /** the loaded approach (its fixes are replaced by the next one) */
  loadedApproach: { info: ApproachInfo; fafId: string; rwId: string } | null = null;
  /** LOAD-ed but not yet on the localizer: switch the CDI GPS → LOC on the final */
  approachArmed = false;
  readonly wheel = new WheelAccumulator();
  private readonly navStandby = [0, 0];
  private readonly navObs = [0, 0];
  private pfdFpl: FplWindow | null = null;
  private pfdNrst: NearestWindow | null = null;
  private synced = false;
  private readonly emitFn: (c: G1000Command) => void;
  private readonly onChange: () => void;
  private s: SimSnapshot | null = null;

  constructor(o: G1000FmsOptions) {
    this.pfd = o.pfd; this.mfd = o.mfd; this.timer = o.timer;
    this.nav = o.nav ?? null; this.planner = o.planner ?? null;
    this.emitFn = o.emit; this.onChange = o.onChange ?? (() => undefined);
    this.fplPage = new FplWindow(this); this.fplPage.display = 'mfd';
    this.nrstPage = new NearestWindow(this, 'apt', false); this.nrstPage.display = 'mfd';
    syncSoftkeys(this);
  }

  // ───────────────────────────── FmsContext ─────────────────────────────

  emit(c: G1000Command): void { this.emitFn(c); }

  open(display: G1000Display, w: FmsWindow): void {
    w.display = display;
    const st = this.stack(display);
    const i = st.indexOf(w);
    if (i >= 0) st.splice(i, 1);
    st.push(w);
    w.refresh(Infinity);
    this.touch();
  }

  close(w: FmsWindow): void {
    for (const st of [this.pfdStack, this.mfdStack]) { const i = st.indexOf(w); if (i >= 0) st.splice(i, 1); }
    this.touch();
  }

  touch(): void { this.version = (this.version + 1) | 0; this.onChange(); }

  directTo(t: FmsTarget): boolean {
    const p = this.planner;
    if (!p) return false;
    p.directToWaypoint(waypointFromTarget(t), this.pos);
    this.touch();
    return true;
  }

  search(prefix: string, limit: number): readonly IdentMatch[] {
    const nav = this.nav;
    return nav && nav.searchIdents ? nav.searchIdents(prefix, this.pos, limit) : [];
  }

  loadApproach(a: ApproachInfo, activate: boolean): void {
    const p = this.planner;
    const fixes = approachWaypoints(a);
    if (p) {
      // a newly loaded approach replaces the previous one's fixes
      for (const id of this.loadedApproach ? [this.loadedApproach.fafId, this.loadedApproach.rwId] : []) {
        const i = p.indexOfId(id);
        if (i >= 0) p.remove(i);
      }
      const at = p.waypoints.length;
      p.insert(at, fixes[0]); p.insert(at + 1, fixes[1]);
      if (activate) p.directToWaypoint(fixes[0], this.pos);
    }
    this.emit({ kind: 'navActive', radio: 1, kHz: a.frequencyKHz });
    this.emit({ kind: 'navCourse', radio: 1, courseDeg: Math.round(wrap360(a.courseTrueDeg - this.magVarDeg)) });
    this.loadedApproach = { info: a, fafId: fixes[0].id, rwId: fixes[1].id };
    this.approachArmed = !activate;
    if (activate) this.setCdiSource('NAV1');
    this.touch();
  }

  procAirport(): Airport | null {
    const nav = this.nav, p = this.planner;
    if (!nav) return null;
    if (p) {
      for (let i = p.waypoints.length - 1; i >= 0; i--) {
        const w = p.waypoints[i];
        if (w.type === 'airport') { const a = nav.getAirport(w.id); if (a) return a; }
      }
      const t = p.offRouteTarget;
      if (t && t.type === 'airport') { const a = nav.getAirport(t.id); if (a) return a; }
    }
    return nav.nearestAirports(this.pos, 1, 100)[0] ?? null;
  }

  /** Fill in a target's name from the database (plan waypoints carry only an ident). */
  named(t: FmsTarget): FmsTarget {
    if (t.name || !this.nav) return t;
    if (t.kind === 'airport') { const a = this.nav.getAirport(t.ident); if (a) return { ...t, name: a.name }; }
    else for (const m of this.search(t.ident, 4)) if (m.ident === t.ident && m.exact) return { ...t, name: m.name, frequencyKHz: m.frequencyKHz };
    return t;
  }

  // ───────────────────────────── display state ─────────────────────────────

  /** Top PFD window (drawn lower right), or null. */
  pfdWindow(): FmsWindow | null { return this.pfdStack[this.pfdStack.length - 1] ?? null; }
  /** Windows stacked on the PFD (bottom first), e.g. a confirmation over the FPL window. */
  get pfdWindows(): readonly FmsWindow[] { return this.pfdStack; }
  /** Popups over the MFD (D→, PROC, menus), bottom first. */
  get mfdPopups(): readonly FmsWindow[] { return this.mfdStack; }
  /** The MFD page window (FPL / NRST) or null on the map page. */
  mfdPage(): FmsWindow | null { return this.mfdGroup === 1 ? this.fplPage : this.mfdGroup === 2 ? this.nrstPage : null; }

  /** True while a window or a page cursor is active: route Enter / Escape (and typing) to the G1000. */
  get wantsKeyboard(): boolean { return this.keyDisplay() !== null; }

  /** The display whose window (or page cursor) takes ENT / CLR from the keyboard, or null. */
  keyDisplay(): G1000Display | null {
    if (this.mfdStack.length) return 'mfd';
    if (this.pfdStack.length) return 'pfd';
    const pg = this.mfdPage();
    return pg && (pg as { cursor?: boolean }).cursor ? 'mfd' : null;
  }

  /** True when a window showing position-dependent values is open on `display`. */
  liveOn(display: G1000Display): boolean {
    const st = this.stack(display);
    for (const w of st) if (w.live) return true;
    if (display === 'mfd') { const pg = this.mfdPage(); if (pg && pg.live) return true; }
    return false;
  }

  setCdiSource(src: CdiSource): void {
    this.pfd.cdiSource = src; this.mfd.cdiSource = src;
    this.emit({ kind: 'cdiSource', source: src, navSource: navSourceFor(src) });
    this.touch();
  }

  setMfdPage(group: number, page = 0): void {
    const g = ((group % MFD_GROUPS.length) + MFD_GROUPS.length) % MFD_GROUPS.length;
    const n = MFD_GROUPS[g].pages.length;
    this.mfdGroup = g; this.mfdPageIndex = ((page % n) + n) % n;
    if (g === 2) this.nrstPage.setType(NRST_KINDS[this.mfdPageIndex]);
    this.mfd.title = `${MFD_GROUPS[g].name} - ${MFD_GROUPS[g].pages[this.mfdPageIndex]}`;
    this.mfdMenu = 'root';
    this.touch();
  }

  /** Open / close a PFD window of one kind (FPL, NRST, PROC, D→, …). */
  togglePfd(kind: FmsWindow['kind'], make: () => FmsWindow): void {
    const top = this.pfdWindow();
    if (top && top.kind === kind) { this.close(top); return; }
    for (const w of [...this.pfdStack]) if (w.kind === kind) this.close(w);
    this.open('pfd', make());
  }

  pfdFplWindow(): FplWindow { return (this.pfdFpl ??= new FplWindow(this)); }
  pfdNrstWindow(): NearestWindow { return (this.pfdNrst ??= new NearestWindow(this, 'apt', true)); }

  /** Power-up state of the UI: windows closed, top-level softkeys, map page (flight reset). */
  resetUi(): void {
    this.pfdStack.length = 0; this.mfdStack.length = 0;
    this.pfdMenu = 'root'; this.mfdMenu = 'root'; this.codeEntry = '';
    this.fplPage.cursor = false; this.fplPage.entry = null; this.nrstPage.cursor = false;
    this.loadedApproach = null; this.approachArmed = false;
    this.pfd.identS = 0;
    this.setMfdPage(0);
    syncSoftkeys(this);
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  update(s: SimSnapshot, r: InstrumentReadings, dt: number): void {
    this.s = s;
    const g = s.aircraft.geo;
    if (Number.isFinite(g.lat) && Number.isFinite(g.lon)) { this.pos.lat = g.lat; this.pos.lon = g.lon; this.pos.alt = g.alt; }
    this.gsKt = r.gsKt; this.magVarDeg = r.heading.magVarDeg; this.plan = s.plan;
    this.navStandby[0] = s.nav1.standbyKHz; this.navStandby[1] = s.nav2.standbyKHz;
    this.navObs[0] = s.nav1.obsDeg; this.navObs[1] = s.nav2.obsDeg;
    if (!this.synced) { this.synced = true; this.emit({ kind: 'cdiSource', source: this.pfd.cdiSource, navSource: navSourceFor(this.pfd.cdiSource) }); }
    for (const w of this.pfdStack) w.refresh(dt);
    for (const w of this.mfdStack) w.refresh(dt);
    const pg = this.mfdPage();
    if (pg) pg.refresh(dt);
    if (this.pfd.identS > 0) {
      this.pfd.identS = Math.max(0, this.pfd.identS - dt);
      if (this.pfd.identS === 0) { this.emitXpdr(); syncSoftkeys(this); this.touch(); }
    }
    this.autoSwitchToLoc(s);
  }

  /** LOAD-ed ILS: switch GPS → NAV1 once the localizer is alive on the final course. */
  private autoSwitchToLoc(s: SimSnapshot): void {
    const a = this.loadedApproach, p = this.planner;
    if (!a || !this.approachArmed || !p || this.pfd.cdiSource !== 'GPS') return;
    const n = s.nav1;
    if (!n.valid || !n.isLocalizer || n.activeKHz !== a.info.frequencyKHz || Math.abs(n.cdi) >= 0.9) return;
    const act = p.activeWaypoint, plan = s.plan;
    const onFinal = !!act && (act.id === a.rwId || (act.id === a.fafId && !!plan && plan.distanceToActiveM < LOC_SWITCH_NM * 1852));
    if (onFinal) { this.setCdiSource('NAV1'); this.approachArmed = false; }
  }

  // ───────────────────────────── input ─────────────────────────────

  handle(e: G1000Input): boolean {
    const used = this.dispatch(e);
    if (used) { syncSoftkeys(this); this.touch(); }
    return used;
  }

  private dispatch(e: G1000Input): boolean {
    switch (e.type) {
      case 'softkey': return e.display === 'pfd' ? pressPfdSoftkey(this, e.index) : pressMfdSoftkey(this, e.index);
      case 'char': return this.fmsEvent(e.display ?? this.editingDisplay() ?? 'mfd', { key: 'char', steps: 0, char: e.char });
      case 'push': return this.push(e.display ?? 'mfd', e.id);
      case 'knob': return this.turn(e.display ?? 'mfd', e.id, e.ring ?? 'inner', Math.trunc(e.steps));
      case 'wheel': {
        const d = e.display ?? 'mfd', ring = e.ring ?? 'inner';
        const n = this.wheel.steps(`${d}:${e.id}:${ring}`, e.deltaY, e.deltaMode ?? 0);
        return n !== 0 ? this.turn(d, e.id, ring, n) : true;
      }
      case 'button': return this.button(e.display ?? 'mfd', e.id);
    }
    return false;
  }

  /** Deliver an FMS event to the top window, else the MFD page, else MFD page navigation. */
  fmsEvent(d: G1000Display, ev: FmsEvent): boolean {
    const st = this.stack(d);
    const top = st[st.length - 1];
    if (top) return top.input(ev) || true;
    if (d === 'pfd') return false;
    const pg = this.mfdPage();
    if (pg && pg.input(ev)) return true;
    if (ev.key === 'outer' && ev.steps) { this.setMfdPage(this.mfdGroup + Math.round(ev.steps)); return true; }
    if (ev.key === 'inner' && ev.steps) { this.setMfdPage(this.mfdGroup, this.mfdPageIndex + Math.round(ev.steps)); return true; }
    return ev.key === 'push' || ev.key === 'ENT' || ev.key === 'CLR' || ev.key === 'MENU';
  }

  /** The display whose top window accepts typed characters now, or null. */
  editingDisplay(): G1000Display | null {
    const m = this.mfdStack[this.mfdStack.length - 1] ?? this.mfdPage();
    if (m && m.editing()) return 'mfd';
    const p = this.pfdWindow();
    if (p && p.editing()) return 'pfd';
    return null;
  }

  private stack(d: G1000Display): FmsWindow[] { return d === 'pfd' ? this.pfdStack : this.mfdStack; }

  private turn(d: G1000Display, id: G1000Knob, ring: KnobRing, steps: number): boolean {
    if (!steps) return true;
    const pfd = this.pfd, dir: 1 | -1 = steps > 0 ? 1 : -1, n = Math.abs(steps);
    switch (id) {
      case 'FMS': return this.fmsEvent(d, { key: ring, steps, char: '' });
      case 'NAV': {
        const r = pfd.navFocus;
        let k = this.navStandby[r - 1];
        for (let i = 0; i < n; i++) k = stepNav(k, dir, ring === 'outer');
        this.navStandby[r - 1] = k;
        this.emit({ kind: 'navStandby', radio: r, kHz: k });
        return true;
      }
      case 'COM': {
        const r = pfd.comFocus, c = r === 1 ? pfd.com1 : pfd.com2;
        for (let i = 0; i < n; i++) c.standbyKHz = stepCom(c.standbyKHz, dir, ring === 'outer');
        this.emit({ kind: 'comStandby', radio: r, kHz: c.standbyKHz });
        return true;
      }
      case 'HDG': this.action(dir > 0 ? 'headingBugInc' : 'headingBugDec', n); return true;
      case 'ALT': this.action(dir > 0 ? 'apAltInc' : 'apAltDec', ring === 'outer' ? n * 10 : n); return true;
      case 'CRS_BARO':
        if (ring === 'outer') this.action(dir > 0 ? 'altimeterInc' : 'altimeterDec', n);
        else this.turnCourse(steps);
        return true;
      case 'RANGE':
        if (d === 'pfd') { for (let i = 0; i < n; i++) pfd.insetRangeNm = clampMapRange(stepMapRange(pfd.insetRangeNm, dir)); }
        else for (let i = 0; i < n; i++) this.mfd.rangeNm = clampMapRange(stepMapRange(this.mfd.rangeNm, dir));
        return true;
      case 'NAV_VOL': case 'COM_VOL': return true;
    }
    return false;
  }

  private turnCourse(steps: number): void {
    const src = this.pfd.cdiSource, mv = this.magVarDeg;
    if (src === 'GPS') {
      const p = this.planner;
      if (p && p.obsCourseDeg !== null) p.setObs(wrap360(Math.round(wrap360(p.obsCourseDeg - mv)) + steps) + mv);
      return;
    }
    const r = src === 'NAV1' ? 1 : 2;
    const c = wrap360(Math.round(this.navObs[r - 1]) + steps);
    this.navObs[r - 1] = c;
    this.emit({ kind: 'navCourse', radio: r, courseDeg: c });
  }

  private push(d: G1000Display, id: G1000Knob): boolean {
    const pfd = this.pfd;
    switch (id) {
      case 'FMS': return this.fmsEvent(d, { key: 'push', steps: 0, char: '' });
      case 'NAV': pfd.navFocus = pfd.navFocus === 1 ? 2 : 1; return true;
      case 'COM': pfd.comFocus = pfd.comFocus === 1 ? 2 : 1; return true;
      case 'HDG': this.action('apHdgSync', 1); return true;
      case 'CRS_BARO': this.centreCourse(); return true;
      case 'ALT': case 'RANGE': case 'NAV_VOL': case 'COM_VOL': return true;
    }
    return false;
  }

  /** CRS push: point the course at the station (VOR) or the active waypoint (GPS OBS). */
  private centreCourse(): void {
    const s = this.s, src = this.pfd.cdiSource;
    if (!s) return;
    if (src === 'GPS') {
      const p = this.planner, plan = s.plan;
      if (p && p.obsCourseDeg !== null && plan) p.setObs(plan.bearingToActiveDeg);
      return;
    }
    const r = src === 'NAV1' ? 1 : 2, nav = r === 1 ? s.nav1 : s.nav2;
    if (!nav.valid || nav.isLocalizer) return;
    const c = wrap360(Math.round(nav.bearingDeg));
    this.navObs[r - 1] = c;
    this.emit({ kind: 'navCourse', radio: r, courseDeg: c });
  }

  private button(d: G1000Display, id: string): boolean {
    const pfd = this.pfd;
    switch (id) {
      case 'DIRECT': {
        const st = this.stack(d), top = st[st.length - 1];
        if (top && top.kind === 'direct') { this.close(top); return true; }
        const pre = (top ?? (d === 'mfd' ? this.mfdPage() : null))?.selection() ?? null;
        this.open(d, new DirectToWindow(this, pre ? this.named(pre) : null));
        return true;
      }
      case 'FPL':
        if (d === 'pfd') this.togglePfd('fpl', () => this.pfdFplWindow());
        else { this.mfdStack.length = 0; this.setMfdPage(this.mfdGroup === 1 ? 0 : 1); }
        return true;
      case 'PROC':
        if (d === 'pfd') this.togglePfd('proc', () => new ProcWindow(this));
        else {
          const top = this.mfdStack[this.mfdStack.length - 1];
          if (top && top.kind === 'proc') this.close(top); else this.open('mfd', new ProcWindow(this));
        }
        return true;
      case 'NRST':
        if (d === 'pfd') this.togglePfd('nrst', () => this.pfdNrstWindow());
        else { this.mfdStack.length = 0; this.setMfdPage(this.mfdGroup === 2 ? 0 : 2); }
        return true;
      case 'MENU': case 'CLR': case 'ENT': return this.fmsEvent(d, { key: id, steps: 0, char: '' });
      case 'NAV_SWAP': this.emit({ kind: 'navSwap', radio: pfd.navFocus }); return true;
      case 'COM_SWAP': {
        const c = pfd.comFocus === 1 ? pfd.com1 : pfd.com2;
        const a = c.activeKHz; c.activeKHz = c.standbyKHz; c.standbyKHz = a;
        this.emit({ kind: 'comSwap', radio: pfd.comFocus });
        return true;
      }
      case 'AP': this.action('apToggle', 1); return true;
      case 'FD': this.action('fdToggle', 1); return true;
      case 'HDG': this.action('apHdg', 1); return true;
      case 'ALT': this.action('apAlt', 1); return true;
      case 'NAV': this.action('apNav', 1); return true;
      case 'APR': this.action('apApr', 1); return true;
      case 'VS': this.action('apVs', 1); return true;
      case 'FLC': this.action('apFlc', 1); return true;
      case 'NOSE_UP': case 'NOSE_DN': {
        const flc = this.s?.autopilot.vertical === 'FLC', up = id === 'NOSE_UP';
        this.action(flc ? (up ? 'apIasDec' : 'apIasInc') : (up ? 'apVsInc' : 'apVsDec'), 1);
        return true;
      }
      case 'VNV': case 'BC': return true;
    }
    return false;
  }

  action(a: Extract<G1000Command, { kind: 'action' }>['action'], count: number): void { this.emit({ kind: 'action', action: a, count }); }

  emitXpdr(): void { this.emit({ kind: 'xpdr', code: this.pfd.squawk, mode: this.pfd.xpdrMode, ident: this.pfd.identS > 0 }); }
}
