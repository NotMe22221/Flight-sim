import { describe, expect, it } from 'vitest';
import { makeCallsign } from './callsign';
import {
  altimeter, altitude, atisLetter, compassWord, digits, frequency, heading, miles, phoneticLetter,
  runway, spellOut, squawk, temperature, thousands, wind, zuluTime,
} from './phraseology';

describe('phraseology spell-outs', () => {
  it('spells digits FAA style: niner, but three/five (not ICAO tree/fife)', () => {
    expect(spellOut('0123456789')).toBe('zero one two three four five six seven eight niner');
    expect(spellOut('3 5')).not.toMatch(/tree|fife/);
    expect(spellOut('A1.5')).toBe('Alpha one point five');
    expect(digits(12).speech).toBe('one two');
  });

  it('callsigns: full on first contact, type + last three after', () => {
    const cs = makeCallsign('N172FS', 'Cessna');
    expect(cs.full.text).toBe('N172FS');
    expect(cs.full.speech).toBe('November One Seven Two Foxtrot Sierra');
    expect(cs.short.text).toBe('Cessna 2FS');
    expect(cs.short.speech).toBe('Cessna Two Foxtrot Sierra');
    expect(makeCallsign('n-739nr', 'Skyhawk').full.speech).toBe('November Seven Three Niner November Romeo');
    expect(makeCallsign('GABCD', 'Cessna').short.speech).toBe('Cessna Golf Charlie Delta');
  });

  it('altitudes in group form', () => {
    expect(altitude(2500)).toEqual({ text: '2,500', speech: 'two thousand five hundred' });
    expect(altitude(10500).speech).toBe('one zero thousand five hundred');
    expect(altitude(12000).speech).toBe('one two thousand');
    expect(altitude(900).speech).toBe('niner hundred');
    expect(altitude(1013).speech).toBe('one thousand');
    expect(altitude(3549).speech).toBe('three thousand five hundred');
    expect(altitude(18000)).toEqual({ text: 'FL180', speech: 'flight level one eight zero' });
    expect(thousands(12500)).toBe('12,500');
  });

  it('altimeter, heading, runway, frequency', () => {
    expect(altimeter(30.05)).toEqual({ text: '30.05', speech: 'three zero zero five' });
    expect(altimeter(29.92).speech).toBe('two niner niner two');
    expect(heading(280)).toEqual({ text: '280', speech: 'two eight zero' });
    expect(heading(5).speech).toBe('zero zero five');
    expect(heading(0).text).toBe('360');
    expect(runway('28R')).toEqual({ text: '28R', speech: 'two eight right' });
    expect(runway('01L')).toEqual({ text: '1L', speech: 'one left' });
    expect(runway('09').speech).toBe('niner');
    expect(runway('36C').speech).toBe('three six center');
    expect(frequency(120.5)).toEqual({ text: '120.5', speech: 'one two zero point five' });
    expect(frequency(118.85).speech).toBe('one one eight point eight five');
    expect(frequency(128.325)).toEqual({ text: '128.325', speech: 'one two eight point three two' }); // 7110.65 §2-4-17: two decimals spoken
    expect(frequency(121).text).toBe('121.0');
  });

  it('winds, temperatures, time, letters', () => {
    expect(wind(280, 12, 18)).toEqual({ text: '280 at 12 gusts 18', speech: 'two eight zero at one two gusts one eight' });
    expect(wind(3, 8).text).toBe('360 at 8');
    expect(wind(275, 9, 0).speech).toBe('two eight zero at niner');
    expect(wind(120, 2, 0).text).toBe('calm');
    expect(wind(120, 10, 9).text).toBe('120 at 10');
    expect(temperature(-5).speech).toBe('minus five');
    expect(temperature(18).speech).toBe('one eight');
    expect(temperature(-0.2).text).toBe('0');
    expect(zuluTime(Date.UTC(2026, 10, 3, 18, 56))).toEqual({ text: '1856Z', speech: 'one eight five six zulu' });
    expect(phoneticLetter('a')).toBe('Alpha');
    expect(atisLetter('J').speech).toBe('Juliet');
    expect(squawk(452).speech).toBe('zero four five two');
    expect(miles(12).speech).toBe('one two miles');
    expect(miles(1).text).toBe('1 mile');
    expect(compassWord(135)).toBe('southeast');
    expect(compassWord(350)).toBe('north');
  });
});
