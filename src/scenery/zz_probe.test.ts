import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeTile } from './mvt';
import { extractFeatures } from './features';
import { buildBuildings } from './buildings';
import { buildTile } from './builder';
import { qualityProfile } from './config';
const root = '/tmp/claude-0/-home-user-Flight-sim/7bee71d5-9f1f-55ef-9ffc-73df5cf9c113/scratchpad/osm-fixtures/14';
it('probe', () => {
  const s = qualityProfile('high').build;
  for (const [x, y] of [[2621, 6341], [2620, 6340], [2619, 6340]]) {
    const bytes = new Uint8Array(readFileSync(`${root}/${x}/${y}.pbf`));
    let t = performance.now();
    const tile = decodeTile(bytes); const td = performance.now() - t; t = performance.now();
    const f = extractFeatures(tile, 14, x, y, { minBuildingAreaM2: 15 }); const te = performance.now() - t; t = performance.now();
    buildBuildings(f.buildings, { maxTriangles: 1e6, pitchedRoofs: true }); const tb = performance.now() - t; t = performance.now();
    const r = buildTile(bytes, 14, x, y, s); const tall = performance.now() - t;
    console.log(x, y, 'decode', td.toFixed(1), 'extract', te.toFixed(1), 'buildings', tb.toFixed(1), 'all', tall.toFixed(1), 'roads', f.roads.length, 'treeAreas', f.treeAreas.length, 'bld', f.buildings.length);
    for (let k = 0; k < 2; k++) { t = performance.now(); buildTile(bytes, 14, x, y, s); console.log('  again', (performance.now() - t).toFixed(1)); }
  }
});
