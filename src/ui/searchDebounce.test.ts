import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebouncedSearch, normalizeQuery } from './searchDebounce';

describe('normalizeQuery', () => {
  it('trims, collapses whitespace and enforces a minimum length', () => {
    expect(normalizeQuery('  san   francisco ')).toBe('san francisco');
    expect(normalizeQuery('k')).toBe('');
    expect(normalizeQuery('k', 1)).toBe('k');
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('DebouncedSearch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = (search: (q: string) => string[] | Promise<string[]> = (q) => [q.toUpperCase()]) => {
    const results: [string, string[]][] = [];
    const calls: string[] = [];
    const s = new DebouncedSearch<string>({
      search: (q) => { calls.push(q); return search(q); },
      onResults: (q, r) => results.push([q, r]),
      delayMs: 200,
    });
    return { s, results, calls };
  };

  it('runs only the last query after the delay', () => {
    const { s, results, calls } = setup();
    s.input('ks'); s.input('ksf'); s.input('ksfo');
    expect(calls).toEqual([]);
    expect(s.pending).toBe(true);
    vi.advanceTimersByTime(199);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['ksfo']);
    expect(results).toEqual([['ksfo', ['KSFO']]]);
    expect(s.pending).toBe(false);
  });

  it('skips a query identical to the last one', () => {
    const { s, calls } = setup();
    s.input('lowi'); vi.advanceTimersByTime(200);
    s.input('lowi '); vi.advanceTimersByTime(200);
    expect(calls).toEqual(['lowi']);
    s.invalidate();
    s.input('lowi'); vi.advanceTimersByTime(200);
    expect(calls).toEqual(['lowi', 'lowi']);
  });

  it('clearing the box reports empty results immediately and cancels the pending search', () => {
    const { s, results, calls } = setup();
    s.input('ksfo'); vi.advanceTimersByTime(200);
    s.input('kso'); s.input('');
    expect(results.at(-1)).toEqual(['', []]);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(['ksfo']);
    s.input(' ');
    expect(results.filter(([q]) => q === '').length).toBe(1); // no duplicate clear
  });

  it('flush() runs the pending search now (Enter)', () => {
    const { s, calls } = setup();
    expect(s.flush()).toBe(false);
    s.input('sion');
    expect(s.flush()).toBe(true);
    expect(calls).toEqual(['sion']);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(['sion']);
  });

  it('drops results from superseded async searches', async () => {
    const resolvers = new Map<string, (r: string[]) => void>();
    const { s, results } = setup((q) => new Promise<string[]>((res) => resolvers.set(q, res)));
    s.input('in'); vi.advanceTimersByTime(200);
    s.input('innsbruck'); vi.advanceTimersByTime(200);
    resolvers.get('innsbruck')!(['LOWI']);
    resolvers.get('in')!(['stale']);
    await Promise.resolve(); await Promise.resolve();
    expect(results).toEqual([['innsbruck', ['LOWI']]]);
  });

  it('reports a throwing search as empty results plus an error', () => {
    const errors: string[] = [];
    const results: [string, string[]][] = [];
    const s = new DebouncedSearch<string>({ search: () => { throw new Error('db'); }, onResults: (q, r) => results.push([q, r]), onError: (q) => errors.push(q), delayMs: 10 });
    s.input('abc'); vi.advanceTimersByTime(10);
    expect(errors).toEqual(['abc']);
    expect(results).toEqual([['abc', []]]);
  });

  it('does nothing after dispose()', () => {
    const { s, calls } = setup();
    s.input('ksfo');
    s.dispose();
    vi.advanceTimersByTime(500);
    s.input('kjfk'); vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
  });
});
