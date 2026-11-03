/**
 * International Standard Atmosphere (0–20 km) with a temperature offset and a non-standard
 * sea-level pressure (QNH), plus airspeed conversions (docs/research/02 §7).
 */
import type { AtmosphereSample } from '../core/types';
import { Table1D } from '../core/math';
import { KT } from '../core/units';

export const T0 = 288.15;
export const P0 = 101325;
export const RHO0 = 1.225;
export const LAPSE = -0.0065;
export const R_AIR = 287.05287;
export const G0 = 9.80665;
export const GAMMA = 1.4;
export const A0 = Math.sqrt(GAMMA * R_AIR * T0); // 340.294 m/s
const H_TROPO = 11000;
/** g0 / (R·|L|) */
const EXP = G0 / (R_AIR * -LAPSE); // 5.25588
const T_TROPO = T0 + LAPSE * H_TROPO; // 216.65 K

/**
 * Atmospheric state at geometric altitude `h` (m) for a day with temperature offset `dT`
 * (K, applied uniformly) and sea-level pressure `qnh` (Pa). Writes into `out`.
 */
export function atmosphere(h: number, dT = 0, qnh = P0, out: AtmosphereSample = { temperatureK: 0, pressurePa: 0, densityKgM3: 0, speedOfSound: 0 }): AtmosphereSample {
  const hc = h < -1000 ? -1000 : h > 30000 ? 30000 : h;
  let tStd: number, p: number;
  if (hc <= H_TROPO) {
    tStd = T0 + LAPSE * hc;
    p = qnh * Math.pow(tStd / T0, EXP);
  } else {
    tStd = T_TROPO;
    const p11 = qnh * Math.pow(T_TROPO / T0, EXP);
    p = p11 * Math.exp((-G0 * (hc - H_TROPO)) / (R_AIR * T_TROPO));
  }
  const t = Math.max(tStd + dT, 150);
  out.temperatureK = t;
  out.pressurePa = p;
  out.densityKgM3 = p / (R_AIR * t);
  out.speedOfSound = Math.sqrt(GAMMA * R_AIR * t);
  return out;
}

/** Calibrated airspeed from true airspeed (subsonic, compressible). */
export function casFromTas(tas: number, p: number, a: number): number {
  const v = Math.abs(tas);
  const mach = v / a;
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** True airspeed from calibrated airspeed (inverse of {@link casFromTas}). */
export function tasFromCas(cas: number, p: number, a: number): number {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
  const mach = Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
  return mach * a;
}

/** Equivalent airspeed. */
export const easFromTas = (tas: number, rho: number): number => Math.abs(tas) * Math.sqrt(rho / RHO0);

/**
 * Barometric (indicated) altitude for static pressure `p` and altimeter setting `pSet` (Pa),
 * standard-atmosphere law in the troposphere.
 */
export function indicatedAltitude(p: number, pSet: number): number {
  return (T0 / -LAPSE) * (1 - Math.pow(p / pSet, 1 / EXP));
}

/** Pressure altitude (indicated altitude with 1013.25 hPa set). */
export const pressureAltitude = (p: number): number => indicatedAltitude(p, P0);

/**
 * Cessna 172S airspeed calibration (normal static source), KCAS → KIAS, flaps up and flaps 30°.
 * Reconstructed from POH headline values (Vs 48 KIAS = 53 KCAS, Vs0 40 KIAS = 48 KCAS);
 * see docs/research/02 §7. Below the table the error scales to zero at zero speed.
 */
const CAS_UP = [48, 56, 62, 70, 79, 88, 98, 107, 117, 127, 136, 146, 156];
const IAS_UP = [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
const CAS_30 = [47, 54, 61, 69, 78, 83];
const IAS_30 = [40, 50, 60, 70, 80, 85];
const iasUp = new Table1D(CAS_UP, IAS_UP);
const ias30 = new Table1D(CAS_30, IAS_30);

/** Indicated airspeed (m/s) from calibrated airspeed (m/s) and flap angle (deg). */
export function iasFromCas(casMs: number, flapDeg: number): number {
  const kcas = casMs / KT;
  const f = flapDeg <= 0 ? 0 : flapDeg >= 30 ? 1 : flapDeg / 30;
  const conv = (t: Table1D, c0: number, i0: number, cMax: number, iMax: number): number => {
    if (kcas <= 0) return 0;
    if (kcas < c0) return (kcas * i0) / c0;
    if (kcas > cMax) return iMax + (kcas - cMax);
    return t.at(kcas);
  };
  const up = conv(iasUp, 48, 40, 156, 160);
  const dn = conv(ias30, 47, 40, 83, 85);
  return (up + (dn - up) * f) * KT;
}
