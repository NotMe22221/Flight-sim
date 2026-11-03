/**
 * Pure view model for the landing report ('landing:scored'). The scorer
 * (src/activities/TouchdownDetector.ts) sends `centre/smooth/zone/stop` as 0..100 percentages plus
 * raw measurements (`centrelineOffsetM`, `verticalSpeedFpm`, `touchdownFromThresholdM`,
 * `stopDistanceM` or 'touch-and-go', `peakG`, `crabDeg`, `bounces`, `grade`, `runway`). Other
 * spellings and 0..1 fractions are accepted too, so a different scorer still renders.
 */
import type { UnitsSettings } from './UiHost';
import { FPM_PER_MS, formatAltitude, formatVerticalSpeed } from './format';

export type LandingDetails = Record<string, number | string>;

export interface LandingComponent { key: 'center' | 'smooth' | 'zone' | 'stop'; label: string; weight: number; frac: number | null; raw: string }
export interface LandingExtra { label: string; value: string }

/** Weights of doc 01 §10.1 (and src/activities/landingScore.ts). */
export const LANDING_WEIGHTS = { center: 0.30, smooth: 0.35, zone: 0.15, stop: 0.20 } as const;

const KEYS = {
  center: ['centre', 'center', 'centerline', 'centreline', 'centerScore'],
  smooth: ['smooth', 'smoothness', 'touchdownScore'],
  zone: ['zone', 'aimPoint', 'aimpoint', 'zoneScore'],
  stop: ['stop', 'stopping', 'stopScore'],
  offsetM: ['centrelineOffsetM', 'centerlineOffsetM', 'lateralOffsetM', 'centreOffsetM'],
  halfWidthM: ['runwayHalfWidthM', 'halfWidthM'],
  widthM: ['runwayWidthM', 'widthM'],
  vsMs: ['verticalSpeedMs', 'touchdownVsMs'],
  vsFpm: ['verticalSpeedFpm', 'touchdownVsFpm', 'touchdownFpm'],
  alongM: ['touchdownFromThresholdM', 'alongTrackM', 'touchdownDistanceM', 'distanceFromThresholdM'],
  aimM: ['aimPointM'],
  stopDistM: ['stopDistanceM', 'rolloutM', 'stoppingDistanceM'],
  lengthM: ['runwayLengthM', 'lengthM'],
} as const;

/** Keys the report shows elsewhere (components, title, band). */
const CONSUMED = new Set<string>([...Object.values(KEYS).flat(), 'runway', 'airport', 'grade']);

function num(d: LandingDetails, keys: readonly string[]): number | null {
  for (const k of keys) { const v = d[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return null;
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * 100 when the scorer reports percentages, 1 for fractions. Any value above 1 means percent;
 * when all are ≤ 1, the reported score decides (fractions × 10 000 vs percentages × 100).
 */
export function componentScale(values: readonly (number | null)[], score?: number): 1 | 100 {
  const v = values.filter((x): x is number => x !== null && x >= 0);
  if (v.some((x) => x > 1)) return 100;
  if (score === undefined || !Number.isFinite(score) || score <= 0 || values.length !== 4 || v.length !== 4) return 1;
  const [c, s, z, t] = values as number[];
  const w = LANDING_WEIGHTS.center * c + LANDING_WEIGHTS.smooth * s + LANDING_WEIGHTS.zone * z + LANDING_WEIGHTS.stop * t;
  return Math.abs(w * 10000 - score) <= Math.abs(w * 100 - score) ? 1 : 100;
}

/** The four weighted components, normalised 0..1 (null when the payload has nothing usable). */
export function landingComponents(d: LandingDetails, units: UnitsSettings, score?: number): LandingComponent[] {
  const cN = num(d, KEYS.center), sN = num(d, KEYS.smooth), zN = num(d, KEYS.zone), tN = num(d, KEYS.stop);
  const scale = componentScale([cN, sN, zN, tN], score);
  const norm = (v: number | null) => (v === null || v < 0 ? null : clamp01(v / scale));

  const offM = num(d, KEYS.offsetM);
  const halfWidthM = num(d, KEYS.halfWidthM) ?? ((num(d, KEYS.widthM) ?? 45) / 2);
  const vsMs = num(d, KEYS.vsMs);
  const vsFpm = num(d, KEYS.vsFpm) ?? (vsMs !== null ? vsMs * FPM_PER_MS : null);
  const alongM = num(d, KEYS.alongM);
  const aimM = num(d, KEYS.aimM) ?? 305; // 1000 ft markers
  const stopDistM = num(d, KEYS.stopDistM);
  const touchAndGo = KEYS.stopDistM.some((k) => typeof d[k] === 'string' && /touch/i.test(String(d[k])));
  const lengthM = num(d, KEYS.lengthM);

  const center = norm(cN) ?? (offM !== null ? 1 - clamp01(Math.abs(offM) / Math.max(1, halfWidthM)) : null);
  const smooth = norm(sN) ?? (vsFpm !== null ? 1 - clamp01((Math.abs(vsFpm) - 60) / 540) : null);
  const zone = norm(zN) ?? (alongM !== null ? 1 - clamp01(Math.abs(alongM - aimM) / 300) : null);
  const stop = norm(tN) ?? (touchAndGo ? 0 : stopDistM !== null && lengthM !== null && alongM !== null ? 1 - clamp01(stopDistM / Math.max(1, lengthM - alongM)) : null);

  return [
    { key: 'center', label: 'Centreline', weight: LANDING_WEIGHTS.center, frac: center, raw: offM !== null ? `${offM >= 0 ? 'R' : 'L'} ${formatAltitude(Math.abs(offM), units)}` : '' },
    { key: 'smooth', label: 'Touchdown rate', weight: LANDING_WEIGHTS.smooth, frac: smooth, raw: vsFpm !== null ? formatVerticalSpeed(-Math.abs(vsFpm) / FPM_PER_MS, units) : '' },
    { key: 'zone', label: 'Aim point', weight: LANDING_WEIGHTS.zone, frac: zone, raw: alongM !== null ? `${formatAltitude(alongM, units)} past threshold` : '' },
    { key: 'stop', label: 'Stopping distance', weight: LANDING_WEIGHTS.stop, frac: stop, raw: touchAndGo ? 'touch-and-go' : stopDistM !== null ? formatAltitude(stopDistM, units) : '' },
  ];
}

export function scoreBand(score: number): string {
  if (score >= 9000) return 'Butter';
  if (score >= 7500) return 'Great landing';
  if (score >= 5000) return 'Good landing';
  if (score >= 2500) return 'Firm';
  if (score > 0) return 'Hard landing';
  return 'Crash';
}

const GRADE_TEXT: Record<string, string> = { Butter: 'Butter', Great: 'Great landing', Good: 'Good landing', Firm: 'Firm landing', Hard: 'Hard landing', Crash: 'Crash' };

/** The scorer's own grade ('Great' → 'Great landing') when it sends one, else the score band. */
export function landingBand(d: LandingDetails, score: number): string {
  const g = d.grade;
  if (typeof g === 'string' && g.trim()) return GRADE_TEXT[g] ?? g;
  return scoreBand(score);
}

/** 'peakG' → 'Peak g' style fallback label for keys the report does not know. */
function humanizeKey(k: string): string {
  const s = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Extra lines below the components: known measurements with labels and units, then anything else. */
export function landingExtras(d: LandingDetails): LandingExtra[] {
  const out: LandingExtra[] = [];
  const g = num(d, ['peakG']);
  if (g !== null) out.push({ label: 'Peak load', value: `${g.toFixed(2)} g` });
  const crab = num(d, ['crabDeg']);
  if (crab !== null) out.push({ label: 'Crab at touchdown', value: `${Math.abs(crab).toFixed(1)}°` });
  const bounces = num(d, ['bounces']);
  if (bounces !== null) out.push({ label: 'Bounces', value: String(Math.round(bounces)) });
  for (const [k, v] of Object.entries(d)) {
    if (CONSUMED.has(k) || k === 'peakG' || k === 'crabDeg' || k === 'bounces') continue;
    out.push({ label: humanizeKey(k), value: typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v });
  }
  return out;
}

/** 'KSFO 28R' (or the airport) for the report title. */
export function landingRunway(d: LandingDetails): string {
  return typeof d.runway === 'string' ? d.runway : typeof d.airport === 'string' ? d.airport : '';
}
