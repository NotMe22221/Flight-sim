import { describe, expect, it, vi } from 'vitest';
import { fetchMetarText, fetchOpenMeteo, nearestHourIndex, openMeteoToWeatherState, openMeteoUrl } from './liveWeather';

const hours = Array.from({ length: 24 }, (_, i) => `2026-11-02T${String(i).padStart(2, '0')}:00`);
const col = (v: number) => hours.map(() => v);

/** A plausible Open-Meteo payload for KSFO on a broken, breezy afternoon. */
const fixture = {
  latitude: 37.62, longitude: -122.38, elevation: 4,
  hourly: {
    time: hours,
    wind_speed_10m: col(14), wind_direction_10m: col(280), wind_gusts_10m: col(24),
    wind_speed_850hPa: col(22), wind_direction_850hPa: col(265), geopotential_height_850hPa: col(1480),
    wind_speed_700hPa: col(30), wind_direction_700hPa: col(250), geopotential_height_700hPa: col(3050),
    wind_speed_500hPa: col(45), wind_direction_500hPa: col(240), geopotential_height_500hPa: col(5600),
    wind_speed_250hPa: col(80), wind_direction_250hPa: col(235), geopotential_height_250hPa: col(10_400),
    temperature_2m: col(16), dew_point_2m: col(10), pressure_msl: col(1016.2),
    cloud_cover_low: col(70), cloud_cover_mid: col(20), cloud_cover_high: col(0),
    visibility: col(24_140), precipitation: col(0), rain: col(0), snowfall: col(0), cape: col(50), freezing_level_height: col(2800), weather_code: col(3),
  },
};

describe('Open-Meteo live weather', () => {
  it('builds a CORS-friendly forecast URL with knots and UTC', () => {
    const u = openMeteoUrl(37.62, -122.38);
    expect(u.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(u).toContain('wind_speed_unit=kn');
    expect(u).toContain('geopotential_height_850hPa');
    expect(u).toContain('timezone=UTC');
  });

  it('picks the nearest hour', () => {
    expect(nearestHourIndex(hours, Date.UTC(2026, 10, 2, 13, 40))).toBe(14);
    expect(nearestHourIndex(hours, Date.UTC(2026, 10, 2, 0, 10))).toBe(0);
    expect(nearestHourIndex(undefined, 0)).toBe(0);
  });

  it('converts a payload into a WeatherState with winds aloft, layered cloud and derived fields', () => {
    const w = openMeteoToWeatherState(fixture, Date.UTC(2026, 10, 2, 20), 4);
    expect(w.preset).toBe('live');
    expect(w.winds).toHaveLength(5);
    expect(w.winds[0]).toMatchObject({ altM: 14, directionDeg: 280, speedKt: 14, gustKt: 24 });
    expect(w.winds[1]).toMatchObject({ altM: 1480, speedKt: 22 });
    expect(w.winds[4].altM).toBe(10_400);
    expect(w.clouds).toHaveLength(2);
    expect(w.clouds[0].coverage).toBeCloseTo(0.7);
    expect(w.clouds[0].baseM).toBeCloseTo(4 + 125 * 6, 6); // LCL from the dew-point depression
    expect(w.clouds[1].coverage).toBeCloseTo(0.2);
    expect(w.visibilityM).toBe(24_140);
    expect(w.qnhPa).toBeCloseTo(101_620, 6);
    expect(w.precipitationType).toBe('none');
    expect(w.thunderstorm).toBe(false);
    expect(w.turbulence).toBe(4); // 10 kt gust factor
    expect(w.humidity).toBeGreaterThan(0.6); expect(w.humidity).toBeLessThan(0.75);
  });

  it('snow, thunderstorms and fog codes', () => {
    const snowy = structuredClone(fixture);
    snowy.hourly.snowfall = col(0.8); snowy.hourly.rain = col(0); snowy.hourly.precipitation = col(0.8); snowy.hourly.weather_code = col(73);
    const s = openMeteoToWeatherState(snowy, 0);
    expect(s.precipitationType).toBe('snow');
    // snowfall is cm of snow depth; the rate is liquid-water equivalent mm/h (Open-Meteo: cm × 10 / 7)
    expect(s.precipitationRate).toBeCloseTo((0.8 * 10) / 7, 6);
    // convective showers are in `precipitation` but not in `rain`
    const showery = structuredClone(fixture);
    showery.hourly.precipitation = col(3); showery.hourly.rain = col(0); showery.hourly.snowfall = col(0); showery.hourly.weather_code = col(81);
    const sh = openMeteoToWeatherState(showery, 0);
    expect(sh.precipitationType).toBe('rain');
    expect(sh.precipitationRate).toBeCloseTo(3, 6);
    const stormy = structuredClone(fixture);
    stormy.hourly.weather_code = col(95); stormy.hourly.rain = col(6); stormy.hourly.cape = col(2000);
    const t = openMeteoToWeatherState(stormy, 0);
    expect(t.thunderstorm).toBe(true); expect(t.turbulence).toBe(5); expect(t.precipitationType).toBe('rain');
    const foggy = structuredClone(fixture);
    foggy.hourly.weather_code = col(45);
    const f = openMeteoToWeatherState(foggy, 0);
    expect(f.fogTopM).toBeGreaterThan(0); expect(f.visibilityM).toBeLessThanOrEqual(1000);
  });

  it('rejects malformed payloads and fetch fails gracefully', async () => {
    expect(() => openMeteoToWeatherState({}, 0)).toThrow();
    expect(() => openMeteoToWeatherState(null, 0)).toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await fetchOpenMeteo(0, 0, { fetchImpl: bad })).toBeNull();
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchOpenMeteo(0, 0, { fetchImpl: boom })).toBeNull();
    expect(await fetchMetarText('KSFO', { fetchImpl: boom })).toBeNull();
    const good = (async () => ({ ok: true, status: 200, json: async () => fixture, text: async () => 'KSFO 021856Z 28012KT' })) as unknown as typeof fetch;
    const w = await fetchOpenMeteo(37.62, -122.38, { fetchImpl: good, utcMs: Date.UTC(2026, 10, 2, 20) });
    expect(w?.preset).toBe('live');
    expect(await fetchMetarText('KSFO', { fetchImpl: good })).toBe('KSFO 021856Z 28012KT');
    expect(await fetchMetarText('bad id', { fetchImpl: good })).toBeNull();
    warn.mockRestore();
  });
});
