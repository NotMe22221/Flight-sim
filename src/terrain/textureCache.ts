/**
 * Reference-counted imagery textures. Several terrain tiles share one imagery tile (EOX stops
 * at z14, GIBS at z8), so the texture is created once per imagery tile and disposed when the
 * last terrain tile using it is evicted. ImageBitmaps are closed on disposal.
 */
import type { Texture } from 'three';

interface Entry { texture: Texture; refs: number }

/** Free the GPU texture and, for ImageBitmap sources, the decoded pixels. */
export function disposeTexture(texture: Texture): void {
  const img: unknown = texture.image;
  texture.dispose();
  if (typeof img === 'object' && img !== null && typeof (img as { close?: unknown }).close === 'function') {
    (img as ImageBitmap).close();
  }
}

export class TextureCache {
  private readonly entries = new Map<string, Entry>();

  /** Number of distinct textures alive. */
  get size(): number { return this.entries.size; }

  /** Take a reference to the texture stored under `key`, or undefined when absent. */
  acquire(key: string): Texture | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.refs++;
    return e.texture;
  }

  /** Store a new texture with one reference. Replaces nothing: callers `acquire` first. */
  add(key: string, texture: Texture): Texture {
    this.entries.set(key, { texture, refs: 1 });
    return texture;
  }

  /** Drop one reference; the texture is disposed when none remain. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    if (--e.refs > 0) return;
    this.entries.delete(key);
    disposeTexture(e.texture);
  }

  /** Dispose every texture regardless of references. */
  dispose(): void {
    for (const e of this.entries.values()) disposeTexture(e.texture);
    this.entries.clear();
  }
}
