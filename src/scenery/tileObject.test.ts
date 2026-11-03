import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTile } from './builder';
import { qualityProfile } from './config';
import { GroundSampler } from './grounding';
import { SceneryMaterials, makeTreeGeometries } from './materials';
import { TileObject, type SharedTreeGeometry } from './tileObject';
import { KSFO_FRAME, makeHost, tileBytesAt, type HeightFn } from './testUtil';

// terminal apron of the synthetic KSFO world: buildings, aprons, taxiways, airport lights, trees
const GATE_A1 = { lat: 37.615867, lon: -122.393443 };

function terminalTile(): { obj: TileObject; dispose(): void } {
  const t = tileBytesAt(GATE_A1.lat, GATE_A1.lon);
  const result = buildTile(t.bytes, t.z, t.x, t.y, qualityProfile('high').build);
  const mats = new SceneryMaterials();
  const tg = makeTreeGeometries();
  const trees: SharedTreeGeometry = { conifer: tg.conifer, broadleaf: tg.broadleaf, coniferTris: 1, broadleafTris: 1 };
  const obj = new TileObject(result, mats, trees);
  return { obj, dispose: () => { obj.dispose(); mats.dispose(); tg.conifer.dispose(); tg.broadleaf.dispose(); } };
}

/** Local y of every grounded thing in the tile: building bases, draped vertices, light points, tree bases. */
function heights(o: TileObject): Record<string, number[]> {
  const out: Record<string, number[]> = { buildings: [] };
  const b = o.result.buildings;
  if (b) for (let i = 0; i < b.count; i++) out.buildings.push(o.buildingGround(i));
  for (const c of o.group.children) {
    if (c instanceof THREE.InstancedMesh) {
      const m = c.instanceMatrix.array as Float32Array;
      out[c.name] = [];
      for (let i = 0; i < c.count; i++) out[c.name].push(m[i * 16 + 13]);
    } else if (c.name !== 'walls' && c.name !== 'plain' && c.name !== 'roofs' && (c instanceof THREE.Mesh || c instanceof THREE.Points)) {
      const p = (c.geometry as THREE.BufferGeometry).getAttribute('position');
      out[c.name] = [];
      for (let i = 0; i < p.count; i++) out[c.name].push(p.getY(i));
    }
  }
  return out;
}

describe('TileObject ground layers', () => {
  it('re-samples every layer (buildings, pavement, markings, lights, trees) after the terrain refines', () => {
    const frame = KSFO_FRAME();
    let h: HeightFn = () => 4;
    const host = makeHost(frame, (lat, lon) => h(lat, lon));
    const s = new GroundSampler(host.groundUp);
    const { obj, dispose } = terminalTile();
    obj.place(frame);
    const kinds = obj.group.children.map((c) => c.name);
    for (const k of ['walls', 'pavement', 'markings', 'airport-lights']) expect(kinds).toContain(k);
    expect(kinds.some((k) => k === 'conifers' || k === 'broadleaf')).toBe(true);

    for (let i = 0; i < 1000 && obj.settling; i++) obj.groundStep(5000, s, true);
    expect(obj.settling).toBe(false);
    const before = heights(obj);

    // the terrain refines (+5 m everywhere): gradual re-sampling must reach every layer
    h = () => 9;
    let total = 0;
    for (const l of obj.layers) total += l.n * l.cost;
    for (let used = 0, i = 0; used < 1.5 * total && i < 100000; i++) used += obj.groundStep(400, s, false);
    const after = heights(obj);
    for (const k of Object.keys(before)) {
      expect(after[k].length, k).toBe(before[k].length);
      let worst = 0;
      for (let i = 0; i < before[k].length; i++) worst = Math.max(worst, Math.abs(after[k][i] - before[k][i] - 5));
      expect(worst, `${k} followed the terrain`).toBeLessThan(0.05);
    }
    dispose();
  });

  it('spreads one re-sampling call over the layers in turn instead of starving all but the first', () => {
    const frame = KSFO_FRAME();
    const host = makeHost(frame, () => 4);
    const s = new GroundSampler(host.groundUp);
    const { obj, dispose } = terminalTile();
    obj.place(frame);
    for (let i = 0; i < 1000 && obj.settling; i++) obj.groundStep(5000, s, true);
    const passes0 = obj.layers.map((l) => l.passes);
    let total = 0;
    for (const l of obj.layers) total += l.n * l.cost;
    for (let used = 0; used < total + 400;) used += obj.groundStep(400, s, false);
    // one full cycle of the budget gave every layer at least one more pass
    obj.layers.forEach((l, i) => expect(l.passes, `layer ${i}`).toBeGreaterThan(passes0[i]));
    dispose();
  });
});
