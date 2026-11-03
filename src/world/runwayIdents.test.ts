import { describe, expect, it } from 'vitest';
import type { Runway } from '../core/types';
import { reciprocalIdent, runwayEndIdents } from './runwayIdents';

const base: Runway = { ident: '10L', threshold: { lat: 0, lon: 0, alt: 0 }, end: { lat: 0, lon: 0.01, alt: 0 }, headingDeg: 118, lengthM: 3600, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 };

describe('runway idents', () => {
  it('reciprocals', () => {
    expect(reciprocalIdent('10L')).toBe('28R');
    expect(reciprocalIdent('28R')).toBe('10L');
    expect(reciprocalIdent('1')).toBe('19');
    expect(reciprocalIdent('18')).toBe('36');
    expect(reciprocalIdent('36C')).toBe('18C');
    expect(reciprocalIdent('H1')).toBe('');
  });
  it('nav-database records use ends[]; plain runways use "A/B" or the reciprocal', () => {
    expect(runwayEndIdents({ ...base, ends: [{ ident: '10L' }, { ident: '28R' }] } as never)).toEqual(['10L', '28R']);
    expect(runwayEndIdents({ ...base, ident: '10L/28R' })).toEqual(['10L', '28R']);
    expect(runwayEndIdents(base)).toEqual(['10L', '28R']);
  });
});
