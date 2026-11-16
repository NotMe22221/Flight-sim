/**
 * The taxi-ribbon assist (MSFS "taxi ribbon"): a strip of blue chevrons on the ground along the
 * taxi route to the runway. Geometry is rebuilt only when the route or the floating-origin frame
 * changes; the strip is draped on the ground height every 3 m and lifted a few centimetres.
 */
import * as THREE from 'three';
import type { LocalFrame } from '../geo/wgs84';

const STEP_M = 3;
const HALF_WIDTH_M = 0.7;
const LIFT_M = 0.08;
/** one chevron per this many metres of ribbon */
const CHEVRON_M = 4;

function chevronTexture(): THREE.Texture {
  const W = 64, H = 64;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // a chevron pointing toward +v (along the route): |x - centre| + y within a band
    const u = Math.abs(x + 0.5 - W / 2) / (W / 2), v = (y + 0.5) / H;
    const d = v - (1 - u) * 0.55;
    const on = d > 0.1 && d < 0.42;
    const i = (y * W + x) * 4;
    data[i] = 70; data[i + 1] = 170; data[i + 2] = 255; data[i + 3] = on ? 235 : 70;
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export class TaxiRibbon {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh | null = null;
  private route: readonly { lat: number; lon: number }[] | null = null;
  private builtFor = '';

  constructor() {
    this.group.name = 'taxiRibbon';
    this.material = new THREE.MeshBasicMaterial({ map: chevronTexture(), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, side: THREE.DoubleSide });
  }

  /** Show a route (geodetic points from the aircraft to the hold-short point), or hide it with null. */
  setRoute(points: readonly { lat: number; lon: number }[] | null): void {
    this.route = points && points.length >= 2 ? points : null;
    this.builtFor = '';
  }

  get visible(): boolean { return this.group.visible && !!this.mesh; }
  setVisible(v: boolean): void { this.group.visible = v; }

  /** Rebuild when the route or the local frame changed. `groundUp(n, e)` is the ground height in the frame. */
  update(frame: LocalFrame, groundUp: (n: number, e: number) => number | null): void {
    const key = this.route ? `${frame.info.lat0},${frame.info.lon0},${frame.info.alt0},${this.route.length},${this.route[0].lat},${this.route[this.route.length - 1].lon}` : '';
    if (key === this.builtFor) return;
    this.builtFor = key;
    this.clearMesh();
    if (!this.route) return;
    // resample the route every STEP_M in the local frame
    const pts: { n: number; e: number }[] = [];
    let prev: { n: number; e: number } | null = null;
    for (const g of this.route) {
      const p = frame.geodeticToNED(g.lat, g.lon, 0);
      const cur = { n: p[0], e: p[1] };
      if (prev) {
        const L = Math.hypot(cur.n - prev.n, cur.e - prev.e), k = Math.max(1, Math.ceil(L / STEP_M));
        for (let i = 1; i <= k; i++) pts.push({ n: prev.n + ((cur.n - prev.n) * i) / k, e: prev.e + ((cur.e - prev.e) * i) / k });
      } else pts.push(cur);
      prev = cur;
    }
    if (pts.length < 2) return;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dn = b.n - a.n, de = b.e - a.e, L = Math.hypot(dn, de) || 1;
      // left/right offsets perpendicular to the route (NED: right of travel = (−de, dn)/L … in n,e)
      const rn = -de / L, re = dn / L;
      if (i > 0) s += Math.hypot(pts[i].n - pts[i - 1].n, pts[i].e - pts[i - 1].e);
      const h = (groundUp(pts[i].n, pts[i].e) ?? 0) + LIFT_M;
      for (const side of [-1, 1]) {
        const n = pts[i].n + rn * HALF_WIDTH_M * side, e = pts[i].e + re * HALF_WIDTH_M * side;
        pos.push(e, h, -n); // render frame (E, Up, S)
        uv.push(side < 0 ? 0 : 1, s / CHEVRON_M);
      }
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 3;
    this.group.add(this.mesh);
  }

  private clearMesh(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    this.mesh = null;
  }

  dispose(): void { this.clearMesh(); this.material.map?.dispose(); this.material.dispose(); this.group.removeFromParent(); }
}
