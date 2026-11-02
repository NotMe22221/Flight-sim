/**
 * Radio frequency helpers. All frequencies are integers in kHz (118_005 = 118.005 MHz) so
 * 8.33 kHz channels and floating-point rounding never bite.
 *
 *  - NAV band 108.00–117.95 MHz in 50 kHz steps; ILS localizers on the odd tenths 108.10–111.95.
 *  - COM band 118.000–136.975 MHz in 25 kHz steps, or 8.33 kHz channel spacing where the
 *    displayed "channel" values inside each 25 kHz block are .000/.005/.010/.015 (ICAO Annex 10).
 */

export const NAV_MIN_KHZ = 108_000;
export const NAV_MAX_KHZ = 117_950;
export const NAV_STEP_KHZ = 50;
export const ILS_MIN_KHZ = 108_100;
export const ILS_MAX_KHZ = 111_950;
export const COM_MIN_KHZ = 118_000;
export const COM_MAX_KHZ_25 = 136_975;
export const COM_MAX_KHZ_833 = 136_990;
export const COM_STEP_25_KHZ = 25;

export type ComSpacing = 25 | 8.33;

/** Offsets (kHz) of the 8.33 channel designators inside a 25 kHz block. */
const CH833_OFFSETS = [0, 5, 10, 15] as const;

/** True for a valid NAV frequency (50 kHz raster inside the band). */
export const isNavFrequency = (khz: number): boolean => Number.isInteger(khz) && khz >= NAV_MIN_KHZ && khz <= NAV_MAX_KHZ && khz % NAV_STEP_KHZ === 0;

/** True for a localizer channel: odd tenths of a MHz between 108.10 and 111.95 (e.g. 108.10, 108.15, 108.30 …). */
export const isIlsFrequency = (khz: number): boolean => isNavFrequency(khz) && khz >= ILS_MIN_KHZ && khz <= ILS_MAX_KHZ && Math.floor(khz / 100) % 2 === 1;

/** True for a 25 kHz COM channel. */
export const isComFrequency25 = (khz: number): boolean => Number.isInteger(khz) && khz >= COM_MIN_KHZ && khz <= COM_MAX_KHZ_25 && khz % COM_STEP_25_KHZ === 0;

/** True for an 8.33 kHz channel designator (…000/005/010/015 within each 25 kHz block). */
export const isComFrequency833 = (khz: number): boolean => {
  if (!Number.isInteger(khz) || khz < COM_MIN_KHZ || khz > COM_MAX_KHZ_833) return false;
  return (CH833_OFFSETS as readonly number[]).includes(khz % 25);
};

/** Snap any kHz value onto the NAV raster, clamped to the band. */
export function snapNav(khz: number): number {
  const k = Math.round(khz / NAV_STEP_KHZ) * NAV_STEP_KHZ;
  return Math.min(Math.max(k, NAV_MIN_KHZ), NAV_MAX_KHZ);
}

/** Snap onto the COM raster for the given spacing, clamped to the band. */
export function snapCom(khz: number, spacing: ComSpacing = 25): number {
  if (spacing === 25) {
    const k = Math.round(khz / 25) * 25;
    return Math.min(Math.max(k, COM_MIN_KHZ), COM_MAX_KHZ_25);
  }
  const block = Math.floor(khz / 25) * 25;
  const rem = khz - block;
  let best = 0;
  for (const o of CH833_OFFSETS) if (Math.abs(rem - o) < Math.abs(rem - best)) best = o;
  return Math.min(Math.max(block + best, COM_MIN_KHZ), COM_MAX_KHZ_833);
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * Step a NAV frequency one channel (50 kHz), wrapping at the band edges (117.95 → 108.00).
 * With `coarse` the MHz knob is turned instead: 108→117→108, keeping the kHz part.
 */
export function stepNav(khz: number, dir: 1 | -1, coarse = false): number {
  const k = snapNav(khz);
  if (coarse) {
    const mhz = Math.floor(k / 1000), frac = k % 1000;
    return (108 + mod(mhz - 108 + dir, 10)) * 1000 + frac;
  }
  const count = (NAV_MAX_KHZ - NAV_MIN_KHZ) / NAV_STEP_KHZ + 1; // 200 channels
  return NAV_MIN_KHZ + mod((k - NAV_MIN_KHZ) / NAV_STEP_KHZ + dir, count) * NAV_STEP_KHZ;
}

/** Index of an 8.33 channel designator within the band (0 = 118.000, 1 = 118.005, …). */
const ch833Index = (khz: number): number => Math.floor((khz - COM_MIN_KHZ) / 25) * 4 + Math.max(CH833_OFFSETS.indexOf((khz % 25) as 0 | 5 | 10 | 15), 0);
const ch833FromIndex = (n: number): number => COM_MIN_KHZ + Math.floor(n / 4) * 25 + CH833_OFFSETS[n % 4];
/** Number of channels in the COM band for each spacing. */
const COM_COUNT_25 = (COM_MAX_KHZ_25 - COM_MIN_KHZ) / 25 + 1; // 760
const COM_COUNT_833 = COM_COUNT_25 * 4; // 3040 designators

/**
 * Step a COM frequency one channel (25 kHz or the next 8.33 designator), wrapping at the band
 * edges (136.975 → 118.000; 136.990 → 118.000 in 8.33 mode). With `coarse` the MHz knob is
 * turned instead: 118→136→118, keeping the kHz part.
 */
export function stepCom(khz: number, dir: 1 | -1, coarse = false, spacing: ComSpacing = 25): number {
  const k = snapCom(khz, spacing);
  if (coarse) {
    const mhz = Math.floor(k / 1000), frac = k % 1000;
    return (118 + mod(mhz - 118 + dir, 19)) * 1000 + frac;
  }
  if (spacing === 25) return COM_MIN_KHZ + mod((k - COM_MIN_KHZ) / 25 + dir, COM_COUNT_25) * 25;
  return ch833FromIndex(mod(ch833Index(k) + dir, COM_COUNT_833));
}

/**
 * Format kHz as MHz text with 2 or 3 decimals ('108.10', '118.005'). Two-decimal output
 * truncates like real 5-digit displays (128.325 → '128.32').
 */
export function formatKHz(khz: number, decimals: 2 | 3): string {
  const mhz = Math.floor(khz / 1000);
  const frac = khz - mhz * 1000; // 0..999 kHz
  const digits = decimals === 2 ? Math.floor(frac / 10) : frac;
  return `${mhz}.${String(digits).padStart(decimals, '0')}`;
}

/** NAV display: two decimals ('108.10'). */
export const formatNav = (khz: number): string => formatKHz(khz, 2);

/** COM display: 'xxx.xx' for 25 kHz radios, 'xxx.xxx' for 8.33 kHz radios ('118.005'). */
export const formatCom = (khz: number, spacing: ComSpacing = 25): string => formatKHz(khz, spacing === 25 ? 2 : 3);

/** Parse '118.005', '108.1', 118.005 → kHz integer, or NaN. */
export function parseMHz(text: string | number): number {
  const v = typeof text === 'number' ? text : Number(String(text).trim());
  if (!Number.isFinite(v)) return NaN;
  return Math.round(v * 1000);
}

/** Active/standby pair with a flip-flop swap. */
export interface RadioTuning { activeKHz: number; standbyKHz: number }

/** Swap active and standby in place; returns the same object. */
export function swapFrequencies<T extends RadioTuning>(radio: T): T {
  const a = radio.activeKHz;
  radio.activeKHz = radio.standbyKHz;
  radio.standbyKHz = a;
  return radio;
}
