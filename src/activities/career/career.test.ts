import { describe, expect, it } from 'vitest';
import type { Airport } from '../../core/types';
import { compileObjective } from '../objectives';
import { CAREER_HOME, CareerStore, START_MONEY, jobPay, reputationDelta } from './careerStore';
import { examActivity, missingFor } from './licences';
import { C172_FIELDS, CUB_FIELDS, generateJobs, jobActivity, usableRunway, type CareerJob } from './missions';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m }; };

const rw = (ident: string, lengthM: number, surface: Airport['runways'][number]['surface'] = 'asphalt') =>
  ({ ident, threshold: { lat: 0, lon: 0, alt: 0 }, end: { lat: 0, lon: 0, alt: 0 }, headingDeg: 0, lengthM, widthM: 30, surface, lighted: true, displacedThresholdM: 0 });
const ap = (icao: string, lat: number, lon: number, runways = [rw('31', 900)], type: Airport['type'] = 'small'): Airport =>
  ({ icao, name: `${icao} field`, position: { lat, lon, alt: 0 }, elevationM: 0, type, country: 'US', runways } as Airport);

const ORIGIN = ap('KPAO', 37.4611, -122.115);
const NEARBY = [
  ORIGIN,
  ap('KSQL', 37.5119, -122.2495),           // ≈ 7 nm
  ap('KHWD', 37.6589, -122.1217),           // ≈ 12 nm
  ap('KLVK', 37.6934, -121.8204),           // ≈ 18 nm
  ap('KHAF', 37.5134, -122.5011),           // ≈ 19 nm
  ap('KCCR', 37.9897, -122.0569),           // ≈ 32 nm
  ap('KSTS', 38.509, -122.8128, [rw('32', 1900)]), // ≈ 70 nm
  ap('O88', 37.75, -121.9, [rw('27', 400, 'grass')]), // short grass strip
  ap('KFAR', 46.92, -96.81),                // far away: filtered
];

describe('career store', () => {
  it('starts a student pilot at Palo Alto with $500, and persists', () => {
    const s = mem();
    const c = new CareerStore(s);
    expect(c.state.location).toBe(CAREER_HOME);
    expect(c.state.money).toBe(START_MONEY);
    expect(c.rank).toBe('student');
    c.grantLicence('ppl');
    expect(new CareerStore(s).rank).toBe('ppl');
  });

  it('pay is 60 % guaranteed plus the score share; reputation +2..+6 or -5', () => {
    expect(jobPay(1000, 0)).toBe(600);
    expect(jobPay(1000, 100)).toBe(1000);
    expect(jobPay(1000, 50)).toBe(800);
    expect(reputationDelta(true, 0)).toBe(2);
    expect(reputationDelta(true, 100)).toBe(6);
    expect(reputationDelta(false, 100)).toBe(-5);
  });

  it('a finished job pays, moves the pilot and reshuffles the board; a failed one only costs reputation', () => {
    const c = new CareerStore(mem(), 'k', () => 123);
    const job = { id: 'career:cargo:x', type: 'cargo', pay: 400, endsAt: 'KHWD', from: 'KPAO' } as CareerJob;
    c.begin(job);
    const seed = c.state.seed;
    const r = c.finish(true, 100)!;
    expect(r.pay).toBe(400);
    expect(c.state.money).toBe(START_MONEY + 400);
    expect(c.state.location).toBe('KHWD');
    expect(c.state.jobsDone).toBe(1);
    expect(c.state.seed).not.toBe(seed);
    expect(c.state.history.at(-1)).toMatchObject({ jobId: job.id, pay: 400, success: true, atMs: 123 });
    c.begin({ ...job, endsAt: 'KSQL' });
    const rep = c.state.reputation;
    expect(c.finish(false, 80)!.pay).toBe(0);
    expect(c.state.location).toBe('KHWD');
    expect(c.state.reputation).toBe(Math.max(0, rep - 5));
    expect(c.finish(true, 100)).toBeNull(); // nothing active
  });

  it('a passed check-ride grants the licence; corrupt saved data is ignored and not overwritten', () => {
    const c = new CareerStore(mem());
    c.beginExam('ppl');
    expect(c.finish(true, 70)!.licence).toBe('ppl');
    expect(c.has('ppl')).toBe(true);
    const s = mem(); s.setItem('flightsim.career.v1', '{not json');
    const bad = new CareerStore(s);
    expect(bad.state.money).toBe(START_MONEY);
    bad.grantLicence('ppl');
    expect(s.getItem('flightsim.career.v1')).toBe('{not json');
  });
});

describe('licences', () => {
  const facts = { licences: ['student' as const], logbookHours: 0, jobsDone: 0, reputation: 10 };
  it('PPL needs only its check-ride; IFR needs the PPL; Commercial needs hours, jobs and reputation', () => {
    expect(missingFor('ppl', facts)).toEqual([]);
    expect(missingFor('ifr', facts)).toEqual(['Private pilot licence']);
    expect(missingFor('commercial', facts).length).toBe(4);
    expect(missingFor('commercial', { licences: ['student', 'ppl'], logbookHours: 12, jobsDone: 20, reputation: 60 })).toEqual([]);
    expect(missingFor('ppl', { ...facts, licences: ['student', 'ppl'] })).toEqual([]);
  });

  it('check-rides compile', () => {
    for (const l of ['ppl', 'ifr'] as const) {
      const def = examActivity(l)!;
      expect(def.kind).toBe('exam');
      for (const st of def.steps) for (const o of st.objectives) expect(() => compileObjective(o)).not.toThrow();
    }
    expect(examActivity('commercial')).toBeNull();
  });
});

describe('job board', () => {
  it('a student gets only short solo practice flights; the board is deterministic for a seed', () => {
    const a = generateJobs({ origin: ORIGIN, nearby: NEARBY, licences: ['student'], needs: C172_FIELDS, seed: 7 });
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((j) => j.type === 'practice' && j.distanceNm <= 25)).toBe(true);
    expect(generateJobs({ origin: ORIGIN, nearby: NEARBY, licences: ['student'], needs: C172_FIELDS, seed: 7 })).toEqual(a);
  });

  it('a private pilot gets paid work within 6–80 nm at fields the aircraft can use', () => {
    const jobs = generateJobs({ origin: ORIGIN, nearby: NEARBY, licences: ['student', 'ppl'], needs: C172_FIELDS, seed: 3, count: 8 });
    expect(jobs.length).toBeGreaterThan(3);
    for (const j of jobs) {
      expect(j.type).not.toBe('medevac');
      expect(['KFAR', 'O88', 'KPAO'].includes(j.to) && j.type !== 'sar').toBe(false);
      expect(j.pay).toBeGreaterThan(100);
    }
    expect(usableRunway(NEARBY[7], C172_FIELDS)).toBeNull();
    expect(usableRunway(NEARBY[7], CUB_FIELDS)).not.toBeNull();
  });

  it('every job compiles into an activity whose objectives are valid; payload and route are set up', () => {
    const jobs = generateJobs({ origin: ORIGIN, nearby: NEARBY, licences: ['student', 'ppl', 'ifr', 'commercial'], needs: C172_FIELDS, seed: 11, count: 12 });
    const types = new Set(jobs.map((j) => j.type));
    expect(types.size).toBeGreaterThan(2);
    for (const j of jobs) {
      const def = jobActivity(j);
      expect(def.kind).toBe('mission');
      expect(def.id.startsWith('career:')).toBe(true);
      expect(def.setup.spawn).toBe('runway');
      if (def.setup.spawn === 'runway') { expect(def.setup.icao).toBe('KPAO'); expect(def.setup.payloadKg).toBe(j.payloadKg); expect(def.setup.route!.at(-1)!.id).toBe(j.endsAt); }
      for (const st of def.steps) for (const o of st.objectives) expect(() => compileObjective(o)).not.toThrow();
      if (j.type === 'sar') expect(j.endsAt).toBe('KPAO');
      if (j.type === 'medevac') expect(j.timeLimitMin).toBeGreaterThan(10);
    }
  });
});
