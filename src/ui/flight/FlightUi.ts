/**
 * Everything on screen during a flight: toolbar + panels (FlightPanels), status bar, flight info
 * strip, ATC subtitles, and the modal overlays (pause menu, keyboard help, landing report).
 * UiManager feeds it events and frames; it never touches the simulator except through UiHost.
 */
import type { AutopilotState, SimAction, SimEvents, SimSnapshot } from '../../core/types';
import type { UiHost, UnitsSettings } from '../UiHost';
import type { ScreenContext } from '../screens/Screen';
import type { InterfaceSettings } from '../settingsStore';
import type { AssistKey } from '../assistPresets';
import { ASSIST_ITEMS } from '../assistPresets';
import { Cls, Txt, h } from '../dom';
import { releasesFocusAfter } from '../routing';
import { FlightPanels, type PanelId } from './FlightPanels';
import type { LayoutStore } from './FloatingPanel';
import { HelpOverlay } from './HelpOverlay';
import { HudStrip } from './HudStrip';
import { LandingReport } from './LandingReport';
import { landingPresentation, landingToastText } from '../landingReportModel';
import { PauseMenu } from './PauseMenu';
import { StatusBar } from './StatusBar';

export interface FlightUiDeps {
  host: UiHost;
  ctx: ScreenContext;
  hudLayer: HTMLElement;
  flightLayer: HTMLElement;
  modalLayer: HTMLElement;
  layout: LayoutStore;
  units: () => UnitsSettings;
  iface: () => InterfaceSettings;
  /** An overlay opened or closed (UiManager re-evaluates keyboard capture). */
  onOverlayChange: () => void;
}

const PANEL_ACTIONS: Partial<Record<SimAction, PanelId>> = { toggleMap: 'vfrmap', toggleCheckList: 'checklist', toggleAtc: 'atc', toggleWeatherPanel: 'weather' };
const ASSIST_ACTIONS: Partial<Record<SimAction, AssistKey>> = { assistAutoRudderToggle: 'autoRudder', assistTakeoffToggle: 'assistedTakeoff', assistLandingToggle: 'assistedLanding' };
const CRASH_MENU_DELAY_MS = 1500;
const AP_EVENT_GRACE_MS = 1500;

export class FlightUi {
  readonly panels: FlightPanels;
  readonly pause: PauseMenu;
  readonly help: HelpOverlay;
  readonly report: LandingReport;
  private status: StatusBar;
  private hud: HudStrip;
  private subtitle: HTMLElement;
  private subFrom: Txt;
  private subText: Txt;
  private subVisible: Cls;
  private hudShift: Cls;
  private subUntil = 0;
  private active = false;
  private hudToggle = true;
  private pausedByMenu = false;
  private resumePaused = false;
  private pendingAssist: AssistKey | null = null;
  private apEngaged: boolean | null = null;
  private apGraceUntil = 0;
  private crashTimer: ReturnType<typeof setTimeout> | null = null;
  private now = 0;

  constructor(private readonly d: FlightUiDeps) {
    this.status = new StatusBar(d.hudLayer);
    this.hud = new HudStrip(d.hudLayer);
    this.subFrom = new Txt(h('span', { class: 'from' }), '');
    this.subText = new Txt(h('span'), '');
    this.subtitle = h('div', { class: 'panel atc-subtitle', aria: { live: 'polite' } }, this.subFrom.el, this.subText.el);
    this.subVisible = new Cls(this.subtitle, 'visible');
    d.hudLayer.appendChild(this.subtitle);
    this.hudShift = new Cls(this.hud.el, 'shifted');
    this.panels = new FlightPanels({ host: d.host, ctx: d.ctx, layer: d.flightLayer, layout: d.layout, units: d.units, onHelp: () => this.toggleHelp(), onMenu: () => this.openPause() });
    this.pause = new PauseMenu(d.modalLayer, {
      resume: () => this.closePause(true),
      restart: () => { this.closePause(false); this.pausedByMenu = false; d.host.dispatch('resetFlight'); },
      worldMap: () => { this.closePause(false); d.ctx.navigate('worldmap'); },
      settings: () => { this.closePause(false); d.ctx.navigate('settings'); },
      mainMenu: () => { this.closePause(false); d.ctx.navigate('main'); },
    });
    this.help = new HelpOverlay(d.modalLayer);
    this.report = new LandingReport(d.modalLayer);
    // hidden until the 'flight' route shows; no onOverlayChange here (the owner is still constructing)
    d.hudLayer.style.display = 'none';
    d.flightLayer.style.display = 'none';
    // a slider, dropdown or button used with the pointer must not keep the keyboard from the flight;
    // pointerup too, because a click can be swallowed before it reaches the UI (the cockpit's
    // capture-phase knob handler stops clicks over the instrument panel) while mousedown already
    // focused the control
    d.flightLayer.addEventListener('click', (e) => { if (e.detail > 0) this.releaseFocus(e.target, 'click'); });
    d.flightLayer.addEventListener('pointerup', (e) => this.releaseFocus(e.target, 'click'));
    d.flightLayer.addEventListener('change', (e) => this.releaseFocus(e.target, 'change'));
  }

  private releaseFocus(target: EventTarget | null, ev: 'click' | 'change'): void {
    const t = target as HTMLElement | null;
    const el = t && typeof t.closest === 'function' ? t.closest<HTMLElement>('button, input, select, textarea, [role]') : null;
    if (!el || !releasesFocusAfter(el, ev)) return;
    // after the browser's own focus handling for this event
    setTimeout(() => { if (document.activeElement === el) el.blur(); }, 0);
  }

  /** True while a modal overlay owns the screen (keyboard captured). */
  get overlayOpen(): boolean { return this.pause.visible || this.help.visible || this.report.visible; }
  get isActive(): boolean { return this.active; }

  /** The 'flight' route became visible/hidden. Returning to a flight paused by the menu re-opens it. */
  setActive(on: boolean): void {
    this.active = on;
    this.d.hudLayer.style.display = on ? '' : 'none';
    this.d.flightLayer.style.display = on ? '' : 'none';
    this.panels.toolbar.setEnabled(on);
    if (on) { this.panels.clampAll(); if (this.pausedByMenu && !this.pause.visible) this.showPause(); }
    else { this.help.hide(); this.report.hide(); if (this.pause.visible) this.pause.hide(); }
    this.d.onOverlayChange();
  }

  /** Esc in flight: close the topmost overlay, otherwise toggle the pause menu. */
  escape(): void {
    if (this.help.visible) this.help.hide();
    else if (this.report.visible) this.report.hide();
    else if (this.pause.visible) this.closePause(true);
    else this.openPause();
    this.d.onOverlayChange();
  }

  openPause(title = 'Paused', note = ''): void {
    this.pause.setTitle(title, note);
    if (!this.pausedByMenu) {
      this.resumePaused = this.d.host.snapshot().paused;
      this.pausedByMenu = true;
      this.d.host.setPaused(true);
    }
    this.showPause();
  }

  /** `resume`: restore the pause state from before the menu (false keeps the sim paused). */
  closePause(resume: boolean): void {
    this.pause.hide();
    if (resume && this.pausedByMenu) { this.pausedByMenu = false; this.d.host.setPaused(this.resumePaused); }
    this.d.onOverlayChange();
  }

  toggleHelp(): void {
    let list: ReturnType<UiHost['bindings']> = [];
    try { list = this.d.host.bindings(); } catch { list = []; }
    this.help.toggle(list, () => this.d.onOverlayChange());
    this.d.onOverlayChange();
  }

  /** Actions routed through Simulator.handleAction → UiManager. Returns true when consumed. */
  handleAction(a: SimAction): boolean {
    if (!this.active) return false;
    const panel = PANEL_ACTIONS[a];
    if (panel) { this.panels.toggle(panel); return true; }
    if (a === 'toggleHelp') { this.toggleHelp(); return true; }
    if (a === 'toggleHud') { this.hudToggle = !this.hudToggle; return false; } // the simulator toggles its HUD too
    const assist = ASSIST_ACTIONS[a];
    if (assist) this.pendingAssist = assist; // toast once the simulator has flipped it
    return false;
  }

  update(s: SimSnapshot, nowMs: number): void {
    this.now = nowMs;
    if (!this.active) return;
    this.status.update(s, nowMs);
    this.hud.enabled = this.hudToggle && this.d.iface().infoStrip;
    this.hud.update(s, this.d.units());
    this.hudShift.set(this.panels.toolbar.el.classList.contains('visible'));
    this.panels.update(s, nowMs);
    if (this.subUntil && nowMs > this.subUntil) { this.subUntil = 0; this.subVisible.set(false); }
    if (this.pendingAssist) this.flushAssistToast(s);
  }

  // ─── events (wired by UiManager) ──────────────────────────────────────────

  onAtcMessage(m: SimEvents['atc:message'], utcMs: number): void {
    this.panels.atc.addMessage(m, utcMs);
    if (!this.d.iface().subtitles || this.panels.isVisible('atc')) return;
    this.subFrom.set(m.from === 'atc' ? 'ATC' : 'You');
    this.subText.set(m.text);
    this.subtitle.classList.toggle('pilot', m.from === 'pilot');
    this.subVisible.set(true);
    this.subUntil = this.now + Math.max(4000, 70 * m.text.length);
  }

  onAtcOptions(p: SimEvents['atc:options']): void { this.panels.atc.setOptions(p); }

  onLanding(p: SimEvents['landing:scored']): void {
    if (!this.active) return;
    // a touch-and-go is scored on the climb-out: a modal would take the keyboard from the pilot
    if (landingPresentation(p.details) === 'toast') { this.d.ctx.toast(landingToastText(p.details, p.score), 'success', 6000); return; }
    this.report.show(p, this.d.units(), () => this.d.onOverlayChange());
    this.d.onOverlayChange();
  }

  onCrash(reason: string): void {
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.crashTimer = setTimeout(() => {
      this.crashTimer = null;
      if (this.active && !this.pause.visible) { this.report.hide(); this.openPause('Crashed', reason); }
    }, CRASH_MENU_DELAY_MS);
  }

  onAutopilot(st: AutopilotState): void {
    const was = this.apEngaged;
    this.apEngaged = st.engaged;
    if (!this.active || was === null || was === st.engaged || this.now < this.apGraceUntil) return;
    this.d.ctx.toast(st.engaged ? 'Autopilot engaged' : 'AP OFF — autopilot disconnected', st.engaged ? 'info' : 'warn');
  }

  /** A new flight (spawn, respawn, challenge): fresh panels, no stale overlays, not paused by us. */
  onFlightReset(): void {
    if (this.crashTimer) { clearTimeout(this.crashTimer); this.crashTimer = null; }
    this.pausedByMenu = false;
    this.pause.hide();
    this.pause.setTitle('Paused');
    this.report.hide();
    this.panels.reset();
    this.subUntil = 0; this.subVisible.set(false);
    this.apEngaged = null;
    this.apGraceUntil = this.now + AP_EVENT_GRACE_MS;
    this.d.onOverlayChange();
  }

  dispose(): void {
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.panels.dispose();
    for (const el of [this.pause.el, this.help.el, this.report.el, this.status.el, this.hud.el, this.subtitle]) el.remove();
  }

  private showPause(): void { this.pause.show(); this.d.onOverlayChange(); }

  private flushAssistToast(s: SimSnapshot): void {
    const key = this.pendingAssist!;
    this.pendingAssist = null;
    const meta = ASSIST_ITEMS.find((i) => i.key === key);
    const on = s.assists[key];
    this.d.ctx.toast(`${meta?.label ?? key} ${on ? 'ON' : 'OFF'}`, 'info');
    this.d.ctx.applySettings({ assists: { ...s.assists } });
  }
}
