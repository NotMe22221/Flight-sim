/** Settings › General: units, assistance (preset + per-item effective state), interface. */
import type { AssistLevel } from '../../../core/types';
import type { UnitsSettings } from '../../UiHost';
import { Txt, h, segmented, select, slider, toggle, type SegmentedHandle, type SliderHandle, type ToggleHandle } from '../../dom';
import { ASSIST_LEVELS, type AssistKey } from '../../assistPresets';
import { assistView, unitSystemOf, type UnitSystem } from '../../settingsModel';
import { UI_SCALE_MAX, UI_SCALE_MIN } from '../../settingsStore';
import { fieldRow, group, type SettingsTabView, type TabDeps } from './types';

type UnitKey = keyof UnitsSettings;
const UNIT_OPTIONS: { key: UnitKey; label: string; options: { value: string; label: string }[] }[] = [
  { key: 'altitude', label: 'Altitude', options: [{ value: 'ft', label: 'Feet (ft)' }, { value: 'm', label: 'Metres (m)' }] },
  { key: 'speed', label: 'Speed', options: [{ value: 'kt', label: 'Knots (kt)' }, { value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }] },
  { key: 'pressure', label: 'Pressure', options: [{ value: 'inHg', label: 'inHg' }, { value: 'hPa', label: 'hPa' }] },
  { key: 'distance', label: 'Distance', options: [{ value: 'nm', label: 'Nautical miles' }, { value: 'km', label: 'Kilometres' }] },
  { key: 'temperature', label: 'Temperature', options: [{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }] },
];

export class GeneralTab implements SettingsTabView {
  readonly el: HTMLElement;
  private unitSeg: SegmentedHandle<UnitSystem>;
  private unitSelects = new Map<UnitKey, HTMLSelectElement>();
  private unitNote: Txt;
  private levelSeg: SegmentedHandle<AssistLevel>;
  private levelNote: Txt;
  private assistToggles = new Map<AssistKey, { t: ToggleHandle; eff: Txt }>();
  private scale: SliderHandle;
  private subtitles: ToggleHandle;
  private infoStrip: ToggleHandle;

  constructor(private readonly d: TabDeps) {
    const s = d.ctx.settings();
    // units
    this.unitSeg = segmented<UnitSystem>([{ value: 'imperial', label: 'Aviation (ft, kt, inHg)' }, { value: 'metric', label: 'Metric (m, km/h, hPa)' }],
      null, (system) => d.dispatch({ type: 'unitSystem', system }), 'stretch');
    this.unitNote = new Txt(h('div', { class: 'effective' }), '');
    const unitRows = UNIT_OPTIONS.map((o) => {
      const sel = select(o.options, s.units[o.key], (v) => d.dispatch({ type: 'units', patch: { [o.key]: v } as Partial<UnitsSettings> }), 'select-sm');
      this.unitSelects.set(o.key, sel);
      return fieldRow(o.label, sel);
    });

    // assistance
    this.levelSeg = segmented<AssistLevel>(ASSIST_LEVELS.map((l) => ({ value: l.id, label: l.label })), null, (level) => d.dispatch({ type: 'assistLevel', level }), 'stretch');
    this.levelNote = new Txt(h('div', { class: 'muted', style: 'font-size:.85em;margin:6px 0 4px' }), '');
    const assistBody = h('div', { class: 'col', style: 'gap:0' });
    for (const cat of assistView(s.assists).categories) {
      assistBody.appendChild(h('div', { class: 'section-label', text: cat.category }));
      for (const row of cat.rows) {
        const t = toggle(row.label, row.value, (v) => d.dispatch({ type: 'assist', key: row.key, value: v }), row.help);
        const eff = new Txt(h('span', { class: 'effective' }), row.effective);
        t.el.insertBefore(eff.el, t.el.lastChild);
        if (row.realism) t.el.title = `${row.help} (realism option: ON makes the flight harder)`;
        this.assistToggles.set(row.key, { t, eff });
        assistBody.appendChild(t.el);
      }
    }

    // interface
    this.scale = slider({ min: UI_SCALE_MIN * 100, max: UI_SCALE_MAX * 100, step: 5, value: Math.round(s.ui.scale * 100), label: 'UI scale', format: (v) => `${v}%`,
      onInput: () => { /* readout only while dragging */ }, onChange: (v) => d.dispatch({ type: 'ui', patch: { scale: v / 100 } }) });
    this.subtitles = toggle('ATC subtitles', s.ui.subtitles, (v) => d.dispatch({ type: 'ui', patch: { subtitles: v } }), 'Show ATC transmissions bottom-left while the ATC window is closed');
    this.infoStrip = toggle('Flight info strip', s.ui.infoStrip, (v) => d.dispatch({ type: 'ui', patch: { infoStrip: v } }), 'Speed, altitude, heading and wind at the top in external views');

    this.el = h('div', { class: 'settings-grid' },
      group('Units', this.unitSeg.el, this.unitNote.el, ...unitRows),
      group('Assistance', this.levelSeg.el, this.levelNote.el, assistBody),
      group('Interface', this.scale.el, this.subtitles.el, this.infoStrip.el));
    this.sync();
  }

  sync(): void {
    const s = this.d.ctx.settings();
    const sys = unitSystemOf(s.units);
    this.unitSeg.set(sys === 'custom' ? null : sys);
    this.unitNote.set(sys === 'custom' ? 'Custom mix' : '');
    for (const [k, sel] of this.unitSelects) if (sel.value !== s.units[k]) sel.value = s.units[k];

    const v = assistView(s.assists);
    this.levelSeg.set(v.level === 'custom' ? null : v.level);
    const lvl = ASSIST_LEVELS.find((l) => l.id === v.level);
    this.levelNote.set(lvl ? `${lvl.help} ${v.helpersOn} helper${v.helpersOn === 1 ? '' : 's'} on.` : `Custom — ${v.helpersOn} helper${v.helpersOn === 1 ? '' : 's'} on. Picking a preset re-applies all of its items.`);
    for (const cat of v.categories) for (const row of cat.rows) {
      const ht = this.assistToggles.get(row.key);
      if (!ht) continue;
      if (ht.t.get() !== row.value) ht.t.set(row.value);
      ht.eff.set(row.effective);
    }

    this.scale.set(Math.round(s.ui.scale * 100));
    if (this.subtitles.get() !== s.ui.subtitles) this.subtitles.set(s.ui.subtitles);
    if (this.infoStrip.get() !== s.ui.infoStrip) this.infoStrip.set(s.ui.infoStrip);
  }
}
