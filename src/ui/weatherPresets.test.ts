import { describe, expect, it } from 'vitest';
import {
  MAX_CLOUD_LAYERS, MIN_CLOUD_THICKNESS_M, WEATHER_PRESETS, WEATHER_PRESET_IDS, validateCustomWeather, weatherPresetTemplate, weatherSummary,
} from './weatherPresets';

describe('weather presets', () => {
  it('has the nine MSFS presets in order', () => {
    expect(WEATHER_PRESET_IDS).toEqual(['clear', 'few', 'scattered', 'broken', 'high-level', 'overcast', 'rain', 'snow', 'storm']);
    expect(WEATHER_PRESETS).toHaveLength(9);
  });
  it('every template validates clean', () => {
    for (const id of WEATHER_PRESET_IDS) {
      const r = validateCustomWeather(weatherPresetTemplate(id));
      expect(r.errors, id).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });
  it('summaries read like a METAR', () => {
    expect(weatherSummary(weatherPresetTemplate('clear'))).toBe('SKC · CALM · 10+ nm · 15 °C · 1013 hPa');
    expect(weatherSummary(weatherPresetTemplate('storm'))).toContain('TS');
    expect(weatherSummary(weatherPresetTemplate('scattered'))).toMatch(/^SCT030 /);
  });
  it('summaries follow the user units (pressure, temperature, visibility) and read a north wind as 360', () => {
    const us = { altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'F' } as const;
    expect(weatherSummary(weatherPresetTemplate('clear'), us)).toBe('SKC · CALM · 10+ nm · 59 °F · 29.92 inHg');
    const metric = { altitude: 'm', speed: 'kmh', pressure: 'hPa', distance: 'km', temperature: 'C' } as const;
    const rain = weatherPresetTemplate('rain'); // 5 nm visibility
    expect(weatherSummary(rain, metric)).toContain('9.3 km');
    expect(weatherSummary(rain, metric)).toContain('1008 hPa');
    const north = weatherPresetTemplate('few');
    north.winds[0] = { altM: 0, directionDeg: 0, speedKt: 12, gustKt: 20 };
    expect(weatherSummary(north)).toContain('360/12G20');
  });
});

describe('validateCustomWeather', () => {
  it('sorts cloud layers by base and reports it', () => {
    const w = weatherPresetTemplate('clear');
    w.clouds = [
      { baseM: 3000, topM: 4000, coverage: 0.5, density: 0.8, type: 'cumulus' },
      { baseM: 500, topM: 1000, coverage: 0.3, density: 0.8, type: 'stratus' },
    ];
    const r = validateCustomWeather(w);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /not sorted/.test(e))).toBe(true);
    expect(r.fixed.clouds.map((c) => c.baseM)).toEqual([500, 3000]);
    expect(r.fixed.preset).toBe('custom');
  });
  it('forces top > base with a minimum thickness', () => {
    const w = weatherPresetTemplate('clear');
    w.clouds = [{ baseM: 2000, topM: 1500, coverage: 0.5, density: 0.8, type: 'cumulus' }];
    const r = validateCustomWeather(w);
    expect(r.ok).toBe(false);
    expect(r.fixed.clouds[0].topM).toBeGreaterThanOrEqual(2000 + MIN_CLOUD_THICKNESS_M);
  });
  it('clamps coverage and density into 0..1', () => {
    const w = weatherPresetTemplate('clear');
    w.clouds = [{ baseM: 1000, topM: 2000, coverage: 1.5, density: -0.2, type: 'cumulus' }];
    const r = validateCustomWeather(w);
    expect(r.fixed.clouds[0].coverage).toBe(1);
    expect(r.fixed.clouds[0].density).toBe(0);
    expect(r.errors.length).toBe(2);
  });
  it('limits the number of layers', () => {
    const w = weatherPresetTemplate('clear');
    w.clouds = Array.from({ length: 5 }, (_, k) => ({ baseM: 1000 * (k + 1), topM: 1000 * (k + 1) + 500, coverage: 0.5, density: 0.5, type: 'cumulus' as const }));
    const r = validateCustomWeather(w);
    expect(r.fixed.clouds).toHaveLength(MAX_CLOUD_LAYERS);
  });
  it('sorts wind layers, normalises direction and drops gusts below the mean', () => {
    const w = weatherPresetTemplate('clear');
    w.winds = [
      { altM: 3000, directionDeg: 370, speedKt: 20, gustKt: 10 },
      { altM: 0, directionDeg: -90, speedKt: 5, gustKt: 15 },
    ];
    const r = validateCustomWeather(w);
    expect(r.fixed.winds.map((l) => l.altM)).toEqual([0, 3000]);
    expect(r.fixed.winds[0].directionDeg).toBe(270);
    expect(r.fixed.winds[1].directionDeg).toBe(10);
    expect(r.fixed.winds[1].gustKt).toBe(0);
    expect(r.fixed.winds[0].gustKt).toBe(15);
  });
  it('fixes inconsistent precipitation and clamps ranges', () => {
    const w = weatherPresetTemplate('clear');
    w.precipitationRate = 5; w.precipitationType = 'none'; w.temperatureC = -5;
    w.qnhPa = 50_000; w.visibilityM = 1; w.turbulence = 9 as never; w.humidity = 2;
    const r = validateCustomWeather(w);
    expect(r.fixed.precipitationType).toBe('snow');
    expect(r.fixed.qnhPa).toBe(94_000);
    expect(r.fixed.visibilityM).toBe(50);
    expect(r.fixed.turbulence).toBe(7);
    expect(r.fixed.humidity).toBe(1);
    expect(r.ok).toBe(false);
  });
  it('does not mutate the input', () => {
    const w = weatherPresetTemplate('clear');
    w.clouds = [{ baseM: 2000, topM: 1500, coverage: 2, density: 0.8, type: 'cumulus' }];
    validateCustomWeather(w);
    expect(w.clouds[0].topM).toBe(1500);
    expect(w.clouds[0].coverage).toBe(2);
    expect(w.preset).toBe('clear');
  });
});
