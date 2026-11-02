import { describe, expect, it } from 'vitest';
import type { WeatherState } from '../core/types';
import { COVERAGE, WEATHER_PRESETS, WEATHER_PRESET_IDS, cloneWeather, presetName, weatherFromPreset } from './presets';

const POE: Record<string, number> = { clear: 0, few: 2, scattered: 3, broken: 3, 'high-level': 2, overcast: 3, rain: 4, snow: 3, storm: 5 };

function expectValid(w: WeatherState): void {
  expect(Number.isFinite(w.qnhPa) && w.qnhPa > 90_000 && w.qnhPa < 110_000).toBe(true);
  expect(w.visibilityM).toBeGreaterThan(0);
  expect(w.humidity).toBeGreaterThanOrEqual(0); expect(w.humidity).toBeLessThanOrEqual(1);
  expect(w.aerosol).toBeGreaterThanOrEqual(0); expect(w.aerosol).toBeLessThanOrEqual(1);
  expect(w.turbulence).toBeGreaterThanOrEqual(0); expect(w.turbulence).toBeLessThanOrEqual(7);
  expect(w.precipitationRate >= 0).toBe(true);
  if (w.precipitationRate > 0) expect(w.precipitationType).not.toBe('none');
  for (const c of w.clouds) {
    expect(c.topM).toBeGreaterThan(c.baseM);
    expect(c.coverage).toBeGreaterThan(0); expect(c.coverage).toBeLessThanOrEqual(1);
    expect(c.density).toBeGreaterThan(0);
  }
  for (let i = 1; i < w.clouds.length; i++) expect(w.clouds[i].baseM).toBeGreaterThanOrEqual(w.clouds[i - 1].baseM);
  expect(w.winds.length).toBeGreaterThan(0);
  for (let i = 1; i < w.winds.length; i++) expect(w.winds[i].altM).toBeGreaterThan(w.winds[i - 1].altM);
  for (const l of w.winds) { expect(l.directionDeg).toBeGreaterThanOrEqual(0); expect(l.directionDeg).toBeLessThan(360); expect(l.speedKt).toBeGreaterThanOrEqual(0); }
}

describe('weather presets', () => {
  it('all nine presets produce a valid WeatherState with the expected POE turbulence index', () => {
    expect(WEATHER_PRESET_IDS).toHaveLength(9);
    for (const id of WEATHER_PRESET_IDS) {
      const w = weatherFromPreset(id, 0);
      expect(w.preset).toBe(id);
      expectValid(w);
      expect(w.turbulence).toBe(POE[id]);
      expect(presetName(id)).toBe(WEATHER_PRESETS[id].name);
    }
  });

  it('converts AGL layer heights to MSL with the airport elevation (clouds and winds)', () => {
    const elev = 1655; // KDEN
    const w = weatherFromPreset('scattered', elev);
    expect(w.clouds[0].baseM).toBe(elev + 1000);
    expect(w.clouds[0].topM).toBe(elev + 1800);
    expect(w.winds[0].altM).toBe(elev + 10); // surface layer at 10 m AGL
    expect(w.winds[1].altM).toBe(elev + 1500);
    const sea = weatherFromPreset('scattered', 0);
    expect(w.clouds[0].baseM - sea.clouds[0].baseM).toBe(elev);
  });

  it('coverage values follow the octa mapping and the preset table', () => {
    expect(COVERAGE).toEqual({ FEW: 0.19, SCT: 0.44, BKN: 0.75, OVC: 1.0 });
    expect(weatherFromPreset('few').clouds[0].coverage).toBe(0.19);
    expect(weatherFromPreset('scattered').clouds[0].coverage).toBe(0.44);
    expect(weatherFromPreset('broken').clouds[0].coverage).toBe(0.75);
    expect(weatherFromPreset('overcast').clouds[0].coverage).toBe(1);
    expect(weatherFromPreset('rain').clouds[0].coverage).toBe(1);
    expect(weatherFromPreset('clear').clouds.every((c) => c.coverage <= 0.1)).toBe(true);
  });

  it('precipitation, storm and visibility fields match the table', () => {
    expect(weatherFromPreset('rain')).toMatchObject({ precipitationType: 'rain', precipitationRate: 4, visibilityM: 4000 });
    expect(weatherFromPreset('snow')).toMatchObject({ precipitationType: 'snow', precipitationRate: 2, visibilityM: 2000 });
    expect(weatherFromPreset('storm')).toMatchObject({ precipitationType: 'rain', precipitationRate: 15, thunderstorm: true, visibilityM: 3000 });
    expect(weatherFromPreset('storm').winds[0].gustKt).toBeGreaterThan(weatherFromPreset('storm').winds[0].speedKt);
    expect(weatherFromPreset('clear').visibilityM).toBe(50_000);
    expect(weatherFromPreset('overcast').visibilityM).toBe(8000);
    // storm has a towering cumulus layer
    expect(weatherFromPreset('storm').clouds.some((c) => c.type === 'cumulus' && c.density === 1.5 && c.topM - c.baseM > 5000)).toBe(true);
  });

  it('cloneWeather deep-copies layers', () => {
    const a = weatherFromPreset('broken');
    const b = cloneWeather(a);
    b.clouds[0].coverage = 0.1;
    b.winds[0].speedKt = 99;
    expect(a.clouds[0].coverage).toBe(0.75);
    expect(a.winds[0].speedKt).toBe(14);
  });
});
