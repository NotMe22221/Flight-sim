/**
 * Dependency-free Mapbox Vector Tile 2.1 decoder (https://github.com/mapbox/vector-tile-spec/tree/master/2.1).
 *
 * Protobuf wire format: varints (up to 10 bytes, int64 two's complement), zigzag sint,
 * fixed32 float, fixed64 double, length-delimited strings / sub-messages and packed repeated
 * fields. Geometry is a packed stream of MoveTo(1) / LineTo(2) / ClosePath(7) commands with
 * zigzag delta parameters in tile coordinates (x right, y down, 0…extent).
 *
 * A malformed feature is skipped (counted in `errors`), never the whole tile; a malformed
 * tile throws `MvtError` from `decodeTile`.
 */

export const GEOM_UNKNOWN = 0;
export const GEOM_POINT = 1;
export const GEOM_LINESTRING = 2;
export const GEOM_POLYGON = 3;
export type GeomType = 0 | 1 | 2 | 3;
export type PropValue = string | number | boolean;

export interface VtFeature {
  id: number;
  type: GeomType;
  properties: Record<string, PropValue>;
  /**
   * Geometry parts as flat [x0, y0, x1, y1, …] arrays in tile coordinates:
   * points → one part holding every point; lines → one part per line;
   * polygons → one part per ring (closed implicitly, the first point is not repeated).
   */
  geometry: number[][];
}

export interface VtLayer {
  name: string;
  version: number;
  extent: number;
  features: VtFeature[];
}

export interface VectorTile {
  layers: Record<string, VtLayer>;
  /** features skipped because their geometry or tags were malformed */
  errors: number;
}

/** Polygon after ring classification: one exterior ring and its holes (flat xy arrays). */
export interface VtPolygon {
  outer: number[];
  holes: number[][];
}

export class MvtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MvtError';
  }
}

const TWO_32 = 4294967296;
const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

/** Minimal protobuf reader over a byte range. */
export class PbfReader {
  readonly buf: Uint8Array;
  pos: number;
  end: number;
  private readonly view: DataView;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get eof(): boolean { return this.pos >= this.end; }

  /** Unsigned varint as a JS number (exact up to 2^53). */
  readVarint(): number {
    if (this.pos < this.end) {
      const byte = this.buf[this.pos];
      if (byte < 0x80) { this.pos++; return byte; }
    }
    return this.varint64(false);
  }

  /** int64 varint (10-byte two's complement for negatives), exact for |v| < 2^53. */
  readInt64(): number { return this.varint64(true); }

  /** Varint split into low / high 32-bit words so that negative int64 values decode exactly. */
  private varint64(signed: boolean): number {
    const b = this.buf, end = this.end;
    let lo = 0, hi = 0, byte = 0;
    for (let i = 0; i < 4; i++) {
      if (this.pos >= end) throw new MvtError('pbf: truncated varint');
      byte = b[this.pos++];
      lo |= (byte & 0x7f) << (7 * i);
      if (byte < 0x80) return lo;
    }
    if (this.pos >= end) throw new MvtError('pbf: truncated varint');
    byte = b[this.pos++];
    lo |= (byte & 0x0f) << 28;
    hi = (byte & 0x70) >> 4;
    for (let i = 0; byte >= 0x80; i++) {
      if (i === 5) throw new MvtError('pbf: varint longer than 10 bytes');
      if (this.pos >= end) throw new MvtError('pbf: truncated varint');
      byte = b[this.pos++];
      hi |= (byte & 0x7f) << (3 + 7 * i);
    }
    return signed ? hi * TWO_32 + (lo >>> 0) : (hi >>> 0) * TWO_32 + (lo >>> 0);
  }

  /** zigzag-encoded sint32/sint64. */
  readSVarint(): number { return zigzagDecode(this.readVarint()); }

  readBool(): boolean { return this.readVarint() !== 0; }

  readFloat(): number {
    if (this.pos + 4 > this.end) throw new MvtError('pbf: truncated fixed32');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readDouble(): number {
    if (this.pos + 8 > this.end) throw new MvtError('pbf: truncated fixed64');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readFixed64(): number {
    if (this.pos + 8 > this.end) throw new MvtError('pbf: truncated fixed64');
    const lo = this.view.getUint32(this.pos, true), hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    return hi * TWO_32 + lo;
  }

  /** Length prefix of a length-delimited field; returns the end offset of its payload. */
  readLengthEnd(): number {
    const len = this.readVarint();
    const end = this.pos + len;
    if (end > this.end) throw new MvtError('pbf: length-delimited field overruns its message');
    return end;
  }

  readString(): string {
    const end = this.readLengthEnd();
    const s = decodeUtf8(this.buf, this.pos, end);
    this.pos = end;
    return s;
  }

  /** Packed (wire type 2) or single (wire type 0) repeated uint32 values appended to `out`. */
  readPackedVarints(wireType: number, out: number[]): number[] {
    if (wireType === 0) { out.push(this.readVarint()); return out; }
    if (wireType !== 2) throw new MvtError(`pbf: wire type ${wireType} for a packed field`);
    const end = this.readLengthEnd();
    const outer = this.end;
    this.end = end;
    while (this.pos < end) out.push(this.readVarint());
    this.end = outer;
    return out;
  }

  /** Skip a field of the given wire type. */
  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.readVarint(); break;
      case 1: this.pos += 8; break;
      case 2: this.pos = this.readLengthEnd(); break;
      case 5: this.pos += 4; break;
      default: throw new MvtError(`pbf: unsupported wire type ${wireType}`);
    }
    if (this.pos > this.end) throw new MvtError('pbf: field overruns its message');
  }
}

export const zigzagDecode = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  if (utf8) return utf8.decode(buf.subarray(start, end));
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}

/** Decode a whole vector tile. Throws `MvtError` when the tile-level structure is corrupt. */
export function decodeTile(bytes: Uint8Array): VectorTile {
  const r = new PbfReader(bytes);
  const tile: VectorTile = { layers: {}, errors: 0 };
  while (!r.eof) {
    const tag = r.readVarint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 3 && wire === 2) {
      const end = r.readLengthEnd();
      const layer = decodeLayer(r, end, tile);
      r.pos = end;
      // a later layer with the same name is merged (spec: names must be unique; be lenient)
      const prev = tile.layers[layer.name];
      if (prev) prev.features.push(...layer.features);
      else tile.layers[layer.name] = layer;
    } else {
      r.skip(wire);
    }
  }
  return tile;
}

function decodeLayer(r: PbfReader, end: number, tile: VectorTile): VtLayer {
  const outerEnd = r.end;
  r.end = end;
  let name = '', version = 1, extent = 4096;
  const keys: string[] = [];
  const values: PropValue[] = [];
  const featureRanges: number[] = [];
  while (r.pos < end) {
    const tag = r.readVarint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 1 && wire === 2) name = r.readString();
    else if (field === 2 && wire === 2) { const fe = r.readLengthEnd(); featureRanges.push(r.pos, fe); r.pos = fe; }
    else if (field === 3 && wire === 2) keys.push(r.readString());
    else if (field === 4 && wire === 2) { const ve = r.readLengthEnd(); values.push(decodeValue(r, ve)); r.pos = ve; }
    else if (field === 5 && wire === 0) extent = r.readVarint();
    else if (field === 15 && wire === 0) version = r.readVarint();
    else r.skip(wire);
  }
  r.end = outerEnd;
  if (!(extent > 0)) extent = 4096;
  const features: VtFeature[] = [];
  for (let i = 0; i < featureRanges.length; i += 2) {
    try {
      const f = decodeFeature(new PbfReader(r.buf, featureRanges[i], featureRanges[i + 1]), keys, values);
      if (f) features.push(f);
    } catch {
      tile.errors++;
    }
  }
  return { name, version, extent, features };
}

function decodeValue(r: PbfReader, end: number): PropValue {
  const outerEnd = r.end;
  r.end = end;
  let v: PropValue = '';
  while (r.pos < end) {
    const tag = r.readVarint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 1 && wire === 2) v = r.readString();
    else if (field === 2 && wire === 5) v = r.readFloat();
    else if (field === 3 && wire === 1) v = r.readDouble();
    else if (field === 4 && wire === 0) v = r.readInt64();
    else if (field === 5 && wire === 0) v = r.readVarint();
    else if (field === 6 && wire === 0) v = r.readSVarint();
    else if (field === 7 && wire === 0) v = r.readBool();
    else r.skip(wire);
  }
  r.end = outerEnd;
  return v;
}

const tagScratch: number[] = [];
const geomScratch: number[] = [];

function decodeFeature(r: PbfReader, keys: string[], values: PropValue[]): VtFeature | null {
  let id = 0;
  let type: GeomType = GEOM_UNKNOWN;
  tagScratch.length = 0;
  geomScratch.length = 0;
  while (!r.eof) {
    const tag = r.readVarint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 1 && wire === 0) id = r.readVarint();
    else if (field === 1 && wire === 1) id = r.readFixed64();
    else if (field === 2) r.readPackedVarints(wire, tagScratch);
    else if (field === 3 && wire === 0) { const t = r.readVarint(); type = (t >= 0 && t <= 3 ? t : 0) as GeomType; }
    else if (field === 4) r.readPackedVarints(wire, geomScratch);
    else r.skip(wire);
  }
  if (tagScratch.length % 2 !== 0) throw new MvtError('mvt: odd tag count');
  const properties: Record<string, PropValue> = {};
  for (let i = 0; i < tagScratch.length; i += 2) {
    const k = keys[tagScratch[i]], v = values[tagScratch[i + 1]];
    if (k === undefined || v === undefined) throw new MvtError('mvt: tag index out of range');
    properties[k] = v;
  }
  if (type === GEOM_UNKNOWN) return null;
  const geometry = decodeGeometry(geomScratch, type);
  if (geometry.length === 0) return null;
  return { id, type, properties, geometry };
}

/** Decode a command stream into parts (see `VtFeature.geometry`). Throws on malformed input. */
export function decodeGeometry(cmds: ArrayLike<number>, type: GeomType): number[][] {
  const parts: number[][] = [];
  let x = 0, y = 0;
  let cur: number[] | null = null;
  const points: number[] = [];
  const n = cmds.length;
  let i = 0;
  while (i < n) {
    const ci = cmds[i++];
    const id = ci & 7, count = Math.floor(ci / 8);
    if (id === 1) {
      if (i + 2 * count > n) throw new MvtError('mvt: MoveTo parameters overrun');
      for (let k = 0; k < count; k++) {
        x += zigzagDecode(cmds[i++]);
        y += zigzagDecode(cmds[i++]);
        if (type === GEOM_POINT) points.push(x, y);
        else { cur = [x, y]; parts.push(cur); }
      }
    } else if (id === 2) {
      if (!cur || type === GEOM_POINT) throw new MvtError('mvt: LineTo without MoveTo');
      if (i + 2 * count > n) throw new MvtError('mvt: LineTo parameters overrun');
      for (let k = 0; k < count; k++) {
        x += zigzagDecode(cmds[i++]);
        y += zigzagDecode(cmds[i++]);
        cur.push(x, y);
      }
    } else if (id === 7) {
      if (type !== GEOM_POLYGON || !cur) throw new MvtError('mvt: ClosePath outside a polygon ring');
      // the ring is closed implicitly; drop an explicit duplicate of the first point
      const m = cur.length;
      if (m >= 4 && cur[m - 2] === cur[0] && cur[m - 1] === cur[1]) cur.length = m - 2;
    } else {
      throw new MvtError(`mvt: unknown command ${id}`);
    }
  }
  if (type === GEOM_POINT) return points.length ? [points] : [];
  if (type === GEOM_LINESTRING) return parts.filter((p) => p.length >= 4);
  return parts.filter((p) => p.length >= 6);
}

/** Signed ring area by the surveyor's formula in tile coordinates (y down): > 0 is an exterior ring per MVT 2.1. */
export function ringArea(ring: ArrayLike<number>): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) s += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return s / 2;
}

/**
 * Group polygon rings into polygons: each exterior ring (positive area) starts a polygon and
 * the following interior rings (negative area) are its holes. Zero-area rings are dropped.
 * Like other decoders, the sign of the first ring defines "exterior" so tiles written with
 * the opposite (v1) winding still decode.
 */
export function classifyRings(rings: number[][]): VtPolygon[] {
  const out: VtPolygon[] = [];
  let exteriorSign = 0;
  let cur: VtPolygon | null = null;
  for (const ring of rings) {
    const a = ringArea(ring);
    if (a === 0 || !Number.isFinite(a)) continue;
    if (exteriorSign === 0) exteriorSign = a > 0 ? 1 : -1;
    if ((a > 0 ? 1 : -1) === exteriorSign) {
      cur = { outer: ring, holes: [] };
      out.push(cur);
    } else if (cur) {
      cur.holes.push(ring);
    }
  }
  return out;
}

/** Convenience: property as number (numeric strings accepted), or the fallback. */
export function numProp(p: Record<string, PropValue>, key: string, fallback: number): number {
  const v = p[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return fallback;
}

export function strProp(p: Record<string, PropValue>, key: string): string {
  const v = p[key];
  return v === undefined ? '' : String(v);
}

export function boolProp(p: Record<string, PropValue>, key: string): boolean {
  const v = p[key];
  return v === true || v === 1 || v === 'true' || v === 'yes' || v === '1';
}
