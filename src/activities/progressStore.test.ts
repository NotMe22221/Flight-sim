import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityDef, ActivityResult } from './activityTypes';
import { defaultStorage, parseProgress, PROGRESS_KEY, ProgressStore, type KeyValueStorage } from './progressStore';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.writes++; this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

class ThrowingStorage implements KeyValueStorage {
  getItem(): string | null { throw new Error('SecurityError'); }
  setItem(): void { throw new Error('QuotaExceededError'); }
}

const result = (over: Partial<ActivityResult>): ActivityResult => ({
  id: 'x', kind: 'lesson', title: 'X', success: true, score: 80, grade: 'Good', summary: '', reason: null, durationS: 100, steps: [], fuelKg: 120, landingScore: null, ...over,
});
const def = (over: Partial<ActivityDef>): ActivityDef => ({
  id: 'lesson-x', kind: 'lesson', title: 'X', description: '', setup: { spawn: 'runway', icao: 'KSFO', runway: '28R' }, steps: [], ...over,
});

describe('ProgressStore: bush-trip legs', () => {
  it('unlocks legs in order and resumes at the first incomplete leg', () => {
    const mem = new MemoryStorage();
    const p = new ProgressStore(mem);
    expect(p.isLegUnlocked('trip', 0)).toBe(true);
    expect(p.isLegUnlocked('trip', 1)).toBe(false);
    expect(p.nextLeg('trip', 8)).toBe(0);
    p.recordLegAttempt('trip', 0);
    p.completeLeg('trip', 0, { score: 72, fuelKg: 101.5, landingScore: 6400 });
    expect(p.isLegUnlocked('trip', 1)).toBe(true);
    expect(p.isLegUnlocked('trip', 2)).toBe(false);
    expect(p.nextLeg('trip', 8)).toBe(1);
    expect(p.leg('trip', 0)).toEqual({ completed: true, bestScore: 72, attempts: 1, fuelKg: 101.5, bestLandingScore: 6400 });
    // a fresh store over the same storage resumes
    const again = new ProgressStore(mem);
    expect(again.nextLeg('trip', 8)).toBe(1);
    expect(again.completedLegs('trip')).toBe(1);
    expect(again.loadedCorrupt).toBe(false);
  });
  it('keeps the best score and clamps out-of-range values', () => {
    const p = new ProgressStore(new MemoryStorage());
    p.completeLeg('trip', 0, { score: 90 });
    p.completeLeg('trip', 0, { score: 60, landingScore: 50_000 });
    expect(p.leg('trip', 0)?.bestScore).toBe(90);
    expect(p.leg('trip', 0)?.bestLandingScore).toBe(10000);
    p.completeLeg('trip', 1, { score: 400 });
    expect(p.leg('trip', 1)?.bestScore).toBe(100);
  });
  it('the whole trip done → nextLeg returns the leg count; reset starts over', () => {
    const p = new ProgressStore(new MemoryStorage());
    for (let i = 0; i < 3; i++) p.completeLeg('t', i, { score: 50 });
    expect(p.nextLeg('t', 3)).toBe(3);
    p.resetTrip('t');
    expect(p.nextLeg('t', 3)).toBe(0);
  });
});

describe('ProgressStore: lessons and results', () => {
  it('records attempts and only successful results', () => {
    const mem = new MemoryStorage();
    const p = new ProgressStore(mem);
    const lesson = def({ id: 'lesson-takeoff' });
    p.recordStart(lesson);
    p.recordResult(lesson, result({ success: false, score: 30 }));
    expect(p.lesson('lesson-takeoff')).toEqual({ completed: false, bestScore: 0, attempts: 1 });
    p.recordStart(lesson);
    p.recordResult(lesson, result({ score: 88 }));
    expect(p.lesson('lesson-takeoff')).toEqual({ completed: true, bestScore: 88, attempts: 2 });
    const leg = def({ id: 'trip-leg2', kind: 'bushTrip', trip: { tripId: 'trip', legIndex: 1 } });
    p.recordStart(leg);
    p.recordResult(leg, result({ score: 77, fuelKg: 90, landingScore: 7100 }));
    expect(p.leg('trip', 1)).toMatchObject({ completed: true, bestScore: 77, attempts: 1, fuelKg: 90, bestLandingScore: 7100 });
    expect(JSON.parse(mem.getItem(PROGRESS_KEY)!).version).toBe(1);
  });
});

describe('ProgressStore: robustness', () => {
  it('corrupt JSON loads as empty progress without throwing, and the next write repairs it', () => {
    const mem = new MemoryStorage();
    mem.setItem(PROGRESS_KEY, '{"version":1,"trips":{"t":{"legs":{"0":{"completed":tr');
    const p = new ProgressStore(mem);
    expect(p.loadedCorrupt).toBe(true);
    expect(p.nextLeg('t', 4)).toBe(0);
    p.completeLeg('t', 0, { score: 10 });
    expect(new ProgressStore(mem).isLegCompleted('t', 0)).toBe(true);
  });
  it('wrong version or wrong shapes are rejected record by record', () => {
    expect(parseProgress('{"version":2,"trips":{}}').corrupt).toBe(true);
    expect(parseProgress('[1,2,3]').corrupt).toBe(true);
    expect(parseProgress('null').corrupt).toBe(true);
    expect(parseProgress(null)).toEqual({ doc: { version: 1, trips: {}, lessons: {} }, corrupt: false });
    const mixed = parseProgress(JSON.stringify({
      version: 1,
      trips: { good: { legs: { 0: { completed: true, bestScore: 55, attempts: 2 }, x: { completed: true }, 1: 'nope' } }, bad: 7 },
      lessons: { a: { completed: true, bestScore: 'high', attempts: -3 }, b: null },
    }));
    expect(mixed.corrupt).toBe(true);
    expect(mixed.doc.trips.good.legs['0']).toEqual({ completed: true, bestScore: 55, attempts: 2, fuelKg: null, bestLandingScore: null });
    expect(Object.keys(mixed.doc.trips.good.legs)).toEqual(['0']);
    expect(mixed.doc.trips.bad).toBeUndefined();
    expect(mixed.doc.lessons.a).toEqual({ completed: true, bestScore: 0, attempts: 0 });
    expect(mixed.doc.lessons.b).toBeUndefined();
  });
  it('a storage that throws on every access degrades to in-memory progress', () => {
    const p = new ProgressStore(new ThrowingStorage());
    expect(p.loadedCorrupt).toBe(true);
    p.completeLeg('t', 0, { score: 50 });
    expect(p.lastWriteFailed).toBe(true);
    expect(p.isLegCompleted('t', 0)).toBe(true);
    expect(() => p.clearAll()).not.toThrow();
  });
  it('null storage works purely in memory', () => {
    const p = new ProgressStore(null);
    p.completeLesson('l', 70);
    expect(p.lesson('l')?.bestScore).toBe(70);
  });
});

describe('defaultStorage', () => {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  afterEach(() => { if (saved === undefined) delete g.localStorage; else g.localStorage = saved; });
  it('is null without localStorage and when it throws (privacy modes)', () => {
    delete g.localStorage;
    expect(defaultStorage()).toBeNull();
    g.localStorage = { getItem: () => null, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(defaultStorage()).toBeNull();
    const mem = new MemoryStorage();
    g.localStorage = mem;
    expect(defaultStorage()).toBe(mem);
    expect(new ProgressStore().nextLeg('t', 2)).toBe(0);
    expect(mem.map.has('__flightsim_probe__')).toBe(false);
  });
});

// ───────────────────────────── review findings (each failed before its fix) ─────────────────────────────

describe('review: a storage that cannot be read', () => {
  it('is never overwritten with the empty in-memory document (the saved progress survives)', () => {
    const saved = JSON.stringify({ version: 1, trips: { t: { legs: { 0: { completed: true, bestScore: 80, attempts: 1 } } } }, lessons: {} });
    const mem = new MemoryStorage();
    mem.setItem(PROGRESS_KEY, saved);
    mem.writes = 0;
    let failReads = true;
    const flaky: KeyValueStorage = {
      getItem: (k) => { if (failReads) throw new Error('NS_ERROR_FILE_CORRUPTED'); return mem.getItem(k); },
      setItem: (k, v) => mem.setItem(k, v),
      removeItem: (k) => mem.removeItem(k),
    };
    const p = new ProgressStore(flaky);
    expect(p.loadedCorrupt).toBe(true);
    p.recordStart(def({ id: 'lesson-takeoff' }));
    p.completeLesson('lesson-takeoff', 70);
    expect(p.lesson('lesson-takeoff')?.bestScore).toBe(70); // kept in memory
    expect(p.lastWriteFailed).toBe(true);
    expect(mem.writes).toBe(0);
    failReads = false;
    expect(new ProgressStore(flaky).isLegCompleted('t', 0)).toBe(true);
  });
});
