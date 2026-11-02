/**
 * Text formatting for instrument readouts. Pure functions, no locale dependence (we build the
 * thousands separator ourselves so a canvas on a de-DE machine still shows "3,500").
 */
import { wrap360 } from '../core/math';

/** Integer with thousands separators: 3500 → "3,500"; −250 → "-250". */
export function formatThousands(value: number): string {
  const v = Math.round(value);
  const neg = v < 0;
  let s = String(Math.abs(v));
  let out = '';
  while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
  return (neg ? '-' : '') + s + out;
}

/** Altitude in feet, rounded to `stepFt` (default 1): 3480 → "3,480". */
export function formatAltitude(ft: number, stepFt = 1): string {
  const r = stepFt > 1 ? Math.round(ft / stepFt) * stepFt : Math.round(ft);
  return formatThousands(r);
}

/** Heading as three zero-padded digits with a degree sign: 285 → "285°", 5 → "005°", 360 → "360°". */
export function formatHeading(deg: number): string {
  return formatHeadingNum(deg) + '°';
}

/** Heading as three zero-padded digits without the symbol; 0 is shown as "360". */
export function formatHeadingNum(deg: number): string {
  let d = Math.round(wrap360(deg));
  if (d === 0) d = 360;
  return d < 10 ? '00' + d : d < 100 ? '0' + d : String(d);
}

/** NAV frequency in MHz from kHz with two decimals: 116800 → "116.80". */
export function formatNavFrequency(khz: number): string {
  return (Math.round(khz / 10) / 100).toFixed(2);
}

/** COM frequency in MHz from kHz with three decimals (8.33/25 kHz channels): 120500 → "120.500". */
export function formatComFrequency(khz: number): string {
  return (Math.round(khz) / 1000).toFixed(3);
}

/** Labelled nav frequency: ("NAV", 116800) → "NAV 116.80". */
export function formatNavLabel(label: string, khz: number): string {
  return `${label} ${formatNavFrequency(khz)}`;
}

/** Signed integer with explicit plus: 500 → "+500", −700 → "-700", 0 → "0". */
export function formatSigned(value: number): string {
  const v = Math.round(value);
  return v > 0 ? '+' + v : String(v);
}

/** Vertical speed rounded to 50 fpm for digital readouts: 487 → "+500". */
export function formatVerticalSpeed(fpm: number, stepFpm = 50): string {
  return formatSigned(Math.round(fpm / stepFpm) * stepFpm);
}

/** Pads an integer with zeros to `width` digits. */
export function pad(value: number, width: number): string {
  let s = String(Math.max(0, Math.floor(value)));
  while (s.length < width) s = '0' + s;
  return s;
}

/** UTC clock "HH:MM:SS" from epoch milliseconds. */
export function formatUtc(utcMs: number): string {
  const s = Math.floor(utcMs / 1000);
  const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${pad(h < 0 ? h + 24 : h, 2)}:${pad(m, 2)}:${pad(sec, 2)}`;
}

/** Elapsed timer "MM:SS" (rolls to "H:MM:SS" past an hour). */
export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(sec, 2)}` : `${pad(m, 2)}:${pad(sec, 2)}`;
}

/** Estimated time en route "HH:MM" from seconds; "__:__" when unknown. */
export function formatEte(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 99 * 3600) return '__:__';
  const m = Math.round(seconds / 60);
  return `${pad(Math.floor(m / 60), 2)}:${pad(m % 60, 2)}`;
}

/** Distance in nm with one decimal below 100 nm, integer above: 12.34 → "12.3". */
export function formatDistanceNm(nm: number): string {
  if (!Number.isFinite(nm)) return '__._';
  return nm < 100 ? nm.toFixed(1) : String(Math.round(nm));
}

/** Hours with one decimal (Hobbs / tach meters): 1234.56 → "1234.6". */
export function formatHours(h: number): string { return h.toFixed(1); }

/** Temperature "15°C" / "-3°C". */
export function formatTempC(c: number): string { return `${Math.round(c)}°C`; }

/** Transponder code as four octal digits. */
export function formatSquawk(code: number): string { return pad(code, 4); }

/** Barometric setting in inHg "29.92" or hPa "1013". */
export function formatBaroInHg(inHg: number): string { return inHg.toFixed(2); }
export function formatBaroHpa(hPa: number): string { return String(Math.round(hPa)); }

/** Wind "280°/10KT" style parts. */
export function formatWind(dirDeg: number, speedKt: number): string {
  return `${formatHeadingNum(dirDeg)}°/${Math.round(speedKt)}`;
}
