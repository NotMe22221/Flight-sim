/**
 * Approximate solar elevation (NOAA low-accuracy algorithm, ±0.5°) — enough for the
 * World Map's sun hint and the dawn/noon/dusk/night time presets. Pure; the UI must not
 * import src/geo, so this is a deliberate small duplicate.
 */
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Sun elevation above the horizon in degrees at a UTC instant and location. */
export function sunElevationDeg(utcMs: number, lat: number, lon: number): number {
  const jd = utcMs / 86_400_000 + 2_440_587.5;
  const n = jd - 2_451_545.0; // days since J2000
  const L = (280.460 + 0.9856474 * n) % 360;          // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;   // mean anomaly
  const λ = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // ecliptic longitude
  const ε = (23.439 - 0.0000004 * n) * D2R;            // obliquity
  const δ = Math.asin(Math.sin(ε) * Math.sin(λ));      // declination
  const α = Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ)); // right ascension
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24; // hours
  const lst = ((gmst + lon / 15) % 24 + 24) % 24;
  const H = ((lst * 15 - α * R2D + 540) % 360 - 180) * D2R; // hour angle
  const φ = lat * D2R;
  const sinEl = Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) * R2D;
}

export type SunPhase = 'night' | 'astronomical' | 'nautical' | 'civil' | 'golden' | 'day';

/** Qualitative label for the sun hint. */
export function sunPhase(elevationDeg: number): SunPhase {
  if (elevationDeg < -18) return 'night';
  if (elevationDeg < -12) return 'astronomical';
  if (elevationDeg < -6) return 'nautical';
  if (elevationDeg < 0) return 'civil';
  if (elevationDeg < 6) return 'golden';
  return 'day';
}

export const SUN_PHASE_LABEL: Record<SunPhase, string> = {
  night: 'Night', astronomical: 'Astronomical twilight', nautical: 'Nautical twilight',
  civil: 'Civil twilight', golden: 'Golden hour', day: 'Day',
};

export type TimePreset = 'dawn' | 'noon' | 'dusk' | 'night';

/** Start of the UTC day containing `utcMs`. */
export function startOfUtcDay(utcMs: number): number { return Math.floor(utcMs / 86_400_000) * 86_400_000; }

/**
 * Finds the UTC instant on the local day of `dayUtcMs` matching a preset by scanning the
 * sun elevation in 5-minute steps. dawn/dusk: elevation crossing −1° (rising/setting);
 * noon: maximum; night: minimum. The scan window is centred on local solar midnight so
 * all four events fall in the same local day regardless of longitude.
 */
export function timeForPreset(preset: TimePreset, dayUtcMs: number, lat: number, lon: number): number {
  const STEP = 5 * 60_000;
  const lonOffsetMs = -lon / 15 * 3_600_000; // local solar midnight ≈ 00:00 UTC + offset
  const day0 = startOfUtcDay(dayUtcMs + (-lonOffsetMs)) + lonOffsetMs; // local solar midnight (UTC)
  const samples: { t: number; el: number }[] = [];
  for (let t = day0; t <= day0 + 86_400_000; t += STEP) samples.push({ t, el: sunElevationDeg(t, lat, lon) });
  if (preset === 'noon' || preset === 'night') {
    let best = samples[0];
    for (const s of samples) if (preset === 'noon' ? s.el > best.el : s.el < best.el) best = s;
    return best.t;
  }
  const target = -1;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const rising = a.el < target && b.el >= target;
    const setting = a.el >= target && b.el < target;
    if ((preset === 'dawn' && rising) || (preset === 'dusk' && setting)) {
      const f = (target - a.el) / (b.el - a.el);
      return a.t + f * (b.t - a.t);
    }
  }
  // Polar day/night: fall back to noon ∓ 6 h.
  const noon = timeForPreset('noon', dayUtcMs, lat, lon);
  return preset === 'dawn' ? noon - 6 * 3_600_000 : noon + 6 * 3_600_000;
}
