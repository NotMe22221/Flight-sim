/**
 * Pilot logbook: one entry per flight, like MSFS's logbook. `LogbookRecorder` is fed once per frame
 * and closes an entry when the flight ends (a new flight starts, the page closes, a crash). Entries with
 * under 30 s in the air are not logged (taxi tests, an aborted spawn). `Logbook` keeps the newest
 * `MAX_ENTRIES` in a key/value store (localStorage in the app).
 */

export interface LogEntry {
  /** UTC ms (world clock) the flight started */
  startUtcMs: number;
  aircraftId: string;
  aircraftName: string;
  /** ICAO of the airport the flight left, or null (an air start, an off-airport take-off) */
  from: string | null;
  /** ICAO where it last landed and stopped, or null (did not land at an airport) */
  to: string | null;
  airTimeS: number;
  /** air time with the sun more than 6° below the horizon (civil twilight's end) */
  nightS: number;
  landings: number;
  distanceNm: number;
  maxAltFt: number;
  crashed: boolean;
}

export interface LogFrame {
  dtS: number;
  utcMs: number;
  onGround: boolean;
  lat: number;
  lon: number;
  altMslM: number;
  groundSpeedMs: number;
  sunElevationRad: number;
  crashed: boolean;
  /** nearest airport within a few km, or null */
  nearestIcao: string | null;
}

const NIGHT_SUN_RAD = (-6 * Math.PI) / 180;
const MIN_AIR_S = 30;
/** airborne this long before a touchdown counts as a landing (not a bounce on the take-off roll) */
const MIN_AIR_FOR_LANDING_S = 15;
const M_PER_NM = 1852;

export class LogbookRecorder {
  private entry: LogEntry | null = null;
  private airSinceS = 0;
  private wasOnGround = true;
  private lastLat = NaN;
  private lastLon = NaN;

  /** A flight starts (spawn). Returns the previous flight's entry when it is worth logging. */
  begin(f: { utcMs: number; aircraftId: string; aircraftName: string; onGround: boolean; nearestIcao: string | null }): LogEntry | null {
    const done = this.end();
    this.entry = {
      startUtcMs: f.utcMs, aircraftId: f.aircraftId, aircraftName: f.aircraftName,
      from: f.onGround ? f.nearestIcao : null, to: null, airTimeS: 0, nightS: 0, landings: 0, distanceNm: 0, maxAltFt: 0, crashed: false,
    };
    this.wasOnGround = f.onGround;
    this.airSinceS = 0;
    this.lastLat = NaN; this.lastLon = NaN;
    return done;
  }

  get current(): Readonly<LogEntry> | null { return this.entry; }

  update(f: LogFrame): void {
    const e = this.entry;
    if (!e || !(f.dtS > 0) || e.crashed) return;
    if (Number.isFinite(this.lastLat)) {
      const d = haversineM(this.lastLat, this.lastLon, f.lat, f.lon);
      if (d < 5000) e.distanceNm += d / M_PER_NM; // a teleport (slew, rebase glitch) is not distance flown
    }
    this.lastLat = f.lat; this.lastLon = f.lon;
    if (!f.onGround) {
      e.airTimeS += f.dtS;
      this.airSinceS += f.dtS;
      if (f.sunElevationRad < NIGHT_SUN_RAD) e.nightS += f.dtS;
      e.maxAltFt = Math.max(e.maxAltFt, f.altMslM / 0.3048);
      // left the ground at an airport with no departure yet (an air start never sets one)
      if (this.wasOnGround && e.from === null && e.airTimeS < 60 && f.nearestIcao && e.landings === 0 && this.airSinceS <= f.dtS) e.from = f.nearestIcao;
    } else {
      if (!this.wasOnGround && this.airSinceS >= MIN_AIR_FOR_LANDING_S) e.landings++;
      this.airSinceS = 0;
      // where it rolled to a stop after a landing is the arrival
      if (e.landings > 0 && f.groundSpeedMs < 3 && f.nearestIcao) e.to = f.nearestIcao;
    }
    this.wasOnGround = f.onGround;
    if (f.crashed) e.crashed = true;
  }

  /** The flight ends: its entry when worth logging (and the recorder is idle until `begin`). */
  end(): LogEntry | null {
    const e = this.entry;
    this.entry = null;
    if (!e || e.airTimeS < MIN_AIR_S) return null;
    return { ...e, distanceNm: Math.round(e.distanceNm * 10) / 10, maxAltFt: Math.round(e.maxAltFt) };
  }
}

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const LOGBOOK_KEY = 'flightsim.logbook.v1';
export const MAX_ENTRIES = 500;

export class Logbook {
  constructor(private readonly store: KeyValueStore | null) {}

  entries(): LogEntry[] {
    try {
      const raw = this.store?.getItem(LOGBOOK_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list.filter((e) => e && typeof e === 'object' && typeof (e as LogEntry).airTimeS === 'number') as LogEntry[]) : [];
    } catch { return []; }
  }

  /** Newest first. */
  add(e: LogEntry): void {
    const list = [e, ...this.entries()].slice(0, MAX_ENTRIES);
    try { this.store?.setItem(LOGBOOK_KEY, JSON.stringify(list)); } catch { /* storage full or blocked: not logged */ }
  }

  clear(): void { try { this.store?.setItem(LOGBOOK_KEY, '[]'); } catch { /* ignore */ } }

  totals(): { flights: number; airTimeS: number; nightS: number; landings: number; distanceNm: number } {
    const t = { flights: 0, airTimeS: 0, nightS: 0, landings: 0, distanceNm: 0 };
    for (const e of this.entries()) { t.flights++; t.airTimeS += e.airTimeS; t.nightS += e.nightS; t.landings += e.landings; t.distanceNm += e.distanceNm; }
    return t;
  }
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
