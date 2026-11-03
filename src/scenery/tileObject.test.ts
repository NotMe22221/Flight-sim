import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTile } from './builder';
import { qualityProfile } from './config';
import { GroundSampler } from './grounding';
import { TreeLayer } from './layers';
import { SceneryMaterials, makeTreeGeometries } from './materials';
import { PROBE_GRID, TileObject, type SharedTreeGeometry } from './tileObject';
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

  it('notices a terrain refinement under the tile through its probe grid (and only a real one)', () => {
    const frame = KSFO_FRAME();
    let h: HeightFn = () => 4;
    const host = makeHost(frame, (lat, lon) => h(lat, lon));
    const s = new GroundSampler(host.groundUp);
    const { obj, dispose } = terminalTile();
    obj.place(frame);
    for (let i = 0; i < 1000 && obj.settling; i++) obj.groundStep(5000, s, true);
    // the first sweep sets the baseline and owes one cycle (things grounded before it may stand
    // on older terrain than the baseline)
    for (let i = 0; i < (PROBE_GRID * PROBE_GRID) / 16; i++) obj.checkTerrain(s, 16);
    expect(obj.hotSamples).toBeGreaterThan(0);
    for (let i = 0; i < 10000 && obj.hotSamples > 0; i++) obj.groundStep(400, s, false);
    // unchanged ground: several full probe sweeps, never hot again
    for (let i = 0; i < 20; i++) obj.checkTerrain(s, 16);
    expect(obj.hotSamples).toBe(0);
    // the ground rises by 3 m under the southern half of the tile
    const midLat = (obj.projector.toLonLat(0, 0).lat);
    h = (lat) => (lat < midLat ? 7 : 4);
    for (let i = 0; i < 20 && obj.hotSamples === 0; i++) obj.checkTerrain(s, 16);
    expect(obj.hotSamples).toBeGreaterThan(0);
    // one owed cycle brings every layer onto the new ground, then the tile cools down
    for (let i = 0; i < 10000 && obj.hotSamples > 0; i++) obj.groundStep(400, s, false);
    expect(obj.hotSamples).toBe(0);
    const b = obj.result.buildings!;
    obj.group.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    for (let i = 0; i < b.count; i++) {
      p.set(b.centroids[i * 2], obj.buildingGround(i), b.centroids[i * 2 + 1]).applyMatrix4(obj.group.matrixWorld);
      const g = frame.threeToGeodetic(p.x, p.y, p.z);
      // the base is the lowest of the building's samples: on the 3 m step it may sit on the low side
      expect(g.alt, `building ${i}`).toBeGreaterThan((g.lat < midLat - 2e-4 ? 7 : 4) - 0.05);
    }
    for (let i = 0; i < 20; i++) obj.checkTerrain(s, 16);
    expect(obj.hotSamples).toBe(0);
    dispose();
  });

  it('re-samples once what was grounded before the probe baseline existed (refinement in between)', () => {
    const frame = KSFO_FRAME();
    let h: HeightFn = () => 4;
    const host = makeHost(frame, (lat, lon) => h(lat, lon));
    const s = new GroundSampler(host.groundUp);
    const { obj, dispose } = terminalTile();
    obj.place(frame);
    for (let i = 0; i < 1000 && obj.settling; i++) obj.groundStep(5000, s, true);
    h = () => 9; // refined after the first passes, before the first probe sweep
    for (let i = 0; i < (PROBE_GRID * PROBE_GRID) / 16 && obj.hotSamples === 0; i++) obj.checkTerrain(s, 16);
    expect(obj.hotSamples).toBeGreaterThan(0);
    for (let i = 0; i < 10000 && obj.hotSamples > 0; i++) obj.groundStep(400, s, false);
    // everything moved up by ~5 m (trees stand 0.3 m into the ground, tile corners ~0.1 m below the tangent plane)
    for (const [k, v] of Object.entries(heights(obj))) for (const y of v) expect(y, k).toBeGreaterThan(8.4);
    dispose();
  });

  it('keeps re-sampling the other layers while one layer still has no ground at all', () => {
    const frame = KSFO_FRAME();
    let h: HeightFn = () => 4;
    const host = makeHost(frame, (lat, lon) => h(lat, lon));
    const s = new GroundSampler(host.groundUp);
    const { obj, dispose } = terminalTile();
    obj.place(frame);
    // the trees stand where no terrain has loaded yet: their layer never gets a first pass
    const trees = obj.layers.filter((l) => l instanceof TreeLayer);
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) (t as unknown as { sampleItem: () => boolean }).sampleItem = () => false;
    for (let i = 0; i < 200; i++) obj.groundStep(5000, s, true);
    for (let i = 0; i < 200; i++) obj.groundStep(400, s, false); // background re-sampling reaches the trees
    h = () => 9;
    for (let i = 0; i < 400; i++) obj.groundStep(400, s, false);
    for (let i = 0; i < obj.result.buildings!.count; i++) expect(obj.buildingGround(i), `building ${i}`).toBeGreaterThan(8.6);
    dispose();
  });

  it('lets aprons, taxiways and their markings receive the sun shadow map like the runway slabs', () => {
    // AirportsLayer runway slabs receive the aircraft's shadow; without this the shadow vanishes
    // as soon as the aircraft rolls off the runway onto a taxiway or parks on an apron
    const { obj, dispose } = terminalTile();
    for (const name of ['pavement', 'markings']) {
      const mesh = obj.group.children.find((c) => c.name === name) as THREE.Mesh;
      expect(mesh, name).toBeDefined();
      expect(mesh.receiveShadow, name).toBe(true);
      expect(mesh.castShadow, name).toBe(false);
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
