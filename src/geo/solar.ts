/**
 * Sun position — NOAA Solar Calculator / Meeus (Astronomical Algorithms ch. 25).
 * Accuracy ≈ 0.01° for 1900–2100. Angles in degrees unless noted. No Three.js here.
 */
import type { Vec3 } from '../core/types';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface SunPosition {
  /** geometric elevation above the horizon, deg */ elevation: number;
  /** elevation including atmospheric refraction, deg (use for the visible disc) */ apparentElevation: number;
  /** azimuth, deg clockwise from true north */ azimuth: number;
  declination: number;
  /** equation of time, minutes */ eotMin: number;
}

export const julianDay = (utcMs: number): number => utcMs / 86_400_000 + 2_440_587.5;

export function sunPosition(utcMs: number, latDeg: number, lonDeg: number): SunPosition {
  const T = (julianDay(utcMs) - 2_451_545) / 36_525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * D2R;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const appLong = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * D2R);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * D2R);
  const decl = Math.asin(Math.sin(eps * D2R) * Math.sin(appLong * D2R));
  const y = Math.tan((eps * D2R) / 2) ** 2;
  const L0r = L0 * D2R;
  const eotMin = 4 * R2D * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  const dayMs = ((utcMs % 86_400_000) + 86_400_000) % 86_400_000;
  const utcMin = dayMs / 60_000;
  const tst = (((utcMin + eotMin + 4 * lonDeg) % 1440) + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const lat = latDeg * D2R, har = ha * D2R;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(har);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevation = 90 - zen * R2D;
  const sinZen = Math.sin(zen);
  let az: number;
  if (sinZen < 1e-9) az = 180;
  else {
    az = Math.acos(Math.min(1, Math.max(-1, (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * sinZen)))) * R2D;
    az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  }
  const te = Math.tan(elevation * D2R);
  let refr = 0;
  if (elevation > 85) refr = 0;
  else if (elevation > 5) refr = (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600;
  else if (elevation > -0.575) refr = (1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))) / 3600;
  else refr = -20.772 / te / 3600;
  return { elevation, apparentElevation: elevation + refr, azimuth: az, declination: decl * R2D, eotMin };
}

/** Unit direction toward a sky object in the render frame (x East, y Up, z South). */
export function dirFromAzEl(azDeg: number, elDeg: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const az = azDeg * D2R, el = elDeg * D2R;
  out[0] = Math.cos(el) * Math.sin(az);
  out[1] = Math.sin(el);
  out[2] = -Math.cos(el) * Math.cos(az);
  return out;
}

export interface MoonPosition {
  elevation: number;
  azimuth: number;
  /** 0 new … 0.5 full … 1 new */ phase: number;
  /** 0..1 */ illuminatedFraction: number;
}

/** Low-precision moon position (Meeus ch. 47 truncated, as in suncalc). Good to ~1°. */
export function moonPosition(utcMs: number, latDeg: number, lonDeg: number): MoonPosition {
  const d = julianDay(utcMs) - 2_451_545;
  const L = (218.316 + 13.176396 * d) * D2R; // ecliptic longitude
  const Mm = (134.963 + 13.064993 * d) * D2R; // mean anomaly
  const F = (93.272 + 13.22935 * d) * D2R; // mean distance
  const l = L + 6.289 * D2R * Math.sin(Mm);
  const b = 5.128 * D2R * Math.sin(F);
  const e = 23.4397 * D2R;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  // sidereal time
  const lw = -lonDeg * D2R, phi = latDeg * D2R;
  const theta = (280.16 + 360.9856235 * d) * D2R - lw;
  const H = theta - ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); // from south, westward
  const azimuth = (((azS * R2D + 180) % 360) + 360) % 360;
  // phase from sun ecliptic longitude
  const Ms = (357.5291 + 0.98560028 * d) * D2R;
  const Cs = (1.9148 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms) + 0.0003 * Math.sin(3 * Ms)) * D2R;
  const Ls = Ms + Cs + (102.9372 + 180) * D2R;
  const sunRa = Math.atan2(Math.sin(Ls) * Math.cos(e), Math.cos(Ls));
  const sunDec = Math.asin(Math.sin(e) * Math.sin(Ls));
  const sdist = 149_598_000, mdist = 385_001 - 20_905 * Math.cos(Mm);
  const phi2 = Math.acos(Math.sin(sunDec) * Math.sin(dec) + Math.cos(sunDec) * Math.cos(dec) * Math.cos(sunRa - ra));
  const inc = Math.atan2(sdist * Math.sin(phi2), mdist - sdist * Math.cos(phi2));
  const angle = Math.atan2(Math.cos(sunDec) * Math.sin(sunRa - ra), Math.sin(sunDec) * Math.cos(dec) - Math.cos(sunDec) * Math.sin(dec) * Math.cos(sunRa - ra));
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;
  return { elevation: alt * R2D, azimuth, phase, illuminatedFraction: (1 + Math.cos(inc)) / 2 };
}

export interface SunEvents {
  /** UTC ms of apparent sunrise / solar noon / sunset on the local solar day containing `utcMs`; NaN when the sun never rises/sets */
  sunriseMs: number;
  noonMs: number;
  sunsetMs: number;
}

/**
 * Sunrise, solar noon and sunset (geometric elevation −0.833°: upper limb on the refracted horizon) for the local solar day that
 * contains `utcMs` at (lat, lon). Scans in 10-minute steps and refines crossings by bisection.
 */
export function sunEvents(utcMs: number, latDeg: number, lonDeg: number): SunEvents {
  const dayMs = 86_400_000;
  const solarOffsetMs = (lonDeg / 15) * 3_600_000;
  const localMidnight = Math.floor((utcMs + solarOffsetMs) / dayMs) * dayMs - solarOffsetMs;
  // −0.833° is the standard *geometric* altitude of the sun's centre at sunrise/sunset: it already
  // contains 34′ of refraction and the 16′ semi-diameter, so use the geometric elevation here.
  const h = (t: number) => sunPosition(t, latDeg, lonDeg).elevation + 0.833;
  const step = 10 * 60_000;
  let rise = NaN, set = NaN, noon = localMidnight + dayMs / 2, maxEl = -Infinity;
  let tPrev = localMidnight, hPrev = h(tPrev);
  for (let t = localMidnight + step; t <= localMidnight + dayMs; t += step) {
    const hv = h(t);
    if (hv > maxEl) { maxEl = hv; noon = t; }
    if (hPrev < 0 && hv >= 0 && Number.isNaN(rise)) rise = bisect(h, tPrev, t);
    if (hPrev >= 0 && hv < 0) set = bisect(h, tPrev, t);
    tPrev = t; hPrev = hv;
  }
  return { sunriseMs: rise, noonMs: noon, sunsetMs: set };
}

function bisect(f: (t: number) => number, a: number, b: number): number {
  let fa = f(a);
  for (let i = 0; i < 30; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}
