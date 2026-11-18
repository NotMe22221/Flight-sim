import { describe, expect, it } from 'vitest';
import { CarbIce, carbIceRisk } from './carbIce';

const humid = { oatC: 8, humidity: 0.95, visibleMoisture: false, rpm: 1800, carbHeat: false };

describe('carbIceRisk', () => {
  it('follows the icing chart: cool and humid worst, hot or dry or very cold safe', () => {
    expect(carbIceRisk(8, 0.95, false)).toBeGreaterThan(0.95);
    expect(carbIceRisk(35, 0.95, false)).toBe(0);
    expect(carbIceRisk(-15, 0.95, false)).toBe(0);
    expect(carbIceRisk(8, 0.3, false)).toBe(0);
    expect(carbIceRisk(8, 0.3, true)).toBeGreaterThan(0.95); // in cloud or rain
    expect(carbIceRisk(25, 0.95, false)).toBeGreaterThan(0.1); // still possible on a warm humid day
  });
});

describe('CarbIce', () => {
  it('ices faster at glide power than at cruise; the rpm falls with it', () => {
    const glide = new CarbIce(), cruise = new CarbIce();
    for (let i = 0; i < 1200; i++) { glide.update(0.1, { ...humid, throttle: 0.1 }); cruise.update(0.1, { ...humid, throttle: 0.85 }); }
    expect(glide.ice).toBeGreaterThan(cruise.ice * 1.6);
    expect(cruise.throttle(0.85, false)).toBeLessThan(0.85);
  });

  it('carb heat costs ~10 % and melts the ice within a minute', () => {
    const c = new CarbIce();
    expect(c.throttle(1, true)).toBeCloseTo(0.9);
    c.ice = 0.8;
    for (let i = 0; i < 600; i++) c.update(0.1, { ...humid, throttle: 0.7, carbHeat: true, rpm: 2300 });
    expect(c.ice).toBe(0);
  });

  it('heavy ice stops the engine until it melts well back', () => {
    const c = new CarbIce();
    for (let i = 0; i < 4000 && !c.starved; i++) c.update(0.1, { ...humid, throttle: 0.2, forced: true });
    expect(c.starved).toBe(true);
    // windmilling with carb heat: some heat, the ice recedes and the engine can run again
    for (let i = 0; i < 600; i++) c.update(0.1, { ...humid, throttle: 0.2, carbHeat: true, rpm: 1200 });
    expect(c.starved).toBe(false);
  });

  it('no ice in dry or hot air, and a stopped engine does not ice', () => {
    const c = new CarbIce();
    for (let i = 0; i < 3000; i++) c.update(0.1, { ...humid, oatC: 34, throttle: 0.2 });
    expect(c.ice).toBe(0);
    for (let i = 0; i < 3000; i++) c.update(0.1, { ...humid, throttle: 0.2, rpm: 0 });
    expect(c.ice).toBe(0);
  });
});
