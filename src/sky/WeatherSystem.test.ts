import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { KT } from '../core/units';
import { weatherFromPreset } from './presets';
import { WeatherSystem } from './WeatherSystem';

describe('WeatherSystem', () => {
  it('starts on a preset converted with the airport elevation and exposes the state by reference', () => {
    const ws = new WeatherSystem({ airportElevationM: 100, initial: 'scattered' });
    const s = ws.state;
    expect(s.preset).toBe('scattered');
    expect(s.clouds[0].baseM).toBe(1100);
    ws.setPreset('overcast', 0);
    expect(ws.state).toBe(s);
    expect(s.preset).toBe('overcast');
    expect(s.clouds[0].coverage).toBe(1);
    expect(ws.transitioning).toBe(false);
  });

  it('transitions lerp numeric fields and layers matched by index, finishing exactly on the target', () => {
    const ws = new WeatherSystem({ airportElevationM: 0, initial: 'clear' });
    const target = weatherFromPreset('rain', 0);
    ws.setPreset('rain', 10);
    expect(ws.transitioning).toBe(true);
    expect(ws.state.preset).toBe('rain'); // discrete switch is immediate
    expect(ws.state.precipitationType).toBe('rain');
    expect(ws.state.clouds).toHaveLength(2); // padded to max(from, to)
    ws.update(5);
    const mid = ws.state;
    expect(mid.visibilityM).toBeGreaterThan(target.visibilityM);
    expect(mid.visibilityM).toBeLessThan(50_000);
    expect(mid.precipitationRate).toBeGreaterThan(0); expect(mid.precipitationRate).toBeLessThan(4);
    expect(mid.clouds[0].coverage).toBeGreaterThan(0); expect(mid.clouds[0].coverage).toBeLessThan(1);
    expect(ws.transitionProgress).toBeCloseTo(0.5, 6);
    ws.update(6);
    expect(ws.transitioning).toBe(false);
    expect(ws.state).toMatchObject({ visibilityM: 4000, precipitationRate: 4, turbulence: 4, thunderstorm: false });
    expect(ws.state.clouds).toEqual(target.clouds);
    expect(ws.state.winds).toEqual(target.winds);
  });

  it('wind direction interpolates through north during a transition', () => {
    const ws = new WeatherSystem({ initial: 'clear' });
    const a = weatherFromPreset('clear'); a.winds = [{ altM: 10, directionDeg: 350, speedKt: 10, gustKt: 0 }];
    const b = weatherFromPreset('clear'); b.winds = [{ altM: 10, directionDeg: 10, speedKt: 10, gustKt: 0 }];
    ws.setState(a, 0);
    ws.setState(b, 10);
    ws.update(5);
    expect(ws.state.winds[0].directionDeg).toBeCloseTo(0, 6);
  });

  it('windNED uses the frame altitude, the ground callback and adds gusts along the mean wind', () => {
    const ws = new WeatherSystem({ airportElevationM: 50, initial: 'clear', frame: { lat0: 0, lon0: 0, alt0: 50 }, groundHeightUp: () => 0, seed: 3 });
    ws.setState({ ...weatherFromPreset('clear', 50), winds: [{ altM: 60, directionDeg: 270, speedKt: 10, gustKt: 20 }] }, 0);
    const out: Vec3 = [0, 0, 0];
    ws.windNED(0, 0, -10, out); // 10 m AGL
    expect(out[1]).toBeCloseTo(10 * KT, 6);
    expect(out[0]).toBeCloseTo(0, 6);
    ws.windNED(0, 0, -2, out); // 2 m AGL: log profile reduces
    expect(out[1]).toBeLessThan(10 * KT);
    // run the gust model until a gust fires; the east component must then exceed the mean
    let peak = 0;
    for (let i = 0; i < 120 * 300; i++) { ws.update(1 / 120, { tasMs: 30, altMslM: 60, aglM: 10 }); peak = Math.max(peak, ws.windNED(0, 0, -10, out)[1]); }
    expect(peak).toBeGreaterThan(10 * KT + 1);
    expect(peak).toBeLessThanOrEqual(20 * KT + 1e-6);
  });

  it('applyMetar and applyLive replace the state; cloudDensityAt follows the layers and drifts with the wind', () => {
    const ws = new WeatherSystem({ airportElevationM: 4, initial: 'clear' });
    const rep = ws.applyMetar('KSFO 021856Z 28012G18KT 10SM OVC012 18/11 A3005');
    expect(rep.station).toBe('KSFO');
    expect(ws.state.preset).toBe('custom');
    const base = ws.state.clouds[0].baseM, top = ws.state.clouds[0].topM;
    expect(ws.cloudDensityAt(0, (base + top) / 2, 0)).toBeCloseTo(1, 9); // OVC ⇒ density 1 in the body
    expect(ws.cloudDensityAt(0, base - 100, 0)).toBe(0);
    expect(ws.cloudDensityAtNED(0, 0, -(base + top) / 2)).toBeCloseTo(1, 9);
    ws.applyLive({ ...weatherFromPreset('few', 4), preset: 'custom' }, 0);
    expect(ws.state.preset).toBe('live');
    const before = ws.cloudDrifts.slice();
    ws.update(10);
    expect(ws.cloudDrifts[0]).not.toBe(before[0] ?? 0);
    expect(ws.cloudDrifts.length).toBe(ws.state.clouds.length * 2);
    ws.notifyRebase(1000, 0);
    expect(ws.cloudDrifts[0]).toBeLessThan(0);
  });
});
