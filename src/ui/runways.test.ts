import { describe, expect, it } from 'vitest';
import { FALLBACK_KSFO, activeRunwayEnd, findRunwayEnd, headwindKt, reciprocalIdent, runwayEnds } from './runways';

describe('runways', () => {
  it('reciprocal idents', () => {
    expect(reciprocalIdent('28R')).toBe('10L');
    expect(reciprocalIdent('10L')).toBe('28R');
    expect(reciprocalIdent('09')).toBe('27');
    expect(reciprocalIdent('18C')).toBe('36C');
    expect(reciprocalIdent('36')).toBe('18');
    expect(reciprocalIdent('01')).toBe('19');
    expect(reciprocalIdent('H1')).toBe('H1/R');
  });
  it('both ends with reciprocal heading and swapped thresholds', () => {
    const r = FALLBACK_KSFO.runways[0];
    const [a, b] = runwayEnds(r);
    expect(a.endIdent).toBe('28R');
    expect(b.endIdent).toBe('10L');
    expect(b.headingDeg).toBeCloseTo((r.headingDeg + 180) % 360, 9);
    expect(b.threshold).toBe(r.end);
    expect(findRunwayEnd(FALLBACK_KSFO, '10l')?.endIdent).toBe('10L');
    expect(findRunwayEnd(FALLBACK_KSFO, '99')).toBeNull();
  });
  it('picks the runway into wind, longest when calm', () => {
    expect(activeRunwayEnd(FALLBACK_KSFO, 0, 0)?.endIdent).toBe('28R');
    expect(activeRunwayEnd(FALLBACK_KSFO, 300, 15)?.endIdent).toBe('28R');
    expect(activeRunwayEnd(FALLBACK_KSFO, 120, 15)?.endIdent).toBe('10L');
    expect(activeRunwayEnd(FALLBACK_KSFO, 30, 15)?.endIdent).toBe('01R');
    const e = runwayEnds(FALLBACK_KSFO.runways[0])[0];
    expect(headwindKt(e, 298, 10)).toBeCloseTo(10, 9);
    expect(headwindKt(e, 118, 10)).toBeCloseTo(-10, 9);
  });
});
