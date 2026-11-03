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
