/**
 * Weather preset templates (doc 01 §3.2) and custom-weather validation. The sky module
 * owns the real presets; these templates only seed the custom editor and summaries.
 */
import type { CloudLayer, WeatherPresetId, WeatherState, WindLayer, TurbulenceIntensity } from '../core/types';

export const FT = 0.3048;
export const NM = 1852;
export const STD_QNH_PA = 101_325;

export interface WeatherPresetMeta { id: WeatherPresetId; label: string; icon: string; summary: string }

export const WEATHER_PRESETS: WeatherPresetMeta[] = [
  { id: 'clear', label: 'Clear skies', icon: 'sun', summary: 'No cloud, 60 nm visibility, calm wind' },
  { id: 'few', label: 'Few clouds', icon: 'cloudSun', summary: 'Cumulus 3,500–5,500 ft, 2/8' },
  { id: 'scattered', label: 'Scattered clouds', icon: 'cloudSun', summary: 'Cumulus 3,000–6,000 ft, 4/8' },
  { id: 'broken', label: 'Broken clouds', icon: 'cloud', summary: 'Stratocumulus 2,500–6,500 ft, 6/8' },
  { id: 'high-level', label: 'High level clouds', icon: 'cirrus', summary: 'Cirrus 25,000–30,000 ft, 4/8' },
  { id: 'overcast', label: 'Overcast', icon: 'overcast', summary: 'Stratus 2,000–6,000 ft, 8/8, 10 nm vis' },
  { id: 'rain', label: 'Rain', icon: 'rain', summary: '1,500–8,000 ft, 4 mm/h, 5 nm vis' },
  { id: 'snow', label: 'Snow', icon: 'snow', summary: '1,500–7,000 ft, −3 °C, 3 nm vis' },
  { id: 'storm', label: 'Storm', icon: 'storm', summary: 'Cb 1,500–30,000 ft, 10 mm/h, gusts +15 kt' },
];

export const WEATHER_PRESET_IDS: WeatherPresetId[] = WEATHER_PRESETS.map((p) => p.id);

export const TURBULENCE_LABELS: Record<TurbulenceIntensity, string> = {
  0: 'None', 1: 'Trace', 2: 'Very light', 3: 'Light', 4: 'Moderate', 5: 'Severe', 6: 'Extreme', 7: 'Max',
};

function cloud(baseFt: number, topFt: number, coverage: number, type: CloudLayer['type'], density = 0.8): CloudLayer {
  return { baseM: baseFt * FT, topM: topFt * FT, coverage, density, type };
}
function wind(altFt: number, dir: number, kt: number, gust = 0): WindLayer {
  return { altM: altFt * FT, directionDeg: dir, speedKt: kt, gustKt: gust };
}

const base = (): WeatherState => ({
  preset: 'clear', clouds: [], winds: [wind(0, 280, 0), wind(6000, 270, 10), wind(20_000, 260, 30)],
  precipitationRate: 0, precipitationType: 'none', thunderstorm: false, humidity: 0.4,
  qnhPa: STD_QNH_PA, temperatureC: 15, aerosol: 0.1, visibilityM: 60 * NM, turbulence: 0, fogTopM: 0,
});

/** A full WeatherState template for a preset (proposed values; the sky module may differ). */
export function weatherPresetTemplate(id: WeatherPresetId): WeatherState {
  const w = base();
  w.preset = id;
  switch (id) {
    case 'clear': break;
    case 'few': w.clouds = [cloud(3500, 5500, 0.2, 'cumulus')]; w.winds[0] = wind(0, 280, 6); w.turbulence = 1; break;
    case 'scattered': w.clouds = [cloud(3000, 6000, 0.45, 'cumulus')]; w.winds[0] = wind(0, 280, 8); w.humidity = 0.55; w.turbulence = 2; break;
    case 'broken': w.clouds = [cloud(2500, 6500, 0.7, 'stratus')]; w.winds[0] = wind(0, 270, 10); w.humidity = 0.65; w.visibilityM = 25 * NM; w.turbulence = 2; break;
    case 'high-level': w.clouds = [cloud(25_000, 30_000, 0.5, 'cirrus', 0.4)]; w.winds[0] = wind(0, 300, 5); break;
    case 'overcast': w.clouds = [cloud(2000, 6000, 1, 'stratus')]; w.winds[0] = wind(0, 250, 8); w.humidity = 0.85; w.visibilityM = 10 * NM; w.aerosol = 0.3; break;
    case 'rain': w.clouds = [cloud(1500, 8000, 0.95, 'stratus', 0.9)]; w.winds[0] = wind(0, 220, 12, 18); w.precipitationRate = 4; w.precipitationType = 'rain';
      w.humidity = 0.95; w.visibilityM = 5 * NM; w.aerosol = 0.4; w.qnhPa = 100_800; w.temperatureC = 12; w.turbulence = 3; break;
    case 'snow': w.clouds = [cloud(1500, 7000, 0.95, 'stratus', 0.9)]; w.winds[0] = wind(0, 20, 8, 12); w.precipitationRate = 2; w.precipitationType = 'snow';
      w.humidity = 0.9; w.visibilityM = 3 * NM; w.aerosol = 0.35; w.qnhPa = 101_000; w.temperatureC = -3; w.turbulence = 2; break;
    case 'storm': w.clouds = [cloud(1500, 30_000, 0.8, 'cumulus', 1), cloud(800, 1500, 0.4, 'stratus', 0.6)]; w.winds = [wind(0, 240, 18, 33), wind(6000, 250, 35, 45), wind(20_000, 260, 60)];
      w.precipitationRate = 10; w.precipitationType = 'rain'; w.thunderstorm = true; w.humidity = 1; w.visibilityM = 2 * NM; w.aerosol = 0.5;
      w.qnhPa = 99_800; w.temperatureC = 18; w.turbulence = 5; break;
  }
  return w;
}

export function cloneWeather(w: WeatherState): WeatherState {
  return { ...w, clouds: w.clouds.map((c) => ({ ...c })), winds: w.winds.map((l) => ({ ...l })) };
}

export const MAX_CLOUD_LAYERS = 3;
export const MAX_WIND_LAYERS = 3;
/** Minimum cloud layer thickness (community note: MSFS enforces one too). */
export const MIN_CLOUD_THICKNESS_M = 100;

export interface WeatherValidation { ok: boolean; errors: string[]; fixed: WeatherState }

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * Validates and normalises a custom WeatherState: sorts cloud and wind layers by altitude,
 * enforces top > base (min thickness), clamps coverage/density/humidity 0..1, limits layer
 * counts, clamps ranges. `errors` lists what was wrong with the input; `fixed` is always usable.
 */
export function validateCustomWeather(input: WeatherState): WeatherValidation {
  const errors: string[] = [];
  const w = cloneWeather(input);
  w.preset = 'custom';

  if (w.clouds.length > MAX_CLOUD_LAYERS) { errors.push(`At most ${MAX_CLOUD_LAYERS} cloud layers`); w.clouds = w.clouds.slice(0, MAX_CLOUD_LAYERS); }
  w.clouds = w.clouds.map((c, i) => {
    const out = { ...c };
    if (!Number.isFinite(out.baseM) || out.baseM < 0) { errors.push(`Cloud layer ${i + 1}: base must be ≥ 0`); out.baseM = clamp(out.baseM, 0, 20_000); }
    if (!(out.topM > out.baseM + MIN_CLOUD_THICKNESS_M - 1e-6)) { errors.push(`Cloud layer ${i + 1}: top must be above base`); out.topM = out.baseM + Math.max(MIN_CLOUD_THICKNESS_M, 300); }
    if (out.coverage < 0 || out.coverage > 1 || !Number.isFinite(out.coverage)) { errors.push(`Cloud layer ${i + 1}: coverage must be 0..1`); out.coverage = clamp(out.coverage, 0, 1); }
    if (out.density < 0 || out.density > 1 || !Number.isFinite(out.density)) { errors.push(`Cloud layer ${i + 1}: density must be 0..1`); out.density = clamp(out.density, 0, 1); }
    if (!['cumulus', 'stratus', 'cirrus'].includes(out.type)) { errors.push(`Cloud layer ${i + 1}: unknown type`); out.type = 'cumulus'; }
    return out;
  });
  const sortedClouds = [...w.clouds].sort((a, b) => a.baseM - b.baseM);
  if (sortedClouds.some((c, i) => c !== w.clouds[i])) errors.push('Cloud layers were not sorted by base altitude');
  w.clouds = sortedClouds;

  if (w.winds.length > MAX_WIND_LAYERS) { errors.push(`At most ${MAX_WIND_LAYERS} wind layers`); w.winds = w.winds.slice(0, MAX_WIND_LAYERS); }
  w.winds = w.winds.map((l, i) => {
    const out = { ...l };
    if (!Number.isFinite(out.altM) || out.altM < 0) { errors.push(`Wind layer ${i + 1}: altitude must be ≥ 0`); out.altM = clamp(out.altM, 0, 20_000); }
    if (!Number.isFinite(out.directionDeg)) { errors.push(`Wind layer ${i + 1}: direction invalid`); out.directionDeg = 0; }
    out.directionDeg = ((out.directionDeg % 360) + 360) % 360;
    if (!Number.isFinite(out.speedKt) || out.speedKt < 0 || out.speedKt > 200) { errors.push(`Wind layer ${i + 1}: speed must be 0..200 kt`); out.speedKt = clamp(out.speedKt, 0, 200); }
    if (!Number.isFinite(out.gustKt) || out.gustKt < 0) { errors.push(`Wind layer ${i + 1}: gust must be ≥ 0`); out.gustKt = clamp(out.gustKt, 0, 250); }
    if (out.gustKt < out.speedKt) out.gustKt = 0; // gusts below the mean mean "no gusts"
    return out;
  });
  const sortedWinds = [...w.winds].sort((a, b) => a.altM - b.altM);
  if (sortedWinds.some((l, i) => l !== w.winds[i])) errors.push('Wind layers were not sorted by altitude');
  w.winds = sortedWinds;

  if (!Number.isFinite(w.visibilityM) || w.visibilityM < 50 || w.visibilityM > 200 * NM) { errors.push('Visibility must be 50 m .. 200 nm'); w.visibilityM = clamp(w.visibilityM, 50, 200 * NM); }
  if (!Number.isFinite(w.precipitationRate) || w.precipitationRate < 0 || w.precipitationRate > 100) { errors.push('Precipitation must be 0..100 mm/h'); w.precipitationRate = clamp(w.precipitationRate, 0, 100); }
  if (w.precipitationRate > 0 && w.precipitationType === 'none') { errors.push('Precipitation rate set but type is none'); w.precipitationType = w.temperatureC <= 0 ? 'snow' : 'rain'; }
  if (w.precipitationRate === 0 && w.precipitationType !== 'none') w.precipitationType = 'none';
  if (!Number.isFinite(w.qnhPa) || w.qnhPa < 94_000 || w.qnhPa > 108_000) { errors.push('QNH must be 940..1080 hPa'); w.qnhPa = clamp(w.qnhPa, 94_000, 108_000); }
  if (!Number.isFinite(w.temperatureC) || w.temperatureC < -60 || w.temperatureC > 55) { errors.push('Temperature must be −60..55 °C'); w.temperatureC = clamp(w.temperatureC, -60, 55); }
  if (!Number.isFinite(w.humidity) || w.humidity < 0 || w.humidity > 1) { errors.push('Humidity must be 0..1'); w.humidity = clamp(w.humidity, 0, 1); }
  if (!Number.isFinite(w.aerosol) || w.aerosol < 0 || w.aerosol > 1) { errors.push('Aerosol must be 0..1'); w.aerosol = clamp(w.aerosol, 0, 1); }
  if (!Number.isInteger(w.turbulence) || w.turbulence < 0 || w.turbulence > 7) { errors.push('Turbulence must be 0..7'); w.turbulence = clamp(Math.round(w.turbulence), 0, 7) as TurbulenceIntensity; }
  if (!Number.isFinite(w.fogTopM) || w.fogTopM < 0) { errors.push('Fog top must be ≥ 0'); w.fogTopM = clamp(w.fogTopM, 0, 3000); }
  w.thunderstorm = !!w.thunderstorm;

  return { ok: errors.length === 0, errors, fixed: w };
}

/** METAR-ish one-liner for summaries: 'SCT035 · 280/08 · 60 nm · 15 °C · 1013 hPa'. */
export function weatherSummary(w: WeatherState): string {
  const cover = (c: number) => (c < 0.1 ? 'SKC' : c < 0.3 ? 'FEW' : c < 0.6 ? 'SCT' : c < 0.9 ? 'BKN' : 'OVC');
  const clouds = w.clouds.length === 0 ? 'SKC' : w.clouds.map((c) => `${cover(c.coverage)}${Math.round(c.baseM / FT / 100).toString().padStart(3, '0')}`).join(' ');
  const sfc = w.winds[0];
  const windTxt = !sfc || sfc.speedKt < 1 ? 'CALM' : `${Math.round(sfc.directionDeg).toString().padStart(3, '0')}/${Math.round(sfc.speedKt).toString().padStart(2, '0')}${sfc.gustKt > sfc.speedKt ? 'G' + Math.round(sfc.gustKt) : ''}`;
  const vis = w.visibilityM >= 10 * NM ? '10+ nm' : `${(w.visibilityM / NM).toFixed(1)} nm`;
  const wx = w.thunderstorm ? ' · TS' : w.precipitationType !== 'none' ? ` · ${w.precipitationType.toUpperCase()}` : '';
  return `${clouds} · ${windTxt} · ${vis} · ${Math.round(w.temperatureC)} °C · ${Math.round(w.qnhPa / 100)} hPa${wx}`;
}

export function weatherPresetLabel(preset: WeatherState['preset']): string {
  if (preset === 'live') return 'Live weather';
  if (preset === 'custom') return 'Custom';
  return WEATHER_PRESETS.find((p) => p.id === preset)?.label ?? preset;
}
