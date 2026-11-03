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

describe('runway records with per-end data (nav database)', () => {
  const base = FALLBACK_KSFO.runways[0];
  const rec = {
    ...base, ident: '10L', headingDeg: 118, threshold: base.end, end: base.threshold, ils: undefined,
    ends: [
      { ident: '10L', headingDeg: 118.2, threshold: base.end, ils: { frequencyMHz: 109.55 } },
      { ident: '28R', headingDeg: 298.4, threshold: base.threshold, ils: { frequencyMHz: 111.7 } },
    ],
  };
  it('uses the record idents, headings, thresholds and per-end ILS', () => {
    const [a, b] = runwayEnds(rec);
    expect([a.endIdent, b.endIdent]).toEqual(['10L', '28R']);
    expect(b.headingDeg).toBe(298.4);
    expect(b.threshold).toBe(base.threshold);
    expect(a.ilsMHz).toBe(109.55);
    expect(b.ilsMHz).toBe(111.7);
    expect(findRunwayEnd({ ...FALLBACK_KSFO, runways: [rec] }, '28r')?.ilsMHz).toBe(111.7);
  });
  it('keeps non-standard idents so the simulator finds the same end', async () => {
    const { runwayPairLabel } = await import('./runways');
    const water = { ...base, ident: 'NE', ends: [{ ident: 'NE', headingDeg: 45 }, { ident: 'SW', headingDeg: 225 }] };
    expect(runwayEnds(water).map((e) => e.endIdent)).toEqual(['NE', 'SW']);
    expect(runwayPairLabel(water)).toBe('NE/SW');
    // malformed ends fall back to the derived reciprocal
    expect(runwayEnds({ ...base, ends: [{ ident: '' }, {}] } as never).map((e) => e.endIdent)).toEqual(['28R', '10L']);
  });
  it('plain core runways: ILS on the primary end only', () => {
    const [a, b] = runwayEnds(base);
    expect(a.ilsMHz).toBe(111.7);
    expect(b.ilsMHz).toBeUndefined();
  });
});

describe('runway heading labels', () => {
  it('magnetic when the host knows the variation, else marked true', async () => {
    const { runwayHeadingLabel, magneticVariationAt } = await import('./runways');
    expect(runwayHeadingLabel(298, 13.2)).toBe('285°');
    expect(runwayHeadingLabel(298, null)).toBe('298°T');
    expect(runwayHeadingLabel(3, 13)).toBe('350°');
    expect(magneticVariationAt({}, 37, -122)).toBeNull();
    expect(magneticVariationAt({ magneticVariationDeg: () => 13 }, 37, -122)).toBe(13);
    expect(magneticVariationAt({ magneticVariationDeg: () => { throw new Error('x'); } }, 37, -122)).toBeNull();
    expect(magneticVariationAt({ magneticVariationDeg: () => Number.NaN }, 37, -122)).toBeNull();
  });
});
