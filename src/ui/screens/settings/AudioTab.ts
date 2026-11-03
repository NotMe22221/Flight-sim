/** Settings › Audio: master and per-bus volumes, applied live. */
import type { AudioSettings } from '../../UiHost';
import { h, slider, type SliderHandle } from '../../dom';
import { group, type SettingsTabView, type TabDeps } from './types';

const BUSES: { key: keyof AudioSettings; label: string; help: string }[] = [
  { key: 'master', label: 'Master', help: '' },
  { key: 'engine', label: 'Engine', help: 'Engine, propeller and exhaust' },
  { key: 'environment', label: 'Environment', help: 'Wind, rain, rolling and touchdown' },
  { key: 'cockpit', label: 'Cockpit', help: 'Switches, warnings and the stall horn' },
  { key: 'ui', label: 'Interface', help: 'Menu clicks and notifications' },
  { key: 'atc', label: 'ATC voices', help: 'Controller and pilot speech' },
];

export class AudioTab implements SettingsTabView {
  readonly el: HTMLElement;
  private sliders = new Map<keyof AudioSettings, SliderHandle>();

  constructor(private readonly d: TabDeps) {
    const a = d.ctx.settings().audio;
    const rows = BUSES.map((b) => {
      const s = slider({ min: 0, max: 100, step: 1, value: Math.round(a[b.key] * 100), label: b.label, format: (v) => `${v}%`,
        onInput: (v) => d.dispatch({ type: 'audio', key: b.key, value: v / 100 }) });
      if (b.help) s.el.title = b.help;
      this.sliders.set(b.key, s);
      return s.el;
    });
    this.el = h('div', { class: 'settings-grid' },
      group('Volume', ...rows, h('div', { class: 'muted', style: 'font-size:.85em', text: 'Sound starts after your first click or key press (browser autoplay rules).' })));
  }

  sync(): void {
    const a = this.d.ctx.settings().audio;
    for (const [k, s] of this.sliders) if (document.activeElement !== s.input) s.set(Math.round(a[k] * 100));
  }
}
