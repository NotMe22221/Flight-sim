/**
 * UiManager — the UI layer's single entry point. Owns the DOM overlay (.fs-ui with hud, flight,
 * screens and modal layers), routes between screens with history (Esc = back in menus; in
 * flight Esc toggles the pause menu), decides when the UI owns the keyboard (host.captureInput),
 * subscribes to host.events, persists settings and pushes them to the host at startup.
 *
 * Integrator: `const ui = new UiManager(container, host); ui.onStart(() => audio.resume());`
 * then per frame `ui.update(snapshot, dt)` and route discrete actions through `ui.handleAction(a)`.
 */
import type { SimAction, SimSnapshot, SpawnState } from '../core/types';
import type { UiHost } from './UiHost';
import { h } from './dom';
import { EscapeDeduper, ScreenRouter, isTextEntry, shouldCaptureInput } from './routing';
import { SelectionStore } from './selection';
import { loadSettings, sanitizeSettings, saveSettings, type PersistedSettings } from './settingsStore';
import { sameFlat } from './settingsModel';
import { FlightLauncher } from './flightLauncher';
import type { Screen, ScreenContext, ScreenId } from './screens/Screen';
import { LoadingScreen } from './screens/LoadingScreen';
import { MainMenu } from './screens/MainMenu';
import { WorldMap } from './screens/WorldMap';
import { AircraftSelect } from './screens/AircraftSelect';
import { WeatherScreen } from './screens/WeatherScreen';
import { Settings } from './screens/Settings';
import { CreditsScreen } from './screens/CreditsScreen';
import { Activities } from './screens/Activities';
import { FlightUi } from './flight/FlightUi';
import { LayoutStore } from './flight/FloatingPanel';
import { Toasts } from './flight/Toasts';

export type UiScreen = ScreenId;
type MenuId = Exclude<ScreenId, 'flight'>;

export class UiManager {
  /** The `.fs-ui` overlay element (appended to the container). */
  readonly root: HTMLElement;
  private readonly layers: { hud: HTMLElement; flight: HTMLElement; screens: HTMLElement; modal: HTMLElement };
  private readonly router = new ScreenRouter('loading');
  private readonly esc = new EscapeDeduper();
  private readonly layout = new LayoutStore();
  private readonly selection: SelectionStore;
  private readonly ctx: ScreenContext;
  private readonly screens: Record<MenuId, Screen>;
  private readonly loading: LoadingScreen;
  private readonly flight: FlightUi;
  private readonly toasts: Toasts;
  private readonly launcher: FlightLauncher;
  private settings: PersistedSettings;
  private startCbs: (() => void)[] = [];
  private started = false;
  private _inFlight = false;
  private captured: boolean | null = null;
  private textFocus = false;
  private lastPct = -1;
  private nowMs = 0;
  private disposed = false;
  private unsubs: (() => void)[] = [];

  constructor(container: HTMLElement, private readonly host: UiHost) {
    this.settings = loadSettings();
    const layer = (cls: string) => h('div', { class: `ui-layer ${cls}` });
    this.layers = { hud: layer('ui-layer-hud'), flight: layer('ui-layer-flight'), screens: layer('ui-layer-screens'), modal: layer('ui-layer-modal') };
    this.root = h('div', { class: 'fs-ui' }, this.layers.hud, this.layers.flight, this.layers.screens, this.layers.modal);
    container.appendChild(this.root);
    this.applyInterface();

    this.selection = new SelectionStore(host);
    this.toasts = new Toasts(this.layers.modal);
    this.launcher = new FlightLauncher({
      host, selection: this.selection, toast: (t) => this.toasts.push(t),
      beginLoading: () => this.beginFlightLoading(),
      enterFlight: () => { this._inFlight = true; this.navigate('flight'); },
      restore: (saved) => { this.router.restore(saved[0] === 'loading' ? ['main'] : saved); this.applyRoute(); },
    });
    this.ctx = {
      host,
      selection: this.selection,
      settings: () => this.settings,
      applySettings: (patch) => this.applySettings(patch),
      navigate: (id) => this.navigate(id),
      back: () => this.back(),
      fly: () => { void this.launcher.fly(); },
      inFlight: () => this._inFlight,
      toast: (text, kind, durationMs) => this.toasts.push({ text, kind, ...(durationMs ? { durationMs } : {}) }),
      resetLayout: () => this.layout.reset(),
      startChallenge: (id) => { void this.launcher.startChallenge(id); },
      resumeFlight: () => {
        if (!this._inFlight) return;
        this.navigate('flight');
        if (this.flight.pause.visible) this.flight.closePause(true);
      },
    };

    this.loading = new LoadingScreen();
    this.loading.onStart = () => this.fireStart();
    this.loading.onDismiss = () => { if (this.router.current === 'loading' && !this.launcher.flying) this.navigate('main'); };
    this.screens = {
      loading: this.loading,
      main: new MainMenu(this.ctx),
      worldmap: new WorldMap(this.ctx),
      aircraft: new AircraftSelect(this.ctx),
      weather: new WeatherScreen(this.ctx),
      settings: new Settings(this.ctx),
      credits: new CreditsScreen(this.ctx),
      activities: new Activities(this.ctx),
    };
    for (const s of Object.values(this.screens)) this.layers.screens.appendChild(s.el);

    this.flight = new FlightUi({
      host, ctx: this.ctx, hudLayer: this.layers.hud, flightLayer: this.layers.flight, modalLayer: this.layers.modal, layout: this.layout,
      units: () => this.settings.units, iface: () => this.settings.ui, onOverlayChange: () => this.syncCapture(),
    });

    this.subscribe();
    this.bindDom();
    this.pushAllSettings();
    this.loading.setMode('boot');
    this.loading.setProgress(1);
    this.applyRoute();
  }

  /** True once a flight has been spawned (stays true while the flight is paused behind menus). */
  get inFlight(): boolean { return this._inFlight; }
  /** The visible screen ('flight' when the 3D view is unobstructed). */
  get current(): UiScreen { return this.router.current; }
  /**
   * True while an opaque full-screen menu or loading screen hides the 3D view completely, so the
   * integrator can skip or throttle `renderer.render` (every menu screen has an opaque background).
   */
  get coversView(): boolean { return this.router.current !== 'flight'; }

  /** Shows a screen. 'loading' shows the boot splash before the first flight, else flight loading. */
  show(screen: UiScreen): void {
    if (screen === 'loading' && this.router.current !== 'loading') this.loading.setMode(this._inFlight || this.launcher.flying ? 'flight' : 'boot');
    if (screen === 'settings') this.syncAssistsFromSim();
    this.router.navigate(screen);
    this.applyRoute();
  }

  /** Called once on the first user gesture (boot "click to start"); the integrator resumes audio here. */
  onStart(cb: () => void): void {
    if (this.started) { try { cb(); } catch (e) { console.error('[ui] onStart callback threw', e); } return; }
    this.startCbs.push(cb);
  }

  /** Per frame: only the visible screen / flight widgets update (each writes the DOM only on change). */
  update(snapshot: SimSnapshot, _dt: number): void {
    if (this.disposed) return;
    this.nowMs = performance.now();
    const route = this.router.current;
    if (route === 'flight') this.flight.update(snapshot, this.nowMs);
    else this.screens[route].update(snapshot, this.nowMs);
  }

  /** Discrete actions from Simulator.handleAction. Returns true when the UI consumed the action. */
  handleAction(a: SimAction): boolean {
    if (this.disposed) return false;
    if (a === 'toggleMenu') {
      if (!this.esc.isEcho(performance.now())) this.escape();
      return true;
    }
    return this.router.current === 'flight' ? this.flight.handleAction(a) : false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.removeGestureListeners();
    for (const s of Object.values(this.screens)) { s.hide(); s.dispose(); }
    this.flight.dispose();
    this.toasts.clear();
    if (this.captured) { try { this.host.captureInput(false); } catch { /* host gone */ } }
    this.root.remove();
  }

  // ─── routing ──────────────────────────────────────────────────────────────

  private navigate(id: ScreenId): void {
    if (id === 'settings') this.syncAssistsFromSim();
    if (this.router.navigate(id)) this.applyRoute();
  }

  private back(): void { if (this.router.back(this._inFlight)) this.applyRoute(); }

  private applyRoute(): void {
    const route = this.router.current;
    for (const [id, s] of Object.entries(this.screens) as [MenuId, Screen][]) if (id !== route) s.hide();
    const inFlightView = route === 'flight';
    this.root.classList.toggle('capturing', !inFlightView);
    if (inFlightView) {
      // a focused field in a hidden screen would swallow flight keys (the input module ignores editable targets)
      const a = document.activeElement as HTMLElement | null;
      if (a && this.root.contains(a)) a.blur();
      this.textFocus = false;
      this.flight.setActive(true);
    } else {
      this.flight.setActive(false);
      const s = this.screens[route];
      s.show();
      if (!s.el.contains(document.activeElement)) s.focus();
    }
    this.syncCapture();
  }

  /** Esc key or a gamepad Menu button. */
  private escape(): void {
    const route = this.router.current;
    if (route === 'loading') { if (this.loading.currentMode === 'boot') this.loading.start(); return; }
    if (route === 'flight') this.flight.escape();
    else this.back();
  }

  private syncCapture(): void {
    // a field hidden while focused (overlay closed, screen switched) must not keep the keyboard
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && this.root.contains(a) && a.getClientRects().length === 0) { a.blur(); this.textFocus = false; }
    // `flight` is unset while FlightUi itself is being constructed
    const overlayOpen = this.flight ? this.flight.overlayOpen : false;
    const want = shouldCaptureInput({ route: this.router.current, overlayOpen, textFocus: this.textFocus });
    if (want === this.captured) return;
    this.captured = want;
    try { this.host.captureInput(want); } catch (e) { console.warn('[ui] captureInput failed', e); }
  }

  // ─── flights ──────────────────────────────────────────────────────────────

  /** Flight loading screen (progress from 'terrain:progress'); returns the history to restore on failure. */
  private beginFlightLoading(): ScreenId[] {
    const saved = this.router.save();
    this.loading.setMode('flight');
    this.lastPct = -1;
    this.loading.setProgress(0);
    if (this.router.navigate('loading')) this.applyRoute();
    return saved;
  }

  // ─── events ───────────────────────────────────────────────────────────────

  private subscribe(): void {
    const ev = this.host.events;
    this.unsubs.push(
      ev.on('ui:toast', (p) => this.toasts.push(p)),
      ev.on('terrain:progress', (p) => {
        if (this.router.current !== 'loading' || this.loading.currentMode !== 'flight') return;
        const pct = Math.round(p.ready * 100);
        if (pct !== this.lastPct) { this.lastPct = pct; this.loading.setProgress(p.ready); }
      }),
      ev.on('landing:scored', (p) => { this.flight.onLanding(p); this.launcher.recordScore(p.score); }),
      ev.on('atc:message', (m) => this.flight.onAtcMessage(m, this.safeUtc())),
      ev.on('atc:options', (p) => this.flight.onAtcOptions(p)),
      ev.on('aircraft:crash', (p) => this.flight.onCrash(p.reason)),
      ev.on('autopilot:changed', (p) => this.flight.onAutopilot(p.state)),
      ev.on('flight:reset', (p) => this.onFlightReset(p.spawn)),
    );
  }

  private onFlightReset(spawn: SpawnState): void {
    this._inFlight = true;
    this.launcher.onFlightReset(spawn);
    this.flight.onFlightReset();
    // a flight started outside the UI (automation, a hotkey) is shown right away
    if (!this.launcher.flying && this.router.current !== 'flight') this.navigate('flight');
  }

  private safeUtc(): number { try { return this.host.snapshot().time.utcMs; } catch { return Date.now(); } }

  // ─── settings ─────────────────────────────────────────────────────────────

  private applySettings(patch: Partial<Omit<PersistedSettings, 'version'>>): void {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    saveSettings(this.settings);
    this.pushSettings(patch);
  }

  private pushAllSettings(): void {
    const s = this.settings;
    this.pushSettings({ graphics: s.graphics, audio: s.audio, units: s.units, assists: s.assists, ui: s.ui });
  }

  private pushSettings(p: Partial<Omit<PersistedSettings, 'version'>>): void {
    const s = this.settings;
    const safe = (what: string, f: () => void) => { try { f(); } catch (e) { console.warn(`[ui] host.${what} failed`, e); } };
    if (p.graphics) safe('setGraphics', () => this.host.setGraphics({ ...s.graphics }));
    if (p.audio) safe('setAudio', () => this.host.setAudio({ ...s.audio }));
    if (p.units) safe('setUnits', () => this.host.setUnits({ ...s.units }));
    if (p.assists) safe('setAssists', () => this.host.setAssists({ ...s.assists }));
    if (p.ui) {
      this.applyInterface();
      if (this.host.setInfoStrip) safe('setInfoStrip', () => this.host.setInfoStrip!(s.ui.infoStrip));
    }
  }

  private applyInterface(): void { this.root.style.setProperty('--ui-scale', String(this.settings.ui.scale)); }

  /** Assists can be toggled by hotkeys in flight; Settings must show the simulator's effective state. */
  private syncAssistsFromSim(): void {
    if (!this._inFlight) return;
    try {
      const live = this.host.snapshot().assists;
      if (live && !sameFlat(live, this.settings.assists)) { this.settings = sanitizeSettings({ ...this.settings, assists: { ...live } }); saveSettings(this.settings); }
    } catch { /* snapshot not ready */ }
  }

  // ─── DOM plumbing ─────────────────────────────────────────────────────────

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // untrusted: the Esc that Settings › Controls synthesizes to end a pending rebind
    if (this.disposed || e.defaultPrevented || !e.isTrusted) return;
    const route = this.router.current;
    if (route !== 'flight' && this.screens[route].onKey(e)) { e.preventDefault(); return; }
    if (e.key !== 'Escape' || e.repeat) return;
    this.esc.noteKey(performance.now());
    e.preventDefault();
    this.escape();
  };

  private readonly onResize = (): void => { if (this.router.current === 'flight') this.flight.panels.clampAll(); };
  private readonly onFirstGesture = (): void => this.fireStart();

  private bindDom(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointerdown', this.onFirstGesture, true);
    window.addEventListener('keydown', this.onFirstGesture, true);
    this.root.addEventListener('focusin', (e) => { this.textFocus = isTextEntry(e.target as HTMLElement | null); this.syncCapture(); });
    this.root.addEventListener('focusout', (e) => { this.textFocus = isTextEntry(e.relatedTarget as HTMLElement | null); this.syncCapture(); });
  }

  private removeGestureListeners(): void {
    window.removeEventListener('pointerdown', this.onFirstGesture, true);
    window.removeEventListener('keydown', this.onFirstGesture, true);
  }

  /** First user gesture anywhere (or the boot screen click): run the onStart callbacks once. */
  private fireStart(): void {
    if (this.started) return;
    this.started = true;
    this.removeGestureListeners();
    for (const cb of this.startCbs.splice(0)) { try { cb(); } catch (e) { console.error('[ui] onStart callback threw', e); } }
  }
}
