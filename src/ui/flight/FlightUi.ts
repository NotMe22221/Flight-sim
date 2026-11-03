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
import { autopilotToast } from '../apAnnunciator';
import { Cls, Txt, h } from '../dom';
import { releasesFocusAfter } from '../routing';
import { FlightPanels, type PanelId } from './FlightPanels';
import type { LayoutStore } from './FloatingPanel';
import { HelpOverlay } from './HelpOverlay';
import { HudStrip } from './HudStrip';
import { LandingReport } from './LandingReport';
import { landingBand, landingPresentation, landingToastText } from '../landingReportModel';
import { PauseMenu, type PauseActivityInfo } from './PauseMenu';
import { StatusBar } from './StatusBar';
import { InstructorSubtitle } from './InstructorSubtitle';
import { DebriefCard } from './DebriefCard';
import { BUSH_TRIPS } from '../../activities/bushTrips';
import { debriefVm, finishPresentation, finishToastText, type ProgressPayload } from '../activityModels';

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
/** the debrief follows the activity's last line ("Welcome to Monterey Regional. Leg complete.") */
const DEBRIEF_DELAY_MS = 1800;

/** The activity the flight belongs to (from 'activity:started'). */
interface ActivityInfo { id: string; title: string; kind: 'lesson' | 'bushTrip' }

export class FlightUi {
  readonly panels: FlightPanels;
  readonly pause: PauseMenu;
  readonly help: HelpOverlay;
  readonly report: LandingReport;
  readonly debrief: DebriefCard;
  private status: StatusBar;
  private instructor: InstructorSubtitle;
  private activity: ActivityInfo | null = null;
  /** the pilot ended the activity from the pause menu: its 'activity:finished' is a toast, not a debrief */
  private abortRequested = false;
  /** the UI ended it to start something else (free flight, challenge): nothing is shown */
  private quietFinish = false;
  private debriefTimer: ReturnType<typeof setTimeout> | null = null;
  /** a debrief that arrived while the flight view was hidden */
  private pendingDebrief = false;
  /** the landing scored during the running activity (the debrief can re-open its report) */
  private activityLanding: SimEvents['landing:scored'] | null = null;
  private crashReason: string | null = null;
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
    this.instructor = new InstructorSubtitle(d.hudLayer);
    this.pause = new PauseMenu(d.modalLayer, {
      resume: () => this.closePause(true),
      restart: () => {
        this.closePause(false); this.pausedByMenu = false;
        // an activity restarts from its set-up (weather, time, route); a free flight respawns in place
        if (this.activityRunning() && d.host.restartActivity && d.ctx.restartActivity) d.ctx.restartActivity();
        else d.host.dispatch('resetFlight');
      },
      restartStep: () => { try { d.host.restartActivityStep?.(); } catch (e) { console.warn('[ui] restartActivityStep failed', e); } this.closePause(true); },
      abortActivity: () => this.abortActivity(),
      worldMap: () => { this.closePause(false); d.ctx.navigate('worldmap'); },
      settings: () => { this.closePause(false); d.ctx.navigate('settings'); },
      mainMenu: () => { this.closePause(false); d.ctx.navigate('main'); },
    });
    this.help = new HelpOverlay(d.modalLayer);
    this.report = new LandingReport(d.modalLayer);
    this.debrief = new DebriefCard(d.modalLayer);
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
  get overlayOpen(): boolean { return this.pause.visible || this.help.visible || this.report.visible || this.debrief.visible; }
  get isActive(): boolean { return this.active; }

  /** The 'flight' route became visible/hidden. Returning to a flight paused by the menu re-opens it. */
  setActive(on: boolean): void {
    this.active = on;
    this.d.hudLayer.style.display = on ? '' : 'none';
    this.d.flightLayer.style.display = on ? '' : 'none';
    this.panels.toolbar.setEnabled(on);
    // frames spent in a menu were not watched: a disconnect from back then must not flash now
    if (on) {
      this.hud.rebase(); this.panels.clampAll();
      if (this.pausedByMenu && !this.pause.visible) this.showPause();
      else if (this.pendingDebrief) this.scheduleDebrief(400);
    } else { this.help.hide(); this.report.hide(); this.debrief.hide(); if (this.pause.visible) this.pause.hide(); }
    this.d.onOverlayChange();
  }

  /** Esc in flight: close the topmost overlay, otherwise toggle the pause menu. */
  escape(): void {
    if (this.help.visible) this.help.hide();
    else if (this.debrief.visible) this.debrief.hide();
    else if (this.report.visible) this.report.hide();
    else if (this.pause.visible) this.closePause(true);
    else this.openPause();
    this.d.onOverlayChange();
  }

  openPause(title = 'Paused', note = ''): void {
    this.pause.setTitle(title, note);
    this.pause.setActivity(this.pauseActivityInfo());
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
    this.hud.update(s, this.d.units(), nowMs);
    this.hudShift.set(this.panels.toolbar.el.classList.contains('visible'));
    this.panels.update(s, nowMs);
    this.instructor.update(nowMs, s.paused);
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
    // during an activity the pilot still has to stop (bush legs) and the debrief follows with the
    // score: a toast now, the full report from the debrief's "Landing report"
    if (this.activityRunning()) {
      this.activityLanding = p;
      this.d.ctx.toast(`Landing${p.details && typeof p.details.runway === 'string' ? ` · ${p.details.runway}` : ''} · ${Math.round(p.score).toLocaleString('en-US')} · ${landingBand(p.details, p.score)}`, 'success', 6000);
      return;
    }
    this.report.show(p, this.d.units(), () => this.d.onOverlayChange());
    this.d.onOverlayChange();
  }

  onCrash(reason: string): void {
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.crashReason = reason;
    this.crashTimer = setTimeout(() => {
      this.crashTimer = null;
      // an activity's debrief (with Retry) replaces the crash menu; closing it opens the menu
      if (this.debrief.visible || this.debriefTimer || this.pendingDebrief) return;
      if (this.active && !this.pause.visible) { this.report.hide(); this.openPause('Crashed', reason); }
    }, CRASH_MENU_DELAY_MS);
  }

  onAutopilot(st: AutopilotState): void {
    const was = this.apEngaged;
    this.apEngaged = st.engaged;
    if (!this.active || this.now < this.apGraceUntil) return;
    // the autopilot reports why it let go (GFC 700): the toast says so when it was not the pilot
    const t = autopilotToast(was, st);
    if (t) this.d.ctx.toast(t.text, t.kind);
  }

  /** A new flight (spawn, respawn, challenge): fresh panels, no stale overlays, not paused by us. */
  onFlightReset(): void {
    if (this.crashTimer) { clearTimeout(this.crashTimer); this.crashTimer = null; }
    this.crashReason = null;
    this.pausedByMenu = false;
    this.pause.hide();
    this.pause.setTitle('Paused');
    this.report.hide();
    this.panels.reset();
    this.subUntil = 0; this.subVisible.set(false);
    // the runner sees the reset first: a respawn at the activity's start restarted it (its first
    // instruction is already queued), a spawn for a new activity is 'starting'; anything else
    // leaves no activity on this flight
    this.cancelDebrief();
    this.debrief.hide();
    this.activityLanding = null;
    if (!this.activityRunning() && this.runnerPhase() !== 'starting') this.clearActivity();
    // the new flight's autopilot state is the baseline (null here used to swallow the first
    // engagement of every flight: no "Autopilot engaged" toast after a spawn)
    try { this.apEngaged = this.d.host.snapshot().autopilot.engaged; } catch { this.apEngaged = null; }
    this.apGraceUntil = this.now + AP_EVENT_GRACE_MS;
    this.hud.rebase();
    this.d.onOverlayChange();
  }

  dispose(): void {
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.cancelDebrief();
    this.panels.dispose();
    for (const el of [this.pause.el, this.help.el, this.report.el, this.debrief.el, this.status.el, this.hud.el, this.subtitle, this.instructor.el]) el.remove();
  }

  // ─── activities (lessons, bush legs) ──────────────────────────────────────

  onActivityStarted(p: SimEvents['activity:started']): void {
    this.activity = { id: p.id, title: p.title, kind: p.kind };
    this.abortRequested = false;
    this.activityLanding = null;
    this.cancelDebrief();
    this.debrief.hide();
    this.instructor.clear();
    this.instructor.setKind(p.kind);
    this.panels.objectives.begin(p);
    this.panels.setActivityAvailable(true);
    this.panels.show('objectives');
    this.d.onOverlayChange();
  }

  onActivityInstruction(p: SimEvents['activity:instruction']): void { this.instructor.push(p.text, p.important === true); }

  onActivityProgress(p: SimEvents['activity:progress']): void { this.panels.objectives.setProgress(p as ProgressPayload); }

  onActivityFinished(p: SimEvents['activity:finished']): void {
    this.panels.objectives.finish(p);
    let reason: string | null = null;
    try { const r = this.d.host.activityRunner?.result; reason = r && r.id === p.id ? r.reason : null; } catch { reason = null; }
    const how = finishPresentation({ replacing: this.quietFinish, userAborted: this.abortRequested, reason });
    this.abortRequested = false;
    if (how === 'none') return; // another activity is taking over (Retry, Start, Next leg)
    if (how === 'toast') {
      this.d.ctx.toast(finishToastText(this.activity?.kind, this.activity?.title ?? p.id, reason), 'info', 5000);
      this.clearActivity();
      return;
    }
    if (this.active) this.scheduleDebrief(DEBRIEF_DELAY_MS); else this.pendingDebrief = true;
  }

  /**
   * The UI is about to start something else (a free flight, a landing challenge): end the running
   * activity without a debrief or toast.
   */
  endActivityQuietly(): void {
    if (!this.activityRunning() && this.runnerPhase() !== 'starting') { this.cancelDebrief(); this.clearActivity(); return; }
    this.quietFinish = true;
    try { this.d.host.abortActivity?.(); } catch (e) { console.warn('[ui] abortActivity failed', e); }
    this.quietFinish = false;
    this.cancelDebrief();
    this.debrief.hide();
    this.clearActivity();
  }

  private runnerPhase(): string {
    try { return this.d.host.activityRunner?.phase ?? 'idle'; } catch { return 'idle'; }
  }

  private activityRunning(): boolean { return this.runnerPhase() === 'running'; }

  private pauseActivityInfo(): PauseActivityInfo | null {
    if (!this.activityRunning()) return null;
    const r = this.d.host.activityRunner;
    const def = r?.def;
    const title = def?.title ?? this.activity?.title ?? 'Activity';
    const steps = def?.steps.length ?? 0;
    const step = r && r.stepIndex >= 0 && steps ? ` · step ${Math.min(r.stepIndex + 1, steps)} of ${steps}` : '';
    const kind = (def?.kind ?? this.activity?.kind) === 'bushTrip' ? 'Bush trip' : 'Lesson';
    return { label: `${kind} · ${title}${step}`, canRestartStep: typeof this.d.host.restartActivityStep === 'function', canAbort: typeof this.d.host.abortActivity === 'function' };
  }

  private abortActivity(): void {
    this.abortRequested = true;
    try { this.d.host.abortActivity?.(); } catch (e) { console.warn('[ui] abortActivity failed', e); }
    this.abortRequested = false;
    // stay paused in the menu, now without the activity items
    this.pause.setActivity(null);
    this.pause.setTitle('Paused', 'Activity aborted · you are in free flight');
    this.d.onOverlayChange();
  }

  /** No activity on this flight any more: idle objectives, no toolbar button, no subtitles. */
  private clearActivity(): void {
    this.activity = null;
    this.activityLanding = null;
    this.pendingDebrief = false;
    this.instructor.clear();
    this.panels.objectives.idle();
    this.panels.setActivityAvailable(false);
  }

  private scheduleDebrief(ms: number): void {
    this.cancelDebrief();
    this.pendingDebrief = false;
    this.debriefTimer = setTimeout(() => { this.debriefTimer = null; this.showDebrief(); }, ms);
  }

  private cancelDebrief(): void { if (this.debriefTimer) { clearTimeout(this.debriefTimer); this.debriefTimer = null; } this.pendingDebrief = false; }

  private showDebrief(): void {
    const host = this.d.host;
    let result = null as NonNullable<UiHost['activityRunner']>['result'];
    let def = null as NonNullable<UiHost['activityRunner']>['def'];
    try { result = host.activityRunner?.result ?? null; def = host.activityRunner?.def ?? null; } catch { result = null; }
    if (!result || !this.active) { if (!this.active) this.pendingDebrief = true; return; }
    if (this.pause.visible) this.closePause(false);
    this.report.hide();
    const vm = debriefVm(result, def && def.id === result.id ? def : null, BUSH_TRIPS, host.activityProgress);
    const landing = this.activityLanding;
    const crashed = this.crashReason;
    this.debrief.show(vm, {
      retry: host.restartActivity && this.d.ctx.restartActivity ? () => this.d.ctx.restartActivity!() : undefined,
      nextLeg: host.startBushLeg && this.d.ctx.startBushLeg ? (tripId, i) => this.d.ctx.startBushLeg!(tripId, i) : undefined,
      landingDetails: landing ? () => this.report.show(landing, this.d.units(), () => { this.d.onOverlayChange(); if (!this.debrief.visible && this.active && this.runnerPhase() === 'finished') this.showDebrief(); }) : undefined,
      onClose: (byAction) => {
        // after a crash the menu (Restart flight, World map …) is the way on
        if (!byAction && crashed && this.active && this.runnerPhase() === 'finished') this.openPause('Crashed', crashed);
        this.d.onOverlayChange();
      },
    });
    this.d.onOverlayChange();
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
