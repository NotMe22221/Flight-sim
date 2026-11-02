/** Node test loader: reads `public/<path>` from disk. Not used by the browser build. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NavDataLoader } from '../navTypes';

export const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

export function fsLoader(root = PUBLIC_DIR): NavDataLoader {
  return async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8')) as unknown;
}

/** A loader that counts calls and records paths, for cache tests. */
export function countingLoader(inner: NavDataLoader = fsLoader()): NavDataLoader & { calls: string[] } {
  const calls: string[] = [];
  const f = ((path: string) => { calls.push(path); return inner(path); }) as NavDataLoader & { calls: string[] };
  f.calls = calls;
  return f;
}
