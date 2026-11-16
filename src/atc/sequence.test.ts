import { describe, expect, it } from 'vitest';
import { atc, sequencePhrase } from './messages';
import { spoken } from './phraseology';

const cs = spoken('Cessna 2FS', 'Cessna Two Foxtrot Sierra');
const wind = spoken('270 at 8', 'two seven zero at eight');

describe('tower sequencing phrases', () => {
  it('landing clearance with the aircraft ahead', () => {
    const seq = sequencePhrase({ type: 'Cessna', leg: 'base' }, 'left');
    expect(atc.landing(cs, wind, '28L', 'land', seq).text).toBe('Cessna 2FS, number two, follow the Cessna on left base, wind 270 at 8, runway 28L, cleared to land.');
    expect(atc.landing(cs, wind, '28L', 'land', sequencePhrase({ type: 'Piper Cub', leg: 'final' }, 'left')).text)
      .toBe('Cessna 2FS, number two, follow the Piper Cub on short final, wind 270 at 8, runway 28L, cleared to land.');
  });

  it('pattern report acknowledgement with the aircraft ahead, and the plain forms without', () => {
    expect(atc.roger(cs, spoken('base'), sequencePhrase({ type: 'Cessna', leg: 'final' }, 'right')).text).toBe('Cessna 2FS, roger, number two, follow the Cessna on short final, report base.');
    expect(atc.roger(cs, spoken('base')).text).toBe('Cessna 2FS, roger, report base.');
    expect(atc.landing(cs, wind, '28L', 'land', sequencePhrase(null, 'left')).text).toBe('Cessna 2FS, wind 270 at 8, runway 28L, cleared to land.');
  });
});
