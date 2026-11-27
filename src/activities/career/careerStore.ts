/**
 * Career progress (MSFS 2024-style career, simplified): money, reputation, licences, where the pilot is,
 * the jobs flown and the one in progress. Plain data, persisted in localStorage (`flightsim.career.v1`)
 * like ProgressStore: an injectable storage, a versioned document, sanitised on load, and nothing written
 * back over a document that could not be read.
 */
import type { KeyValueStorage } from '../progressStore';
import type { CareerJob } from './missions';

export const CAREER_KEY = 'flightsim.career.v1';
export type Licence = 'student' | 'ppl' | 'ifr' | 'commercial';
export const LICENCE_ORDER: readonly Licence[] = ['student', 'ppl', 'ifr', 'commercial'];
/** The career starts here: Palo Alto, a busy general-aviation field near San Francisco. */
export const CAREER_HOME = 'KPAO';
export const START_MONEY = 500;
const HISTORY_MAX = 50;

export interface CareerHistoryEntry { jobId: string; type: string; from: string; to: string; pay: number; score: number; success: boolean; atMs: number }

export interface CareerDoc {
  v: 1;
  started: boolean;
  money: number;
  /** 0..100 */
  reputation: number;
  licences: Licence[];
  /** ICAO of the airport the pilot is at (jobs start here) */
  location: string;
  jobsDone: number;
  history: CareerHistoryEntry[];
  /** the job (or check-ride) being flown, settled when its activity finishes */
  active: { job: CareerJob } | { exam: Licence } | null;
  /** job board seed: changes when a job is flown, so the board is stable until then */
  seed: number;
}

export const emptyCareer = (): CareerDoc => ({
  v: 1, started: false, money: START_MONEY, reputation: 10, licences: ['student'], location: CAREER_HOME, jobsDone: 0, history: [], active: null, seed: 1,
});

/** Pay for a completed job: 60 % guaranteed, the rest by the flight's score (0..100). */
export function jobPay(basePay: number, score: number): number {
  return Math.round(basePay * (0.6 + 0.4 * Math.min(Math.max(score, 0), 100) / 100));
}

/** Reputation earned by a completed job (+2 … +6 by score); a failed job costs 5. */
export function reputationDelta(success: boolean, score: number): number {
  return success ? 2 + Math.round((4 * Math.min(Math.max(score, 0), 100)) / 100) : -5;
}

function sanitise(raw: unknown): CareerDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<CareerDoc>;
  if (r.v !== 1) return null;
  const d = emptyCareer();
  const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : def);
  d.started = r.started === true;
  d.money = Math.round(num(r.money, d.money, -1e9, 1e12));
  d.reputation = num(r.reputation, d.reputation, 0, 100);
  d.licences = Array.isArray(r.licences) ? LICENCE_ORDER.filter((l) => (r.licences as unknown[]).includes(l)) : d.licences;
  if (!d.licences.includes('student')) d.licences.unshift('student');
  d.location = typeof r.location === 'string' && /^[A-Z0-9]{3,4}$/.test(r.location) ? r.location : d.location;
  d.jobsDone = Math.floor(num(r.jobsDone, 0, 0, 1e7));
  d.history = Array.isArray(r.history) ? (r.history as CareerHistoryEntry[]).filter((h) => h && typeof h.jobId === 'string').slice(-HISTORY_MAX) : [];
  d.active = r.active && typeof r.active === 'object' && ('job' in r.active || 'exam' in r.active) ? r.active : null;
  d.seed = Math.floor(num(r.seed, 1, 1, 2 ** 31));
  return d;
}

export class CareerStore {
  private doc: CareerDoc;
  private readonly writable: boolean;

  constructor(private readonly storage: KeyValueStorage | null, private readonly key = CAREER_KEY, private readonly now: () => number = () => Date.now()) {
    let doc: CareerDoc | null = null, ok = true;
    try {
      const raw = storage?.getItem(key) ?? null;
      if (raw) { doc = sanitise(JSON.parse(raw)); ok = doc !== null; }
    } catch { ok = false; }
    this.doc = doc ?? emptyCareer();
    this.writable = ok;
  }

  get state(): Readonly<CareerDoc> { return this.doc; }
  has(l: Licence): boolean { return this.doc.licences.includes(l); }
  /** highest licence held */
  get rank(): Licence { return LICENCE_ORDER.filter((l) => this.has(l)).pop() ?? 'student'; }

  private save(): void {
    if (!this.writable) return;
    try { this.storage?.setItem(this.key, JSON.stringify(this.doc)); } catch { /* full / private mode */ }
  }

  begin(job: CareerJob): void { this.doc.started = true; this.doc.active = { job }; this.save(); }
  beginExam(l: Licence): void { this.doc.started = true; this.doc.active = { exam: l }; this.save(); }

  /**
   * Settle the active job or check-ride with its activity's result. Returns what changed (null: nothing
   * was active).
   */
  finish(success: boolean, score: number): { pay: number; reputation: number; licence: Licence | null; location: string } | null {
    const a = this.doc.active;
    if (!a) return null;
    this.doc.active = null;
    if ('exam' in a) {
      const granted = success && !this.has(a.exam) ? a.exam : null;
      if (granted) this.doc.licences = LICENCE_ORDER.filter((l) => l === granted || this.has(l));
      this.save();
      return { pay: 0, reputation: 0, licence: granted, location: this.doc.location };
    }
    const job = a.job;
    const pay = success ? jobPay(job.pay, score) : 0;
    const rep = reputationDelta(success, score);
    this.doc.money += pay;
    this.doc.reputation = Math.min(100, Math.max(0, this.doc.reputation + rep));
    if (success) { this.doc.jobsDone++; this.doc.location = job.endsAt; this.doc.seed = (this.doc.seed * 1103515245 + 12345) % 2147483647 || 1; }
    this.doc.history.push({ jobId: job.id, type: job.type, from: job.from, to: job.endsAt, pay, score: Math.round(score), success, atMs: this.now() });
    if (this.doc.history.length > HISTORY_MAX) this.doc.history.splice(0, this.doc.history.length - HISTORY_MAX);
    this.save();
    return { pay, reputation: rep, licence: null, location: this.doc.location };
  }

  /** Drop an active job that never finished (aborted, app closed). */
  cancelActive(): void { if (this.doc.active) { this.doc.active = null; this.save(); } }

  grantLicence(l: Licence): void { if (!this.has(l)) { this.doc.licences = LICENCE_ORDER.filter((x) => x === l || this.has(x)); this.save(); } }

  reset(): void {
    this.doc = emptyCareer();
    try { this.storage?.removeItem?.(this.key); } catch { /* ignore */ }
  }
}
