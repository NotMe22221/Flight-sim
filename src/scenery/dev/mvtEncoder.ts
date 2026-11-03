/**
 * Minimal Mapbox Vector Tile 2.1 encoder for tests and the dev fixture generator.
 * Never imported by the app. Writes exactly what the decoder in ../mvt.ts reads:
 * layers (version 2), deduplicated key/value tables, packed tags and geometry commands.
 *
 * Rings are written as given: callers pass exterior rings with positive surveyor area in tile
 * coordinates (clockwise on screen, y down) and holes with negative area (`orientPolygon`).
 */

export type EncValue = string | number | boolean | { kind: 'float' | 'double' | 'int' | 'uint' | 'sint'; value: number };

export interface EncFeature {
  id?: number;
  /** 1 point, 2 line string, 3 polygon */
  type: 1 | 2 | 3;
  properties?: Record<string, EncValue>;
  /** parts in tile coordinates: points → one part with every point; lines → one per line; polygons → rings without the closing point */
  geometry: number[][];
}

export interface EncLayer {
  name: string;
  extent?: number;
  version?: number;
  features: EncFeature[];
}

export class PbfWriter {
  buf = new Uint8Array(1024);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.pos + n) len *= 2;
    const b = new Uint8Array(len);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }

  /** Unsigned varint; negative numbers are written as 10-byte two's complement (int64). */
  varint(v: number): this {
    this.ensure(10);
    if (v < 0) {
      // int64 two's complement from exact 32-bit words
      const hiS = Math.floor(v / 4294967296);
      let lo = v - hiS * 4294967296;
      let hi = hiS + 4294967296;
      for (let i = 0; i < 4; i++) { this.buf[this.pos++] = (lo & 0x7f) | 0x80; lo = Math.floor(lo / 128); }
      this.buf[this.pos++] = (lo & 0x0f) | ((hi & 0x07) << 4) | 0x80;
      hi = Math.floor(hi / 8);
      while (hi >= 128) { this.buf[this.pos++] = (hi & 0x7f) | 0x80; hi = Math.floor(hi / 128); }
      this.buf[this.pos++] = hi;
      return this;
    }
    while (v >= 128) {
      this.buf[this.pos++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
    return this;
  }

  svarint(v: number): this { return this.varint(v < 0 ? -2 * v - 1 : 2 * v); }

  tag(field: number, wire: number): this { return this.varint(field * 8 + wire); }

  bytes(b: Uint8Array): this {
    this.varint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  string(s: string): this { return this.bytes(new TextEncoder().encode(s)); }

  float(v: number): this {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  double(v: number): this {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  packed(values: readonly number[]): this {
    const w = new PbfWriter();
    for (const v of values) w.varint(v);
    return this.bytes(w.finish());
  }

  message(field: number, write: (w: PbfWriter) => void): this {
    const w = new PbfWriter();
    write(w);
    return this.tag(field, 2).bytes(w.finish());
  }

  finish(): Uint8Array { return this.buf.slice(0, this.pos); }
}

const zz = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id: number, count: number): number => (id & 7) | (count << 3);

/** Geometry command stream for one feature. */
export function encodeGeometry(type: 1 | 2 | 3, parts: number[][]): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  const moveRel = (px: number, py: number) => {
    const dx = Math.round(px) - x, dy = Math.round(py) - y;
    x += dx; y += dy;
    out.push(zz(dx), zz(dy));
  };
  if (type === 1) {
    const pts = parts.flat();
    if (pts.length < 2) return out;
    out.push(command(1, pts.length / 2));
    for (let i = 0; i < pts.length; i += 2) moveRel(pts[i], pts[i + 1]);
    return out;
  }
  for (const p of parts) {
    const n = p.length / 2;
    if (n < (type === 2 ? 2 : 3)) continue;
    out.push(command(1, 1));
    moveRel(p[0], p[1]);
    out.push(command(2, n - 1));
    for (let i = 2; i < p.length; i += 2) moveRel(p[i], p[i + 1]);
    if (type === 3) out.push(command(7, 1));
  }
  return out;
}

const valueKey = (v: EncValue): string => (typeof v === 'object' ? `${v.kind}:${v.value}` : `${typeof v}:${String(v)}`);

function writeValue(w: PbfWriter, v: EncValue): void {
  if (typeof v === 'string') w.tag(1, 2).string(v);
  else if (typeof v === 'boolean') w.tag(7, 0).varint(v ? 1 : 0);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
      if (v < 0) w.tag(6, 0).svarint(v);
      else w.tag(5, 0).varint(v);
    } else w.tag(3, 1).double(v);
  } else {
    switch (v.kind) {
      case 'float': w.tag(2, 5).float(v.value); break;
      case 'double': w.tag(3, 1).double(v.value); break;
      case 'int': w.tag(4, 0).varint(v.value); break;
      case 'uint': w.tag(5, 0).varint(v.value); break;
      case 'sint': w.tag(6, 0).svarint(v.value); break;
    }
  }
}

export function encodeLayer(w: PbfWriter, layer: EncLayer): void {
  w.message(3, (lw) => {
    lw.tag(15, 0).varint(layer.version ?? 2);
    lw.tag(1, 2).string(layer.name);
    const keys: string[] = [], keyIdx = new Map<string, number>();
    const values: EncValue[] = [], valIdx = new Map<string, number>();
    const featureTags: number[][] = [];
    for (const f of layer.features) {
      const tags: number[] = [];
      for (const [k, v] of Object.entries(f.properties ?? {})) {
        let ki = keyIdx.get(k);
        if (ki === undefined) { ki = keys.length; keys.push(k); keyIdx.set(k, ki); }
        const vk = valueKey(v);
        let vi = valIdx.get(vk);
        if (vi === undefined) { vi = values.length; values.push(v); valIdx.set(vk, vi); }
        tags.push(ki, vi);
      }
      featureTags.push(tags);
    }
    layer.features.forEach((f, i) => {
      lw.message(2, (fw) => {
        if (f.id !== undefined) fw.tag(1, 0).varint(f.id);
        if (featureTags[i].length) fw.tag(2, 2).packed(featureTags[i]);
        fw.tag(3, 0).varint(f.type);
        fw.tag(4, 2).packed(encodeGeometry(f.type, f.geometry));
      });
    });
    for (const k of keys) lw.tag(3, 2).string(k);
    for (const v of values) lw.message(4, (vw) => writeValue(vw, v));
    lw.tag(5, 0).varint(layer.extent ?? 4096);
  });
}

/** Encode layers into a tile. */
export function encodeTile(layers: readonly EncLayer[]): Uint8Array {
  const w = new PbfWriter();
  for (const l of layers) encodeLayer(w, l);
  return w.finish();
}

/** Surveyor's area in tile coordinates (y down); positive = exterior per MVT 2.1. */
export function signedArea(ring: readonly number[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) s += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return s / 2;
}

function reverseRing(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1]);
  return out;
}

/** Orient rings as MVT 2.1 requires: exterior positive area, holes negative. */
export function orientPolygon(outer: number[], holes: number[][] = []): number[][] {
  const o = signedArea(outer) > 0 ? outer : reverseRing(outer);
  return [o, ...holes.map((h) => (signedArea(h) < 0 ? h : reverseRing(h)))];
}
