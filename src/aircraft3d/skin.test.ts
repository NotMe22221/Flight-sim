import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { c172ModelConfig, resolveC172Layout } from './c172Layout';
import { LoftProfile } from './loft';
import { buildSkin, inside, outlineField, outside, shrinkConvex, type SkinOutline } from './skin';

const L = resolveC172Layout(c172ModelConfig());
const profile = new LoftProfile(L.fuselage.stations);

/** Triangle centroids of a non-indexed geometry. */
function centroids(g: THREE.BufferGeometry): THREE.Vector3[] {
  const p = g.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i += 3) {
    out.push(new THREE.Vector3(
      (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3,
      (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3,
      (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3,
    ));
  }
  return out;
}

describe('outlineField', () => {
  const sq: SkinOutline = { name: 'sq', side: 'right', radius: 0.1, outline: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  const f = outlineField(sq);
  it('is negative inside, positive outside, zero on the edge, rounded at the corners', () => {
    expect(f(0.5, 0.5, 0.5)).toBeCloseTo(-0.5, 6);
    expect(f(0.5, 0.5, 1.2)).toBeCloseTo(0.2, 6);
    expect(f(0.5, 0, 0.5)).toBeCloseTo(0, 6);
    // the corner is rounded with r = 0.1: the sharp corner point lies outside
    expect(f(0.5, 0, 0)).toBeCloseTo(0.1 * Math.SQRT2 - 0.1, 6);
  });
  it('a short edge collapses cleanly when the corner radius exceeds it (door window front edge)', () => {
    // 6 cm front edge, 5 cm radius: the offset polygon must stay convex and contain the centre
    const door: SkinOutline = { name: 'door', side: 'left', radius: 0.05, outline: [[-0.83, 0.26], [0.37, 0.26], [0.37, 0.73], [-0.237, 0.73], [-0.83, 0.32]] };
    const core = shrinkConvex(door.outline, 0.05);
    for (let i = 0; i < core.length; i++) {
      const [a, b, c] = [core[i], core[(i + 1) % core.length], core[(i + 2) % core.length]];
      expect((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(outlineField(door)(-0.53, 0.56, -0.1)).toBeLessThan(-0.1);
    expect(outlineField(door)(-0.53, 0.2, -0.1)).toBeGreaterThan(0);
  });
  it('only applies to its own side of the fuselage', () => {
    expect(f(-0.5, 0.5, 0.5)).toBeGreaterThan(0);
    expect(outlineField({ ...sq, side: 'left' })(-0.5, 0.5, 0.5)).toBeLessThan(0);
    expect(outlineField({ ...sq, side: 'both' })(-0.5, 0.5, 0.5)).toBeLessThan(0);
  });
});

describe('buildSkin window cut-outs', () => {
  const win = L.windows;
  const fields = win.map(outlineField);
  const F = L.fuselage;
  const skin = buildSkin(profile, { z0: F.cowlEndZ, z1: F.cabinEndZ, dz: 0.04, radial: 72, keep: fields.map(outside) }).geometry;

  it('every window outline has a centre inside it that lies on the skin of its side', () => {
    for (const [i, w] of win.entries()) {
      const zc = w.outline.reduce((a, q) => a + q[0], 0) / w.outline.length;
      // a point on the skin at that station, on the window's side, inside the outline
      let found = false;
      for (let t = 0; t < 2 * Math.PI && !found; t += 0.01) {
        const p = profile.pointAt(zc, t, new THREE.Vector3());
        if (fields[i](p.x, p.y, p.z) < -0.03) found = true;
      }
      expect(found, w.name).toBe(true);
    }
  });

  it('leaves no skin triangle inside a window and keeps the skin between them', () => {
    const cs = centroids(skin);
    for (const c of cs) for (const f of fields) expect(f(c.x, c.y, c.z)).toBeGreaterThan(-0.02);
    // the B-pillar between the door and rear side windows is skin on both sides
    for (const side of [1, -1]) {
      const near = cs.filter((c) => Math.sign(c.x) === side && Math.abs(c.z - 0.42) < 0.02 && Math.abs(c.y - 0.5) < 0.05);
      expect(near.length, `B-pillar ${side}`).toBeGreaterThan(0);
    }
  });

  it('glass fills exactly the cut-out (area of skin + glass ≈ area of the uncut skin)', () => {
    const area = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute('position');
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      let s = 0;
      for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
        s += b.sub(a).cross(c.sub(a)).length() / 2;
      }
      return s;
    };
    const full = area(buildSkin(profile, { z0: F.cowlEndZ, z1: F.cabinEndZ, dz: 0.04, radial: 72 }).geometry);
    const glass = fields.reduce((s, f) => s + area(buildSkin(profile, { z0: F.cowlEndZ, z1: F.cabinEndZ, dz: 0.04, radial: 72, keep: [inside(f)] }).geometry), 0);
    expect(glass).toBeGreaterThan(1.0);
    expect(area(skin) + glass).toBeCloseTo(full, 2);
  });

  it('faces outward (normals agree with the triangle winding)', () => {
    const p = skin.getAttribute('position'), n = skin.getAttribute('normal');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
    let bad = 0;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      const geo = b.sub(a).cross(c.sub(a));
      nn.fromBufferAttribute(n, i);
      if (geo.lengthSq() > 1e-12 && geo.dot(nn) < 0) bad++;
    }
    expect(bad).toBe(0);
  });
});
