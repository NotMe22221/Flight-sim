import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_FILTERS, categoryCounts, challengeConditions, challengeTimeLabel, challengesIn, formatLocalHour, landingChallenges, loadBestScores,
  parseBestScores, recordBestScore,
} from './activities';

describe('challenge list', () => {
  const list = landingChallenges();
  it('exposes the bundled challenges with unique ids', () => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
  });
  it('filters by category and counts per tab', () => {
    const counts = categoryCounts(list);
    expect(counts.All).toBe(list.length);
    expect(counts.Famous + counts.Epic + counts['Strong Wind']).toBe(list.length);
    for (const f of CHALLENGE_FILTERS) expect(challengesIn(list, f).length).toBe(counts[f]);
    expect(challengesIn(list, 'Epic').every((c) => c.category === 'Epic')).toBe(true);
  });
  it('builds briefing lines', () => {
    const c = list.find((x) => x.id === 'ksfo-28l-wind') ?? list.find((x) => x.wind)!;
    const b = challengeConditions(c);
    expect(b.airport).toContain(c.icao);
    expect(b.wind).toMatch(/^\d{3}\/\d{2}G\d+ kt$/);
    expect(b.approach).toContain(`${c.speedKt} kt`);
    const calm = challengeConditions({ ...c, wind: undefined });
    expect(calm.wind).toBe('Preset winds');
    const still = challengeConditions({ ...c, wind: { fromDeg: 0, speedKt: 0 } });
    expect(still.wind).toBe('Calm'); // not 'CALM kt'
  });
  it('labels the challenge time from the sun-relative name and/or the nominal hour', () => {
    expect(challengeTimeLabel({ time: 'dusk', localHour: 17.5 })).toBe('Dusk · ~17:30 local');
    expect(challengeTimeLabel({ time: 'noon' })).toBe('Noon');
    expect(challengeTimeLabel({ localHour: 9 })).toBe('09:00 local');
    expect(challengeTimeLabel({})).toBe('—');
  });
  it('formats local hours', () => {
    expect(formatLocalHour(17.5)).toBe('17:30');
    expect(formatLocalHour(9)).toBe('09:00');
    expect(formatLocalHour(24)).toBe('00:00');
    expect(formatLocalHour(-1)).toBe('23:00');
    expect(formatLocalHour(Number.NaN)).toBe('--:--');
  });
});

describe('best scores', () => {
  it('records only improvements', () => {
    let r = recordBestScore({}, 'a', 6000.4, 1);
    expect(r.isNewBest).toBe(true);
    expect(r.previous).toBeNull();
    expect(r.scores.a).toEqual({ score: 6000, atMs: 1 });
    r = recordBestScore(r.scores, 'a', 5000, 2);
    expect(r.isNewBest).toBe(false);
    expect(r.previous).toBe(6000);
    expect(r.scores.a.score).toBe(6000);
    r = recordBestScore(r.scores, 'a', 9100, 3);
    expect(r.isNewBest).toBe(true);
    expect(r.scores.a).toEqual({ score: 9100, atMs: 3 });
  });
  it('ignores invalid scores and never mutates the input', () => {
    const s = { a: { score: 10, atMs: 0 } };
    const r = recordBestScore(s, 'a', Number.NaN, 0);
    expect(r.isNewBest).toBe(false);
    expect(recordBestScore(s, 'b', 20, 5).scores).not.toBe(s);
    expect(s).toEqual({ a: { score: 10, atMs: 0 } });
  });
  it('sanitizes stored blobs', () => {
    expect(parseBestScores(null)).toEqual({});
    expect(parseBestScores({ a: { score: 5.6, atMs: 'x' }, b: { score: -1 }, c: 'junk', d: { score: 7, atMs: 9 } }))
      .toEqual({ a: { score: 6, atMs: 0 }, d: { score: 7, atMs: 9 } });
  });
  it('loads an empty table without localStorage (Node)', () => {
    expect(loadBestScores()).toEqual({});
  });
});

describe('ChallengeSession', () => {
  const at = (lat: number, lon: number, alt = 300) => ({ geo: { lat, lon, alt } });
  it('adopts the first spawn after begin and survives respawns there', async () => {
    const { ChallengeSession } = await import('./activities');
    const s = new ChallengeSession();
    s.onFlightReset(at(1, 1)); // nothing active: ignored
    expect(s.activeId).toBeNull();
    s.begin('ksfo-28r');
    s.onFlightReset(at(37.6, -122.3));
    expect(s.activeId).toBe('ksfo-28r');
    s.onFlightReset(at(37.6, -122.3)); // "Restart"
    expect(s.activeId).toBe('ksfo-28r');
    s.onFlightReset(at(47.2, 11.3)); // a different flight
    expect(s.activeId).toBeNull();
  });
  it('end() clears the session', async () => {
    const { ChallengeSession } = await import('./activities');
    const s = new ChallengeSession();
    s.begin('x');
    s.end();
    s.onFlightReset(at(0, 0));
    expect(s.activeId).toBeNull();
  });
  it('spawnKey ignores sub-metre jitter only', async () => {
    const { spawnKey } = await import('./activities');
    expect(spawnKey(at(37.6000001, -122.3))).toBe(spawnKey(at(37.6, -122.3)));
    expect(spawnKey(at(37.61, -122.3))).not.toBe(spawnKey(at(37.6, -122.3)));
  });
});
