/**
 * The nine MSFS-style weather presets (docs/research/04 §4.4) as `WeatherState` factories.
 * Preset cloud bases/tops are AGL at the departure airport (MSFS behaviour); `WeatherState`
 * stores MSL, so pass the airport elevation.
 */
import type { CloudLayer, TurbulenceIntensity, WeatherPresetId, WeatherState, WindLayer } from '../core/types';

/** Coverage values for the METAR octa classes. */
export const COVERAGE = { FEW: 0.19, SCT: 0.44, BKN: 0.75, OVC: 1.0 } as const;

export interface PresetCloudLayer {
  baseAglM: number;
  topAglM: number;
  coverage: number;
  density: number;
  type: CloudLayer['type'];
}

export interface PresetWindLayer {
  /** 0 = surface (10 m AGL); otherwise height above the airport, m */ aglM: number;
  directionDeg: number;
  speedKt: number;
  gustKt: number;
}

export interface WeatherPresetDefinition {
  id: WeatherPresetId;
  name: string;
  clouds: PresetCloudLayer[];
  winds: PresetWindLayer[];
  visibilityM: number;
  precipitationRate: number;
  precipitationType: WeatherState['precipitationType'];
  thunderstorm: boolean;
  /** MIL-F-8785C POE index 0..7 */ turbulence: TurbulenceIntensity;
  qnhPa: number;
  temperatureC: number;
  humidity: number;
  aerosol: number;
  fogTopM: number;
}

const winds = (sfc: number, gust: number, aloft: number, dir = 280): PresetWindLayer[] => [
  { aglM: 0, directionDeg: dir, speedKt: sfc, gustKt: gust },
  { aglM: 1500, directionDeg: dir - 10, speedKt: Math.round((sfc + aloft) / 2), gustKt: 0 },
  { aglM: 3000, directionDeg: dir - 20, speedKt: aloft, gustKt: 0 },
  { aglM: 6000, directionDeg: dir - 30, speedKt: Math.round(aloft * 1.4), gustKt: 0 },
];

/** §4.4 table. Wind speeds in knots (sfc / aloft at 3000 m AGL). */
export const WEATHER_PRESETS: Readonly<Record<WeatherPresetId, WeatherPresetDefinition>> = {
  clear: {
    id: 'clear', name: 'Clear Skies',
    clouds: [{ baseAglM: 9000, topAglM: 9500, coverage: 0.1, density: 0.3, type: 'cirrus' }],
    winds: winds(6, 0, 19), visibilityM: 50_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 0,
    qnhPa: 102_000, temperatureC: 18, humidity: 0.45, aerosol: 0.05, fogTopM: 0,
  },
  few: {
    id: 'few', name: 'Few Clouds',
    clouds: [{ baseAglM: 1200, topAglM: 1700, coverage: COVERAGE.FEW, density: 1.0, type: 'cumulus' }],
    winds: winds(8, 0, 23), visibilityM: 40_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 2,
    qnhPa: 101_700, temperatureC: 17, humidity: 0.55, aerosol: 0.1, fogTopM: 0,
  },
  scattered: {
    id: 'scattered', name: 'Scattered Clouds',
    clouds: [{ baseAglM: 1000, topAglM: 1800, coverage: COVERAGE.SCT, density: 1.0, type: 'cumulus' }],
    winds: winds(10, 0, 29), visibilityM: 25_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 3,
    qnhPa: 101_500, temperatureC: 16, humidity: 0.6, aerosol: 0.15, fogTopM: 0,
  },
  broken: {
    id: 'broken', name: 'Broken Clouds',
    clouds: [
      { baseAglM: 800, topAglM: 1900, coverage: COVERAGE.BKN, density: 1.0, type: 'stratus' },
      { baseAglM: 6000, topAglM: 6500, coverage: 0.3, density: 0.6, type: 'stratus' },
    ],
    winds: winds(14, 0, 39), visibilityM: 15_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 3,
    qnhPa: 101_200, temperatureC: 14, humidity: 0.7, aerosol: 0.25, fogTopM: 0,
  },
  'high-level': {
    id: 'high-level', name: 'High Level Clouds',
    clouds: [{ baseAglM: 7000, topAglM: 8500, coverage: 0.6, density: 0.5, type: 'cirrus' }],
    winds: winds(6, 0, 49, 260), visibilityM: 40_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 2,
    qnhPa: 101_800, temperatureC: 15, humidity: 0.5, aerosol: 0.1, fogTopM: 0,
  },
  overcast: {
    id: 'overcast', name: 'Overcast',
    clouds: [{ baseAglM: 500, topAglM: 1500, coverage: COVERAGE.OVC, density: 1.0, type: 'stratus' }],
    winds: winds(12, 0, 29, 240), visibilityM: 8_000,
    precipitationRate: 0, precipitationType: 'none', thunderstorm: false, turbulence: 3,
    qnhPa: 100_900, temperatureC: 12, humidity: 0.85, aerosol: 0.4, fogTopM: 0,
  },
  rain: {
    id: 'rain', name: 'Rain',
    clouds: [
      { baseAglM: 400, topAglM: 2200, coverage: COVERAGE.OVC, density: 1.2, type: 'stratus' },
      { baseAglM: 3000, topAglM: 4500, coverage: 0.8, density: 0.8, type: 'stratus' },
    ],
    winds: winds(18, 27, 39, 220), visibilityM: 4_000,
    precipitationRate: 4, precipitationType: 'rain', thunderstorm: false, turbulence: 4,
    qnhPa: 100_300, temperatureC: 11, humidity: 0.95, aerosol: 0.6, fogTopM: 0,
  },
  snow: {
    id: 'snow', name: 'Snow',
    clouds: [{ baseAglM: 300, topAglM: 1800, coverage: COVERAGE.OVC, density: 1.0, type: 'stratus' }],
    winds: winds(12, 0, 29, 30), visibilityM: 2_000,
    precipitationRate: 2, precipitationType: 'snow', thunderstorm: false, turbulence: 3,
    qnhPa: 101_000, temperatureC: -3, humidity: 0.9, aerosol: 0.7, fogTopM: 0,
  },
  storm: {
    id: 'storm', name: 'Storm',
    clouds: [
      { baseAglM: 1500, topAglM: 2500, coverage: COVERAGE.BKN, density: 1.0, type: 'stratus' },
      { baseAglM: 600, topAglM: 9000, coverage: 0.7, density: 1.5, type: 'cumulus' },
    ],
    winds: winds(24, 43, 58, 200), visibilityM: 3_000,
    precipitationRate: 15, precipitationType: 'rain', thunderstorm: true, turbulence: 5,
    qnhPa: 99_800, temperatureC: 20, humidity: 0.95, aerosol: 0.7, fogTopM: 0,
  },
};

export const WEATHER_PRESET_IDS: readonly WeatherPresetId[] = ['clear', 'few', 'scattered', 'broken', 'high-level', 'overcast', 'rain', 'snow', 'storm'];

export const presetName = (id: WeatherPresetId): string => WEATHER_PRESETS[id].name;

/**
 * Build a `WeatherState` from a preset. Cloud and wind layer heights are converted from AGL at the
 * departure airport to MSL. Layers are sorted by base.
 */
export function weatherFromPreset(id: WeatherPresetId, airportElevationM = 0): WeatherState {
  const p = WEATHER_PRESETS[id];
  const clouds: CloudLayer[] = p.clouds
    .map((c) => ({ baseM: airportElevationM + c.baseAglM, topM: airportElevationM + c.topAglM, coverage: c.coverage, density: c.density, type: c.type }))
    .sort((a, b) => a.baseM - b.baseM);
  const windsMsl: WindLayer[] = p.winds
    .map((w) => ({ altM: airportElevationM + (w.aglM === 0 ? 10 : w.aglM), directionDeg: ((w.directionDeg % 360) + 360) % 360, speedKt: w.speedKt, gustKt: w.gustKt }))
    .sort((a, b) => a.altM - b.altM);
  return {
    preset: id,
    clouds,
    winds: windsMsl,
    precipitationRate: p.precipitationRate,
    precipitationType: p.precipitationType,
    thunderstorm: p.thunderstorm,
    humidity: p.humidity,
    qnhPa: p.qnhPa,
    temperatureC: p.temperatureC,
    aerosol: p.aerosol,
    visibilityM: p.visibilityM,
    turbulence: p.turbulence,
    fogTopM: p.fogTopM,
  };
}

/** Deep copy of a WeatherState (layers are copied, not shared). */
export function cloneWeather(w: WeatherState): WeatherState {
  return {
    ...w,
    clouds: w.clouds.map((c) => ({ ...c })),
    winds: w.winds.map((l) => ({ ...l })),
  };
}

/** Standard-atmosphere defaults used when a source leaves a field unspecified. */
export const defaultWeather = (): WeatherState => weatherFromPreset('clear', 0);
