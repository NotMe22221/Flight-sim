/**
 * Landing scoring (docs/research/01 §10.1): weights centreline 30 %, touchdown smoothness 35 %,
 * aim point 15 %, stopping distance 20 %, on a 0–10 000 scale like MSFS landing challenges.
 */
import { clamp } from '../core/math';
import { MS_TO_FPM } from '../core/units';

export interface TouchdownRecord {
  /** m/s, negative = descending */
  verticalSpeedMs: number;
  /** peak normal load factor in the 0.5 s after touchdown, g */
  peakG: number;
  /** m, signed, + right of centreline */
  lateralOffsetM: number;
  /** m from the threshold */
  alongTrackM: number;
  /** m/s sideways drift across the runway heading at touchdown */
  lateralDriftMs: number;
  /** degrees between the nose and the runway heading */
  crabDeg: number;
  /** touchdown happened off the pavement */
  offRunway: boolean;
  bounces: number;
}

export interface RolloutRecord {
  /** distance from touchdown to stop, m (or to the runway end if the aircraft did not stop) */
  stopDistanceM: number;
  stopped: boolean;
}

export interface RunwayInfo { widthM: number; lengthM: number; aimPointM: number }

export interface LandingScore {
  score: number;
  centre: number;
  smooth: number;
  zone: number;
  stop: number;
  grade: 'Butter' | 'Great' | 'Good' | 'Firm' | 'Hard' | 'Crash';
  crashed: boolean;
}

export function scoreLanding(td: TouchdownRecord, rollout: RolloutRecord, rwy: RunwayInfo): LandingScore {
  const vsFpm = td.verticalSpeedMs * MS_TO_FPM; // negative descending
  const centre = 1 - clamp(Math.abs(td.lateralOffsetM) / (rwy.widthM / 2), 0, 1);
  const smooth = 1 - clamp((Math.abs(vsFpm) - 60) / 540, 0, 1);
  const zone = 1 - clamp(Math.abs(td.alongTrackM - rwy.aimPointM) / 300, 0, 1);
  const remaining = Math.max(rwy.lengthM - td.alongTrackM, 1);
  const stop = rollout.stopped ? 1 - clamp(rollout.stopDistanceM / remaining, 0, 1) : 0;
  const crashed = vsFpm < -1200 || td.offRunway || td.peakG > 3.8;
  const raw = 0.3 * centre + 0.35 * smooth + 0.15 * zone + 0.2 * stop;
  const score = crashed ? 0 : Math.round(10000 * raw);
  const a = Math.abs(vsFpm);
  const grade: LandingScore['grade'] = crashed ? 'Crash' : a < 60 ? 'Butter' : a < 150 ? 'Great' : a < 300 ? 'Good' : a < 600 ? 'Firm' : 'Hard';
  return { score, centre, smooth, zone, stop, grade, crashed };
}
