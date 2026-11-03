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
import { CAMERA_MODES, Toolbar } from './Toolbar';
import { VfrMap } from './VfrMap';

export type PanelId = 'atc' | 'checklist' | 'navlog' | 'vfrmap' | 'weather';
export const PANEL_IDS: readonly PanelId[] = ['atc', 'checklist', 'navlog', 'vfrmap', 'weather'];

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

export class FlightPanels {
  readonly toolbar: Toolbar;
  readonly atc: AtcWindow;
  private panels = new Map<PanelId, FloatingPanel>();
  private checklist: Checklist;
  private navlog: NavLog;
  private vfr: VfrMap;
  private weather: WeatherPanel;
  private lastAtc = -Infinity;
  private lastCamera = '';

  constructor(private readonly d: FlightPanelsDeps) {
    const W = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const H = typeof window !== 'undefined' ? window.innerHeight : 800;
    const mk = (id: PanelId, title: string, icon: 'headset' | 'checklist' | 'list' | 'map' | 'cloudSun', w: number, hgt: number, x: number, y: number, tight = false) => {
      const p = new FloatingPanel(d.layer, d.layout, { id, title, icon, width: w, height: hgt, defaultPos: { x, y }, tight, onVisibility: (v) => this.toolbar?.setActive(id, v) });
      this.panels.set(id, p);
      return p;
    };
    const atcP = mk('atc', 'ATC', 'headset', 380, 420, Math.max(16, W - 396), 70);
    const clP = mk('checklist', 'Checklist', 'checklist', 400, 480, 16, 70);
    const nlP = mk('navlog', 'Nav log', 'list', 460, 260, 16, Math.max(80, H - 330));
    const vfrP = mk('vfrmap', 'VFR map', 'map', 420, 420, Math.max(16, W - 436), Math.max(80, H - 500), true);
    const wxP = mk('weather', 'Weather & time', 'cloudSun', 420, 560, Math.max(16, Math.round(W / 2 - 210)), 70);
    this.atc = new AtcWindow(atcP.body, d.host);
    this.checklist = new Checklist(clP.body);
    this.navlog = new NavLog(nlP.body, d.host, d.units);
    this.vfr = new VfrMap(vfrP.body, d.host, d.units);
    this.weather = new WeatherPanel(d.ctx, { compact: true });
    wxP.body.appendChild(this.weather.el);

    this.toolbar = new Toolbar(d.layer, [
      { id: 'camera', label: 'Camera', icon: 'camera', onClick: () => { /* menu handled by the toolbar */ }, title: 'Camera views' },
      { id: 'atc', label: 'ATC', icon: 'headset', onClick: () => this.toggle('atc'), title: 'ATC (Scroll Lock)' },
      { id: 'checklist', label: 'Checklist', icon: 'checklist', onClick: () => this.toggle('checklist'), title: 'Checklist' },
      { id: 'navlog', label: 'Nav log', icon: 'list', onClick: () => this.toggle('navlog'), title: 'Nav log' },
      { id: 'vfrmap', label: 'VFR map', icon: 'map', onClick: () => this.toggle('vfrmap'), title: 'VFR map' },
      { id: 'weather', label: 'Weather', icon: 'cloudSun', onClick: () => this.toggle('weather'), title: 'Weather & time' },
      { id: 'controls', label: 'Controls', icon: 'keyboard', onClick: () => d.onHelp(), title: 'Controls cheat sheet' },
      { id: 'menu', label: 'Menu', icon: 'pause', onClick: () => d.onMenu(), title: 'Pause menu (Esc)' },
    ], { modes: CAMERA_MODES, onPick: (mode) => d.host.setCamera(mode) });
  }

  isVisible(id: PanelId): boolean { return this.panels.get(id)?.visible ?? false; }
  toggle(id: PanelId): void { this.panels.get(id)?.toggle(); }
  show(id: PanelId): void { this.panels.get(id)?.show(); }
  hide(id: PanelId): void { this.panels.get(id)?.hide(); }
  hideAll(): void { for (const p of this.panels.values()) p.hide(); }
  /** Keeps panels on screen after a window resize. */
  clampAll(): void { for (const p of this.panels.values()) if (p.visible) p.clampToViewport(); }

  /** New flight: fresh checklist, empty ATC transcript. */
  reset(): void {
    this.checklist.resetAll();
    this.atc.clearLog();
  }

  /** Per frame while in flight; each panel throttles itself. Allocation-free when panels are closed. */
  update(s: SimSnapshot, nowMs: number): void {
    if (s.camera.mode !== this.lastCamera) { this.lastCamera = s.camera.mode; this.toolbar.setCameraMode(s.camera.mode); }
    if (this.isVisible('atc') && nowMs - this.lastAtc >= ATC_INTERVAL_MS) { this.lastAtc = nowMs; this.atc.update(s); }
    if (this.isVisible('checklist')) this.checklist.update(s, nowMs);
    if (this.isVisible('navlog')) this.navlog.update(s, nowMs);
    if (this.isVisible('vfrmap')) this.vfr.update(s, nowMs);
    if (this.isVisible('weather')) this.weather.update(s);
  }

  dispose(): void {
    this.toolbar.dispose();
    this.weather.dispose();
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}
