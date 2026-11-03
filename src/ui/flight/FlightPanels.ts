/**
 * The in-flight toolbar and its draggable panels (ATC, checklist, nav log, VFR map, weather).
 * Panel contents are only updated while their panel is visible.
 */
import type { SimSnapshot } from '../../core/types';
import type { UiHost, UnitsSettings } from '../UiHost';
import type { ScreenContext } from '../screens/Screen';
import { WeatherPanel } from '../screens/WeatherPanel';
import { AtcWindow } from './AtcWindow';
import { Checklist } from './Checklist';
import { FloatingPanel, type LayoutStore } from './FloatingPanel';
import { NavLog } from './NavLog';
import { ObjectivesPanel } from './ObjectivesPanel';
import { CAMERA_MODES, Toolbar } from './Toolbar';
import { VfrMap } from './VfrMap';

export type PanelId = 'atc' | 'checklist' | 'navlog' | 'vfrmap' | 'weather' | 'objectives';
export const PANEL_IDS: readonly PanelId[] = ['atc', 'checklist', 'navlog', 'vfrmap', 'weather', 'objectives'];

export interface FlightPanelsDeps {
  host: UiHost;
  ctx: ScreenContext;
  layer: HTMLElement;
  layout: LayoutStore;
  units: () => UnitsSettings;
  /** toolbar "Controls" button */ onHelp: () => void;
  /** toolbar "Menu" button */ onMenu: () => void;
}

const ATC_INTERVAL_MS = 1000;

/** Default top of the panels in the top row (below the toolbar strip). */
const TOP_ROW_Y = 70;

/**
 * Top of a panel placed in the top row by default: 70 px, or just under the instruments HUD's flight
 * strip when the panel reaches it horizontally. The strip (src/instruments/hud, drawn in the
 * external views) is 620·k px wide, centred, from 12·k to 76·k px, k = clamp(min(h/600, (w−24)/620),
 * 0.45, 1.6); a panel at 70 px covered the bottom of its IAS / heading / ALT boxes on laptop-sized
 * windows (the objectives panel opens by itself at every activity start).
 */
export function topRowY(x: number, width: number, viewW: number, viewH: number): number {
  const k = Math.min(1.6, Math.max(0.45, Math.min(viewH / 600, (viewW - 24) / 620)));
  const left = viewW / 2 - 310 * k, right = viewW / 2 + 310 * k;
  if (x + width + 8 <= left || x - 8 >= right) return TOP_ROW_Y;
  return Math.max(TOP_ROW_Y, Math.round(76 * k + 10));
}

export class FlightPanels {
  readonly toolbar: Toolbar;
  readonly atc: AtcWindow;
  /** activity objectives (lessons, bush legs); its toolbar button shows while an activity is on */
  readonly objectives: ObjectivesPanel;
  private panels = new Map<PanelId, FloatingPanel>();
  private checklist: Checklist;
  private navlog: NavLog;
  private vfr: VfrMap;
  private weather: WeatherPanel;
  private lastAtc = -Infinity;
  private lastCamera = '';
  /** window size the default places were computed for */
  private view = { W: 1280, H: 800 };

  constructor(private readonly d: FlightPanelsDeps) {
    const W = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const H = typeof window !== 'undefined' ? window.innerHeight : 800;
    const mk = (id: PanelId, title: string, icon: 'headset' | 'checklist' | 'list' | 'map' | 'cloudSun' | 'target', w: number, hgt: number | undefined, x: number, y: number, tight = false) => {
      const p = new FloatingPanel(d.layer, d.layout, { id, title, icon, width: w, height: hgt, defaultPos: { x, y }, tight, onVisibility: (v) => this.toolbar?.setActive(id, v) });
      this.panels.set(id, p);
      return p;
    };
    const top = (x: number, w: number) => topRowY(x, w, W, H);
    const atcX = Math.max(16, W - 396), wxX = Math.max(16, Math.round(W / 2 - 210));
    const atcP = mk('atc', 'ATC', 'headset', 380, 420, atcX, top(atcX, 380));
    const clP = mk('checklist', 'Checklist', 'checklist', 400, 480, 16, top(16, 400));
    const nlP = mk('navlog', 'Nav log', 'list', 460, 260, 16, Math.max(80, H - 330));
    const vfrP = mk('vfrmap', 'VFR map', 'map', 420, 420, Math.max(16, W - 436), Math.max(80, H - 500), true);
    const wxP = mk('weather', 'Weather & time', 'cloudSun', 420, 560, wxX, top(wxX, 420));
    // top-left like MSFS's objectives; height follows the content (no fixed height)
    const objP = mk('objectives', 'Objectives', 'target', 340, undefined, 16, top(16, 340));
    this.view = { W, H };
    objP.el.classList.add('objectives-panel');
    this.atc = new AtcWindow(atcP.body, d.host);
    this.checklist = new Checklist(clP.body);
    this.navlog = new NavLog(nlP.body, d.host, d.units);
    this.vfr = new VfrMap(vfrP.body, d.host, d.units);
    this.weather = new WeatherPanel(d.ctx, { compact: true });
    wxP.body.appendChild(this.weather.el);
    this.objectives = new ObjectivesPanel(objP.body, d.host);

    this.toolbar = new Toolbar(d.layer, [
      { id: 'camera', label: 'Camera', icon: 'camera', onClick: () => { /* menu handled by the toolbar */ }, title: 'Camera views' },
      { id: 'objectives', label: 'Objectives', icon: 'target', onClick: () => this.toggle('objectives'), title: 'Activity objectives' },
      { id: 'atc', label: 'ATC', icon: 'headset', onClick: () => this.toggle('atc'), title: 'ATC (Scroll Lock)' },
      { id: 'checklist', label: 'Checklist', icon: 'checklist', onClick: () => this.toggle('checklist'), title: 'Checklist' },
      { id: 'navlog', label: 'Nav log', icon: 'list', onClick: () => this.toggle('navlog'), title: 'Nav log' },
      { id: 'vfrmap', label: 'VFR map', icon: 'map', onClick: () => this.toggle('vfrmap'), title: 'VFR map' },
      { id: 'weather', label: 'Weather', icon: 'cloudSun', onClick: () => this.toggle('weather'), title: 'Weather & time' },
      { id: 'controls', label: 'Controls', icon: 'keyboard', onClick: () => d.onHelp(), title: 'Controls cheat sheet' },
      { id: 'menu', label: 'Menu', icon: 'pause', onClick: () => d.onMenu(), title: 'Pause menu (Esc)' },
    ], { modes: CAMERA_MODES, onPick: (mode) => d.host.setCamera(mode) });
    this.toolbar.setItemVisible('objectives', false);
  }

  /** The Objectives toolbar button exists only while an activity is on (running or just finished). */
  setActivityAvailable(on: boolean): void {
    this.toolbar.setItemVisible('objectives', on);
    if (!on) this.hide('objectives');
  }

  isVisible(id: PanelId): boolean { return this.panels.get(id)?.visible ?? false; }
  toggle(id: PanelId): void { if (this.isVisible(id)) this.hide(id); else this.show(id); }
  show(id: PanelId): void { this.arrangeTopLeft(id); this.panels.get(id)?.show(); }
  hide(id: PanelId): void { this.panels.get(id)?.hide(); }
  hideAll(): void { for (const p of this.panels.values()) p.hide(); }
  /**
   * The objectives (during an activity) and the checklist share the top-left default slot: the
   * objectives keep it (as in MSFS) and a checklist the pilot has not placed opens beside them, not
   * exactly on top. Runs before `id` is shown; panels the pilot moved are left where they are.
   */
  private arrangeTopLeft(id: PanelId): void {
    const obj = this.panels.get('objectives'), cl = this.panels.get('checklist');
    if (!obj || !cl || cl.userPlaced || (id !== 'checklist' && id !== 'objectives')) return;
    // a visible checklist is only moved when the objectives appear (at an activity start, behind the loading screen)
    if (id === 'checklist' && cl.visible) return;
    const beside = id === 'objectives' || obj.visible;
    const o = obj.userPlaced ? null : obj.defaultRect;
    const d = cl.defaultRect;
    const x = beside && o ? o.x + (o.w ?? 340) + 12 : d.x;
    cl.placeAt(x, x === d.x ? d.y : topRowY(x, d.w ?? 400, this.view.W, this.view.H));
  }

  /** Settings › Reset window layout: every panel back to its default place now (not only after a reload). */
  resetPositions(): void { for (const p of this.panels.values()) p.resetPosition(); }
  /** Keeps panels on screen after a window resize. */
  clampAll(): void { for (const p of this.panels.values()) if (p.visible) p.clampToViewport(); }

  /** New flight: fresh checklist, empty ATC transcript. */
  reset(): void {
    this.checklist.resetAll();
    this.atc.reset();
    this.lastAtc = -Infinity;
  }

  /** Per frame while in flight; each panel throttles itself. Allocation-free when panels are closed. */
  update(s: SimSnapshot, nowMs: number): void {
    if (s.camera.mode !== this.lastCamera) { this.lastCamera = s.camera.mode; this.toolbar.setCameraMode(s.camera.mode); }
    if (this.isVisible('atc') && nowMs - this.lastAtc >= ATC_INTERVAL_MS) { this.lastAtc = nowMs; this.atc.update(s); }
    if (this.isVisible('checklist')) this.checklist.update(s, nowMs);
    if (this.isVisible('navlog')) this.navlog.update(s, nowMs);
    if (this.isVisible('vfrmap')) this.vfr.update(s, nowMs);
    if (this.isVisible('weather')) this.weather.update(s, nowMs);
    if (this.isVisible('objectives')) this.objectives.update(nowMs);
  }

  dispose(): void {
    this.toolbar.dispose();
    this.weather.dispose();
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}
