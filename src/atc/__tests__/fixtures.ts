/** Shared test fixtures: the real nav database from public/data and a KSFO weather state. */
import type { Geodetic, WeatherState } from '../../core/types';
import { FT, INHG } from '../../core/units';
import { NavDb } from '../../nav';
import { fsLoader } from '../../nav/__tests__/fsLoader';
import { relativeHumidity } from '../surfaceObs';

export const KSFO_POS: Geodetic = { lat: 37.619806, lon: -122.374821, alt: 4 };
/** KSFO field elevation in the dataset, m. */
export const KSFO_ELEV_M = 4;

let dbPromise: Promise<NavDb> | null = null;

/** The real NavDb with the Bay Area region loaded (shared between tests in one file). */
export function loadBayAreaDb(): Promise<NavDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = new NavDb(fsLoader());
      await db.loadRegion(KSFO_POS, 60);
      return db;
    })();
  }
  return dbPromise;
}

/**
 * KSFO METAR-like weather: wind 280@12G18, FEW012 BKN200, 18/11, A3005, 10 SM.
 * Cloud bases are MSL (field elevation + height AGL); the temperature is the sea-level reference.
 */
export function ksfoWeather(overrides: Partial<WeatherState> = {}): WeatherState {
  return {
    preset: 'custom',
    clouds: [
      { baseM: KSFO_ELEV_M + 20000 * FT, topM: KSFO_ELEV_M + 21000 * FT, coverage: 0.7, density: 0.5, type: 'cirrus' },
      { baseM: KSFO_ELEV_M + 1200 * FT, topM: KSFO_ELEV_M + 2500 * FT, coverage: 0.2, density: 0.6, type: 'cumulus' },
    ],
    winds: [
      { altM: 1500, directionDeg: 295, speedKt: 20, gustKt: 0 },
      { altM: 14, directionDeg: 280, speedKt: 12, gustKt: 18 },
    ],
    precipitationRate: 0,
    precipitationType: 'none',
    thunderstorm: false,
    humidity: relativeHumidity(18, 11),
    qnhPa: 30.05 * INHG,
    temperatureC: 18 + 0.0065 * KSFO_ELEV_M,
    aerosol: 0.1,
    visibilityM: 20000,
    turbulence: 0,
    fogTopM: 0,
    ...overrides,
  };
}
