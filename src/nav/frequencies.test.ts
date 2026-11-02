import { describe, expect, it } from 'vitest';
import {
  formatCom, formatKHz, formatNav, isComFrequency25, isComFrequency833, isIlsFrequency, isNavFrequency,
  parseMHz, snapCom, snapNav, stepCom, stepNav, swapFrequencies,
} from './frequencies';

describe('frequencies', () => {
  it('classifies NAV and ILS frequencies', () => {
    expect(isNavFrequency(108_000)).toBe(true);
    expect(isNavFrequency(117_950)).toBe(true);
    expect(isNavFrequency(118_000)).toBe(false);
    expect(isNavFrequency(108_025)).toBe(false);
    expect(isIlsFrequency(108_100)).toBe(true); // 108.10
    expect(isIlsFrequency(108_150)).toBe(true); // 108.15
    expect(isIlsFrequency(108_200)).toBe(false); // even tenth → VOR
    expect(isIlsFrequency(110_350)).toBe(true);
    expect(isIlsFrequency(111_950)).toBe(true);
    expect(isIlsFrequency(112_100)).toBe(false); // above the ILS sub-band
    expect(isIlsFrequency(108_000)).toBe(false);
  });

  it('classifies COM frequencies for both spacings', () => {
    expect(isComFrequency25(118_000)).toBe(true);
    expect(isComFrequency25(136_975)).toBe(true);
    expect(isComFrequency25(118_005)).toBe(false);
    expect(isComFrequency833(118_005)).toBe(true);
    expect(isComFrequency833(118_015)).toBe(true);
    expect(isComFrequency833(118_020)).toBe(false); // not a designator
    expect(isComFrequency833(136_990)).toBe(true);
  });

  it('NAV steps wrap at the band edges', () => {
    expect(stepNav(117_950, 1)).toBe(108_000);
    expect(stepNav(108_000, -1)).toBe(117_950);
    expect(stepNav(108_000, 1)).toBe(108_050);
    expect(stepNav(117_950, 1, true)).toBe(108_950); // MHz knob keeps the kHz part
    expect(stepNav(108_300, -1, true)).toBe(117_300);
  });

  it('COM steps wrap at the band edges (25 kHz and 8.33 kHz)', () => {
    expect(stepCom(136_975, 1)).toBe(118_000);
    expect(stepCom(118_000, -1)).toBe(136_975);
    expect(stepCom(118_000, 1)).toBe(118_025);
    expect(stepCom(136_990, 1, false, 8.33)).toBe(118_000);
    expect(stepCom(118_000, -1, false, 8.33)).toBe(136_990);
    expect(stepCom(118_000, 1, false, 8.33)).toBe(118_005);
    expect(stepCom(118_015, 1, false, 8.33)).toBe(118_025); // skips the unused .020
    expect(stepCom(118_040, 1, false, 8.33)).toBe(118_050);
    expect(stepCom(136_500, 1, true)).toBe(118_500);
    expect(stepCom(118_500, -1, true)).toBe(136_500);
  });

  it('formats frequencies', () => {
    expect(formatNav(108_100)).toBe('108.10');
    expect(formatNav(117_950)).toBe('117.95');
    expect(formatCom(118_005, 8.33)).toBe('118.005');
    expect(formatCom(128_325, 8.33)).toBe('128.325');
    expect(formatCom(128_325, 25)).toBe('128.32'); // 5-digit display truncates
    expect(formatCom(121_500, 25)).toBe('121.50');
    expect(formatKHz(118_000, 3)).toBe('118.000');
  });

  it('snaps and parses', () => {
    expect(snapNav(108_020)).toBe(108_000);
    expect(snapNav(108_030)).toBe(108_050);
    expect(snapNav(200_000)).toBe(117_950);
    expect(snapCom(118_012)).toBe(118_000);
    expect(snapCom(118_013)).toBe(118_025);
    expect(snapCom(118_007, 8.33)).toBe(118_005);
    expect(snapCom(118_018, 8.33)).toBe(118_015);
    expect(parseMHz('118.005')).toBe(118_005);
    expect(parseMHz('108.1')).toBe(108_100);
    expect(parseMHz(116.8)).toBe(116_800);
    expect(parseMHz('abc')).toBeNaN();
  });

  it('swaps active and standby', () => {
    const r = swapFrequencies({ activeKHz: 108_100, standbyKHz: 116_800 });
    expect(r.activeKHz).toBe(116_800);
    expect(r.standbyKHz).toBe(108_100);
  });
});
