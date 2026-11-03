import { describe, expect, it } from 'vitest';
import type { AircraftConfig, SimEvents, SpawnState } from '../core/types';
import type { UiHost } from './UiHost';
import type { ScreenId } from './screens/Screen';
import { FlightLauncher } from './flightLauncher';
import { SelectionStore } from './selection';
import { FALLBACK_KSFO } from './runways';

const KOAK = { ...FALLBACK_KSFO, icao: 'KOAK', name: 'Oakland', position: { lat: 37.72, lon: -122.22, alt: 3 } };
const spawnAt = (lat: number): SpawnState => ({ geo: { lat, lon: -122, alt: 5 }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true });

function setup(opts: { failSpawn?: boolean; live?: boolean; noChallenge?: boolean } = {}) {
  const calls: string[] = [];
  const toasts: SimEvents['ui:toast'][] = [];
  const route: string[] = [];
  let resetHook: ((s: SpawnState) => void) | null = null;
  const host = {
    nav: { getAirport: (icao: string) => [FALLBACK_KSFO, KOAK].find((a) => a.icao === icao) },
    aircraftList: () => [{ id: 'c172s', name: '172S', manufacturer: 'Cessna' } as unknown as AircraftConfig],
    setWeatherPreset: (id: string) => calls.push(`wx:${id}`),
    setCustomWeather: () => calls.push('wx:custom'),
    requestLiveWeather: async () => { calls.push('live'); return opts.live ?? false; },
    setTime: () => calls.push('time'),
    spawn: async (c: { airport: { icao: string } }) => {
      calls.push(`spawn:${c.airport.icao}`);
      await Promise.resolve();
      if (opts.failSpawn) throw new Error('no terrain');
      resetHook?.(spawnAt(1));
    },
    addWaypoint: (wp: { id: string }) => calls.push(`wp:${wp.id}`),
    startChallenge: opts.noChallenge ? undefined : async (id: string) => { calls.push(`challenge:${id}`); await Promise.resolve(); resetHook?.(spawnAt(2)); },
  } as unknown as UiHost;
  const selection = new SelectionStore(host);
  const launcher: FlightLauncher = new FlightLauncher({
    host, selection, toast: (t) => toasts.push(t),
    beginLoading: () => { route.push('loading'); return ['main', 'worldmap'] as ScreenId[]; },
    enterFlight: () => route.push('flight'),
    restore: (saved) => route.push(`restore:${saved.join('>')}`),
  });
  resetHook = (s) => { expect(launcher.flying).toBe(true); launcher.onFlightReset(s); };
  return { calls, toasts, route, launcher, selection };
}

describe('FlightLauncher.fly', () => {
  it('applies weather and time before the spawn and the arrival after it', async () => {
    const t = setup();
    t.selection.set({ weather: { mode: 'preset', presetId: 'overcast' }, arrival: KOAK });
    expect(await t.launcher.fly()).toBe(true);
    expect(t.calls).toEqual(['wx:overcast', 'time', 'spawn:KSFO', 'wp:KOAK']);
    expect(t.route).toEqual(['loading', 'flight']);
    expect(t.launcher.flying).toBe(false);
  });

  it('fetches live weather only after the spawn and warns when it fails', async () => {
    const t = setup({ live: false });
    t.selection.set({ weather: { mode: 'live' } });
    await t.launcher.fly();
    await Promise.resolve(); await Promise.resolve();
    expect(t.calls).toEqual(['time', 'spawn:KSFO', 'live']);
    expect(t.toasts.some((x) => x.kind === 'warn')).toBe(true);
  });

  it('never adds the departure as its own arrival', async () => {
    const t = setup();
    t.selection.set({ arrival: FALLBACK_KSFO });
    await t.launcher.fly();
    expect(t.calls.some((c) => c.startsWith('wp:'))).toBe(false);
  });

  it('restores the menu and toasts on failure', async () => {
    const t = setup({ failSpawn: true });
    const orig = console.error;
    console.error = () => undefined;
    try { expect(await t.launcher.fly()).toBe(false); } finally { console.error = orig; }
    expect(t.route).toEqual(['loading', 'restore:main>worldmap']);
    expect(t.toasts[0].kind).toBe('error');
    expect(t.toasts[0].text).toContain('no terrain');
    expect(t.launcher.flying).toBe(false);
  });

  it('ignores a second FLY while one is in progress', async () => {
    const t = setup();
    const a = t.launcher.fly();
    expect(await t.launcher.fly()).toBe(false);
    await a;
    expect(t.calls.filter((c) => c.startsWith('spawn')).length).toBe(1);
  });
});

describe('FlightLauncher challenges', () => {
  it('attributes scores to the running challenge and toasts a new best', async () => {
    const t = setup();
    expect(await t.launcher.startChallenge('ksfo-28r')).toBe(true);
    expect(t.calls).toEqual(['challenge:ksfo-28r']);
    expect(t.launcher.challenge.activeId).toBe('ksfo-28r');
    t.launcher.recordScore(8123);
    expect(t.toasts.at(-1)?.text).toContain('8,123');
    // a regular flight ends the challenge
    await t.launcher.fly();
    expect(t.launcher.challenge.activeId).toBeNull();
    const n = t.toasts.length;
    t.launcher.recordScore(9000);
    expect(t.toasts.length).toBe(n);
  });

  it('is a no-op without host.startChallenge', async () => {
    const t = setup({ noChallenge: true });
    expect(await t.launcher.startChallenge('x')).toBe(false);
    expect(t.route).toEqual([]);
  });
});
