import { describe, expect, it } from 'vitest';
import { buildTile, runwayZone, MARKING_LIFT_M, NEAR_RUNWAY_LIFT_M, RIBBON_LIFT_M, RUNWAY_MARGIN_M, SURFACE_LIFT_M } from './builder';
import { qualityProfile } from './config';
import { DrapeBuilder, drapePolygon, drapeRibbon, type DrapeStyle } from './drape';
import { encodeTile, orientPolygon } from './dev/mvtEncoder';
import { extractFeatures } from './features';
import { decodeTile } from './mvt';
import { distToRingSq, pointInPolygon, reverseRing, signedArea } from './polygon';
import { TileProjector } from './tileMath';
import { tileBytesAt } from './testUtil';

const settings = qualityProfile('high').build;
// synthetic world (src/scenery/dev/syntheticWorld.ts): terminal apron west of the runways, city further west
const GATE_A1 = { lat: 37.615867, lon: -122.393443 }; // north half of the terminal apron, taxiway A, gates A*
const ARP = { lat: 37.619806, lon: -122.374821 }; // runway intersection, taxiways crossing runways
const CITY = { lat: 37.6225, lon: -122.4155 };

describe('drape', () => {
  const style: DrapeStyle = { r: 1, g: 1, b: 1, lift: () => 0.2, drop: null, dropMode: 'all' };
  it('clips polygons to the grid without cracks (every interior edge shared by two triangles)', () => {
    const d = new DrapeBuilder();
    const outer = [0, 0, 95, 0, 95, 47, 0, 47];
    const ring = signedArea(outer) > 0 ? outer : reverseRing(outer);
    const h = [40, 10, 60, 10, 60, 30, 40, 30];
    const hole = signedArea(h) < 0 ? h : reverseRing(h);
    drapePolygon(d, ring, [hole], 16, style);
    const out = d.finish()!;
    const idx = out.mesh.index, pos = out.mesh.position;
    const edges = new Map<string, number>();
    let area = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const t = [idx[k], idx[k + 1], idx[k + 2]];
      const ax = pos[t[0] * 3], az = pos[t[0] * 3 + 2], bx = pos[t[1] * 3], bz = pos[t[1] * 3 + 2], cx = pos[t[2] * 3], cz = pos[t[2] * 3 + 2];
      const cr = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      expect(cr).toBeLessThan(0); // faces up
      area -= cr / 2;
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
        expect(Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 2] - pos[b * 3 + 2])).toBeLessThanOrEqual(16 * Math.SQRT2 + 1e-6);
      }
    }
    expect(area).toBeCloseTo(95 * 47 - 20 * 20, 3);
    let boundary = 0;
    for (const n of edges.values()) { expect(n).toBeLessThanOrEqual(2); if (n === 1) boundary++; }
    // boundary edges only along the outline and the hole (perimeter / cell-ish), not inside
    expect(boundary).toBeLessThan(60);
    expect(out.lift.length).toBe(pos.length / 3);
  });

  it('builds mitred ribbons of constant width', () => {
    const d = new DrapeBuilder();
    drapeRibbon(d, [0, 0, 100, 0, 100, 100], 9, 20, style);
    const out = d.finish()!;
    const p = out.mesh.position;
    // the corner station's mitre reaches √2 · 9 from the corner point
    let corner = Infinity;
    for (let i = 0; i < p.length; i += 3) { const d = Math.hypot(p[i] - 100, p[i + 2]); if (d > 1e-6) corner = Math.min(corner, d); }
    expect(corner).toBeCloseTo(9 * Math.SQRT2, 3);
    expect(out.mesh.index.length / 3).toBe(2 * 2 * (5 + 5));
  });
});

describe('buildTile on synthetic OSM tiles', () => {
  const ap = tileBytesAt(GATE_A1.lat, GATE_A1.lon);
  const r = buildTile(ap.bytes, ap.z, ap.x, ap.y, settings);
  const f = extractFeatures(decodeTile(ap.bytes), ap.z, ap.x, ap.y, { minBuildingAreaM2: settings.minBuildingAreaM2 });
  const near = runwayZone(f, RUNWAY_MARGIN_M);
  const rw = tileBytesAt(ARP.lat, ARP.lon);
  const rr = buildTile(rw.bytes, rw.z, rw.x, rw.y, settings);
  const rf = extractFeatures(decodeTile(rw.bytes), rw.z, rw.x, rw.y, { minBuildingAreaM2: settings.minBuildingAreaM2 });
  const rnear = runwayZone(rf, RUNWAY_MARGIN_M);

  it('drapes aprons and taxiways, lowered and unbiased next to runways', () => {
    expect(r.surfaces).not.toBeNull();
    expect(rf.runwayLines.length).toBeGreaterThan(0);
    const s = rr.surfaces!;
    let lowered = 0, normal = 0;
    for (let i = 0; i < s.lift.length; i++) {
      const x = s.mesh.position[i * 3], z = s.mesh.position[i * 3 + 2];
      if (rnear(x, z)) { expect(s.lift[i]).toBeLessThanOrEqual(NEAR_RUNWAY_LIFT_M + 0.02 + 1e-6); lowered++; }
      else { expect(s.lift[i]).toBeGreaterThanOrEqual(SURFACE_LIFT_M - 1e-6); normal++; }
      expect(s.mesh.position[i * 3 + 1]).toBe(0);
    }
    expect(lowered).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(lowered);
  });

  it('keeps markings and taxiway lights off the runways and edge lights off the aprons', () => {
    for (const [res, zone] of [[r, near], [rr, rnear]] as const) {
      const m = res.markings!;
      for (let k = 0; k < m.mesh.index.length; k++) {
        const v = m.mesh.index[k];
        expect(zone(m.mesh.position[v * 3], m.mesh.position[v * 3 + 2])).toBe(false);
      }
      const L = res.airportLights!;
      for (let i = 0; i < L.count; i++) if (L.height[i] < 10) expect(zone(L.xz[i * 2], L.xz[i * 2 + 1])).toBe(false);
    }
    const L = r.airportLights!;
    let blue = 0;
    for (let i = 0; i < L.count; i++) {
      const x = L.xz[i * 2], z = L.xz[i * 2 + 1];
      const isFlood = L.height[i] > 10;
      if (!isFlood) expect(near(x, z)).toBe(false);
      if (L.color[i * 3 + 2] > 200 && L.color[i * 3] < 100) {
        blue++;
        for (const a of f.aprons) expect(pointInPolygon(x, z, a.outer, a.holes)).toBe(false);
      }
    }
    expect(blue).toBeGreaterThan(10);
    expect(r.lightPools).not.toBeNull();
  });

  it('puts apron floodlights only along real apron edges, never along the tile-clipping edge', () => {
    // the terminal apron is cut by this tile's east edge: the clipped ring runs along the tile
    // border, which is no apron edge (the apron continues in the neighbouring tile)
    expect(f.aprons.length).toBeGreaterThan(0);
    const proj = new TileProjector(ap.z, ap.x, ap.y, 4096);
    const L = r.airportLights!;
    let floods = 0;
    for (let i = 0; i < L.count; i++) {
      if (L.height[i] < 10) continue;
      floods++;
      const t = proj.toTile(L.xz[i * 2], L.xz[i * 2 + 1]);
      const m = Math.min(t.px, 4096 - t.px, t.py, 4096 - t.py) * proj.unitM; // metres inside the tile square
      expect(m, `floodlight ${i} at ${t.px.toFixed(0)}, ${t.py.toFixed(0)}`).toBeGreaterThan(8);
    }
    expect(floods).toBeGreaterThan(3);
    // one floodlight pool per mast
    expect(r.lightPools!.mesh.position.length / 3).toBe(floods * 9);
  });

  it('paints taxiways crossing an apron as yellow lines on the concrete, not as asphalt strips', () => {
    // apron taxilanes / taxiways are lead-in lines painted on the apron surface
    const onApron = (x: number, z: number) => f.aprons.some((a) => pointInPolygon(x, z, a.outer, a.holes));
    const s = r.surfaces!;
    let ribbonTris = 0;
    for (let k = 0; k < s.mesh.index.length; k += 3) {
      const v = [s.mesh.index[k], s.mesh.index[k + 1], s.mesh.index[k + 2]];
      if (!v.every((i) => Math.abs(s.lift[i] - RIBBON_LIFT_M) < 1e-6)) continue;
      ribbonTris++;
      expect(v.every((i) => onApron(s.mesh.position[i * 3], s.mesh.position[i * 3 + 2])), `asphalt ribbon triangle ${k / 3} inside the apron`).toBe(false);
    }
    expect(ribbonTris).toBeGreaterThan(20);
    // the line sits just above the apron well inside it, and above the ribbon everywhere else
    // (ribbon triangles straddling the apron edge still reach up to one ribbon step onto it)
    const m = r.markings!;
    const inset = settings.ribbonStepM + 2;
    const deep = (x: number, z: number) => f.aprons.some((a) => pointInPolygon(x, z, a.outer, a.holes)
      && distToRingSq(x, z, a.outer) >= inset * inset && a.holes.every((h) => distToRingSq(x, z, h) >= inset * inset));
    let inside = 0;
    for (let i = 0; i < m.lift.length; i++) {
      const x = m.mesh.position[i * 3], z = m.mesh.position[i * 3 + 2];
      if (deep(x, z)) { inside++; expect(m.lift[i]).toBeCloseTo(SURFACE_LIFT_M + MARKING_LIFT_M, 5); }
      else if (!near(x, z) && !onApron(x, z)) expect(m.lift[i]).toBeCloseTo(RIBBON_LIFT_M + MARKING_LIFT_M, 5);
    }
    expect(inside).toBeGreaterThan(20);
  });

  it('puts taxiway lights above the pavement they stand on (centre lines above ribbon + marking)', () => {
    const L = r.airportLights!;
    let green = 0;
    for (let i = 0; i < L.count; i++) {
      if (L.height[i] > 10) continue; // floodlight masts
      expect(L.height[i]).toBeGreaterThan(RIBBON_LIFT_M + MARKING_LIFT_M);
      if (L.color[i * 3 + 1] > 200 && L.color[i * 3] < 100) green++;
    }
    expect(green).toBeGreaterThan(10);
  });

  it('finds gates (named from ref) facing a taxiway, and stands inside the aprons', () => {
    const gates = r.parking.filter((p) => p.kind === 'gate');
    expect(gates.length).toBeGreaterThanOrEqual(8);
    expect(gates.some((g) => g.name === 'Gate A1')).toBe(true);
    const stands = r.parking.filter((p) => p.kind === 'stand');
    expect(stands.length).toBeGreaterThan(3);
    for (const s of stands) expect(f.aprons.some((a) => pointInPolygon(s.x, s.z, a.outer, a.holes))).toBe(true);
    for (const p of r.parking) {
      // heading points toward the nearest taxiway centre line
      let best = Infinity, bx = 0, bz = 0;
      for (const t of f.taxiwayLines) for (let i = 0; i + 3 < t.line.length; i += 2) {
        const ax = t.line[i], az = t.line[i + 1], ex = t.line[i + 2] - ax, ez = t.line[i + 3] - az;
        const l2 = ex * ex + ez * ez;
        const u = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / l2));
        const cx = ax + ex * u, cz = az + ez * u, d = Math.hypot(cx - p.x, cz - p.z);
        if (d < best) { best = d; bx = cx; bz = cz; }
      }
      const h = (p.headingDeg * Math.PI) / 180;
      const dot = (Math.sin(h) * (bx - p.x) + -Math.cos(h) * (bz - p.z)) / Math.max(best, 1e-6);
      expect(dot).toBeGreaterThan(0.99);
    }
  });

  it('is deterministic', () => {
    const again = buildTile(ap.bytes, ap.z, ap.x, ap.y, settings);
    expect(again.stats).toEqual(r.stats);
    expect(Array.from(again.surfaces!.mesh.position)).toEqual(Array.from(r.surfaces!.mesh.position));
    expect(again.parking).toEqual(r.parking);
  });

  it('scatters trees off buildings, roads and water, the same way every time, within the cap', () => {
    const c = tileBytesAt(CITY.lat, CITY.lon);
    const t1 = buildTile(c.bytes, c.z, c.x, c.y, settings);
    const t2 = buildTile(c.bytes, c.z, c.x, c.y, settings);
    expect(t1.trees).not.toBeNull();
    expect(Array.from(t1.trees!.broadleaf)).toEqual(Array.from(t2.trees!.broadleaf));
    expect(t1.trees!.count).toBeLessThanOrEqual(settings.maxTrees);
    const cf = extractFeatures(decodeTile(c.bytes), c.z, c.x, c.y, { minBuildingAreaM2: 0 });
    const all = [t1.trees!.conifer, t1.trees!.broadleaf];
    // one assertion over all tree × building pairs (an expect per pair took minutes on a loaded machine)
    let inBuilding = 0;
    for (const arr of all) for (let i = 0; i < arr.length; i += 4) {
      for (const b of cf.buildings) if (pointInPolygon(arr[i], arr[i + 1], b.outer, b.holes)) inBuilding++;
    }
    expect(inBuilding).toBe(0);
    const capped = buildTile(c.bytes, c.z, c.x, c.y, { ...settings, maxTrees: 100 });
    expect(capped.trees!.count).toBeLessThanOrEqual(100);
    expect(t1.streetlights!.count).toBeLessThanOrEqual(settings.maxStreetlights);
    expect(t1.stats.buildings).toBeGreaterThan(100);
  });

  it('clips features at the tile edge (no double drawing in the buffer) and skips hide_3d parts', () => {
    const bytes = encodeTile([{ name: 'building', features: [
      { type: 3, properties: { render_height: 10 }, geometry: orientPolygon([-200, 1000, 200, 1000, 200, 1400, -200, 1400]) },
      { type: 3, properties: { render_height: 10, hide_3d: true }, geometry: orientPolygon([1000, 1000, 1300, 1000, 1300, 1300, 1000, 1300]) },
    ] }]);
    const fx = extractFeatures(decodeTile(bytes), 14, 2621, 6341, { minBuildingAreaM2: 0 });
    expect(fx.buildings).toHaveLength(1);
    const unit = fx.projector.unitM;
    expect(Math.abs(signedArea(fx.buildings[0].outer)) / (200 * 400 * unit * unit)).toBeCloseTo(1, 2);
    expect(Array.from(fx.buildings[0].outerEdge!).filter((c) => c === 1)).toHaveLength(2);
  });

  it('maps layers with an extent other than 4096 to the same ground positions and tile edges', () => {
    // same building (crossing the west edge) and gate in a 4096 and a 512 extent layer
    const ring = (k: number) => orientPolygon([-200, 1000, 200, 1000, 200, 1400, -200, 1400].map((v) => v / k));
    const tile = (k: number) => encodeTile([
      { name: 'building', extent: 4096 / k, features: [{ type: 3, properties: { render_height: 10 }, geometry: ring(k) }] },
      { name: 'aeroway', extent: 4096 / k, features: [{ type: 1, properties: { class: 'gate', ref: 'A1' }, geometry: [[2048 / k, 1024 / k]] }] },
    ]);
    const a = extractFeatures(decodeTile(tile(1)), 14, 2621, 6341, { minBuildingAreaM2: 0 });
    const b = extractFeatures(decodeTile(tile(8)), 14, 2621, 6341, { minBuildingAreaM2: 0 });
    expect(b.buildings).toHaveLength(1);
    expect(b.buildings[0].outer.length).toBe(a.buildings[0].outer.length);
    for (let i = 0; i < a.buildings[0].outer.length; i++) expect(b.buildings[0].outer[i]).toBeCloseTo(a.buildings[0].outer[i], 6);
    expect(Array.from(b.buildings[0].outerEdge!)).toEqual(Array.from(a.buildings[0].outerEdge!));
    expect(b.gates).toHaveLength(1);
    expect(b.gates[0].x).toBeCloseTo(a.gates[0].x, 6);
    expect(b.gates[0].z).toBeCloseTo(a.gates[0].z, 6);
  });

  it('turns an empty or layer-less tile into an empty result, and garbage into a throw', () => {
    const e = buildTile(new Uint8Array(0), 14, 1, 1, settings);
    expect(e.buildings).toBeNull();
    expect(e.surfaces).toBeNull();
    expect(e.parking).toEqual([]);
    expect(() => buildTile(new Uint8Array([0x1a, 0xff, 0xff, 0xff, 0x0f, 1, 2]), 14, 1, 1, settings)).toThrow();
  });
});
