/**
 * Growable vertex / index accumulator for merged tile meshes (worker side, no Three.js).
 */
import type { MeshData } from './protocol';

export class MeshBuilder {
  readonly withUv: boolean;
  readonly withColor: boolean;
  private pos: Float32Array;
  private nrm: Float32Array;
  private uvs: Float32Array;
  private col: Uint8Array;
  private idx: Uint32Array;
  vertexCount = 0;
  indexCount = 0;

  constructor(withUv: boolean, withColor: boolean, initialVertices = 1024) {
    this.withUv = withUv;
    this.withColor = withColor;
    const n = Math.max(16, initialVertices);
    this.pos = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.uvs = new Float32Array(withUv ? n * 2 : 0);
    this.col = new Uint8Array(withColor ? n * 3 : 0);
    this.idx = new Uint32Array(n * 2);
  }

  get triangleCount(): number { return this.indexCount / 3; }

  private growVertices(min: number): void {
    let n = this.pos.length / 3;
    while (n < min) n *= 2;
    const grow = <T extends Float32Array | Uint8Array>(a: T, k: number, make: (len: number) => T): T => {
      if (a.length === 0) return a;
      const b = make(n * k);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos, 3, (l) => new Float32Array(l));
    this.nrm = grow(this.nrm, 3, (l) => new Float32Array(l));
    this.uvs = grow(this.uvs, 2, (l) => new Float32Array(l));
    this.col = grow(this.col, 3, (l) => new Uint8Array(l));
  }

  /** Append a vertex; returns its index. */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, r = 255, g = 255, b = 255): number {
    const i = this.vertexCount;
    if ((i + 1) * 3 > this.pos.length) this.growVertices(i + 1);
    const p = i * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz;
    if (this.withUv) { this.uvs[i * 2] = u; this.uvs[i * 2 + 1] = v; }
    if (this.withColor) { this.col[p] = r; this.col[p + 1] = g; this.col[p + 2] = b; }
    this.vertexCount = i + 1;
    return i;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.idx.length) {
      const n = new Uint32Array(this.idx.length * 2);
      n.set(this.idx);
      this.idx = n;
    }
    this.idx[this.indexCount++] = a;
    this.idx[this.indexCount++] = b;
    this.idx[this.indexCount++] = c;
  }

  /** Read back a vertex position (for tests / post-processing). */
  getY(i: number): number { return this.pos[i * 3 + 1]; }
  setY(i: number, y: number): void { this.pos[i * 3 + 1] = y; }
  getX(i: number): number { return this.pos[i * 3]; }
  getZ(i: number): number { return this.pos[i * 3 + 2]; }

  /** Copy the index range [from, to) of triangles into a new order (used to sort by importance). */
  indexSlice(from: number, to: number): Uint32Array { return this.idx.slice(from, to); }

  replaceIndices(order: Uint32Array): void {
    if (order.length !== this.indexCount) throw new Error('MeshBuilder: index count mismatch');
    this.idx.set(order);
  }

  finish(): MeshData {
    const v = this.vertexCount;
    return {
      position: this.pos.slice(0, v * 3),
      normal: this.nrm.slice(0, v * 3),
      uv: this.withUv ? this.uvs.slice(0, v * 2) : null,
      color: this.withColor ? this.col.slice(0, v * 3) : null,
      index: this.idx.slice(0, this.indexCount),
    };
  }
}

/** Growable Float32 list. */
export class FloatList {
  data: Float32Array;
  length = 0;
  constructor(initial = 256) { this.data = new Float32Array(Math.max(8, initial)); }
  push(v: number): void {
    if (this.length >= this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data[this.length++] = v;
  }
  push2(a: number, b: number): void { this.push(a); this.push(b); }
  finish(): Float32Array { return this.data.slice(0, this.length); }
}

/** Growable Uint8 list. */
export class ByteList {
  data: Uint8Array;
  length = 0;
  constructor(initial = 256) { this.data = new Uint8Array(Math.max(8, initial)); }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const n = new Uint8Array(this.data.length * 2 + 3);
      n.set(this.data);
      this.data = n;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  finish(): Uint8Array { return this.data.slice(0, this.length); }
}
