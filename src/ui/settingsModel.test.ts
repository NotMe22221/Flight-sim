import { describe, expect, it } from 'vitest';
import { assistPreset } from './assistPresets';
import { defaultSettings, sanitizeSettings } from './settingsStore';
import {
  SETTINGS_TABS, UNIT_SYSTEMS, assistView, cycleTab, graphicsQualityLabel, parseTab, sameFlat, settingsReducer, unitSystemOf,
} from './settingsModel';

describe('settings tabs', () => {
  it('parses remembered tabs and falls back to general', () => {
    expect(parseTab('audio')).toBe('audio');
    expect(parseTab('nope')).toBe('general');
    expect(parseTab(undefined)).toBe('general');
  });
  it('cycles with wrap-around', () => {
    expect(cycleTab('general', 1)).toBe('graphics');
    expect(cycleTab('general', -1)).toBe(SETTINGS_TABS[SETTINGS_TABS.length - 1].id);
    expect(cycleTab('data', 1)).toBe('general');
  });
});

describe('unit systems', () => {
  it('detects imperial, metric and custom mixes', () => {
    expect(unitSystemOf(UNIT_SYSTEMS.imperial)).toBe('imperial');
    expect(unitSystemOf(UNIT_SYSTEMS.metric)).toBe('metric');
    expect(unitSystemOf({ ...UNIT_SYSTEMS.metric, altitude: 'ft' })).toBe('custom');
  });
});

describe('settingsReducer', () => {
  it('reports only the groups that changed and never mutates its input', () => {
    const s = defaultSettings();
    const frozen = JSON.stringify(s);
    const r = settingsReducer(s, { type: 'audio', key: 'engine', value: 0.3 });
    expect(r.changed).toEqual(['audio']);
    expect(r.next.audio.engine).toBe(0.3);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(settingsReducer(s, { type: 'audio', key: 'engine', value: s.audio.engine }).changed).toEqual([]);
  });

  it('switches unit systems and single units', () => {
    const s = defaultSettings();
    const m = settingsReducer(s, { type: 'unitSystem', system: 'metric' });
    expect(m.next.units).toEqual(UNIT_SYSTEMS.metric);
    expect(m.changed).toEqual(['units']);
    const f = settingsReducer(m.next, { type: 'units', patch: { temperature: 'F' } });
    expect(f.next.units.temperature).toBe('F');
    expect(unitSystemOf(f.next.units)).toBe('custom');
  });

  it('assist presets overwrite every item; single toggles leave the preset as custom', () => {
    const s = defaultSettings();
    const t = settingsReducer(s, { type: 'assistLevel', level: 'true-to-life' });
    expect(t.next.assists).toEqual(assistPreset('true-to-life'));
    expect(assistView(t.next.assists).level).toBe('true-to-life');
    const c = settingsReducer(t.next, { type: 'assist', key: 'autoRudder', value: true });
    expect(c.next.assists.autoRudder).toBe(true);
    expect(assistView(c.next.assists).level).toBe('custom');
    // re-selecting the preset re-applies everything (the MSFS gotcha the UI must make visible)
    const back = settingsReducer(c.next, { type: 'assistLevel', level: 'true-to-life' });
    expect(back.next.assists.autoRudder).toBe(false);
  });

  it('graphics quality presets set the dependent toggles; edits show as custom', () => {
    const s = defaultSettings();
    const lo = settingsReducer(s, { type: 'graphicsQuality', quality: 'low' });
    expect(lo.next.graphics.shadows).toBe(false);
    expect(lo.next.graphics.quality).toBe('low');
    expect(graphicsQualityLabel(lo.next.graphics)).toBe('Low');
    const edited = settingsReducer(lo.next, { type: 'graphics', patch: { shadows: true } });
    expect(graphicsQualityLabel(edited.next.graphics)).toBe('Custom (Low base)');
    // fov and imagery survive a preset change
    const fov = settingsReducer(s, { type: 'graphics', patch: { fov: 90, imagery: 'procedural' } });
    const hi = settingsReducer(fov.next, { type: 'graphicsQuality', quality: 'ultra' });
    expect(hi.next.graphics.fov).toBe(90);
    expect(hi.next.graphics.imagery).toBe('procedural');
  });

  it('sanitizes out-of-range values', () => {
    const s = defaultSettings();
    expect(settingsReducer(s, { type: 'audio', key: 'master', value: 7 }).next.audio.master).toBe(1);
    expect(settingsReducer(s, { type: 'graphics', patch: { fov: 500 } }).next.graphics.fov).toBe(120);
    expect(settingsReducer(s, { type: 'ui', patch: { scale: 9 } }).next.ui.scale).toBe(1.5);
    expect(settingsReducer(s, { type: 'ui', patch: { scale: Number.NaN } }).next.ui.scale).toBe(1);
  });

  it('resets one group or everything', () => {
    let s = settingsReducer(defaultSettings(), { type: 'unitSystem', system: 'metric' }).next;
    s = settingsReducer(s, { type: 'audio', key: 'ui', value: 0 }).next;
    const r = settingsReducer(s, { type: 'reset', group: 'units' });
    expect(r.changed).toEqual(['units']);
    expect(r.next.audio.ui).toBe(0);
    const all = settingsReducer(s, { type: 'resetAll' });
    expect(all.next).toEqual(defaultSettings());
    expect(all.changed.sort()).toEqual(['audio', 'units']);
  });

  it('replaces assists from the live simulator state', () => {
    const live = { ...assistPreset('all'), unlimitedFuel: false };
    const r = settingsReducer(defaultSettings(), { type: 'assistsReplace', assists: live });
    expect(r.next.assists).toEqual(live);
  });
});

describe('assistView', () => {
  it('groups by category with the effective state', () => {
    const v = assistView(assistPreset('middle'));
    expect(v.level).toBe('middle');
    expect(v.categories.map((c) => c.category)).toEqual(['Piloting', 'Aircraft systems', 'Failure & damage', 'Navigation aids']);
    const rudder = v.categories[0].rows.find((r) => r.key === 'autoRudder')!;
    expect(rudder.effective).toBe('ON');
    const crash = v.categories[2].rows.find((r) => r.key === 'crashDamage')!;
    expect(crash.realism).toBe(true);
    expect(crash.effective).toBe('OFF');
    expect(v.helpersOn).toBe(5); // auto-rudder, auto-mixture, landing path, taxi ribbon, route
  });
});

describe('interface settings persistence', () => {
  it('fills the new ui group for blobs saved before it existed', () => {
    const old = { version: 1, graphics: {}, audio: {}, units: {}, assists: {} };
    expect(sanitizeSettings(old).ui).toEqual(defaultSettings().ui);
    expect(sanitizeSettings({ ui: { scale: 0.1, subtitles: false } }).ui).toEqual({ scale: 0.75, subtitles: false, infoStrip: true });
  });
  it('sameFlat compares flat objects', () => {
    expect(sameFlat({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true);
    expect(sameFlat({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameFlat({ a: 1 }, { a: 1, b: 2 } as { a: number })).toBe(false);
  });
});
