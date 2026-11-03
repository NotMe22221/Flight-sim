/**
 * Activities → Landing challenges, view side. The challenge table itself is pure data in
 * src/activities/landingChallenges.ts (types-only dependency on core); this adapter is the one
 * place the UI reads it. Best scores live in localStorage (guarded for Node/private mode).
 */
import { LANDING_CHALLENGES, type LandingChallenge } from '../activities/landingChallenges';
import { formatWind } from './format';
import { loadJson, saveJson } from './settingsStore';
import { weatherPresetLabel } from './weatherPresets';

export type { LandingChallenge };
export type ChallengeCategory = LandingChallenge['category'];
export type CategoryFilter = 'All' | ChallengeCategory;

export const CHALLENGE_FILTERS: CategoryFilter[] = ['All', 'Famous', 'Epic', 'Strong Wind'];
export const BEST_SCORES_KEY = 'flightsim.activities.best.v1';

/** The bundled challenges (read-only). */
export function landingChallenges(): readonly LandingChallenge[] { return LANDING_CHALLENGES; }

export function challengesIn(list: readonly LandingChallenge[], filter: CategoryFilter): LandingChallenge[] {
  return filter === 'All' ? list.slice() : list.filter((c) => c.category === filter);
}

/** Count per filter for the tab labels. */
export function categoryCounts(list: readonly LandingChallenge[]): Record<CategoryFilter, number> {
  const out: Record<CategoryFilter, number> = { All: list.length, Famous: 0, Epic: 0, 'Strong Wind': 0 };
  for (const c of list) out[c.category]++;
  return out;
}

/** '17:30' from a local solar hour. */
export function formatLocalHour(hour: number): string {
  if (!Number.isFinite(hour)) return '--:--';
  const total = Math.round((((hour % 24) + 24) % 24) * 60);
  const h = Math.floor(total / 60) % 24, m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export interface ChallengeConditions { weather: string; wind: string; time: string; approach: string; airport: string }

/**
 * Time fields are read defensively: the simulator uses a sun-relative `time` ('dusk', …) and a
 * nominal `localHour` is kept for display; either may be absent in other builds of the table.
 */
type TimeFields = { time?: string; localHour?: number };

/** 'Dusk · ~17:30 local', 'Noon', or '09:00 local'. */
export function challengeTimeLabel(c: TimeFields): string {
  const named = typeof c.time === 'string' && c.time ? c.time.charAt(0).toUpperCase() + c.time.slice(1) : '';
  const hour = typeof c.localHour === 'number' && Number.isFinite(c.localHour) ? formatLocalHour(c.localHour) : '';
  if (named && hour) return `${named} · ~${hour} local`;
  if (named) return named;
  return hour ? `${hour} local` : '—';
}

/** Human-readable briefing lines for the detail card. */
export function challengeConditions(c: LandingChallenge): ChallengeConditions {
  return {
    airport: `${c.icao} · runway ${c.runway}`,
    weather: weatherPresetLabel(c.weather),
    wind: c.wind ? `${formatWind(c.wind.fromDeg, c.wind.speedKt, c.wind.gustKt)} kt` : 'Preset winds',
    time: challengeTimeLabel(c as LandingChallenge & TimeFields),
    approach: `${c.startNm} nm final · ${c.glideDeg.toFixed(1)}° path · ${c.speedKt} kt`,
  };
}

// ─── best scores ──────────────────────────────────────────────────────────────

export interface BestScore { score: number; atMs: number }
export type BestScores = Record<string, BestScore>;

/** Keeps only well-formed entries (a hand-edited blob can never break the screen). */
export function parseBestScores(raw: unknown): BestScores {
  const out: BestScores = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const s = (v as { score?: unknown }).score, t = (v as { atMs?: unknown }).atMs;
    if (typeof s === 'number' && Number.isFinite(s) && s >= 0) out[id] = { score: Math.round(s), atMs: typeof t === 'number' && Number.isFinite(t) ? t : 0 };
  }
  return out;
}

export interface RecordResult { scores: BestScores; isNewBest: boolean; previous: number | null }

/** Returns a new table with `score` recorded if it beats the previous best. */
export function recordBestScore(scores: BestScores, id: string, score: number, atMs: number): RecordResult {
  const prev = scores[id]?.score ?? null;
  if (!Number.isFinite(score) || score < 0) return { scores, isNewBest: false, previous: prev };
  const s = Math.round(score);
  if (prev !== null && s <= prev) return { scores, isNewBest: false, previous: prev };
  return { scores: { ...scores, [id]: { score: s, atMs } }, isNewBest: true, previous: prev };
}

export function loadBestScores(): BestScores { return parseBestScores(loadJson<unknown>(BEST_SCORES_KEY, {})); }
export function saveBestScores(s: BestScores): void { saveJson(BEST_SCORES_KEY, s); }

// ─── challenge session ────────────────────────────────────────────────────────

/** Identity of a spawn (≈1 m) so "Restart" of the same challenge keeps its session. */
export function spawnKey(s: { geo: { lat: number; lon: number; alt: number } }): string {
  return `${s.geo.lat.toFixed(5)},${s.geo.lon.toFixed(5)},${Math.round(s.geo.alt)}`;
}

/**
 * Which challenge (if any) the current flight belongs to. `begin` before host.startChallenge
 * (its 'flight:reset' fires before the promise resolves); a later reset at a different spawn
 * (a free flight, automation) ends the session, a respawn at the same spot keeps it.
 */
export class ChallengeSession {
  private id: string | null = null;
  private key: string | null = null;
  private awaitingSpawn = false;

  get activeId(): string | null { return this.id; }

  begin(id: string): void { this.id = id; this.key = null; this.awaitingSpawn = true; }

  end(): void { this.id = null; this.key = null; this.awaitingSpawn = false; }

  onFlightReset(spawn: { geo: { lat: number; lon: number; alt: number } }): void {
    if (!this.id) return;
    const k = spawnKey(spawn);
    if (this.awaitingSpawn) { this.key = k; this.awaitingSpawn = false; return; }
    if (k !== this.key) this.end();
  }
}
