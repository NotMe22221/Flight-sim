/**
 * Surface observation at an airport derived from the sim `WeatherState`, rounded the way a
 * METAR reports it (wind to 10° / 1 kt, visibility to reportable statute-mile values, cloud
 * bases in hundreds of feet AGL, whole-degree temperatures, altimeter to 0.01 inHg).
 */
import type { WeatherState } from '../core/types';
import { clamp, wrap360 } from '../core/math';
import { FT, INHG } from '../core/units';

/** Cloud cover category (oktas: FEW 1–2, SCT 3–4, BKN 5–7, OVC 8). */
export type CloudCover = 'FEW' | 'SCT' | 'BKN' | 'OVC';

/** One reported cloud layer. */
export interface SkyLayer {
  cover: CloudCover;
  /** base above the field, ft, rounded to the METAR resolution */
  baseFtAgl: number;
}

/** A rounded surface observation (true wind, as in a METAR). */
export interface SurfaceObservation {
  /** wind direction the wind blows FROM, true deg rounded to 10 (0 when calm) */
  windDirTrueDeg: number;
  /** whole knots */
  windSpeedKt: number;
  /** whole knots, 0 when no gust is reported */
  windGustKt: number;
  /** reportable statute miles (10 = "10 or more"); < 0.25 reported as 0 ("less than 1/4") */
  visibilitySM: number;
  /** present weather, METAR code ('' when none): '-RA', '+SN', 'TSRA', 'BR', 'FG', 'HZ' */
  weather: string;
  /** ascending, at most 4 */
  layers: SkyLayer[];
  /** whole °C at field elevation */
  temperatureC: number;
  dewpointC: number;
  /** inHg rounded to 0.01 */
  altimeterInHg: number;
}

/** Statute mile, m. */
export const STATUTE_MILE_M = 1609.344;
/** Standard temperature lapse rate, K/m. */
const LAPSE_K_PER_M = 0.0065;
/** Reportable visibility values below 10 SM (METAR: report the next lower value). */
const REPORTABLE_SM = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10];

// Magnus formula coefficients (Alduchov & Eskridge 1996), °C.
const MAGNUS_A = 17.625;
const MAGNUS_B = 243.04;

/** Dew point (°C) from temperature (°C) and relative humidity (0..1). */
export function dewpointC(tempC: number, rh: number): number {
  const g = Math.log(clamp(rh, 0.01, 1)) + (MAGNUS_A * tempC) / (MAGNUS_B + tempC);
  return (MAGNUS_B * g) / (MAGNUS_A - g);
}

/** Relative humidity (0..1) from temperature and dew point (°C). Inverse of {@link dewpointC}. */
export function relativeHumidity(tempC: number, dewC: number): number {
  return clamp(Math.exp((MAGNUS_A * dewC) / (MAGNUS_B + dewC) - (MAGNUS_A * tempC) / (MAGNUS_B + tempC)), 0, 1);
}

/** Round a visibility in metres down to a reportable statute-mile value. */
export function reportableVisibilitySM(visibilityM: number): number {
  const sm = visibilityM / STATUTE_MILE_M;
  if (sm >= 10) return 10;
  let best = 0;
  for (const v of REPORTABLE_SM) if (v <= sm + 1e-9) best = v;
  return best;
}

/** METAR height rounding: 100 ft up to 5 000 ft, 500 ft up to 10 000 ft, 1 000 ft above. */
export function roundCloudBaseFt(ft: number): number {
  const f = Math.max(0, ft);
  if (f <= 5000) return Math.round(f / 100) * 100;
  if (f <= 10000) return Math.round(f / 500) * 500;
  return Math.round(f / 1000) * 1000;
}

/** Cloud cover category from a 0..1 coverage fraction; null below one okta. */
export function cloudCover(coverage: number): CloudCover | null {
  const oktas = Math.round(clamp(coverage, 0, 1) * 8);
  if (oktas <= 0) return null;
  if (oktas <= 2) return 'FEW';
  if (oktas <= 4) return 'SCT';
  if (oktas <= 7) return 'BKN';
  return 'OVC';
}

function presentWeather(w: WeatherState, visSM: number): string {
  let precip = '';
  if (w.precipitationType !== 'none' && w.precipitationRate > 0.1) {
    const code = w.precipitationType === 'snow' ? 'SN' : 'RA';
    const intensity = w.precipitationRate < 2.5 ? '-' : w.precipitationRate > 7.6 ? '+' : '';
    precip = `${intensity}${code}`;
  }
  if (w.thunderstorm) {
    // "-TSRA": the intensity prefix applies to the precipitation, written before TS.
    const sign = precip.startsWith('-') || precip.startsWith('+') ? precip[0] : '';
    return `${sign}TS${precip.replace(/^[-+]/, '')}`;
  }
  if (precip) return precip;
  if (visSM < 0.625 && (w.fogTopM > 0 || w.humidity >= 0.9)) return 'FG';
  if (visSM <= 6 && w.humidity >= 0.7) return 'BR';
  if (visSM <= 6 && w.aerosol >= 0.3) return 'HZ';
  return '';
}

/**
 * Observe the weather at a field. Surface wind is the lowest wind layer (calm when none);
 * temperature is reduced from the sea-level reference with the standard lapse rate; the dew
 * point comes from the relative humidity. Allocates (call on change, not per frame).
 */
export function observeSurface(w: WeatherState, fieldElevM: number): SurfaceObservation {
  let sfc = w.winds.length ? w.winds[0] : null;
  for (const l of w.winds) if (sfc && l.altM < sfc.altM) sfc = l;
  const spd = sfc ? Math.round(sfc.speedKt) : 0;
  const gust = sfc && sfc.gustKt > sfc.speedKt + 0.5 ? Math.round(sfc.gustKt) : 0;
  let dir = sfc && spd > 0 ? Math.round(wrap360(sfc.directionDeg) / 10) * 10 : 0;
  if (spd > 0 && dir === 0) dir = 360;

  const visibilitySM = reportableVisibilitySM(w.visibilityM);
  const layers: SkyLayer[] = [];
  const sorted = [...w.clouds].sort((a, b) => a.baseM - b.baseM);
  for (const c of sorted) {
    const cover = cloudCover(c.coverage);
    if (!cover) continue;
    layers.push({ cover, baseFtAgl: roundCloudBaseFt((c.baseM - fieldElevM) / FT) });
    if (layers.length === 4) break;
  }

  const t = w.temperatureC - LAPSE_K_PER_M * fieldElevM;
  const td = Math.min(t, dewpointC(t, w.humidity));
  return {
    windDirTrueDeg: dir,
    windSpeedKt: spd,
    windGustKt: gust,
    visibilitySM,
    weather: presentWeather(w, visibilitySM),
    layers,
    temperatureC: Math.round(t) === 0 ? 0 : Math.round(t),
    dewpointC: Math.round(td) === 0 ? 0 : Math.round(td),
    altimeterInHg: Math.round((w.qnhPa / INHG) * 100) / 100,
  };
}

/** The lowest broken or overcast layer (the ceiling), or null. */
export function ceilingLayer(obs: SurfaceObservation): SkyLayer | null {
  for (const l of obs.layers) if (l.cover === 'BKN' || l.cover === 'OVC') return l;
  return null;
}

/** Flight category: VFR (ceiling ≥ 3 000 ft and vis ≥ 5 SM), MVFR, IFR (< 1 000 / < 3), LIFR (< 500 / < 1). */
export function flightCategory(obs: SurfaceObservation): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' {
  const ceil = ceilingLayer(obs)?.baseFtAgl ?? Infinity;
  const vis = obs.visibilitySM;
  if (ceil < 500 || vis < 1) return 'LIFR';
  if (ceil < 1000 || vis < 3) return 'IFR';
  if (ceil <= 3000 || vis <= 5) return 'MVFR';
  return 'VFR';
}
