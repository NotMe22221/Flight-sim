import { describe, expect, it } from 'vitest';
import type { AircraftConfig } from '../core/types';
import type { UiHost } from './UiHost';
import { SelectionStore, aircraftDisplayName } from './selection';
import { FALLBACK_KSFO } from './runways';

const KOAK = { ...FALLBACK_KSFO, icao: 'KOAK', name: 'Metropolitan Oakland International Airport', position: { lat: 37.7213, lon: -122.2208, alt: 3 } };

/** Just enough host for SelectionStore (it never calls the setters in these tests). */
function fakeHost(): UiHost {
  const airports = [FALLBACK_KSFO, KOAK];
  const ac = { id: 'c172s', name: 'Cessna 172S Skyhawk', manufacturer: 'Cessna' } as unknown as AircraftConfig;
  return {
    nav: { getAirport: (icao: string) => airports.find((a) => a.icao === icao) },
    aircraftList: () => [ac],
  } as unknown as UiHost;
}

describe('aircraftDisplayName', () => {
  it('does not repeat the manufacturer', () => {
    expect(aircraftDisplayName('Cessna', 'Cessna 172S Skyhawk')).toBe('Cessna 172S Skyhawk');
    expect(aircraftDisplayName('Cessna', '172S Skyhawk')).toBe('Cessna 172S Skyhawk');
    expect(aircraftDisplayName('', 'Glider')).toBe('Glider');
  });
});

describe('SelectionStore', () => {
  it('defaults to KSFO 28R, the C172 and no arrival (no localStorage in Node)', () => {
    const s = new SelectionStore(fakeHost());
    expect(s.sel.spawn.airport.icao).toBe('KSFO');
    expect(s.sel.spawn.runwayEnd?.endIdent).toBe('28R');
    expect(s.sel.aircraftId).toBe('c172s');
    expect(s.sel.arrival).toBeNull();
    expect(s.describe().arrival).toBe('None');
    expect(s.describe().aircraft).toBe('Cessna 172S Skyhawk');
  });

  it('notifies listeners and describes the arrival', () => {
    const s = new SelectionStore(fakeHost());
    let n = 0;
    s.onChange(() => n++);
    s.set({ arrival: KOAK });
    expect(n).toBe(1);
    expect(s.describe().arrival).toBe('KOAK · Metropolitan Oakland International Airport');
  });

  it('parking spawns are always cold & dark', () => {
    const s = new SelectionStore(fakeHost());
    s.set({ spawn: { airport: KOAK, runwayEnd: null, coldAndDark: false } });
    expect(s.sel.spawn.coldAndDark).toBe(true);
    expect(s.describe().runway).toBe('Parking · cold & dark');
  });
});

describe('SelectionStore with a corrupted saved selection', () => {
  const withStorage = (value: string, fn: () => void) => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: () => value, setItem: () => undefined, removeItem: () => undefined };
    try { fn(); } finally { if (prev === undefined) delete g.localStorage; else g.localStorage = prev; }
  };
  it('survives JSON that is not an object (null, a number, an array)', () => {
    for (const raw of ['null', '42', '"KSFO"', '[1,2]']) {
      withStorage(raw, () => {
        const s = new SelectionStore(fakeHost());
        expect(s.sel.spawn.airport.icao).toBe('KSFO');
        expect(s.sel.weather).toEqual({ mode: 'preset', presetId: 'clear' });
      });
    }
  });
  it('drops malformed fields instead of passing them on to the simulator', () => {
    const bad = JSON.stringify({
      icao: 123, endIdent: 7, fuelFraction: 'full', payloadKg: 'heavy',
      weather: { mode: 'custom', custom: { clouds: 'lots' } }, time: { mode: 'custom', utcMs: null }, arrivalIcao: 5,
    });
    withStorage(bad, () => {
      const s = new SelectionStore(fakeHost());
      expect(s.sel.spawn.airport.icao).toBe('KSFO');
      expect(s.sel.spawn.runwayEnd?.endIdent).toBe('28R');
      expect(s.sel.fuelFraction).toBe(0.75);
      expect(s.sel.payloadKg).toBe(170);
      expect(s.sel.weather.mode).toBe('preset');
      expect(s.sel.time).toEqual({ mode: 'now' });
      expect(s.sel.arrival).toBeNull();
      expect(Number.isFinite(s.resolvedTimeUtcMs())).toBe(true);
    });
  });
  it('keeps a valid custom weather but normalises it (sorted layers, clamped values)', () => {
    const custom = {
      preset: 'custom', clouds: [{ baseM: 2000, topM: 2500, coverage: 2, density: 0.5, type: 'cumulus' }, { baseM: 500, topM: 900, coverage: 0.3, density: 0.5, type: 'stratus' }],
      winds: [{ altM: 0, directionDeg: 270, speedKt: 10, gustKt: 0 }], precipitationRate: 0, precipitationType: 'none', thunderstorm: false, humidity: 0.5,
      qnhPa: 101325, temperatureC: 15, aerosol: 0.1, visibilityM: 20000, turbulence: 0, fogTopM: 0,
    };
    withStorage(JSON.stringify({ weather: { mode: 'custom', custom } }), () => {
      const s = new SelectionStore(fakeHost());
      expect(s.sel.weather.mode).toBe('custom');
      const w = s.sel.weather.mode === 'custom' ? s.sel.weather.custom : null;
      expect(w?.clouds.map((c) => c.baseM)).toEqual([500, 2000]);
      expect(w?.clouds[1].coverage).toBe(1);
    });
  });
});
