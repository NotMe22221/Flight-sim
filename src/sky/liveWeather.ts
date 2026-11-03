/**
 * Live weather from Open-Meteo (https://open-meteo.com — free for non-commercial use, CORS enabled,
 * data CC BY 4.0: show `OPEN_METEO_ATTRIBUTION` in the UI).
 *
 * Why not aviationweather.gov? Its Data API explicitly does not permit cross-origin requests
 * (no `Access-Control-Allow-Origin`), so a static site cannot call it from the browser without a
 * proxy (e.g. a Cloudflare Worker adding the CORS header). `parseMetar` is ready for whenever such
 * a proxy exists; `fetchMetarText` tries the community-reported keyless mirror as a best effort.
 *
 * All network functions fail gracefully (resolve to `null`) — never throw into the render loop.
 */
import { clamp } from '../core/math';
import type { CloudLayer, TurbulenceIntensity, WeatherState, WindLayer } from '../core/types';
import { relativeHumidity } from './metar';
import { defaultWeather } from './presets';

export const OPEN_METEO_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

/** Pressure levels requested, with ISA fallback heights (m) when geopotential height is missing. */
export const OPEN_METEO_LEVELS: readonly { hPa: number; isaM: number }[] = [
  { hPa: 850, isaM: 1460 }, { hPa: 700, isaM: 3010 }, { hPa: 500, isaM: 5570 }, { hPa: 250, isaM: 10_360 },
];

const HOURLY_FIELDS = [
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  ...OPEN_METEO_LEVELS.flatMap((l) => [`wind_speed_${l.hPa}hPa`, `wind_direction_${l.hPa}hPa`, `geopotential_height_${l.hPa}hPa`]),
  'temperature_2m', 'dew_point_2m', 'pressure_msl', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'visibility', 'precipitation', 'rain', 'snowfall', 'cape', 'freezing_level_height', 'weather_code',
];

/** Build the forecast URL for a location. */
export function openMeteoUrl(lat: number, lon: number): string {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: HOURLY_FIELDS.join(','), wind_speed_unit: 'kn', timezone: 'UTC', forecast_days: '1',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

/** Shape of the parts of the Open-Meteo response we read. */
export interface OpenMeteoResponse {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  hourly?: { time?: string[] } & Record<string, (number | null)[] | string[] | undefined>;
}

const isResponse = (j: unknown): j is OpenMeteoResponse => typeof j === 'object' && j !== null && 'hourly' in j;

function hourlyNumber(h: OpenMeteoResponse['hourly'], key: string, i: number): number | null {
  const arr = h?.[key];
  if (!arr) return null;
  const v = arr[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Index of the hourly sample closest to `utcMs` (0 when times are missing). */
export function nearestHourIndex(times: string[] | undefined, utcMs: number): number {
  if (!times || times.length === 0) return 0;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i].endsWith('Z') ? times[i] : `${times[i]}Z`);
    const d = Math.abs(t - utcMs);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Convert an Open-Meteo forecast JSON into a `WeatherState` for the hour nearest `utcMs`.
 * `elevationM` is the ground elevation used to place the low cloud base (defaults to the response's).
 * Throws on a malformed payload (callers that need graceful failure use `fetchOpenMeteo`).
 */
export function openMeteoToWeatherState(json: unknown, utcMs: number, elevationM?: number): WeatherState {
  if (!isResponse(json) || !json.hourly) throw new Error('open-meteo: malformed response');
  const h = json.hourly;
  const i = nearestHourIndex(h.time, utcMs);
  const elev = elevationM ?? json.elevation ?? 0;
  const w = defaultWeather();
  w.preset = 'live';

  const t2 = hourlyNumber(h, 'temperature_2m', i), td = hourlyNumber(h, 'dew_point_2m', i);
  if (t2 !== null) w.temperatureC = t2 + 0.0065 * elev;
  w.humidity = t2 !== null && td !== null ? relativeHumidity(t2, td) : 0.6;
  const pmsl = hourlyNumber(h, 'pressure_msl', i);
  if (pmsl !== null) w.qnhPa = pmsl * 100;

  // ── winds: surface + pressure levels ────────────────────────────────────────────────
  const sfcSpd = hourlyNumber(h, 'wind_speed_10m', i) ?? 0, sfcDir = hourlyNumber(h, 'wind_direction_10m', i) ?? 0;
  const gust = hourlyNumber(h, 'wind_gusts_10m', i) ?? 0;
  const winds: WindLayer[] = [{ altM: elev + 10, directionDeg: sfcDir, speedKt: sfcSpd, gustKt: gust > sfcSpd ? gust : 0 }];
  for (const l of OPEN_METEO_LEVELS) {
    const spd = hourlyNumber(h, `wind_speed_${l.hPa}hPa`, i), dir = hourlyNumber(h, `wind_direction_${l.hPa}hPa`, i);
    if (spd === null || dir === null) continue;
    const alt = hourlyNumber(h, `geopotential_height_${l.hPa}hPa`, i) ?? l.isaM;
    if (alt <= winds[winds.length - 1].altM) continue;
    winds.push({ altM: alt, directionDeg: dir, speedKt: spd, gustKt: 0 });
  }
  w.winds = winds;

  // ── clouds from low/mid/high cover ──────────────────────────────────────────────────
  const clouds: CloudLayer[] = [];
  const low = (hourlyNumber(h, 'cloud_cover_low', i) ?? 0) / 100;
  const mid = (hourlyNumber(h, 'cloud_cover_mid', i) ?? 0) / 100;
  const high = (hourlyNumber(h, 'cloud_cover_high', i) ?? 0) / 100;
  // lifted condensation level ≈ 125 m per °C of dew-point depression (Espy)
  const lcl = t2 !== null && td !== null ? clamp(125 * (t2 - td), 150, 2500) : 800;
  if (low >= 0.05) clouds.push({ baseM: elev + lcl, topM: elev + lcl + (low > 0.7 ? 1200 : 800), coverage: low, density: 1, type: low > 0.7 ? 'stratus' : 'cumulus' });
  if (mid >= 0.05) clouds.push({ baseM: Math.max(elev + lcl + 1500, 3000), topM: Math.max(elev + lcl + 1500, 3000) + 1200, coverage: mid, density: 0.8, type: 'stratus' });
  if (high >= 0.05) clouds.push({ baseM: 7500, topM: 9000, coverage: high, density: 0.5, type: 'cirrus' });
  w.clouds = clouds;

  // ── precipitation / storms (rates are liquid-water equivalent, mm/h) ─────────────────
  // `snowfall` is cm of fresh snow (water equivalent = cm · 10 / 7 mm per Open-Meteo); `rain` excludes
  // convective showers, which only appear in the `precipitation` total (rain + showers + snow WE).
  const snowWe = ((hourlyNumber(h, 'snowfall', i) ?? 0) * 10) / 7;
  const total = hourlyNumber(h, 'precipitation', i);
  const liquid = Math.max(hourlyNumber(h, 'rain', i) ?? 0, total !== null ? total - snowWe : 0);
  const code = hourlyNumber(h, 'weather_code', i) ?? 0;
  if (snowWe > 0 && snowWe >= liquid) { w.precipitationType = 'snow'; w.precipitationRate = snowWe; }
  else if (liquid > 0) { w.precipitationType = 'rain'; w.precipitationRate = liquid; }
  else { w.precipitationType = 'none'; w.precipitationRate = 0; }
  w.thunderstorm = code >= 95;

  // ── visibility / aerosol ────────────────────────────────────────────────────────────
  const vis = hourlyNumber(h, 'visibility', i);
  w.visibilityM = clamp(vis ?? 20_000, 50, 100_000);
  w.aerosol = clamp(1 - w.visibilityM / 40_000, 0, 1);
  if (code === 45 || code === 48) { w.fogTopM = 150; w.visibilityM = Math.min(w.visibilityM, 1000); }

  // ── turbulence (POE index) ──────────────────────────────────────────────────────────
  const cape = hourlyNumber(h, 'cape', i) ?? 0;
  const gf = Math.max(0, gust - sfcSpd);
  let turb: TurbulenceIntensity = 0;
  if (w.thunderstorm || cape > 1500) turb = 5;
  else if (gf >= 10 || cape > 600 || sfcSpd >= 25) turb = 4;
  else if (gf > 3 || sfcSpd >= 15) turb = 3;
  else if (sfcSpd >= 8) turb = 2;
  else if (sfcSpd >= 4) turb = 1;
  w.turbulence = turb;
  return w;
}

export interface FetchOptions {
  /** sim UTC time used to choose the forecast hour (default: now) */ utcMs?: number;
  /** ground elevation at the location, m */ elevationM?: number;
  /** injectable fetch (tests) */ fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function fetchWithTimeout(url: string, o: FetchOptions): Promise<Response | null> {
  const f = o.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000) : null;
  try {
    return await f(url, ctrl ? { signal: ctrl.signal } : undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch live weather for a location from Open-Meteo. Resolves to `null` (and logs a warning) on
 * network errors, HTTP errors, timeouts or malformed payloads — never throws.
 */
export async function fetchOpenMeteo(lat: number, lon: number, options: FetchOptions = {}): Promise<WeatherState | null> {
  try {
    const res = await fetchWithTimeout(openMeteoUrl(lat, lon), options);
    if (!res || !res.ok) { console.warn(`[sky] open-meteo request failed: ${res ? res.status : 'no fetch available'}`); return null; }
    const json: unknown = await res.json();
    return openMeteoToWeatherState(json, options.utcMs ?? Date.now(), options.elevationM);
  } catch (e) {
    console.warn('[sky] open-meteo request failed', e);
    return null;
  }
}

/**
 * Best-effort raw METAR text from the keyless community mirror (CORS `*` per community reports,
 * unverified). Resolves to `null` on any failure. Feed the result to `parseMetar`.
 */
export async function fetchMetarText(icao: string, options: FetchOptions = {}): Promise<string | null> {
  const id = icao.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(id)) return null;
  try {
    const res = await fetchWithTimeout(`https://metar.vatsim.net/${id}`, options);
    if (!res || !res.ok) return null;
    const text = (await res.text()).trim();
    return text.startsWith(id) ? text : null;
  } catch {
    return null;
  }
}
