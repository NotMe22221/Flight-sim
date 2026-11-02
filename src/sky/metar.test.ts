import { describe, expect, it } from 'vitest';
import { FT, INHG } from '../core/units';
import { parseMetar, relativeHumidity } from './metar';

describe('parseMetar', () => {
  it('KSFO: wind with gusts, SM visibility, FEW/BKN layers, A-altimeter', () => {
    const r = parseMetar('KSFO 021856Z 28012G18KT 10SM FEW012 BKN200 18/11 A3005', 4);
    expect(r.station).toBe('KSFO');
    expect(r.day).toBe(2); expect(r.hourUtc).toBe(18); expect(r.minuteUtc).toBe(56);
    expect(r.windFromDeg).toBe(280); expect(r.windSpeedKt).toBe(12); expect(r.windGustKt).toBe(18);
    expect(r.visibilityM).toBeCloseTo(16093.44, 0);
    expect(r.clouds).toHaveLength(2);
    expect(r.clouds[0]).toMatchObject({ cover: 'FEW', towering: false });
    expect(r.clouds[0].baseAglM).toBeCloseTo(1200 * FT, 6);
    expect(r.temperatureC).toBe(18); expect(r.dewpointC).toBe(11);
    expect(r.qnhPa).toBeCloseTo(30.05 * INHG, 3);
    expect(r.unparsed).toEqual([]);
    const w = r.weather;
    expect(w.preset).toBe('custom');
    expect(w.clouds[0].baseM).toBeCloseTo(4 + 1200 * FT, 6); // AGL → MSL with station elevation
    expect(w.clouds[0].coverage).toBeCloseTo(0.19);
    expect(w.clouds[1].coverage).toBeCloseTo(0.75);
    expect(w.clouds[1].type).toBe('cirrus'); // 20 000 ft is a high layer
    expect(w.winds[0]).toMatchObject({ directionDeg: 280, speedKt: 12, gustKt: 18, altM: 14 });
    expect(w.precipitationType).toBe('none');
    expect(w.qnhPa).toBeCloseTo(30.05 * INHG, 3);
    expect(w.humidity).toBeCloseTo(relativeHumidity(18, 11), 6);
    expect(w.turbulence).toBe(3); // gusting
  });

  it('EGLL: metres visibility, -RA, CB layer, Q-altimeter', () => {
    const r = parseMetar('EGLL 021750Z 24008KT 9999 -RA SCT012 BKN020 OVC045CB 12/10 Q1009', 25);
    expect(r.visibilityM).toBe(10_000);
    expect(r.phenomena).toEqual(['-RA']);
    expect(r.clouds).toHaveLength(3);
    expect(r.clouds[2]).toMatchObject({ cover: 'OVC', towering: true, cb: true });
    expect(r.qnhPa).toBe(100_900);
    const w = r.weather;
    expect(w.precipitationType).toBe('rain');
    expect(w.precipitationRate).toBeCloseTo(2); // light rain = 0.5 × 4 mm/h
    expect(w.clouds[2].type).toBe('cumulus');
    expect(w.clouds[2].density).toBe(1.5);
    expect(w.clouds[2].topM - w.clouds[2].baseM).toBe(6000);
    expect(w.turbulence).toBeGreaterThanOrEqual(4); // CB present
    expect(w.visibilityM).toBe(10_000);
  });

  it('CAVOK: no cloud, visibility ≥ 10 km, no weather', () => {
    const r = parseMetar('LFPG 021800Z 36005KT CAVOK 22/08 Q1021', 119);
    expect(r.cavok).toBe(true);
    expect(r.visibilityM).toBe(10_000);
    expect(r.clouds).toHaveLength(0);
    expect(r.weather.clouds).toHaveLength(0);
    expect(r.weather.precipitationRate).toBe(0);
    expect(r.weather.qnhPa).toBe(102_100);
    expect(r.weather.turbulence).toBe(1);
  });

  it('VRB wind, mixed-fraction statute miles, mist', () => {
    const r = parseMetar('KJFK 021851Z VRB03KT 1 1/2SM BR OVC004 M02/M03 A2992', 4);
    expect(r.windVariable).toBe(true);
    expect(r.windFromDeg).toBeNull();
    expect(r.windSpeedKt).toBe(3);
    expect(r.visibilityM).toBeCloseTo(1.5 * 1609.344, 3);
    expect(r.phenomena).toEqual(['BR']);
    expect(r.temperatureC).toBe(-2); expect(r.dewpointC).toBe(-3);
    expect(r.qnhPa).toBeCloseTo(29.92 * INHG, 3);
    expect(r.weather.winds[0].directionDeg).toBe(0); // VRB without range → north
    expect(r.weather.fogTopM).toBeGreaterThan(0); // mist with < 3 km
    expect(r.weather.temperatureC).toBeCloseTo(-2 + 0.0065 * 4, 6);
  });

  it('variable wind with a range uses the bisector; MPS units; snow', () => {
    const r = parseMetar('UUEE 021800Z VRB04MPS 340V040 2000 -SN BKN008 OVC020 M05/M07 Q1002', 192);
    expect(r.windVariationDeg).toEqual([340, 40]);
    expect(r.windSpeedKt).toBeCloseTo(4 * 1.943844, 4);
    expect(r.weather.winds[0].directionDeg).toBeCloseTo(10, 6);
    expect(r.weather.precipitationType).toBe('snow');
    expect(r.weather.precipitationRate).toBeCloseTo(1); // light snow 0.5 × 2
    expect(r.weather.visibilityM).toBe(2000);
    expect(r.weather.qnhPa).toBe(100_200);
    expect(r.temperatureC).toBe(-5);
  });

  it('vertical visibility (sky obscured) makes a surface-based layer and a fog top', () => {
    const r = parseMetar('KSEA 021853Z 00000KT 1/4SM FG VV002 08/08 A3010 RMK AO2 SLP195', 130);
    expect(r.verticalVisibilityM).toBeCloseTo(200 * FT, 6);
    expect(r.visibilityM).toBeCloseTo(0.25 * 1609.344, 3);
    expect(r.windSpeedKt).toBe(0);
    const w = r.weather;
    expect(w.clouds).toHaveLength(1);
    expect(w.clouds[0].baseM).toBe(130); // at the surface
    expect(w.clouds[0].coverage).toBe(1);
    expect(w.fogTopM).toBeCloseTo(200 * FT, 6);
    expect(w.humidity).toBeCloseTo(1, 6);
    expect(r.unparsed).toEqual([]); // remarks ignored, not reported as unparsed
  });

  it('thunderstorm with heavy rain and hail; P6SM; TCU', () => {
    const r = parseMetar('KDEN 022053Z 18015G28KT 150V220 P6SM +TSRAGR SCT040TCU BKN070 OVC100 24/16 A2985', 1655);
    expect(r.phenomena).toEqual(['+TSRAGR']);
    expect(r.visibilityM).toBeGreaterThan(6 * 1609.344);
    const w = r.weather;
    expect(w.thunderstorm).toBe(true);
    expect(w.precipitationType).toBe('rain');
    expect(w.precipitationRate).toBeCloseTo(12); // heavy = 3 × 4
    expect(w.turbulence).toBe(5);
    expect(w.clouds[0].type).toBe('cumulus');
    expect(w.clouds[0].density).toBe(1.5);
    expect(w.winds[0].gustKt).toBe(28);
  });

  it('KMH wind, NSC, trend groups are ignored', () => {
    const r = parseMetar('YSSY 021800Z 12020KMH 9999 NSC 25/12 Q1015 NOSIG', 6);
    expect(r.windSpeedKt).toBeCloseTo(20 * 0.539957, 4);
    expect(r.clouds).toHaveLength(0);
    expect(r.weather.qnhPa).toBe(101_500);
    expect(r.unparsed).toEqual([]);
  });

  it('TEMPO groups do not override the main body', () => {
    const r = parseMetar('EGKK 021820Z 20010KT 8000 -DZ BKN006 11/10 Q1004 TEMPO 3000 DZ BKN003', 62);
    expect(r.visibilityM).toBe(8000);
    expect(r.clouds).toHaveLength(1);
    expect(r.clouds[0].baseAglM).toBeCloseTo(600 * FT, 6);
    expect(r.weather.precipitationType).toBe('rain');
  });

  it('AUTO/COR tokens, missing dew point and a trailing = are tolerated; garbage never throws', () => {
    const r = parseMetar('METAR CYVR 021800Z AUTO 09012KT 15SM SKC 20/ A3001=', 2);
    expect(r.station).toBe('CYVR');
    expect(r.temperatureC).toBe(20);
    expect(r.dewpointC).toBeNull();
    expect(r.weather.clouds).toHaveLength(0);
    expect(() => parseMetar('')).not.toThrow();
    expect(() => parseMetar('garbage 123 ??? !!!')).not.toThrow();
    expect(parseMetar('garbage 123 ??? !!!').unparsed.length).toBeGreaterThan(0);
  });

  it('relative humidity: saturated when T = Td, ~50 % for 20/9', () => {
    expect(relativeHumidity(10, 10)).toBeCloseTo(1, 6);
    expect(relativeHumidity(20, 9)).toBeGreaterThan(0.45);
    expect(relativeHumidity(20, 9)).toBeLessThan(0.55);
  });
});
