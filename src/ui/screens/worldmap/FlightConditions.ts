/**
 * World Map "Flight conditions": the 9 weather presets + Live + Custom, time of day
 * (Now / dawn / noon / dusk / night / custom slider) with a sun-elevation hint for the departure
 * airport, and the selected aircraft with fuel and payload.
 */
import type { WeatherPresetId } from '../../../core/types';
import type { ScreenContext } from '../Screen';
import { Txt, button, h, icon, segmented, type SegmentedHandle } from '../../dom';
import { ICONS, WEATHER_ICON } from '../../icons';
import { formatMass, timezoneOffsetFromLon } from '../../format';
import { WEATHER_PRESETS, cloneWeather, weatherPresetTemplate, weatherSummary } from '../../weatherPresets';
import { localMinutesToUtc, sunHint, timeReadout, utcToLocalMinutes } from '../../timeOfDay';
import type { TimePreset } from '../../solar';
import { aircraftDisplayName } from '../../selection';

type WxMode = WeatherPresetId | 'live' | 'custom';
type TimeMode = 'now' | TimePreset | 'custom';

export class FlightConditions {
  readonly el: HTMLElement;
  private wxButtons = new Map<WxMode, HTMLButtonElement>();
  private wxStatus: Txt;
  private editCustom: HTMLButtonElement;
  private timeSeg: SegmentedHandle<TimeMode>;
  private sliderRow: HTMLElement;
  private timeInput: HTMLInputElement;
  private timeTxt: Txt;
  private sunTxt: Txt;
  private sunIcon: HTMLElement;
  private aircraftTxt: Txt;
  private loadTxt: Txt;
  private unsub: () => void;

  constructor(private readonly ctx: ScreenContext) {
    const grid = h('div', { class: 'wx-presets', role: 'radiogroup', aria: { label: 'Weather' } });
    const add = (id: WxMode, label: string, title: string) => {
      const b = h('button', { class: 'wx-preset', type: 'button', role: 'radio', title, onClick: () => this.pickWeather(id) }, icon(WEATHER_ICON[id] ?? 'cloud'), h('span', { class: 'wx-preset-label', text: label }));
      this.wxButtons.set(id, b);
      grid.appendChild(b);
    };
    for (const p of WEATHER_PRESETS) add(p.id, p.label, p.summary);
    add('live', 'Live', 'Real-world weather at the departure airport');
    add('custom', 'Custom', 'Your own cloud and wind layers');
    this.wxStatus = new Txt(h('div', { class: 'wx-status mono', style: 'font-size:.78em' }), '');
    this.editCustom = button('Edit custom weather…', () => ctx.navigate('weather'), { cls: 'btn-sm', icon: 'sliders' });

    this.timeSeg = segmented<TimeMode>([
      { value: 'now', label: 'Now' }, { value: 'dawn', label: 'Dawn' }, { value: 'noon', label: 'Noon' },
      { value: 'dusk', label: 'Dusk' }, { value: 'night', label: 'Night' }, { value: 'custom', label: '…' },
    ], 'now', (m) => this.pickTime(m), 'stretch');
    this.timeInput = h('input', { type: 'range', min: 0, max: 1435, step: 5, value: 720, class: 'slider', aria: { label: 'Local time of day' }, onInput: () => this.onSlider() });
    this.sliderRow = h('div', { class: 'slider-row no-label' }, this.timeInput, h('span'));
    this.timeTxt = new Txt(h('div', { class: 'tnum', style: 'font-size:.9em' }), '');
    this.sunIcon = icon('sun');
    this.sunTxt = new Txt(h('span'), '');
    this.aircraftTxt = new Txt(h('div', { class: 'aircraft-name', style: 'font-size:1em' }), '');
    this.loadTxt = new Txt(h('div', { class: 'muted tnum', style: 'font-size:.85em' }), '');

    this.el = h('section', { class: 'panel wm-conditions', aria: { label: 'Flight conditions' } },
      h('div', { class: 'section-label' }, icon('cloudSun'), ' Weather'),
      h('div', { class: 'wx-compact' }, grid), this.wxStatus.el, this.editCustom,
      h('div', { class: 'section-label' }, icon('clock'), ' Time of day'),
      this.timeSeg.el, this.sliderRow, this.timeTxt.el, h('div', { class: 'sun-hint' }, this.sunIcon, this.sunTxt.el),
      h('div', { class: 'section-label' }, icon('plane'), ' Aircraft'),
      this.aircraftTxt.el, this.loadTxt.el,
      h('div', { class: 'row' }, button('Fuel & payload…', () => ctx.navigate('aircraft'), { cls: 'btn-sm', icon: 'fuel' })));
    this.unsub = ctx.selection.onChange(() => this.refresh());
    this.refresh();
  }

  dispose(): void { this.unsub(); }

  private get wxMode(): WxMode { const w = this.ctx.selection.sel.weather; return w.mode === 'preset' ? w.presetId : w.mode; }

  /** Syncs every control with the selection store (cheap; called on change and on show). */
  refresh(): void {
    const sel = this.ctx.selection.sel;
    const m = this.wxMode;
    for (const [id, b] of this.wxButtons) { b.classList.toggle('active', id === m); b.setAttribute('aria-checked', String(id === m)); }
    this.editCustom.style.display = m === 'custom' ? '' : 'none';
    this.wxStatus.set(m === 'live'
      ? (this.ctx.inFlight() ? 'Live weather (METAR-based) at your position' : `Live weather for ${sel.spawn.airport.icao} loads when you fly`)
      : weatherSummary(this.ctx.selection.weatherState()));

    const t = sel.time;
    const tm: TimeMode = t.mode === 'now' ? 'now' : t.mode === 'preset' ? t.preset : 'custom';
    this.timeSeg.set(tm);
    this.sliderRow.style.display = tm === 'custom' ? '' : 'none';
    const p = sel.spawn.airport.position;
    const utc = this.ctx.selection.resolvedTimeUtcMs();
    if (tm === 'custom') this.timeInput.value = String(utcToLocalMinutes(utc, timezoneOffsetFromLon(p.lon)));
    this.timeTxt.set(timeReadout(utc, p.lon));
    const sun = sunHint(utc, p.lat, p.lon);
    this.sunTxt.set(sun.text);
    this.sunIcon.innerHTML = ICONS[sun.night ? 'moon' : 'sun'];

    const ac = this.ctx.host.aircraftList().find((a) => a.id === sel.aircraftId);
    this.aircraftTxt.set(ac ? aircraftDisplayName(ac.manufacturer, ac.name) : sel.aircraftId);
    this.loadTxt.set(`Fuel ${Math.round(sel.fuelFraction * 100)}% · payload ${formatMass(sel.payloadKg, this.ctx.settings().units)}`);
  }

  private pickWeather(id: WxMode): void {
    const s = this.ctx.selection;
    if (id === 'live') {
      s.set({ weather: { mode: 'live' } });
      // pre-flight the live fetch waits for the spawn (it needs the new position)
      if (this.ctx.inFlight()) void this.ctx.host.requestLiveWeather().then((ok) => { if (!ok) this.ctx.toast('Live weather unavailable', 'warn'); });
      return;
    }
    if (id === 'custom') {
      const cur = s.sel.weather;
      const base = cur.mode === 'custom' ? cloneWeather(cur.custom) : weatherPresetTemplate(cur.mode === 'preset' ? cur.presetId : 'clear');
      base.preset = 'custom';
      s.set({ weather: { mode: 'custom', custom: base } });
      this.ctx.host.setCustomWeather(base);
      return;
    }
    s.set({ weather: { mode: 'preset', presetId: id } });
    this.ctx.host.setWeatherPreset(id);
  }

  private pickTime(m: TimeMode): void {
    const s = this.ctx.selection;
    if (m === 'now') s.set({ time: { mode: 'now' } });
    else if (m === 'custom') s.set({ time: { mode: 'custom', utcMs: this.sliderUtc() } });
    else s.set({ time: { mode: 'preset', preset: m } });
    this.ctx.host.setTime(s.resolvedTimeUtcMs());
  }

  private sliderUtc(): number {
    const lon = this.ctx.selection.sel.spawn.airport.position.lon;
    return localMinutesToUtc(parseFloat(this.timeInput.value), timezoneOffsetFromLon(lon), Date.now());
  }

  private onSlider(): void {
    const utc = this.sliderUtc();
    this.ctx.selection.set({ time: { mode: 'custom', utcMs: utc } });
    this.ctx.host.setTime(utc);
  }
}
