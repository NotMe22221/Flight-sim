/** Settings › Data & credits: host.dataCredits(), storage resets. */
import { button, clear, h } from '../../dom';
import { group, type SettingsTabView, type TabDeps } from './types';

const FALLBACK_CREDITS = [
  'Elevation: AWS Terrain Tiles (Mapzen Terrarium; public domain / CC-BY sources)',
  'Imagery: EOX Sentinel-2 cloudless (CC BY 4.0); NASA GIBS Blue Marble',
  'Airports: OurAirports (public domain)',
];

export class DataTab implements SettingsTabView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private armed = 0;
  private resetBtn: HTMLButtonElement;

  constructor(private readonly d: TabDeps) {
    this.list = h('ul', { class: 'credits-list' });
    this.resetBtn = button('Reset all settings', () => this.resetAll(), { cls: 'btn-sm', icon: 'restart', title: 'Graphics, audio, units, assistance and interface back to defaults' });
    const storage = h('div', { class: 'col' },
      h('div', { class: 'muted', style: 'font-size:.85em', text: 'Settings, key bindings, window positions, your last flight selection and challenge best scores are stored in this browser only.' }),
      h('div', { class: 'row wrap' },
        d.ctx.resetLayout ? button('Reset window layout', () => { d.ctx.resetLayout?.(); d.ctx.toast('Panel positions reset', 'success'); }, { cls: 'btn-sm', icon: 'layers' }) : null,
        this.resetBtn));
    this.el = h('div', { class: 'settings-grid' }, group('Data sources & licences', this.list), group('Storage', storage));
  }

  onShow(): void {
    clear(this.list);
    let lines: string[] = [];
    try { lines = this.d.ctx.host.dataCredits(); } catch { lines = []; }
    for (const l of lines.length ? lines : FALLBACK_CREDITS) this.list.appendChild(h('li', { text: l }));
  }

  sync(): void { /* nothing derived from settings */ }

  private resetAll(): void {
    const now = Date.now();
    if (now > this.armed) {
      this.armed = now + 3000;
      this.resetBtn.classList.add('btn-danger');
      this.d.ctx.toast('Click "Reset all settings" again to confirm', 'warn');
      setTimeout(() => { if (Date.now() >= this.armed) this.resetBtn.classList.remove('btn-danger'); }, 3050);
      return;
    }
    this.armed = 0;
    this.resetBtn.classList.remove('btn-danger');
    this.d.dispatch({ type: 'resetAll' });
    this.d.ctx.toast('Settings restored to defaults', 'success');
  }
}
