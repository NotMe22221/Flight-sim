/**
 * Pure unit formatting for the UI boundary. SI in, strings out. No DOM, no locale
 * dependence (thousands are grouped with ',' explicitly so tests are deterministic).
 */
import type { UnitsSettings } from './UiHost';

export const FT_PER_M = 3.280839895;
export const KT_PER_MS = 1.943844492;
export const KMH_PER_MS = 3.6;
export const MPH_PER_MS = 2.236936292;
export const NM_PER_M = 1 / 1852;
export const KM_PER_M = 0.001;
export const INHG_PER_PA = 1 / 3386.389;
export const HPA_PER_PA = 0.01;
export const FPM_PER_MS = 196.8503937;
export const LB_PER_KG = 2.204622622;
export const L_PER_GAL = 3.785411784;
/** Avgas 100LL density kg/L (ASTM typical 0.72) */
export const AVGAS_KG_PER_L = 0.72;

export const defaultUnits: UnitsSettings = { altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'C' };

function isFiniteNum(v: number): boolean { return typeof v === 'number' && Number.isFinite(v); }

/** Groups an integer with ',' thousands separators; keeps the sign. Non-finite → '--'. */
export function groupThousands(n: number): string {
  if (!isFiniteNum(n)) return '--';
  const r = Math.round(n);
  const sign = r < 0 ? '-' : '';
  const digits = Math.abs(r).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return sign + out;
}

/** Rounds to the nearest multiple of `step` (step > 0). */
export function roundTo(v: number, step: number): number {
  if (!isFiniteNum(v) || !(step > 0)) return v;
  return Math.round(v / step) * step;
}

function fixed(v: number, decimals: number): string {
  if (!isFiniteNum(v)) return '--';
  const s = v.toFixed(decimals);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

// ── Altitude ────────────────────────────────────────────────────────────────────────────

export function altitudeValue(m: number, u: UnitsSettings): number { return u.altitude === 'ft' ? m * FT_PER_M : m; }
export function altitudeUnit(u: UnitsSettings): string { return u.altitude; }
/** '3,500 ft' / '1,067 m'. `step` rounds the displayed value (default 1). */
export function formatAltitude(m: number, u: UnitsSettings = defaultUnits, step = 1): string {
  if (!isFiniteNum(m)) return '--';
  return `${groupThousands(roundTo(altitudeValue(m, u), step))} ${altitudeUnit(u)}`;
}

// ── Speed ───────────────────────────────────────────────────────────────────────────────

export function speedValue(ms: number, u: UnitsSettings): number {
  switch (u.speed) {
    case 'kt': return ms * KT_PER_MS;
    case 'kmh': return ms * KMH_PER_MS;
    case 'mph': return ms * MPH_PER_MS;
  }
}
export function speedUnit(u: UnitsSettings): string { return u.speed === 'kmh' ? 'km/h' : u.speed; }
/** '112 kt' / '207 km/h' / '129 mph' */
export function formatSpeed(ms: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(ms)) return '--';
  return `${groupThousands(speedValue(ms, u))} ${speedUnit(u)}`;
}

/** '+500 fpm' / '-2.5 m/s' (sign always shown; 0 shows as '0'). */
export function formatVerticalSpeed(ms: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(ms)) return '--';
  if (u.altitude === 'ft') {
    const fpm = roundTo(ms * FPM_PER_MS, 10);
    const sign = fpm > 0 ? '+' : '';
    return `${sign}${groupThousands(fpm)} fpm`;
  }
  const r = Math.round(ms * 10) / 10;
  const sign = r > 0 ? '+' : '';
  return `${sign}${fixed(r, 1)} m/s`;
}

// ── Pressure ────────────────────────────────────────────────────────────────────────────

/** '29.92 inHg' / '1013 hPa' */
export function formatPressure(pa: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(pa)) return '--';
  return u.pressure === 'inHg' ? `${fixed(pa * INHG_PER_PA, 2)} inHg` : `${Math.round(pa * HPA_PER_PA)} hPa`;
}

// ── Distance ────────────────────────────────────────────────────────────────────────────

export function distanceValue(m: number, u: UnitsSettings): number { return u.distance === 'nm' ? m * NM_PER_M : m * KM_PER_M; }
export function distanceUnit(u: UnitsSettings): string { return u.distance; }
/** '12.3 nm' below 100, '123 nm' above; '0.8 km'. */
export function formatDistance(m: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(m)) return '--';
  const v = distanceValue(m, u);
  const a = Math.abs(v);
  const s = a < 10 ? fixed(v, 1) : groupThousands(v);
  return `${s} ${distanceUnit(u)}`;
}

/** Short lengths (runways): '11,870 ft' or '3,618 m' — follows the altitude unit. */
export function formatLength(m: number, u: UnitsSettings = defaultUnits): string {
  return formatAltitude(m, u, 1);
}

// ── Temperature ─────────────────────────────────────────────────────────────────────────

export function temperatureValue(c: number, u: UnitsSettings): number { return u.temperature === 'F' ? c * 9 / 5 + 32 : c; }
/** '15 °C' / '59 °F' */
export function formatTemperature(c: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(c)) return '--';
  const v = Math.round(temperatureValue(c, u));
  return `${v === 0 ? 0 : v} °${u.temperature}`;
}

// ── Mass / fuel ─────────────────────────────────────────────────────────────────────────

/** Mass follows the altitude unit family: ft → lb, m → kg. */
export function formatMass(kg: number, u: UnitsSettings = defaultUnits): string {
  if (!isFiniteNum(kg)) return '--';
  return u.altitude === 'ft' ? `${groupThousands(kg * LB_PER_KG)} lb` : `${groupThousands(kg)} kg`;
}

export type FuelUnit = 'gal' | 'l' | 'kg' | 'lb';
export function fuelValue(kg: number, unit: FuelUnit): number {
  switch (unit) {
    case 'kg': return kg;
    case 'lb': return kg * LB_PER_KG;
    case 'l': return kg / AVGAS_KG_PER_L;
    case 'gal': return kg / AVGAS_KG_PER_L / L_PER_GAL;
  }
}
/** '26.4 gal' / '100.0 L' / '72.0 kg'; ≥ 1,000 shown grouped without decimals */
export function formatFuel(kg: number, unit: FuelUnit): string {
  if (!isFiniteNum(kg)) return '--';
  const v = fuelValue(kg, unit);
  const label = unit === 'l' ? 'L' : unit;
  return `${Math.abs(v) < 1000 ? fixed(v, 1) : groupThousands(v)} ${label}`;
}

// ── Frequencies ─────────────────────────────────────────────────────────────────────────

/**
 * kHz → display. Channels whose third decimal is 0 on the 25 kHz raster use two decimals
 * ('116.80', '118.25'); the other 25 kHz channels keep all three ('118.125', '118.275' — two
 * decimals would round them onto a different channel), as do 8.33 kHz channels ('118.005',
 * '118.010'). Digits are taken from the integer kHz, never from a rounded float.
 */
export function formatFrequency(khz: number): string {
  if (!isFiniteNum(khz) || khz <= 0) return '---.--';
  const k = Math.round(khz);
  const mhz = Math.floor(k / 1000);
  const frac = (k % 1000).toString().padStart(3, '0');
  return k % 25 === 0 && k % 10 === 0 ? `${mhz}.${frac.slice(0, 2)}` : `${mhz}.${frac}`;
}
/** MHz → display (rounds to the nearest kHz first so 118.005 stays 118.005). */
export function formatFrequencyMHz(mhz: number): string {
  if (!isFiniteNum(mhz)) return '---.--';
  return formatFrequency(Math.round(mhz * 1000));
}

// ── Angles ──────────────────────────────────────────────────────────────────────────────

/** Wraps to [0, 360). */
export function normalizeHeading(deg: number): number {
  if (!isFiniteNum(deg)) return 0;
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}
/** Aviation style: three digits, 0 shown as 360: '283°', '005°', '360°'. */
export function formatHeading(deg: number): string {
  if (!isFiniteNum(deg)) return '---°';
  let r = Math.round(normalizeHeading(deg));
  if (r === 0 || r === 360) r = 360;
  return `${r.toString().padStart(3, '0')}°`;
}
/** Signed angle: '+2.5°' / '-10°' (one decimal when |v| < 10). */
export function formatAngle(deg: number): string {
  if (!isFiniteNum(deg)) return '--';
  const a = Math.abs(deg);
  const s = a < 10 ? fixed(deg, 1) : Math.round(deg).toString();
  return `${deg > 0 ? '+' : ''}${s}°`;
}

/** 'N37°36.81′ W122°21.43′' */
export function formatCoord(lat: number, lon: number): string {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return '--';
  const f = (v: number, pos: string, neg: string) => {
    const h = v < 0 ? neg : pos;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${h}${d}°${m.toFixed(2).padStart(5, '0')}′`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

// ── Time ────────────────────────────────────────────────────────────────────────────────

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
}
/** '14:05Z' */
export function formatTimeUtc(utcMs: number): string {
  if (!isFiniteNum(utcMs)) return '--:--Z';
  return `${hhmm(utcMs)}Z`;
}
/**
 * Local time without a timezone database: the caller supplies an offset in minutes,
 * typically `timezoneOffsetFromLon(lon)` (solar-ish) since the sim has no tz data.
 */
export function formatTimeLocal(utcMs: number, offsetMinutes: number): string {
  if (!isFiniteNum(utcMs) || !isFiniteNum(offsetMinutes)) return '--:--';
  return hhmm(utcMs + offsetMinutes * 60_000);
}
/** Longitude → whole-hour zone offset in minutes (lon 15° per hour; -122 → -480). */
export function timezoneOffsetFromLon(lonDeg: number): number {
  if (!isFiniteNum(lonDeg)) return 0;
  const lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  return Math.round(lon / 15) * 60;
}
/** 'UTC-8' / 'UTC+5:30' / 'UTC' */
export function formatUtcOffset(offsetMinutes: number): string {
  if (!isFiniteNum(offsetMinutes) || offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const a = Math.abs(offsetMinutes);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? ':' + m.toString().padStart(2, '0') : ''}`;
}
/** '2026-11-02' */
export function formatDateUtc(utcMs: number): string {
  if (!isFiniteNum(utcMs)) return '----------';
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
}
/** Seconds → '1h 05m' (≥ 1 h), '12m 30s' (≥ 1 min), '45s'. Negative/NaN/∞ → '--'. */
export function formatDuration(s: number): string {
  if (!isFiniteNum(s) || s < 0) return '--';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}
/** Clock-style ETE 'H:MM' or 'MM:SS' for tables. */
export function formatEte(s: number): string {
  if (!isFiniteNum(s) || s < 0) return '--:--';
  const t = Math.round(s);
  if (t >= 3600) return `${Math.floor(t / 3600)}:${Math.floor((t % 3600) / 60).toString().padStart(2, '0')}`;
  return `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}`;
}

// ── Misc ────────────────────────────────────────────────────────────────────────────────

/** '280/10' or '280/10G15'. Calm (< 1 kt) → 'CALM'. */
export function formatWind(dirDeg: number, kt: number, gustKt = 0): string {
  if (!isFiniteNum(kt) || kt < 1) return 'CALM';
  const g = gustKt > kt + 0.5 ? `G${Math.round(gustKt)}` : '';
  return `${formatHeading(dirDeg).slice(0, 3)}/${Math.round(kt).toString().padStart(2, '0')}${g}`;
}
/** 0.457 → '46%' */
export function formatPercent(frac: number): string {
  if (!isFiniteNum(frac)) return '--%';
  return `${Math.round(frac * 100)}%`;
}
/** 'x1', 'x0.5', 'x16' */
export function formatTimeScale(scale: number): string {
  if (!isFiniteNum(scale)) return 'x--';
  return `x${Number.isInteger(scale) ? scale : fixed(scale, 2).replace(/0+$/, '')}`;
}
/** Visibility in the distance unit; ≥ 10 units shown as integer: '10 nm', '2.5 km'. */
export function formatVisibility(m: number, u: UnitsSettings = defaultUnits): string {
  return formatDistance(m, u);
}
