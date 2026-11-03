import { describe, expect, it } from 'vitest';
import { magneticDeclinationDeg } from '../nav';
import { buildAtis, metarLine, visibility, weatherWords } from './atis';
import { AtisLetterTracker, atisContentKey } from './atisTracker';
import { fieldInfo, runwaysInUse } from './field';
import { dewpointC, flightCategory, observeSurface, relativeHumidity, reportableVisibilitySM, roundCloudBaseFt } from './surfaceObs';
import { KSFO_ELEV_M, ksfoWeather, loadBayAreaDb } from './__tests__/fixtures';

const UTC = Date.UTC(2026, 10, 3, 18, 56);

describe('surface observation', () => {
  it('rounds the KSFO weather like a METAR', () => {
    const obs = observeSurface(ksfoWeather(), KSFO_ELEV_M);
    expect(obs).toMatchObject({ windDirTrueDeg: 280, windSpeedKt: 12, windGustKt: 18, visibilitySM: 10, temperatureC: 18, dewpointC: 11, altimeterInHg: 30.05, weather: '' });
    expect(obs.layers).toEqual([{ cover: 'FEW', baseFtAgl: 1200 }, { cover: 'BKN', baseFtAgl: 20000 }]);
    expect(metarLine('KSFO', UTC, obs)).toBe('KSFO 031856Z 28012G18KT 10SM FEW012 BKN200 18/11 A3005');
    expect(flightCategory(obs)).toBe('VFR');
  });

  it('humidity ↔ dew point, visibility and cloud-base rounding', () => {
    expect(dewpointC(18, relativeHumidity(18, 11))).toBeCloseTo(11, 6);
    expect(reportableVisibilitySM(4000)).toBe(2);
    expect(reportableVisibilitySM(300)).toBe(0);
    expect(visibility(2.5)).toEqual({ text: '2 1/2', speech: 'two and one half' });
    expect(visibility(0.75).speech).toBe('three quarters');
    expect(visibility(10).speech).toBe('one zero');
    expect(roundCloudBaseFt(7240)).toBe(7000);
    expect(roundCloudBaseFt(1249)).toBe(1200);
    expect(weatherWords('-TSRA')).toBe('light thunderstorm rain');
    const wet = observeSurface(ksfoWeather({ precipitationType: 'rain', precipitationRate: 1, visibilityM: 5000, thunderstorm: true }), KSFO_ELEV_M);
    expect(wet.weather).toBe('-TSRA');
  });
});

describe('ATIS for KSFO', () => {
  it('wind 280@12G18, FEW012 BKN200, 18/11, A3005 → runways 28L/28R', async () => {
    const db = await loadBayAreaDb();
    const ksfo = db.getAirport('KSFO');
    expect(ksfo).toBeDefined();
    if (!ksfo) return;
    const rw = runwaysInUse(ksfo, 280, 12);
    expect(rw?.primary.ident).toBe('28R');
    expect(rw?.all.map((r) => r.ident)).toEqual(['28L', '28R']);

    // True-wind report (no declination): matches the METAR numbers exactly.
    const trueAtis = buildAtis({ airport: ksfo, weather: ksfoWeather(), letter: 'C', utcMs: UTC, runways: ['28L', '28R'] });
    expect(trueAtis.text).toBe(
      'San Francisco International information Charlie. 1856Z. Wind 280 at 12 gusting 18. Visibility 10. ' +
      'Few clouds at 1,200, ceiling 20,000 broken. Temperature 18, dew point 11. Altimeter 30.05. ' +
      'Landing and departing runways 28L and 28R. Advise on initial contact you have information Charlie.',
    );
    const sp = trueAtis.speech.toLowerCase();
    expect(sp).toContain('information charlie');
    expect(sp).toContain('one eight five six zulu');
    expect(sp).toContain('wind two eight zero at one two gusting one eight');
    expect(sp).toContain('few clouds at one thousand two hundred, ceiling two zero thousand broken');
    expect(sp).toContain('temperature one eight, dew point one one');
    expect(sp).toContain('altimeter three zero zero five');
    expect(sp).toContain('runways two eight left and two eight right');
    expect(sp).toContain('advise on initial contact you have information charlie');
    expect(trueAtis.metar).toBe('KSFO 031856Z 28012G18KT 10SM FEW012 BKN200 18/11 A3005');

    // FAA practice: ATIS winds are magnetic (KSFO declination ≈ 13° E → 270).
    const decl = magneticDeclinationDeg(ksfo.position.lat, ksfo.position.lon, 0, UTC);
    expect(decl).toBeGreaterThan(11);
    const magAtis = buildAtis({ airport: ksfo, weather: ksfoWeather(), letter: 'C', utcMs: UTC, runways: ['28L', '28R'], magVarDeg: decl });
    expect(magAtis.text).toContain('Wind 270 at 12 gusting 18.');
    expect(magAtis.metar).toContain('28012G18KT');
  });

  it('frequencies and facility names come from the airport data', async () => {
    const db = await loadBayAreaDb();
    const ksfo = db.getAirport('KSFO');
    if (!ksfo) throw new Error('KSFO missing');
    const f = fieldInfo(ksfo);
    expect(f.towered).toBe(true);
    expect(f.tower?.mhz).toBe(120.5);
    expect(f.ground?.mhz).toBe(121.8);
    expect(f.atis?.mhz).toBe(113.7);
    expect(f.tower?.name.text).toBe('San Francisco Tower');
    expect(f.departure?.mhz).toBe(120.9);
    expect(f.patternAltitudeFt).toBe(1000);
  });

  it('AWOS-style automated report has no letter and no runways', async () => {
    const db = await loadBayAreaDb();
    const ksfo = db.getAirport('KSFO');
    if (!ksfo) throw new Error('KSFO missing');
    const r = buildAtis({ airport: ksfo, weather: ksfoWeather({ clouds: [] }), letter: 'A', utcMs: UTC, runways: ['28R'], automated: true });
    expect(r.text).toMatch(/^San Francisco International automated weather observation, 1856Z\. Wind 280/);
    expect(r.text).toContain('Sky clear.');
    expect(r.text).not.toContain('information');
    expect(r.text).not.toContain('runway');
  });
});

describe('ATIS letter tracker', () => {
  it('advances hourly and on content change, not on every evaluation', () => {
    const t = new AtisLetterTracker('KSFO', UTC);
    const first = t.letter;
    const obs = observeSurface(ksfoWeather(), KSFO_ELEV_M);
    const key = atisContentKey(obs, ['28L', '28R']);
    expect(t.update(UTC + 1000, key)).toBe(false);
    expect(t.update(UTC + 2000, key)).toBe(false);
    expect(t.letter).toBe(first);
    // Hour boundary (18:56 → 19:00).
    expect(t.update(UTC + 5 * 60_000, key)).toBe(true);
    const second = t.letter;
    expect(second).not.toBe(first);
    // Weather change → new letter (once).
    const key2 = atisContentKey(observeSurface(ksfoWeather({ qnhPa: 29.92 * 3386.39 }), KSFO_ELEV_M), ['28L', '28R']);
    expect(t.update(UTC + 7 * 60_000, key2)).toBe(true);
    expect(t.update(UTC + 7 * 60_000 + 1000, key2)).toBe(false);
    expect(t.letter).not.toBe(second);
    // Flapping back within the minimum interval does not cycle the letter.
    expect(t.update(UTC + 7 * 60_000 + 2000, key)).toBe(false);
  });
});
