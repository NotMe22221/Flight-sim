/**
 * Small FMS windows: the page menu (MENU key), yes/no confirmations ("REMOVE KOAK?"), the PFD
 * ALERTS window and the PFD timer / references window (TMR/REF: elapsed timer, V-speed bugs,
 * barometric minimums).
 */
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { ALERT_DEFS } from './alerts';
import { type FmsContext, type FmsEvent, FmsWindow, type Rect, type WindowDrawData } from './fmsCore';
import { button, cell, ftLabels, windowFrame, winStyle } from './fmsDraw';
import { G } from './palette';
import { text } from './widgets';
import { LabelCache } from '../labelCache';
import { formatTimer } from '../format';

export interface MenuItem { label: string; enabled: boolean; run: () => void }

/** Page menu: a list of commands; ENT runs the selected one, CLR or MENU closes. */
export class MenuWindow extends FmsWindow {
  readonly kind = 'menu' as const;
  sel = 0;
  constructor(fms: FmsContext, readonly title: string, readonly items: readonly MenuItem[]) {
    super(fms);
    this.sel = Math.max(0, items.findIndex((i) => i.enabled));
  }

  input(e: FmsEvent): boolean {
    switch (e.key) {
      case 'inner': case 'outer': this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + Math.sign(e.steps) * Math.max(1, Math.abs(Math.round(e.steps))))); return true;
      case 'ENT': {
        const it = this.items[this.sel];
        if (!it || !it.enabled) return true;
        this.fms.close(this);
        it.run();
        return true;
      }
      case 'CLR': case 'MENU': case 'push': this.fms.close(this); return true;
      default: return true;
    }
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), x = rc.x + st.pad, w = rc.w - 2 * st.pad;
    let y = windowFrame(ctx, rc, this.title, st);
    text(ctx, 'OPTIONS', x, y + 1, st.small, G.grey, 'left');
    y += st.rowH;
    for (let i = 0; i < this.items.length; i++, y += st.rowH) {
      const it = this.items[i];
      cell(ctx, it.label, x, y, w, st.rowH - 2, st.bold, it.enabled ? G.white : G.darkGrey, i === this.sel);
    }
    text(ctx, 'PRESS ENT TO SELECT · CLR TO EXIT', rc.x + rc.w / 2, rc.y + rc.h - st.rowH / 2 - 2, st.small, G.grey, 'center');
  }
}

/** A question answered with ENT (yes) or CLR (no). */
export class ConfirmWindow extends FmsWindow {
  readonly kind = 'confirm' as const;
  constructor(fms: FmsContext, readonly question: string, private readonly yes: () => void) { super(fms); }

  input(e: FmsEvent): boolean {
    if (e.key === 'ENT') { this.fms.close(this); this.yes(); return true; }
    if (e.key === 'CLR' || e.key === 'push' || e.key === 'MENU') { this.fms.close(this); return true; }
    return true;
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact);
    const h = st.rowH * 4 + 8, y0 = rc.y + Math.max(0, (rc.h - h) / 2);
    const box = { x: rc.x + 6, y: y0, w: rc.w - 12, h };
    const y = windowFrame(ctx, box, 'CONFIRM', st);
    text(ctx, this.question, box.x + box.w / 2, y + 2, st.bold, G.white, 'center');
    button(ctx, 'OK?', box.x + box.w / 2 - 50, y + st.rowH * 1.6, 70, st, true);
    text(ctx, 'ENT', box.x + box.w / 2 - 50, y + st.rowH * 2.6, st.small, G.grey, 'center');
    text(ctx, 'CANCEL: CLR', box.x + box.w / 2 + 50, y + st.rowH * 1.6, st.small, G.white, 'center');
  }
}

/** Active warnings and cautions (PFD ALERTS softkey). */
export class AlertsWindow extends FmsWindow {
  readonly kind = 'alerts' as const;
  override live = true;
  input(e: FmsEvent): boolean {
    if (e.key === 'CLR' || e.key === 'push') { this.fms.close(this); return true; }
    return e.key === 'inner' || e.key === 'outer' || e.key === 'ENT';
  }
  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), x = rc.x + st.pad;
    let y = windowFrame(ctx, rc, 'ALERTS', st), n = 0;
    for (const a of ALERT_DEFS) {
      if (!d.r.annunciators[a.key] || y > rc.y + rc.h - st.rowH) continue;
      text(ctx, a.text, x, y + 1, st.bold, a.level === 'warning' ? G.red : G.yellow, 'left');
      y += st.rowH; n++;
    }
    if (!n) text(ctx, 'NO ACTIVE ALERTS', rc.x + rc.w / 2, y + 1, st.font, G.white, 'center');
  }
}

/** What the TMR/REF window controls (owned by the G1000). */
export interface RefSettings {
  vspeedBugs: boolean;
  /** barometric minimums, ft (shown on the altitude tape when enabled) */
  minimumsFt: number;
  minimumsOn: boolean;
}

/** Timer and references: TIMER (START/STOP/RESET), V-speed bugs ON/OFF, baro minimums. */
export class TimerRefWindow extends FmsWindow {
  readonly kind = 'tmrref' as const;
  override live = true;
  /** 0 timer, 1 V-speeds, 2 minimums value, 3 minimums on/off */
  focus = 0;
  /** timer action shown: 0 START?/STOP?, 1 RESET? */
  action = 0;
  constructor(fms: FmsContext, private readonly ref: RefSettings, private readonly timer: { readonly timerIsRunning: boolean; startTimer(): void; stopTimer(): void; resetTimer(): void }) { super(fms); }

  input(e: FmsEvent): boolean {
    switch (e.key) {
      case 'outer': this.focus = Math.max(0, Math.min(3, this.focus + Math.sign(e.steps))); return true;
      case 'inner':
        if (this.focus === 0) this.action = this.action ? 0 : 1;
        else if (this.focus === 1) this.ref.vspeedBugs = !this.ref.vspeedBugs;
        else if (this.focus === 2) this.ref.minimumsFt = Math.max(0, Math.min(16000, this.ref.minimumsFt + 10 * Math.round(e.steps)));
        else this.ref.minimumsOn = !this.ref.minimumsOn;
        return true;
      case 'ENT':
        if (this.focus === 0) {
          if (this.action === 1) { this.timer.resetTimer(); this.action = 0; }
          else if (this.timer.timerIsRunning) this.timer.stopTimer(); else this.timer.startTimer();
        } else if (this.focus === 1) this.ref.vspeedBugs = !this.ref.vspeedBugs;
        else this.ref.minimumsOn = !this.ref.minimumsOn;
        return true;
      case 'CLR': case 'push': this.fms.close(this); return true;
      default: return true;
    }
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), x = rc.x + st.pad, w = rc.w - 2 * st.pad, h = st.rowH;
    let y = windowFrame(ctx, rc, 'TIMER / REFERENCES', st);
    text(ctx, 'TIMER', x, y + 1, st.small, G.white, 'left');
    text(ctx, timerLabels.get(readTimer(d.r)), x + 120, y + 1, st.bold, G.white, 'right');
    const act = this.action === 1 ? 'RESET?' : this.timer.timerIsRunning ? 'STOP?' : 'START?';
    cell(ctx, act, x + w - 90, y, 90, h - 2, st.bold, G.cyan, this.focus === 0, 'center');
    y += h * 1.4;
    text(ctx, 'VR VX VY VG', x, y + 1, st.small, G.white, 'left');
    cell(ctx, this.ref.vspeedBugs ? 'ON' : 'OFF', x + w - 90, y, 90, h - 2, st.bold, G.cyan, this.focus === 1, 'center');
    y += h * 1.4;
    text(ctx, 'MINIMUMS  BARO', x, y + 1, st.small, G.white, 'left');
    cell(ctx, ftLabels.get(this.ref.minimumsFt), x + w - 190, y, 90, h - 2, st.bold, G.cyan, this.focus === 2, 'right');
    cell(ctx, this.ref.minimumsOn ? 'ON' : 'OFF', x + w - 90, y, 90, h - 2, st.bold, G.cyan, this.focus === 3, 'center');
    text(ctx, 'FMS: OUTER FIELD · INNER VALUE · ENT', rc.x + rc.w / 2, rc.y + rc.h - h / 2 - 2, st.small, G.grey, 'center');
  }
}

const timerLabels = new LabelCache(formatTimer);
const readTimer = (r: InstrumentReadings): number => r.clock.timerS;
