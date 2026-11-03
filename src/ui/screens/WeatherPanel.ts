/**
 * Weather & time component used by the pre-flight screen and the in-flight floating panel:
 * presets grid, custom editor (3 cloud + 3 wind layers, vis, precip, QNH, temp, turbulence),
 * live weather, time of day and time acceleration.
 */
import type { CloudLayer, SimSnapshot, WeatherPresetId, WeatherState, WindLayer, TurbulenceIntensity } from '../../core/types';
import type { ScreenContext } from './Screen';
import { Txt, button, clear, h, icon, segmented, select, slider, type SegmentedHandle } from '../dom';
import { WEATHER_ICON } from '../icons';
import { FT, NM, MAX_CLOUD_LAYERS, MAX_WIND_LAYERS, TURBULENCE_LABELS, WEATHER_PRESETS, cloneWeather, validateCustomWeather, weatherPresetTemplate, weatherSummary } from '../weatherPresets';
import { KT_PER_MS, formatPressure, formatTemperature, formatTimeLocal, formatTimeScale, formatTimeUtc, formatUtcOffset, speedUnit, speedValue, timezoneOffsetFromLon } from '../format';
import { SUN_PHASE_LABEL, startOfUtcDay, sunElevationDeg, sunPhase, type TimePreset } from '../solar';

type Mode = WeatherPresetId | 'live' | 'custom';
type TimeMode = 'now' | TimePreset | 'custom';
const TIME_SCALES = [1, 2, 4, 8, 16];
const SUMMARY_INTERVAL_MS = 500;

export class WeatherPanel {
  readonly el: HTMLElement;
  private presetButtons = new Map<Mode, HTMLButtonElement>();
  private editor: HTMLElement;
  private editorWrap: HTMLElement;
  private draft: WeatherState;
  /** the selection's custom weather the draft was copied from */
  private draftFrom: WeatherState | null = null;
  private errors: HTMLElement;
  private status: Txt;
  private timeSeg: SegmentedHandle<TimeMode>;
  private timeSlider: HTMLElement;
  private timeInput: HTMLInputElement;
  private timeReadout: Txt;
  private sunHint: Txt;
  private sunIcon: HTMLElement;
  private scaleSeg: SegmentedHandle<string>;
  private currentWx: Txt;
  private lastScale = -1;
  private lastWxSummary = '';
  private lastSummaryMs = -Infinity;
  /** last simulator preset reflected by the in-flight panel (a challenge or a hotkey can change it) */
  private lastLivePreset: string | null = null;
  private unsub: () => void;

  constructor(private readonly ctx: ScreenContext, private readonly opts: { compact: boolean }) {
    const sel = ctx.selection.sel;
    this.draft = sel.weather.mode === 'custom' ? cloneWeather(sel.weather.custom) : weatherPresetTemplate(sel.weather.mode === 'preset' ? sel.weather.presetId : 'clear');
    this.draft.preset = 'custom';

    // presets
    const grid = h('div', { class: 'wx-presets', role: 'radiogroup', aria: { label: 'Weather preset' } });
    const mk = (id: Mode, label: string, summary: string) => {
      const b = h('button', { class: 'wx-preset', type: 'button', role: 'radio', title: summary, onClick: () => this.pick(id) }, icon(WEATHER_ICON[id] ?? 'cloud'), h('span', { class: 'wx-preset-label', text: label }));
      this.presetButtons.set(id, b); grid.appendChild(b);
    };
    for (const p of WEATHER_PRESETS) mk(p.id, p.label, p.summary);
    mk('live', 'Live weather', 'Real-world METAR for the nearest airport');
    mk('custom', 'Custom', 'Edit cloud and wind layers');
    this.status = new Txt(h('div', { class: 'wx-status' }), '');

    // custom editor
    this.editor = h('div', { class: 'col' });
    this.errors = h('div', { class: 'wx-errors' });
    this.editorWrap = h('div', { class: 'panel wx-card' }, h('div', { class: 'section-label' }, icon('sliders'), ' Custom weather'),
      h('div', { class: 'row' }, h('span', { class: 'muted', style: 'font-size:.85em', text: 'Start from' }),
        select(WEATHER_PRESETS.map((p) => ({ value: p.id, label: p.label })), 'clear', (id) => { this.draft = weatherPresetTemplate(id); this.draft.preset = 'custom'; this.renderEditor(); }, 'select-sm')),
      this.editor, this.errors,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, button('Apply custom weather', () => this.applyCustom(), { primary: true, icon: 'check' })));

    // time of day
    this.timeInput = h('input', { type: 'range', min: 0, max: 1439, step: 5, value: 720, class: 'slider', onInput: () => this.onTimeSlider() });
    this.timeReadout = new Txt(h('span', { class: 'slider-readout' }), '');
    this.sunIcon = icon('sun');
    this.sunHint = new Txt(h('span'), '');
    this.timeSlider = h('div', { class: 'col', style: 'gap:4px' }, h('div', { class: 'slider-row no-label' }, this.timeInput, this.timeReadout.el), h('div', { class: 'sun-hint' }, this.sunIcon, this.sunHint.el));
    this.timeSeg = segmented<TimeMode>([{ value: 'now', label: 'Now' }, { value: 'dawn', label: 'Dawn' }, { value: 'noon', label: 'Noon' }, { value: 'dusk', label: 'Dusk' }, { value: 'night', label: 'Night' }, { value: 'custom', label: 'Custom' }],
      this.timeModeFromSelection(), (m) => this.pickTime(m), 'stretch');
    this.scaleSeg = segmented(TIME_SCALES.map((s) => ({ value: String(s), label: `${s}×` })), '1', (v) => ctx.host.setTimeScale(parseFloat(v)), 'stretch');
    this.currentWx = new Txt(h('div', { class: 'muted mono', style: 'font-size:.82em' }), '');

    const presetsCard = h('div', { class: 'panel wx-card' }, h('div', { class: 'section-label' }, icon('cloudSun'), ' Weather'), grid, this.status.el, this.currentWx.el);
    const timeCard = h('div', { class: 'panel wx-card' }, h('div', { class: 'section-label' }, icon('clock'), ' Time of day'), this.timeSeg.el, this.timeSlider,
      h('div', { class: 'section-label' }, icon('fast'), ' Time acceleration'), this.scaleSeg.el);
    this.el = opts.compact
      ? h('div', { class: 'col wx-compact' }, presetsCard, this.editorWrap, timeCard)
      : h('div', { class: 'screen-body' }, h('div', { class: 'wx-left' }, presetsCard, timeCard), h('div', { class: 'wx-right scroll' }, this.editorWrap));
    this.renderEditor();
    this.refresh();
    this.unsub = ctx.selection.onChange(() => this.refresh());
  }

  dispose(): void { this.unsub(); }

  private get mode(): Mode { const w = this.ctx.selection.sel.weather; return w.mode === 'preset' ? w.presetId : w.mode; }
  private timeModeFromSelection(): TimeMode { const t = this.ctx.selection.sel.time; return t.mode === 'now' ? 'now' : t.mode === 'preset' ? t.preset : 'custom'; }
  private lon(): number { return this.ctx.selection.sel.spawn.airport.position.lon; }
  private lat(): number { return this.ctx.selection.sel.spawn.airport.position.lat; }

  private markPreset(m: string): void {
    for (const [id, b] of this.presetButtons) { b.classList.toggle('active', id === m); b.setAttribute('aria-checked', String(id === m)); }
  }

  /** Syncs the controls with the selection store. */
  refresh(): void {
    const m = this.mode;
    this.lastLivePreset = null; // the next in-flight update re-checks the simulator's weather
    this.markPreset(m);
    this.editorWrap.style.display = m === 'custom' ? '' : 'none';
    // re-seed the editor only when the applied custom weather itself changed: an unrelated change
    // (time of day, departure) must not throw away edits that were not applied yet
    if (m === 'custom') { const w = this.ctx.selection.sel.weather; if (w.mode === 'custom' && w.custom !== this.draftFrom) { this.draftFrom = w.custom; this.draft = cloneWeather(w.custom); this.renderEditor(); } }
    const tm = this.timeModeFromSelection();
    this.timeSeg.set(tm);
    this.timeSlider.style.display = tm === 'custom' ? '' : 'none';
    this.updateTimeReadout();
  }

  private pick(id: Mode): void {
    if (id === 'live') {
      this.ctx.selection.set({ weather: { mode: 'live' } });
      // before a flight the host would fetch for the aircraft's old position, not the departure:
      // the live fetch waits for the spawn (FlightLauncher), as on the World Map
      if (!this.ctx.inFlight()) { this.status.set(`Live weather for ${this.ctx.selection.sel.spawn.airport.icao} loads when you fly`); this.ctx.host.setTime(this.ctx.selection.resolvedTimeUtcMs()); return; }
      this.status.set('Fetching live weather…');
      this.ctx.host.requestLiveWeather().then((ok) => {
        this.status.set(ok ? 'Live weather active' : 'Live weather unavailable — using Clear skies');
        if (!ok) { this.ctx.selection.set({ weather: { mode: 'preset', presetId: 'clear' } }); this.ctx.host.setWeatherPreset('clear'); }
      }).catch(() => { this.status.set('Live weather failed'); });
      this.ctx.host.setTime(this.ctx.selection.resolvedTimeUtcMs());
      return;
    }
    this.status.set('');
    if (id === 'custom') { this.ctx.selection.set({ weather: { mode: 'custom', custom: validateCustomWeather(this.draft).fixed } }); this.ctx.selection.applyEnvironment(); return; }
    this.ctx.selection.set({ weather: { mode: 'preset', presetId: id } });
    this.ctx.selection.applyEnvironment();
  }

  private applyCustom(): void {
    const r = validateCustomWeather(this.draft);
    clear(this.errors);
    if (!r.ok) { for (const e of r.errors) this.errors.appendChild(h('div', { text: `• ${e}` })); }
    this.draft = r.fixed;
    this.ctx.selection.set({ weather: { mode: 'custom', custom: r.fixed } });
    this.ctx.selection.applyEnvironment();
    this.ctx.toast(r.ok ? 'Custom weather applied' : 'Custom weather applied with corrections', r.ok ? 'success' : 'warn');
    this.renderEditor();
  }

  private pickTime(m: TimeMode): void {
    if (m === 'now') this.ctx.selection.set({ time: { mode: 'now' } });
    else if (m === 'custom') {
      const off = timezoneOffsetFromLon(this.lon());
      const minutes = parseFloat(this.timeInput.value);
      this.ctx.selection.set({ time: { mode: 'custom', utcMs: this.customUtc(minutes, off) } });
    } else this.ctx.selection.set({ time: { mode: 'preset', preset: m } });
    this.ctx.host.setTime(this.ctx.selection.resolvedTimeUtcMs());
  }

  /** Local minutes-of-day (lon-based zone) → UTC ms on the current local day. */
  private customUtc(localMinutes: number, offsetMin: number): number {
    const now = Date.now();
    const localDay0 = startOfUtcDay(now + offsetMin * 60_000) - offsetMin * 60_000;
    return localDay0 + localMinutes * 60_000;
  }

  private onTimeSlider(): void {
    const off = timezoneOffsetFromLon(this.lon());
    const utc = this.customUtc(parseFloat(this.timeInput.value), off);
    this.ctx.selection.set({ time: { mode: 'custom', utcMs: utc } });
    this.ctx.host.setTime(utc);
  }

  private updateTimeReadout(): void {
    const off = timezoneOffsetFromLon(this.lon());
    const utc = this.ctx.selection.resolvedTimeUtcMs();
    const t = this.ctx.selection.sel.time;
    if (t.mode === 'custom') { const local = new Date(utc + off * 60_000); this.timeInput.value = String(local.getUTCHours() * 60 + local.getUTCMinutes()); }
    this.timeReadout.set(`${formatTimeLocal(utc, off)} local (${formatUtcOffset(off)}) · ${formatTimeUtc(utc)}`);
    const el = sunElevationDeg(utc, this.lat(), this.lon());
    const phase = sunPhase(el);
    this.sunHint.set(`${SUN_PHASE_LABEL[phase]} · sun ${el >= 0 ? '+' : ''}${el.toFixed(0)}°`);
    this.sunIcon.innerHTML = (phase === 'night' || phase === 'astronomical') ? (icon('moon').innerHTML) : icon('sun').innerHTML;
  }

  private renderEditor(): void {
    clear(this.editor);
    const u = this.ctx.settings().units;
    const d = this.draft;
    // the editor speaks the user's units (layer altitudes ft/m, wind kt/km/h/mph, visibility nm/km)
    const altK = u.altitude === 'ft' ? FT : 1, altU = u.altitude, altStep = u.altitude === 'ft' ? 100 : 50;
    const spdK = speedValue(1 / KT_PER_MS, u), spdU = speedUnit(u);
    const visK = u.distance === 'km' ? 1000 : NM, visMax = u.distance === 'km' ? 100 : 60;
    const numField = (label: string, value: number, onChange: (v: number) => void, step = 1, min?: number, max?: number) => {
      const inp = h('input', { class: 'input input-sm', type: 'number', value: Math.round(value * 100) / 100, step, min, max, onChange: (e) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) onChange(v); } });
      return h('label', { class: 'field' }, h('span', { class: 'field-k', text: label }), inp);
    };
    // clouds
    const clouds = h('div', { class: 'layer-editor' });
    d.clouds.forEach((c, i) => {
      clouds.appendChild(h('div', { class: 'layer-row' }, h('span', { class: 'layer-index', text: `C${i + 1}` }),
        numField(`Base ${altU}`, c.baseM / altK, (v) => { c.baseM = v * altK; }, altStep, 0),
        numField(`Top ${altU}`, c.topM / altK, (v) => { c.topM = v * altK; }, altStep, 0),
        numField('Cover %', c.coverage * 100, (v) => { c.coverage = v / 100; }, 5, 0, 100),
        h('label', { class: 'field' }, h('span', { class: 'field-k', text: 'Type' }), select<CloudLayer['type']>([{ value: 'cumulus', label: 'Cumulus' }, { value: 'stratus', label: 'Stratus' }, { value: 'cirrus', label: 'Cirrus' }], c.type, (v) => { c.type = v; }, 'select-sm')),
        button('', () => { d.clouds.splice(i, 1); this.renderEditor(); }, { icon: 'close', cls: 'btn-ghost btn-icon btn-sm', title: 'Remove layer' })));
    });
    if (d.clouds.length < MAX_CLOUD_LAYERS) clouds.appendChild(button('Add cloud layer', () => { const top = d.clouds.length ? d.clouds[d.clouds.length - 1].topM : 600; d.clouds.push({ baseM: top + 300, topM: top + 1200, coverage: 0.4, density: 0.8, type: 'cumulus' }); this.renderEditor(); }, { cls: 'btn-sm', icon: 'cloud' }));
    // winds
    const winds = h('div', { class: 'layer-editor' });
    d.winds.forEach((w, i) => {
      winds.appendChild(h('div', { class: 'layer-row' }, h('span', { class: 'layer-index', text: `W${i + 1}` }),
        numField(`Alt ${altU}`, w.altM / altK, (v) => { w.altM = v * altK; }, altStep * 5, 0),
        numField('From °', w.directionDeg, (v) => { w.directionDeg = v; }, 10, 0, 360),
        numField(`Speed ${spdU}`, w.speedKt * spdK, (v) => { w.speedKt = v / spdK; }, 1, 0, Math.round(200 * spdK)),
        numField(`Gust ${spdU}`, w.gustKt * spdK, (v) => { w.gustKt = v / spdK; }, 1, 0, Math.round(250 * spdK)),
        button('', () => { d.winds.splice(i, 1); this.renderEditor(); }, { icon: 'close', cls: 'btn-ghost btn-icon btn-sm', title: 'Remove layer' })));
    });
    if (d.winds.length < MAX_WIND_LAYERS) winds.appendChild(button('Add wind layer', () => { const alt = d.winds.length ? d.winds[d.winds.length - 1].altM + 1500 : 0; const l: WindLayer = { altM: alt, directionDeg: 270, speedKt: 10, gustKt: 0 }; d.winds.push(l); this.renderEditor(); }, { cls: 'btn-sm', icon: 'wind' }));
    // scalars
    const vis = slider({ min: 0.1, max: visMax, step: 0.1, value: Math.min(visMax, Math.round(d.visibilityM / visK * 10) / 10), label: 'Visibility', format: (v) => `${v.toFixed(1)} ${u.distance}`, onInput: (v) => { d.visibilityM = v * visK; } });
    const precip = slider({ min: 0, max: 20, step: 0.5, value: d.precipitationRate, label: 'Precipitation', format: (v) => `${v} mm/h`, onInput: (v) => { d.precipitationRate = v; if (v > 0 && d.precipitationType === 'none') d.precipitationType = d.temperatureC <= 0 ? 'snow' : 'rain'; } });
    const precipType = select<WeatherState['precipitationType']>([{ value: 'none', label: 'None' }, { value: 'rain', label: 'Rain' }, { value: 'snow', label: 'Snow' }], d.precipitationType, (v) => { d.precipitationType = v; }, 'select-sm');
    const qnhInHg = u.pressure === 'inHg';
    const qnh = slider({ min: qnhInHg ? 27.5 : 940, max: qnhInHg ? 31.5 : 1080, step: qnhInHg ? 0.01 : 1, value: qnhInHg ? Math.round(d.qnhPa / 3386.389 * 100) / 100 : Math.round(d.qnhPa / 100), label: 'QNH',
      format: (v) => formatPressure(qnhInHg ? v * 3386.389 : v * 100, u), onInput: (v) => { d.qnhPa = qnhInHg ? v * 3386.389 : v * 100; } });
    const temp = slider({ min: -40, max: 50, step: 1, value: Math.round(d.temperatureC), label: 'Temperature', format: (v) => formatTemperature(v, u), onInput: (v) => { d.temperatureC = v; } });
    const turb = slider({ min: 0, max: 7, step: 1, value: d.turbulence, label: 'Turbulence', format: (v) => TURBULENCE_LABELS[v as TurbulenceIntensity], onInput: (v) => { d.turbulence = v as TurbulenceIntensity; } });
    const ts = h('label', { class: 'toggle-row', style: 'border:0' }, h('span', { class: 'toggle-label', text: 'Thunderstorm' }),
      h('input', { type: 'checkbox', checked: d.thunderstorm, onChange: (e) => { d.thunderstorm = (e.target as HTMLInputElement).checked; } }));
    this.editor.append(
      h('div', { class: 'section-label', text: `Cloud layers (${d.clouds.length}/${MAX_CLOUD_LAYERS})` }), clouds,
      h('div', { class: 'section-label', text: `Wind layers (${d.winds.length}/${MAX_WIND_LAYERS})` }), winds,
      h('div', { class: 'section-label', text: 'Conditions' }), vis.el, precip.el,
      h('div', { class: 'slider-row' }, h('span', { class: 'slider-label', text: 'Precip. type' }), precipType, h('span')),
      qnh.el, temp.el, turb.el, ts);
  }

  /**
   * In flight: reflect the current time scale, the weather summary and (compact in-flight panel)
   * the preset the simulator is actually flying, e.g. a landing challenge's own weather. The
   * summary string is rebuilt at most twice a second (this runs every frame while visible).
   */
  update(s: SimSnapshot, nowMs: number): void {
    if (this.opts.compact && this.ctx.inFlight() && s.weather.preset !== this.lastLivePreset) {
      this.lastLivePreset = s.weather.preset;
      if (this.presetButtons.has(s.weather.preset)) this.markPreset(s.weather.preset);
    }
    const sc = s.time.timeScale;
    if (sc !== this.lastScale) { this.lastScale = sc; this.scaleSeg.set(TIME_SCALES.includes(sc) ? String(sc) : null); this.lastSummaryMs = -Infinity; }
    if (nowMs - this.lastSummaryMs < SUMMARY_INTERVAL_MS) return;
    this.lastSummaryMs = nowMs;
    const sum = `${weatherSummary(s.weather, this.ctx.settings().units)} · ${formatTimeScale(sc)}`;
    if (sum !== this.lastWxSummary) { this.lastWxSummary = sum; this.currentWx.set(this.opts.compact ? sum : `Current: ${sum}`); }
  }
}
