/**
 * Data loaders. The database only knows about site-relative paths such as `data/airports.json`;
 * a `NavDataLoader` turns that into JSON. In the browser that is `fetch` with the Vite base URL,
 * in Node tests it is `fs.readFile` (see `__tests__/fsLoader.ts`).
 */
import type { NavDataLoader } from './navTypes';

/** Browser loader: `fetch(`${base}${path}`)` and parse JSON. `base` must end with '/'. */
export function fetchLoader(base = '/'): NavDataLoader {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return async (path: string) => {
    const res = await fetch(prefix + path);
    if (!res.ok) throw new Error(`nav data: ${path} → HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
}

/** Wrap a loader so that each path is fetched at most once (concurrent calls share the promise). */
export function memoizeLoader(loader: NavDataLoader): NavDataLoader & { readonly calls: number } {
  const cache = new Map<string, Promise<unknown>>();
  let calls = 0;
  const memo = ((path: string) => {
    let p = cache.get(path);
    if (!p) {
      calls++;
      p = loader(path).catch((err: unknown) => { cache.delete(path); throw err; });
      cache.set(path, p);
    }
    return p;
  }) as NavDataLoader & { calls: number };
  Object.defineProperty(memo, 'calls', { get: () => calls });
  return memo;
}
