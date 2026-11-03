import { describe, expect, it } from 'vitest';
import { GEOM_LINESTRING, GEOM_POINT, GEOM_POLYGON, MvtError, PbfReader, classifyRings, decodeGeometry, decodeTile, numProp, ringArea, zigzagDecode } from './mvt';
import { PbfWriter, encodeGeometry, encodeTile, orientPolygon, signedArea } from './dev/mvtEncoder';

describe('protobuf primitives', () => {
  it('reads varints of every length, including 10-byte negative int64', () => {
    const values = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 2 ** 31, 2 ** 32 + 5, 2 ** 45 + 7, 2 ** 53 - 1];
    const w = new PbfWriter();
    for (const v of values) w.varint(v);
    w.varint(-1).varint(-5).varint(-(2 ** 40) - 3);
    const r = new PbfReader(w.finish());
    for (const v of values) expect(r.readVarint()).toBe(v);
    expect(r.readInt64()).toBe(-1);
    expect(r.readInt64()).toBe(-5);
    expect(r.readInt64()).toBe(-(2 ** 40) - 3);
    expect(r.eof).toBe(true);
  });

  it('zigzag decodes', () => {
    expect([0, 1, 2, 3, 4, 4294967294, 4294967295].map(zigzagDecode)).toEqual([0, -1, 1, -2, 2, 2147483647, -2147483648]);
    const w = new PbfWriter();
    for (const v of [0, -1, 1, -64, 64, -123456789, 987654321]) w.svarint(v);
    const r = new PbfReader(w.finish());
    expect([0, 0, 0, 0, 0, 0, 0].map(() => r.readSVarint())).toEqual([0, -1, 1, -64, 64, -123456789, 987654321]);
  });

  it('reads packed fields and fixed32 / fixed64', () => {
    const w = new PbfWriter();
    w.tag(4, 2).packed([9, 50, 34, 300]);
    w.float(1.5).double(-2.25);
    const r = new PbfReader(w.finish());
    const tag = r.readVarint();
    expect(tag >>> 3).toBe(4);
    expect(r.readPackedVarints(tag & 7, [])).toEqual([9, 50, 34, 300]);
    expect(r.readFloat()).toBe(1.5);
    expect(r.readDouble()).toBe(-2.25);
  });

  it('throws on truncated input', () => {
    expect(() => new PbfReader(new Uint8Array([0x80, 0x80])).readVarint()).toThrow(MvtError);
    const w = new PbfWriter();
    w.tag(3, 2).varint(50).varint(1);
    expect(() => decodeTile(w.finish())).toThrow(MvtError);
  });
});

describe('geometry commands', () => {
  it('decodes the spec examples (point, line, polygon)', () => {
    // MVT 2.1 spec §4.3.5 examples
    expect(decodeGeometry([9, 50, 34], GEOM_POINT)).toEqual([[25, 17]]);
    expect(decodeGeometry([17, 10, 14, 3, 9], GEOM_POINT)).toEqual([[5, 7, 3, 2]]);
    expect(decodeGeometry([9, 4, 4, 18, 0, 16, 16, 0], GEOM_LINESTRING)).toEqual([[2, 2, 2, 10, 10, 10]]);
    expect(decodeGeometry([9, 4, 4, 18, 0, 16, 16, 0, 9, 17, 17, 10, 4, 8], GEOM_LINESTRING)).toEqual([[2, 2, 2, 10, 10, 10], [1, 1, 3, 5]]);
    expect(decodeGeometry([9, 6, 12, 18, 10, 12, 24, 44, 15], GEOM_POLYGON)).toEqual([[3, 6, 8, 12, 20, 34]]);
  });

  it('round-trips the encoder and rejects malformed streams', () => {
    const parts = [[0, 0, 100, 0, 100, 100, 0, 100], [20, 20, 20, 80, 80, 80, 80, 20]];
    expect(decodeGeometry(encodeGeometry(3, parts), GEOM_POLYGON)).toEqual(parts);
    expect(decodeGeometry(encodeGeometry(2, [[5, 5, 9, -3, 4000, 4096]]), GEOM_LINESTRING)).toEqual([[5, 5, 9, -3, 4000, 4096]]);
    expect(() => decodeGeometry([18, 2, 2], GEOM_LINESTRING)).toThrow(MvtError); // LineTo first
    expect(() => decodeGeometry([9, 2], GEOM_POINT)).toThrow(MvtError); // missing parameter
    expect(() => decodeGeometry([12, 0, 0], GEOM_POINT)).toThrow(MvtError); // command 4
  });

  it('classifies rings by winding: exterior positive area, holes follow', () => {
    const [outer, hole] = orientPolygon([0, 0, 0, 100, 100, 100, 100, 0], [[20, 20, 80, 20, 80, 80, 20, 80]]);
    expect(ringArea(outer)).toBeGreaterThan(0);
    expect(ringArea(hole)).toBeLessThan(0);
    const [outer2] = orientPolygon([200, 0, 300, 0, 300, 100, 200, 100]);
    const polys = classifyRings([outer, hole, outer2]);
    expect(polys).toHaveLength(2);
    expect(polys[0].holes).toHaveLength(1);
    expect(polys[1].holes).toHaveLength(0);
    // zero-area rings are dropped; reversed (v1) winding still groups correctly
    expect(classifyRings([[0, 0, 10, 0, 20, 0]])).toHaveLength(0);
    const rev = classifyRings([flip(outer), flip(hole)]);
    expect(rev).toHaveLength(1);
    expect(rev[0].holes).toHaveLength(1);
    expect(signedArea(outer)).toBe(ringArea(outer));
  });
});

/** reverse a flat xy ring */
function flip(r: number[]): number[] {
  const o: number[] = [];
  for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]);
  return o;
}

describe('decodeTile', () => {
  it('decodes several layers with typed property values', () => {
    const bytes = encodeTile([
      {
        name: 'building',
        features: [
          { id: 42, type: 3, properties: { render_height: 25, render_min_height: 0, colour: '#aabbcc', hide_3d: false }, geometry: orientPolygon([10, 10, 10, 60, 60, 60, 60, 10]) },
          { id: 43, type: 3, properties: { render_height: 7.5 }, geometry: orientPolygon([100, 100, 100, 150, 150, 150, 150, 100]) },
        ],
      },
      {
        name: 'aeroway',
        extent: 8192,
        features: [
          { type: 1, properties: { class: 'gate', ref: 'A12' }, geometry: [[500, 600]] },
          { type: 2, properties: { class: 'taxiway', ref: 'B' }, geometry: [[0, 0, 100, 100, 200, 100]] },
        ],
      },
      {
        name: 'misc',
        features: [{ type: 1, properties: { f: { kind: 'float', value: 1.25 }, d: { kind: 'double', value: -7.125 }, i: { kind: 'int', value: -9 }, u: { kind: 'uint', value: 2 ** 40 }, s: { kind: 'sint', value: -3 }, b: true, neg: -12 }, geometry: [[1, 2]] }],
      },
    ]);
    const t = decodeTile(bytes);
    expect(Object.keys(t.layers).sort()).toEqual(['aeroway', 'building', 'misc']);
    expect(t.errors).toBe(0);
    const b = t.layers.building;
    expect(b.extent).toBe(4096);
    expect(b.version).toBe(2);
    expect(b.features).toHaveLength(2);
    expect(b.features[0].id).toBe(42);
    expect(b.features[0].properties).toEqual({ render_height: 25, render_min_height: 0, colour: '#aabbcc', hide_3d: false });
    expect(b.features[1].properties.render_height).toBe(7.5);
    expect(b.features[0].type).toBe(GEOM_POLYGON);
    const a = t.layers.aeroway;
    expect(a.extent).toBe(8192);
    expect(a.features[0].geometry).toEqual([[500, 600]]);
    expect(a.features[1].geometry).toEqual([[0, 0, 100, 100, 200, 100]]);
    expect(a.features[1].properties.ref).toBe('B');
    const m = t.layers.misc.features[0].properties;
    expect(m).toEqual({ f: 1.25, d: -7.125, i: -9, u: 2 ** 40, s: -3, b: true, neg: -12 });
    expect(numProp(m, 'missing', 3)).toBe(3);
  });

  it('skips a malformed feature but keeps the rest of the layer', () => {
    const good = encodeTile([{ name: 'l', features: [{ type: 1, geometry: [[1, 1]] }, { type: 1, geometry: [[2, 2]] }] }]);
    // corrupt the second feature's geometry: replace its MoveTo command count with a huge one
    const t0 = decodeTile(good);
    expect(t0.layers.l.features).toHaveLength(2);
    const w = new PbfWriter();
    w.message(3, (lw) => {
      lw.tag(1, 2).string('l');
      lw.message(2, (fw) => { fw.tag(3, 0).varint(1); fw.tag(4, 2).packed([9, 2, 2]); });
      lw.message(2, (fw) => { fw.tag(3, 0).varint(1); fw.tag(4, 2).packed([9 + 8 * 50, 2, 2]); });
      lw.message(2, (fw) => { fw.tag(2, 2).packed([0, 7]); fw.tag(3, 0).varint(1); fw.tag(4, 2).packed([9, 4, 4]); });
      lw.tag(3, 2).string('k');
      lw.message(4, (vw) => vw.tag(1, 2).string('v'));
    });
    const t = decodeTile(w.finish());
    expect(t.layers.l.features).toHaveLength(1);
    expect(t.errors).toBe(2);
  });

  it('decodes an empty buffer as a tile without layers', () => {
    expect(decodeTile(new Uint8Array(0))).toEqual({ layers: {}, errors: 0 });
  });
});
