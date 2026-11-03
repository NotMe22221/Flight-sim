/**
 * Active flight plan (MFD FPL page and PFD FPL window). Rows show each waypoint with the DTK
 * (magnetic) and length of the leg into it and its ETE at the current ground speed; the active
 * leg is magenta with the leg arrow, past legs grey. All edits go through the `FlightPlanner`:
 * with the cursor on (FMS push), the outer knob selects a row, the inner knob (or typing) spells
 * an ident that ENT inserts before the selected row (the last row appends), CLR asks to remove
 * the selected waypoint, MENU offers ACTIVATE LEG / DELETE FLIGHT PLAN / CANCEL DIRECT-TO, and
 * D→ goes direct to the selected waypoint.
 */
import type { Geodetic, Waypoint } from '../../core/types';
import type { FlightPlanEx, IdentMatch } from '../../nav';
import type { Ctx2D } from '../canvas';
import { ConfirmWindow, MenuWindow, type MenuItem } from './fmsWindows';
import { type FmsEvent, FmsWindow, type FmsTarget, IdentField, type Rect, type WindowDrawData, bearingDegGeo, distanceNmGeo, targetFromMatch, targetFromWaypoint, waypointFromTarget } from './fmsCore';
import { brgLabels, cell, clip, disLabels, eteLabels, identCell, windowFrame, winStyle } from './fmsDraw';
import { G } from './palette';
import { text } from './widgets';

const NO_WAYPOINTS: readonly Waypoint[] = Object.freeze([]);

export class FplWindow extends FmsWindow {
  readonly kind = 'fpl' as const;
  override live = true;
  cursor = false;
  /** selected row: 0 … n − 1 waypoints, n = the empty row that appends */
  sel = 0;
  top = 0;
  /** insertion entry before `sel`, or null */
  entry: IdentField | null = null;
  entryTarget: FmsTarget | null = null;
  entryName = '';
  message = '';
  // per-plan-version leg table (true DTK and length of the leg into each waypoint)
  private tableVersion = NaN;
  private readonly legDtkTrue: number[] = [];
  private readonly legNm: number[] = [];
  private header = '';
  private totalNm = 0;

  get count(): number { return this.fms.planner ? this.fms.planner.waypoints.length : 0; }

  override editing(): boolean { return this.entry !== null; }

  override selection(): FmsTarget | null {
    const p = this.fms.planner;
    if (!this.cursor || !p || this.sel >= p.waypoints.length) return null;
    return targetFromWaypoint(p.waypoints[this.sel]);
  }

  input(e: FmsEvent): boolean {
    const p = this.fms.planner;
    this.message = '';
    if (e.key === 'push') { this.cursor = !this.cursor; this.entry = null; this.clampSel(); return true; }
    if (this.entry) return this.entryInput(e);
    if (e.key === 'MENU') { this.openMenu(); return true; }
    if (!this.cursor) {
      if (e.key === 'char') { this.cursor = true; this.sel = this.count; return this.entryInput(e); }
      return false;
    }
    switch (e.key) {
      case 'outer': this.sel += Math.round(e.steps); this.clampSel(); return true;
      case 'inner': case 'char': return this.entryInput(e);
      case 'CLR': {
        if (!p || this.sel >= p.waypoints.length) { this.cursor = false; return true; }
        const wp = p.waypoints[this.sel], i = this.sel;
        this.fms.open(this.display, new ConfirmWindow(this.fms, `REMOVE ${wp.id}?`, () => { if (p.waypoints[i] === wp) p.remove(i); this.clampSel(); }));
        return true;
      }
      case 'ENT': return true;
    }
    return false;
  }

  /** ACT LEG softkey / menu: activate the leg into the selected waypoint after confirmation. */
  activateSelected(): void {
    const p = this.fms.planner;
    if (!p || !this.cursor || this.sel >= p.waypoints.length) { this.message = 'SELECT A WAYPOINT'; this.fms.touch(); return; }
    const wp = p.waypoints[this.sel], i = this.sel;
    this.fms.open(this.display, new ConfirmWindow(this.fms, `ACTIVATE LEG TO ${wp.id}?`, () => { if (p.waypoints[i] === wp) p.activateLeg(i); }));
  }

  private entryInput(e: FmsEvent): boolean {
    if (!this.entry) { this.entry = new IdentField(6); this.entry.reset(''); }
    const f = this.entry;
    switch (e.key) {
      case 'inner': f.turn(e.steps); this.search(); return true;
      case 'outer': f.move(e.steps); this.search(); return true;
      case 'char': f.type(e.char); this.search(); return true;
      case 'CLR': this.entry = null; this.entryTarget = null; return true;
      case 'ENT': {
        const p = this.fms.planner;
        if (!p) { this.message = 'NO FLIGHT PLANNER'; return true; }
        if (!this.entryTarget) { this.message = 'WAYPOINT NOT FOUND'; return true; }
        p.insert(this.sel, waypointFromTarget(this.entryTarget));
        this.sel++;
        this.entry = null; this.entryTarget = null;
        this.clampSel();
        return true;
      }
      default: return true;
    }
  }

  private search(): void {
    const f = this.entry!;
    const m: readonly IdentMatch[] = f.text ? this.fms.search(f.text, 1) : [];
    f.completion = m.length ? m[0].ident : '';
    this.entryTarget = m.length ? targetFromMatch(m[0]) : null;
    this.entryName = this.entryTarget ? clip(this.entryTarget.name, 26) : '';
  }

  private openMenu(): void {
    const p = this.fms.planner;
    const onWpt = !!p && this.cursor && this.sel < p.waypoints.length;
    const items: MenuItem[] = [
      { label: 'ACTIVATE LEG', enabled: onWpt, run: () => this.activateSelected() },
      { label: 'DELETE FLIGHT PLAN', enabled: !!p && p.waypoints.length > 0, run: () => this.fms.open(this.display, new ConfirmWindow(this.fms, 'DELETE FLIGHT PLAN?', () => { p!.clear(); this.sel = 0; })) },
      { label: 'CANCEL DIRECT-TO NAV', enabled: !!p && p.isDirectTo, run: () => p!.cancelDirectTo() },
    ];
    this.fms.open(this.display, new MenuWindow(this.fms, 'PAGE MENU', items));
  }

  private clampSel(): void { this.sel = Math.max(0, Math.min(this.count, this.sel)); }

  private rebuild(): void {
    const p = this.fms.planner;
    const wps = p ? p.waypoints : NO_WAYPOINTS;
    this.tableVersion = p ? p.version : NaN;
    this.legDtkTrue.length = wps.length; this.legNm.length = wps.length;
    let total = 0;
    for (let i = 0; i < wps.length; i++) {
      if (i === 0) { this.legDtkTrue[i] = NaN; this.legNm[i] = NaN; continue; }
      this.legDtkTrue[i] = bearingDegGeo(wps[i - 1].position, wps[i].position);
      this.legNm[i] = distanceNmGeo(wps[i - 1].position, wps[i].position);
      total += this.legNm[i];
    }
    this.totalNm = total;
    this.header = wps.length ? `${wps[0].id} / ${wps[wps.length - 1].id}` : 'NO FLIGHT PLAN';
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), h = st.rowH, x = rc.x + st.pad, w = rc.w - 2 * st.pad;
    const p = this.fms.planner;
    if (p && p.version !== this.tableVersion) this.rebuild();
    else if (!p && this.header === '') this.rebuild();
    let y = windowFrame(ctx, rc, 'ACTIVE FLIGHT PLAN', st);
    const plan = this.fms.plan as FlightPlanEx | null;
    const offRoute = p ? p.offRouteTarget : null;
    text(ctx, this.header, x, y + 1, st.bold, G.white, 'left');
    if (offRoute) text(ctx, `D→ ${offRoute.id}`, x + w, y + 1, st.bold, G.magenta, 'right');
    y += h;
    // column headers
    const cDtk = x + w * 0.52, cDis = x + w * 0.77, cEte = x + w;
    text(ctx, 'DTK', cDtk, y + 1, st.small, G.white, 'right');
    text(ctx, 'DIS', cDis, y + 1, st.small, G.white, 'right');
    text(ctx, 'ETE', cEte, y + 1, st.small, G.white, 'right');
    y += h;
    const wps = p ? p.waypoints : NO_WAYPOINTS;
    const n = wps.length;
    const rows = Math.max(1, Math.floor((rc.y + rc.h - y - h * 1.2) / h));
    const total = n + 1 + (this.entry ? 1 : 0);
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + rows - (this.entry ? 1 : 0)) this.top = this.sel - rows + 1 + (this.entry ? 1 : 0);
    this.top = Math.max(0, Math.min(this.top, Math.max(0, total - rows)));
    const active = offRoute ? -1 : p ? p.activeLeg : -1;
    const gs = this.fms.gsKt, mv = this.fms.magVarDeg, pos = this.fms.pos;
    const legFrom: Geodetic | null = plan && plan.legFrom && !offRoute ? plan.legFrom : null;
    let arrowFromY = NaN, arrowToY = NaN;
    for (let row = this.top, drawn = 0; row < total && drawn < rows; row++, drawn++, y += h) {
      // map the visual row to a waypoint index (the entry row sits before `sel`)
      let i = row;
      if (this.entry && row === this.sel) {
        identCell(ctx, this.entry, x + 14, y, 86, h - 2, st, true);
        if (this.entryName) text(ctx, this.entryName, x + 110, y + 1, st.small, G.white, 'left');
        continue;
      }
      if (this.entry && row > this.sel) i = row - 1;
      if (i >= n) { cell(ctx, '_____', x + 14, y, 86, h - 2, st.bold, G.cyan, this.cursor && this.sel === n && !this.entry); continue; }
      const isActive = i === active, past = active >= 0 && i < active;
      const color = isActive ? G.magenta : past ? G.grey : G.white;
      cell(ctx, wps[i].id, x + 14, y, 86, h - 2, st.bold, color, this.cursor && this.sel === i && !this.entry);
      if (isActive) arrowToY = y;
      if (active >= 1 && i === active - 1 && !(p && p.isDirectTo)) arrowFromY = y;
      let dtk = this.legDtkTrue[i], dis = this.legNm[i];
      if (isActive) {
        if (p && p.isDirectTo && legFrom) dtk = bearingDegGeo(legFrom, wps[i].position);
        dis = plan ? plan.distanceToActiveM / 1852 : distanceNmGeo(pos, wps[i].position);
      }
      if (Number.isFinite(dtk)) text(ctx, brgLabels.get(dtk - mv), cDtk, y + 1, st.font, color, 'right');
      if (Number.isFinite(dis)) text(ctx, disLabels.get(dis), cDis, y + 1, st.font, color, 'right');
      if (!past && Number.isFinite(dis) && gs > 1) text(ctx, eteLabels.get((dis / gs) * 3600), cEte, y + 1, st.font, color, 'right');
      if (isActive && p && p.isDirectTo) text(ctx, 'D→', x, y + 1, st.small, G.magenta, 'left');
    }
    // active leg arrow in the left margin
    if (Number.isFinite(arrowFromY) && Number.isFinite(arrowToY)) {
      const ax = x + 6;
      ctx.strokeStyle = G.magenta; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x + 12, arrowFromY); ctx.lineTo(ax, arrowFromY); ctx.lineTo(ax, arrowToY); ctx.lineTo(x + 12, arrowToY); ctx.stroke();
      ctx.fillStyle = G.magenta;
      ctx.beginPath(); ctx.moveTo(x + 13, arrowToY); ctx.lineTo(x + 7, arrowToY - 4); ctx.lineTo(x + 7, arrowToY + 4); ctx.closePath(); ctx.fill();
    }
    const fy = rc.y + rc.h - h * 0.7;
    if (this.message) text(ctx, this.message, x, fy - h, st.small, G.amber, 'left');
    text(ctx, 'TOTAL', x, fy, st.small, G.white, 'left');
    text(ctx, disLabels.get(this.totalNm), cDis, fy, st.font, G.white, 'right');
    if (gs > 1 && plan) text(ctx, eteLabels.get(((plan as FlightPlanEx).remainingDistanceM ?? 0) / 1852 / gs * 3600), cEte, fy, st.font, G.white, 'right');
    if (!this.cursor) text(ctx, 'PUSH FMS FOR CURSOR', rc.x + rc.w / 2, fy - (this.message ? 2 * h : h), st.small, G.grey, 'center');
  }
}
