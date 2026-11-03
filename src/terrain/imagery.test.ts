import { describe, expect, it } from 'vitest';
import { imageryUvTransform, planImagery } from './imagery';
import { DEFAULT_IMAGERY_CHAIN, eoxS2Cloudless2016, gibsBlueMarble, proceduralImagery } from './providers';

describe('imagery planning', () => {
  it('z15 terrain uses the z14 EOX parent tile, GIBS at z8, then procedural', () => {
    const plan = planImagery(15, 5246, 12684, DEFAULT_IMAGERY_CHAIN);
    expect(plan.map((c) => c.providerId)).toEqual([eoxS2Cloudless2016.id, gibsBlueMarble.id, proceduralImagery.id]);
    expect(plan[0]).toMatchObject({ zI: 14, x: 2623, y: 6342, url: eoxS2Cloudless2016.url(14, 2623, 6342) });
    expect(plan[1]).toMatchObject({ zI: 8, x: 5246 >> 7, y: 12684 >> 7 });
    expect(plan[2].url).toBeNull();
  });

  it('GIBS is skipped at z0 (its minZoom is 1)', () => {
    const plan = planImagery(0, 0, 0, [gibsBlueMarble, proceduralImagery]);
    expect(plan.map((c) => c.providerId)).toEqual([proceduralImagery.id]);
  });

  it('uv transform selects the right quadrant of a coarser image with flipped v', () => {
    expect(Array.from(imageryUvTransform(15, 5246, 12684, 15))).toEqual([0, 0, 1]);
    // x even, y even → NW quadrant of the z14 image: u from 0, v from 0.5 (top half of a bottom-up image)
    expect(Array.from(imageryUvTransform(15, 5246, 12684, 14))).toEqual([0, 0.5, 0.5]);
    // x odd, y odd → SE quadrant: u from 0.5, v from 0
    expect(Array.from(imageryUvTransform(15, 5247, 12685, 14))).toEqual([0.5, 0, 0.5]);
    // seven levels down: 1/128 scale
    const t = imageryUvTransform(15, 5246, 12684, 8);
    expect(t[2]).toBe(1 / 128);
    expect(t[0]).toBe((5246 & 127) / 128);
    expect(t[1]).toBe((127 - (12684 & 127)) / 128);
    expect(() => imageryUvTransform(14, 1, 1, 15)).toThrow();
  });
});
