/**
 * Dev only: write synthetic z14 OpenMapTiles fixtures around KSFO to {outDir}/{z}/{x}/{y}.pbf.
 *
 *   node --experimental-transform-types --import ./src/scenery/dev/register.mjs \
 *        src/scenery/dev/generateFixtures.ts [outDir]
 *
 * Runway coordinates come from public/data/airports.json (KSFO); everything else is authored
 * in src/scenery/dev/syntheticWorld.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KSFO_REF, buildSyntheticWorld, encodeWorldTile, worldTiles, type RunwayInput } from './syntheticWorld';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-0/-home-user-Flight-sim/7bee71d5-9f1f-55ef-9ffc-73df5cf9c113/scratchpad/osm-fixtures');
const Z = 14;

interface RawAirport { i: string; la: number; lo: number; r?: { id: string; le: [string, number, number]; he: [string, number, number]; w: number }[] }
const db = JSON.parse(readFileSync(join(repo, 'public/data/airports.json'), 'utf8')) as { airports: RawAirport[] };
const ksfo = db.airports.find((a) => a.i === 'KSFO');
if (!ksfo || !ksfo.r) throw new Error('KSFO not found in public/data/airports.json');
const runways: RunwayInput[] = ksfo.r.map((r) => ({ ident: r.id, a: { lat: r.le[1], lon: r.le[2] }, b: { lat: r.he[1], lon: r.he[2] }, widthM: r.w }));

const world = buildSyntheticWorld(runways, { lat: ksfo.la ?? KSFO_REF.lat, lon: ksfo.lo ?? KSFO_REF.lon });
let files = 0, bytes = 0;
for (const t of worldTiles(world, Z)) {
  const data = encodeWorldTile(world, Z, t.x, t.y);
  if (!data) continue;
  const file = join(outDir, String(Z), String(t.x), `${t.y}.pbf`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  files++;
  bytes += data.length;
}
console.log(`wrote ${files} tiles (${(bytes / 1024).toFixed(0)} KiB, ${world.features.length} features) to ${outDir}/${Z}/{x}/{y}.pbf`);
