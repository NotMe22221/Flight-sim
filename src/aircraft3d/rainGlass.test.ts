import { describe, expect, it } from 'vitest';
import { RainGlass } from './rainGlass';
import { windscreenRain } from '../app/Simulator';

describe('RainGlass', () => {
  it('wets within ~10 s, dries slower at rest than in cruise', () => {
    const g = new RainGlass();
    g.setRain(1);
    for (let i = 0; i < 300; i++) g.update(0.1, 0);
    expect(g.wetness).toBeGreaterThan(0.94);
    g.setRain(0);
    const rest = new RainGlass(); rest.setRain(1); for (let i = 0; i < 600; i++) rest.update(0.1, 0);
    rest.setRain(0); g.setRain(0);
    for (let i = 0; i < 300; i++) { rest.update(0.1, 0); g.update(0.1, 50); }
    expect(g.wetness).toBeLessThan(rest.wetness);
    expect(rest.wetness).toBeGreaterThan(0.4);
    expect(g.material.uniforms.uSpeed.value).toBe(50);
  });
});

describe('windscreenRain', () => {
  const cloud = { baseM: 500, topM: 2000, coverage: 0.9, density: 0.8, type: 'stratus' as const };
  it('rain below the cloud tops, none above them or when dry; snow wets a little', () => {
    expect(windscreenRain({ precipitationRate: 4, precipitationType: 'rain', clouds: [cloud] }, 300)).toBeCloseTo(0.75);
    expect(windscreenRain({ precipitationRate: 4, precipitationType: 'rain', clouds: [cloud] }, 2500)).toBe(0);
    expect(windscreenRain({ precipitationRate: 0, precipitationType: 'rain', clouds: [cloud] }, 300)).toBe(0);
    expect(windscreenRain({ precipitationRate: 20, precipitationType: 'rain', clouds: [] }, 300)).toBe(1);
    expect(windscreenRain({ precipitationRate: 4, precipitationType: 'snow', clouds: [cloud] }, 300)).toBeCloseTo(0.2625);
  });
});
