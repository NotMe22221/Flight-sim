import { describe, expect, it } from 'vitest';
import { formatAltitude, formatComFrequency, formatEte, formatHeading, formatHeadingNum, formatNavFrequency, formatNavLabel, formatSigned, formatThousands, formatTimer, formatUtc, formatVerticalSpeed } from './format';
import { asiDialTravelDeg, asiNeedleDeg, forEachTick, linearAngleDeg, pxPerUnit, snapMapRange, stepMapRange, tapeOffsetPx } from './scales';
import { ASI_DIAL, C172S_VSPEEDS } from './c172';

describe('format', () => {
  it('frequencies', () => {
    expect(formatNavFrequency(116800)).toBe('116.80');
    expect(formatNavLabel('NAV', 116800)).toBe('NAV 116.80');
    expect(formatNavFrequency(108050)).toBe('108.05');
    expect(formatComFrequency(120500)).toBe('120.500');
    expect(formatComFrequency(118005)).toBe('118.005');
  });
  it('altitudes with thousands separators', () => {
    expect(formatAltitude(3500)).toBe('3,500');
    expect(formatAltitude(3487.6)).toBe('3,488');
    expect(formatAltitude(3487, 20)).toBe('3,480');
    expect(formatAltitude(12345)).toBe('12,345');
    expect(formatThousands(-250)).toBe('-250');
    expect(formatThousands(999)).toBe('999');
    expect(formatThousands(1000000)).toBe('1,000,000');
  });
  it('headings are three digits and 0 shows as 360', () => {
    expect(formatHeading(285)).toBe('285°');
    expect(formatHeading(5)).toBe('005°');
    expect(formatHeading(0)).toBe('360°');
    expect(formatHeading(-15)).toBe('345°');
    expect(formatHeadingNum(359.6)).toBe('360');
  });
  it('signed and vertical speeds', () => {
    expect(formatSigned(500)).toBe('+500');
    expect(formatSigned(-700)).toBe('-700');
    expect(formatSigned(0)).toBe('0');
    expect(formatVerticalSpeed(487)).toBe('+500');
    expect(formatVerticalSpeed(-120)).toBe('-100');
  });
  it('clocks and timers', () => {
    expect(formatUtc(Date.UTC(2026, 0, 1, 18, 30, 15))).toBe('18:30:15');
    expect(formatTimer(65)).toBe('01:05');
    expect(formatTimer(3725)).toBe('1:02:05');
    expect(formatEte(420)).toBe('00:07');
    expect(formatEte(NaN)).toBe('__:__');
  });
});

describe('scales', () => {
  it('tape scaling: 450 px for 60 kt = 7.5 px/kt, 450 px for 600 ft = 0.75 px/ft', () => {
    expect(pxPerUnit(450, 60)).toBe(7.5);
    expect(pxPerUnit(450, 600)).toBe(0.75);
    expect(tapeOffsetPx(120, 110, 7.5)).toBe(-75); // faster speeds are drawn above the centre
    expect(tapeOffsetPx(3400, 3500, 0.75)).toBe(75);
  });
  it('forEachTick visits every step inside the window and clamps to the range', () => {
    const seen: number[] = [];
    forEachTick(25, 10, 7.5, 225, 20, 400, (v) => seen.push(v));
    expect(seen[0]).toBe(20);
    expect(seen[seen.length - 1]).toBe(50);
    expect(seen).toEqual([20, 30, 40, 50]);
  });
  it('C172 airspeed dial is compressed below 40 kt and linear above', () => {
    expect(asiDialTravelDeg(0)).toBe(0);
    expect(asiDialTravelDeg(40)).toBe(ASI_DIAL.kneeDeg);
    expect(asiDialTravelDeg(120)).toBeCloseTo(ASI_DIAL.kneeDeg + 160, 9);
    expect(asiDialTravelDeg(200)).toBeCloseTo(340, 9);
    expect(asiDialTravelDeg(250)).toBeCloseTo(340, 9); // clamped
    expect(asiNeedleDeg(0)).toBe(ASI_DIAL.zeroDeg);
    // arcs land in the right order on the dial
    const v = C172S_VSPEEDS;
    const angles = [v.vso, v.vs1, v.vfe, v.vno, v.vne].map(asiDialTravelDeg);
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
    expect(asiDialTravelDeg(v.vne)).toBeCloseTo(20 + ((163 - 40) / 160) * 320, 9);
  });
  it('linear dial mapping and MFD range steps', () => {
    expect(linearAngleDeg(2700, 0, 3500, -135, 270)).toBeCloseTo(-135 + (2700 / 3500) * 270, 9);
    expect(snapMapRange(11)).toBe(10);
    expect(stepMapRange(10, 1)).toBe(15);
    expect(stepMapRange(0.5, -1)).toBe(0.5);
  });
});
