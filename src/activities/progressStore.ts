/**
 * Persistent activity progress: bush-trip legs (unlocked in order, resumable) and lesson best
 * scores. Stored as one versioned JSON document in an injectable key/value storage
 * (localStorage by default when the browser allows it). Every storage access is wrapped in
 * try/catch: a blocked, full or corrupt storage degrades to in-memory progress, never a throw.
 */
import type { ActivityDef, ActivityResult } from './activityTypes';

/** The subset of the Web Storage API the store uses. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface LegRecord {
  completed: boolean;
  /** best score 0..100 */
  bestScore: number;
  attempts: number;
  /** fuel on board when the leg was completed, kg (bush trips carry fuel between legs) */
  fuelKg: number | null;
  /** best landing score 0..10 000 at the destination */
  bestLandingScore: number | null;
}

export interface LessonRecord {
  completed: boolean;
  bestScore: number;
  attempts: number;
}

interface ProgressDoc {
  version: 1;
  trips: Record<string, { legs: Record<string, LegRecord> }>;
  lessons: Record<string, LessonRecord>;
}

export const PROGRESS_KEY = 'flightsim.activities.progress.v1';

const emptyDoc = (): ProgressDoc => ({ version: 1, trips: {}, lessons: {} });

const num = (x: unknown, lo: number, hi: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : null;
const count = (x: unknown): number => { const n = num(x, 0, 1e6); return n === null ? 0 : Math.floor(n); };

function sanitizeLeg(x: unknown): LegRecord | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  return {
    completed: r.completed === true,
    bestScore: num(r.bestScore, 0, 100) ?? 0,
    attempts: count(r.attempts),
    fuelKg: num(r.fuelKg, 0, 1e5),
    bestLandingScore: num(r.bestLandingScore, 0, 10000),
  };
}

function sanitizeLesson(x: unknown): LessonRecord | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  return { completed: r.completed === true, bestScore: num(r.bestScore, 0, 100) ?? 0, attempts: count(r.attempts) };
}

/** Parse and validate a stored document; anything malformed is dropped record by record. */
export function parseProgress(json: string | null): { doc: ProgressDoc; corrupt: boolean } {
  if (json === null || json === '') return { doc: emptyDoc(), corrupt: false };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { doc: emptyDoc(), corrupt: true }; }
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return { doc: emptyDoc(), corrupt: true };
  const r = raw as { trips?: unknown; lessons?: unknown };
  const doc = emptyDoc();
  let corrupt = false;
  if (r.trips && typeof r.trips === 'object') {
    for (const [tripId, t] of Object.entries(r.trips as Record<string, unknown>)) {
      const legs = t && typeof t === 'object' ? (t as { legs?: unknown }).legs : null;
      if (!legs || typeof legs !== 'object') { corrupt = true; continue; }
      const out: Record<string, LegRecord> = {};
      for (const [k, v] of Object.entries(legs as Record<string, unknown>)) {
        const leg = /^\d+$/.test(k) ? sanitizeLeg(v) : null;
        if (leg) out[k] = leg; else corrupt = true;
      }
      doc.trips[tripId] = { legs: out };
    }
  } else if (r.trips !== undefined) corrupt = true;
  if (r.lessons && typeof r.lessons === 'object') {
    for (const [id, v] of Object.entries(r.lessons as Record<string, unknown>)) {
      const l = sanitizeLesson(v);
      if (l) doc.lessons[id] = l; else corrupt = true;
    }
  } else if (r.lessons !== undefined) corrupt = true;
  return { doc, corrupt };
}

/** localStorage when it exists and is usable (it throws in some privacy modes), else null. */
export function defaultStorage(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!ls) return null;
    const probe = '__flightsim_probe__';
    ls.setItem(probe, '1');
    ls.removeItem?.(probe);
    return ls;
  } catch {
    return null;
  }
}

export class ProgressStore {
  private doc: ProgressDoc;
  /** the stored document was unreadable or partly invalid when loaded */
  readonly loadedCorrupt: boolean;
  /** the last write failed (quota, blocked storage); progress lives in memory until the next good write */
  lastWriteFailed = false;
  private readonly storage: KeyValueStorage | null;
  /** false when the stored document could not be read: writing would replace saved progress with this empty one */
  private readonly writable: boolean;

  constructor(storage: KeyValueStorage | null | undefined = undefined, private readonly key = PROGRESS_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let json: string | null = null;
    let readFailed = false;
    try { json = this.storage ? this.storage.getItem(key) : null; } catch { readFailed = true; }
    const { doc, corrupt } = parseProgress(json);
    this.doc = doc;
    this.loadedCorrupt = corrupt || readFailed;
    this.writable = !readFailed;
  }

  // ─────────────── bush trips ───────────────

  leg(tripId: string, legIndex: number): LegRecord | null {
    return this.doc.trips[tripId]?.legs[String(legIndex)] ?? null;
  }

  isLegCompleted(tripId: string, legIndex: number): boolean { return this.leg(tripId, legIndex)?.completed === true; }

  /** Legs unlock in order: the first is always open, each next one once its predecessor is complete. */
  isLegUnlocked(tripId: string, legIndex: number): boolean {
    return legIndex === 0 || this.isLegCompleted(tripId, legIndex - 1);
  }

  /** The leg to resume: the first one not completed (legCount when the whole trip is done). */
  nextLeg(tripId: string, legCount: number): number {
    for (let i = 0; i < legCount; i++) if (!this.isLegCompleted(tripId, i)) return i;
    return legCount;
  }

  completedLegs(tripId: string): number {
    const legs = this.doc.trips[tripId]?.legs;
    return legs ? Object.values(legs).filter((l) => l.completed).length : 0;
  }

  /** Count an attempt (a leg was started). */
  recordLegAttempt(tripId: string, legIndex: number): void {
    const r = this.ensureLeg(tripId, legIndex);
    r.attempts++;
    this.save();
  }

  completeLeg(tripId: string, legIndex: number, result: { score: number; fuelKg?: number | null; landingScore?: number | null }): void {
    const r = this.ensureLeg(tripId, legIndex);
    r.completed = true;
    r.bestScore = Math.max(r.bestScore, num(result.score, 0, 100) ?? 0);
    const f = num(result.fuelKg, 0, 1e5);
    if (f !== null) r.fuelKg = f;
    const l = num(result.landingScore, 0, 10000);
    if (l !== null) r.bestLandingScore = Math.max(r.bestLandingScore ?? 0, l);
    this.save();
  }

  resetTrip(tripId: string): void {
    delete this.doc.trips[tripId];
    this.save();
  }

  // ─────────────── lessons ───────────────

  lesson(id: string): LessonRecord | null { return this.doc.lessons[id] ?? null; }

  recordLessonAttempt(id: string): void {
    const r = this.ensureLesson(id);
    r.attempts++;
    this.save();
  }

  completeLesson(id: string, score: number): void {
    const r = this.ensureLesson(id);
    r.completed = true;
    r.bestScore = Math.max(r.bestScore, num(score, 0, 100) ?? 0);
    this.save();
  }

  /** Record a finished activity (what ActivityRunner calls). Failed attempts only count as attempts. */
  recordResult(def: ActivityDef, result: ActivityResult): void {
    if (!result.success) return;
    if (def.trip) this.completeLeg(def.trip.tripId, def.trip.legIndex, { score: result.score, fuelKg: result.fuelKg, landingScore: result.landingScore });
    else this.completeLesson(def.id, result.score);
  }

  /** Record that an activity started. */
  recordStart(def: ActivityDef): void {
    if (def.trip) this.recordLegAttempt(def.trip.tripId, def.trip.legIndex);
    else this.recordLessonAttempt(def.id);
  }

  clearAll(): void {
    this.doc = emptyDoc();
    try { this.storage?.removeItem?.(this.key); } catch { /* ignore */ }
    this.save();
  }

  /** The stored JSON (for debugging / export). */
  toJSON(): string { return JSON.stringify(this.doc); }

  private ensureLeg(tripId: string, legIndex: number): LegRecord {
    const trip = (this.doc.trips[tripId] ??= { legs: {} });
    return (trip.legs[String(legIndex)] ??= { completed: false, bestScore: 0, attempts: 0, fuelKg: null, bestLandingScore: null });
  }

  private ensureLesson(id: string): LessonRecord {
    return (this.doc.lessons[id] ??= { completed: false, bestScore: 0, attempts: 0 });
  }

  private save(): void {
    if (!this.storage) return;
    // unreadable storage: keep progress in memory rather than overwrite what is saved there
    if (!this.writable) { this.lastWriteFailed = true; return; }
    try {
      this.storage.setItem(this.key, JSON.stringify(this.doc));
      this.lastWriteFailed = false;
    } catch {
      this.lastWriteFailed = true;
    }
  }
}
