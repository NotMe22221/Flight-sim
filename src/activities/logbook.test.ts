import { describe, expect, it } from 'vitest';
import { Logbook, LogbookRecorder, type LogFrame } from './logbook';

const base: LogFrame = { dtS: 0.1, utcMs: 0, onGround: true, lat: 37.6, lon: -122.4, altMslM: 4, groundSpeedMs: 0, sunElevationRad: 0.5, crashed: false, nearestIcao: 'KSFO' };

/** taxi, take off from KSFO, fly ~10 nm east at 100 kt, land at KOAK, stop */
function circuit(r: LogbookRecorder, night = false) {
  let lon = -122.4;
  const step = (n: number, f: Partial<LogFrame>) => { for (let i = 0; i < n; i++) { lon += (f.groundSpeedMs ?? 0) * 0.1 / 88000; r.update({ ...base, lon, ...f }); } };
  step(100, { groundSpeedMs: 5 });
  step(3000, { onGround: false, groundSpeedMs: 51, altMslM: 600, nearestIcao: null, sunElevationRad: night ? -0.3 : 0.5 });
  step(50, { groundSpeedMs: 20, nearestIcao: 'KOAK' });
  step(50, { groundSpeedMs: 1, nearestIcao: 'KOAK' });
}

describe('LogbookRecorder', () => {
  it('logs departure, arrival, air time, a landing, distance and max altitude', () => {
    const r = new LogbookRecorder();
    r.begin({ utcMs: 1000, aircraftId: 'c172s', aircraftName: 'Cessna 172S', onGround: true, nearestIcao: 'KSFO' });
    circuit(r);
    const e = r.end()!;
    expect(e.from).toBe('KSFO'); expect(e.to).toBe('KOAK');
    expect(e.airTimeS).toBeCloseTo(300, 0);
    expect(e.landings).toBe(1);
    expect(e.distanceNm).toBeGreaterThan(7); expect(e.distanceNm).toBeLessThan(10);
    expect(e.maxAltFt).toBe(1969);
    expect(e.nightS).toBe(0);
    expect(r.end()).toBeNull(); // idle after end
  });

  it('counts night time, skips flights under 30 s, an air start has no departure, begin closes the previous flight', () => {
    const r = new LogbookRecorder();
    r.begin({ utcMs: 0, aircraftId: 'pa18-150', aircraftName: 'Cub', onGround: false, nearestIcao: 'KSFO' });
    circuit(r, true);
    const prev = r.begin({ utcMs: 0, aircraftId: 'c172s', aircraftName: 'C172', onGround: true, nearestIcao: 'KSFO' })!;
    expect(prev.from).toBeNull();
    expect(prev.nightS).toBeCloseTo(300, 0);
    for (let i = 0; i < 100; i++) r.update({ ...base, onGround: false });
    expect(r.end()).toBeNull(); // 10 s in the air
  });

  it('a bounce on the take-off roll is not a landing; a crash ends the counting', () => {
    const r = new LogbookRecorder();
    r.begin({ utcMs: 0, aircraftId: 'c172s', aircraftName: 'C172', onGround: true, nearestIcao: 'KSFO' });
    for (let i = 0; i < 20; i++) r.update({ ...base, onGround: false });
    r.update({ ...base, onGround: true });
    for (let i = 0; i < 400; i++) r.update({ ...base, onGround: false });
    r.update({ ...base, onGround: true, crashed: true });
    for (let i = 0; i < 400; i++) r.update({ ...base, onGround: false });
    const e = r.end()!;
    expect(e.landings).toBe(1); expect(e.crashed).toBe(true);
    expect(e.airTimeS).toBeCloseTo(42, 0);
  });
});

describe('Logbook', () => {
  it('stores newest first, totals, survives junk', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const lb = new Logbook(store);
    const e = { startUtcMs: 0, aircraftId: 'a', aircraftName: 'A', from: null, to: null, airTimeS: 60, nightS: 0, landings: 1, distanceNm: 2, maxAltFt: 0, crashed: false };
    lb.add(e); lb.add({ ...e, aircraftId: 'b', landings: 2 });
    expect(lb.entries().map((x) => x.aircraftId)).toEqual(['b', 'a']);
    expect(lb.totals()).toEqual({ flights: 2, airTimeS: 120, nightS: 0, landings: 3, distanceNm: 4 });
    m.set('flightsim.logbook.v1', '{bad');
    expect(lb.entries()).toEqual([]);
    expect(new Logbook(null).entries()).toEqual([]);
  });
});

import { formatLogTime } from '../ui/screens/LogbookScreen';
describe('formatLogTime', () => {
  it('hours:minutes', () => { expect(formatLogTime(0)).toBe('0:00'); expect(formatLogTime(3900)).toBe('1:05'); expect(formatLogTime(59)).toBe('0:01'); });
});
