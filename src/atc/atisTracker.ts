/**
 * ATIS code-letter bookkeeping: a deterministic starting letter per airport, advanced every
 * hour (new routine observation) and whenever the broadcast content changes (new runway,
 * wind, altimeter, sky…), with a minimum spacing so a value hovering on a rounding boundary
 * cannot cycle letters.
 */
import { fnv1a } from '../nav';
import type { SurfaceObservation } from './surfaceObs';

/** Minimum time between two content-triggered letter changes, s. */
export const ATIS_MIN_CHANGE_INTERVAL_S = 60;
const HOUR_MS = 3_600_000;

/** Content key of a broadcast: changes exactly when something read on the ATIS changes. */
export function atisContentKey(obs: SurfaceObservation, runways: readonly string[]): string {
  const sky = obs.layers.map((l) => `${l.cover}${l.baseFtAgl}`).join(',');
  return `${obs.windDirTrueDeg}/${obs.windSpeedKt}/${obs.windGustKt}|${obs.visibilitySM}|${obs.weather}|${sky}|` +
    `${obs.temperatureC}/${obs.dewpointC}|${obs.altimeterInHg}|${runways.join(',')}`;
}

/** Tracks the current ATIS letter of one airport. */
export class AtisLetterTracker {
  private index: number;
  private hour: number;
  private key = '';
  private lastChangeUtcMs: number;
  /** UTC ms at which the current letter was issued (the broadcast's observation time). */
  issuedUtcMs: number;

  /** @param airportId seeds the starting letter (e.g. the ICAO code); @param utcMs current UTC epoch ms */
  constructor(airportId: string, utcMs: number) {
    this.hour = Math.floor(utcMs / HOUR_MS);
    this.index = (fnv1a(airportId) + this.hour) % 26;
    this.issuedUtcMs = utcMs;
    this.lastChangeUtcMs = -Infinity;
  }

  /** Current code letter 'A'..'Z'. */
  get letter(): string {
    return String.fromCharCode(65 + this.index);
  }

  /**
   * Re-evaluate at `utcMs` with the current content key. Returns true when a new letter was
   * issued (hour boundary crossed, or content changed and the last change is old enough).
   * One letter per hourly broadcast missed, so a long gap between evaluations (or a clock jump
   * forward) lands on the same letter as hourly evaluation would; a clock set back issues one.
   * The first call only records the key.
   */
  update(utcMs: number, contentKey: string): boolean {
    const hour = Math.floor(utcMs / HOUR_MS);
    let steps = 0;
    if (hour !== this.hour) { steps = hour > this.hour ? hour - this.hour : 1; this.hour = hour; }
    if (this.key === '') this.key = contentKey;
    else if (contentKey !== this.key && (utcMs - this.lastChangeUtcMs) / 1000 >= ATIS_MIN_CHANGE_INTERVAL_S) {
      this.key = contentKey;
      steps = Math.max(steps, 1);
    }
    if (steps === 0) return false;
    this.key = contentKey;
    this.index = (this.index + steps) % 26;
    this.issuedUtcMs = utcMs;
    this.lastChangeUtcMs = utcMs;
    return true;
  }
}
