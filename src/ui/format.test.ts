import { describe, expect, it } from 'vitest';
import {
  defaultUnits, formatAltitude, formatAngle, formatCoord, formatDateUtc, formatDistance, formatDuration, formatEte,
  formatFrequency, formatFrequencyMHz, formatFuel, formatHeading, formatMass, formatPercent, formatPressure, formatSpeed,
  formatTemperature, formatTimeLocal, formatTimeScale, formatTimeUtc, formatUtcOffset, formatVerticalSpeed, formatWind,
  groupThousands, normalizeHeading, roundTo, timezoneOffsetFromLon,
} from './format';
import type { UnitsSettings } from './UiHost';

const metric: UnitsSettings = { altitude: 'm', speed: 'kmh', pressure: 'hPa', distance: 'km', temperature: 'F' };
const mph: UnitsSettings = { ...defaultUnits, speed: 'mph' };

describe('groupThousands / roundTo', () => {
  it('groups with commas and keeps the sign', () => {
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1000)).toBe('1,000');
    expect(groupThousands(1234567.6)).toBe('1,234,568');
    expect(groupThousands(-1234)).toBe('-1,234');
    expect(groupThousands(NaN)).toBe('--');
  });
  it('rounds to a step', () => {
    expect(roundTo(1234, 10)).toBe(1230);
    expect(roundTo(1235, 10)).toBe(1240);
    expect(roundTo(-15, 10)).toBe(-10);
  });
});

describe('altitude', () => {
  it('converts to feet and metres with rounding', () => {
    expect(formatAltitude(1066.8)).toBe('3,500 ft');
    expect(formatAltitude(1066.8, metric)).toBe('1,067 m');
    expect(formatAltitude(304.8, defaultUnits, 100)).toBe('1,000 ft');
    expect(formatAltitude(-15.24)).toBe('-50 ft');
    expect(formatAltitude(NaN)).toBe('--');
  });
});

describe('speed', () => {
  it('handles kt, km/h, mph', () => {
    expect(formatSpeed(57.6)).toBe('112 kt');
    expect(formatSpeed(57.6, metric)).toBe('207 km/h');
    expect(formatSpeed(57.6, mph)).toBe('129 mph');
    expect(formatSpeed(0)).toBe('0 kt');
  });
  it('vertical speed carries a sign and rounds to 10 fpm', () => {
    expect(formatVerticalSpeed(2.54)).toBe('+500 fpm');
    expect(formatVerticalSpeed(-3.81)).toBe('-750 fpm');
    expect(formatVerticalSpeed(0)).toBe('0 fpm');
    expect(formatVerticalSpeed(2.54, metric)).toBe('+2.5 m/s');
    expect(formatVerticalSpeed(-0.04, metric)).toBe('0.0 m/s');
  });
});

describe('pressure', () => {
  it('formats inHg with two decimals and hPa as integer', () => {
    expect(formatPressure(101325)).toBe('29.92 inHg');
    expect(formatPressure(101325, metric)).toBe('1013 hPa');
    expect(formatPressure(100800, metric)).toBe('1008 hPa');
  });
});

describe('distance', () => {
  it('uses one decimal under 10 units and integers above', () => {
    expect(formatDistance(1852 * 2.5)).toBe('2.5 nm');
    expect(formatDistance(1852 * 123.4)).toBe('123 nm');
    expect(formatDistance(800, metric)).toBe('0.8 km');
    expect(formatDistance(-1852 * 3)).toBe('-3.0 nm');
  });
});

describe('temperature', () => {
  it('converts C/F and never prints -0', () => {
    expect(formatTemperature(15)).toBe('15 °C');
    expect(formatTemperature(15, metric)).toBe('59 °F');
    expect(formatTemperature(-3)).toBe('-3 °C');
    expect(formatTemperature(-0.2)).toBe('0 °C');
  });
});

describe('mass & fuel', () => {
  it('follows the altitude unit for mass', () => {
    expect(formatMass(1000)).toBe('2,205 lb');
    expect(formatMass(1000, metric)).toBe('1,000 kg');
  });
  it('fuel in gal / L / kg / lb', () => {
    expect(formatFuel(72, 'kg')).toBe('72.0 kg');
    expect(formatFuel(72, 'l')).toBe('100.0 L');
    expect(formatFuel(72, 'gal')).toBe('26.4 gal');
    expect(formatFuel(72, 'lb')).toBe('158.7 lb');
    expect(formatFuel(500, 'l')).toBe('694.4 L');
    expect(formatFuel(10_000, 'kg')).toBe('10,000 kg');
  });
});

describe('frequency', () => {
  it('uses three decimals for 8.33 kHz channels and two for 25 kHz channels', () => {
    expect(formatFrequency(118005)).toBe('118.005');
    expect(formatFrequency(116800)).toBe('116.80');
    expect(formatFrequency(118250)).toBe('118.25');
    expect(formatFrequency(118010)).toBe('118.010');
    expect(formatFrequency(121500)).toBe('121.50');
    expect(formatFrequency(0)).toBe('---.--');
  });
  it('keeps the third decimal of 25 kHz channels such as 118.125 (no rounding onto another channel)', () => {
    expect(formatFrequency(118125)).toBe('118.125');
    expect(formatFrequency(118275)).toBe('118.275');
    expect(formatFrequency(118025)).toBe('118.025');
    expect(formatFrequency(124425)).toBe('124.425');
    expect(formatFrequencyMHz(121.775)).toBe('121.775');
    expect(formatFrequencyMHz(119.1)).toBe('119.10');
    expect(formatFrequencyMHz(108.0)).toBe('108.00');
  });
  it('accepts MHz with float noise', () => {
    expect(formatFrequencyMHz(118.005)).toBe('118.005');
    expect(formatFrequencyMHz(116.8)).toBe('116.80');
    expect(formatFrequencyMHz(111.7)).toBe('111.70');
  });
});

describe('headings', () => {
  it('wraps into 0..360 and shows 0 as 360 with three digits', () => {
    expect(normalizeHeading(370)).toBe(10);
    expect(normalizeHeading(-10)).toBe(350);
    expect(normalizeHeading(720)).toBe(0);
    expect(formatHeading(283.4)).toBe('283°');
    expect(formatHeading(5)).toBe('005°');
    expect(formatHeading(0)).toBe('360°');
    expect(formatHeading(360)).toBe('360°');
    expect(formatHeading(-90)).toBe('270°');
    expect(formatHeading(359.7)).toBe('360°');
    expect(formatHeading(NaN)).toBe('---°');
  });
  it('signed angles', () => {
    expect(formatAngle(2.5)).toBe('+2.5°');
    expect(formatAngle(-10)).toBe('-10°');
    expect(formatAngle(0)).toBe('0.0°');
  });
  it('coordinates', () => {
    expect(formatCoord(37.613538, -122.35716)).toBe('N37°36.81′ W122°21.43′');
    expect(formatCoord(-33.9, 151.2)).toBe('S33°54.00′ E151°12.00′');
  });
});

describe('time', () => {
  const t = Date.UTC(2026, 10, 2, 14, 5, 30);
  it('UTC and offset-based local', () => {
    expect(formatTimeUtc(t)).toBe('14:05Z');
    expect(formatTimeLocal(t, -480)).toBe('06:05');
    expect(formatTimeLocal(t, 330)).toBe('19:35');
    expect(formatDateUtc(t)).toBe('2026-11-02');
  });
  it('longitude → whole-hour offset', () => {
    expect(timezoneOffsetFromLon(-122.4)).toBe(-480);
    expect(timezoneOffsetFromLon(0)).toBe(0);
    expect(timezoneOffsetFromLon(151.2)).toBe(600);
    expect(timezoneOffsetFromLon(-187)).toBe(720); // wraps to +173° → 11.5 h → 12 h
    expect(formatUtcOffset(-480)).toBe('UTC-8');
    expect(formatUtcOffset(330)).toBe('UTC+5:30');
    expect(formatUtcOffset(0)).toBe('UTC');
  });
  it('durations', () => {
    expect(formatDuration(3900)).toBe('1h 05m');
    expect(formatDuration(750)).toBe('12m 30s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(-1)).toBe('--');
    expect(formatDuration(Infinity)).toBe('--');
    expect(formatEte(3900)).toBe('1:05');
    expect(formatEte(750)).toBe('12:30');
    expect(formatEte(NaN)).toBe('--:--');
  });
});

describe('misc', () => {
  it('wind, percent, time scale', () => {
    expect(formatWind(280, 10)).toBe('280/10');
    expect(formatWind(280, 10, 15)).toBe('280/10G15');
    expect(formatWind(0, 8)).toBe('360/08');
    expect(formatWind(90, 0.4)).toBe('CALM');
    expect(formatPercent(0.457)).toBe('46%');
    expect(formatTimeScale(1)).toBe('x1');
    expect(formatTimeScale(0.5)).toBe('x0.5');
    expect(formatTimeScale(16)).toBe('x16');
  });
});
