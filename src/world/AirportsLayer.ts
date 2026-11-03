/**
 * 3D airports: runway pavement with markings, edge/threshold lights and PAPI, built from the
 * navigation database around the aircraft. Everything is placed from geodetic coordinates
 * through the current LocalFrame, so a floating-origin rebase simply rebuilds the layer.
 */
import * as THREE from 'three';
import type { Airport, Geodetic, NavDatabase, Runway, Vec3 } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import { approachLights, papiIndication, runwayGeometry, runwayLights, type RunwayGeometry, type RunwayLights } from './runwayGeometry';

export interface AirportsLayerOptions {
  /** radius around the aircraft within which airports are built, nm */
  buildRadiusNm: number;
  /** airports further than this are disposed, nm */
  disposeRadiusNm: number;
  maxAirports: number;
  /** seconds between database queries */
  refreshIntervalS: number;
}

const DEFAULTS: AirportsLayerOptions = { buildRadiusNm: 45, disposeRadiusNm: 60, maxAirports: 14, refreshIntervalS: 4 };

interface RunwayObjects {
  geom: RunwayGeometry;
  lights: RunwayLights;
  papiA: THREE.Points;
  papiB: THREE.Points;
  /** sequenced flashers ("rabbit") per approach end, null when the end has no approach lights */
  rabbits: THREE.Points[];
}
interface AirportObjects {
  airport: Airport;
  group: THREE.Group;
  runways: RunwayObjects[];
  lightPoints: THREE.Points[];
}

const COLOR_WHITE = new THREE.Color(1, 0.98, 0.9);

const EARTH_R = 6_371_000;
/** Height of the earth's arc above the straight end-to-end chord at fraction t of a runway of length L (m). */
export const runwayBulge = (lengthM: number, t: number): number => (lengthM * lengthM * t * (1 - t)) / (2 * EARTH_R);
/**
 * Near-camera drop of the runway pavement (m, at full strength). Slabs are built 0.12 m above the
 * flattened strip (`runwayGeometry`), markings 0.15 m and designators 0.16 m, so a coarser
 * terrain LOD never pokes through in the distance; the wheels stand on the strip itself, so
 * within RUNWAY_NEAR_FULL_M of the camera (none beyond RUNWAY_NEAR_END_M) they come down to
 * 12 / 14 / 16 mm, scaled by `nearDrop.value` (full with the camera near the ground, none from
 * the air; World.update sets it). The OSM taxiways next to a runway stay under the slab (6–10 mm).
 */
export const RUNWAY_NEAR_DROP_M = { slab: 0.108, markings: 0.136, designator: 0.144 };
export const RUNWAY_NEAR_FULL_M = 40;
export const RUNWAY_NEAR_END_M = 400;

/** Lower a material's vertices along the render-frame up near the camera by `drop.value × scale` (view space, after project_vertex). */
export function patchRunwayNearDrop(m: THREE.Material, drop: { value: number }, scale: number): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.rwyNearDrop = drop;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float rwyNearDrop;\nvoid main() {')
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        `\tfloat rwyFade = rwyNearDrop * ${scale.toFixed(4)} * ( 1.0 - smoothstep( ${RUNWAY_NEAR_FULL_M.toFixed(1)}, ${RUNWAY_NEAR_END_M.toFixed(1)}, length( mvPosition.xyz ) ) );`,
        '\tmvPosition.xyz -= ( viewMatrix * vec4( 0.0, rwyFade, 0.0, 0.0 ) ).xyz;',
        '\tgl_Position = projectionMatrix * mvPosition;',
      ].join('\n'));
  };
  m.customProgramCacheKey = () => `runway-near-drop-${scale.toFixed(4)}`;
}

const COLOR_RED = new THREE.Color(1, 0.12, 0.08);
const COLOR_GREEN = new THREE.Color(0.1, 1, 0.3);

export class AirportsLayer {
  readonly group = new THREE.Group();
  private readonly opts: AirportsLayerOptions;
  private built = new Map<string, AirportObjects>();
  private sinceRefresh = Infinity;
  private asphalt: THREE.MeshStandardMaterial;
  private markings: THREE.MeshStandardMaterial;
  private lightSprite: THREE.Texture;
  private lightMaterial: THREE.PointsMaterial;
  private reilMaterial: THREE.PointsMaterial;
  private rabbitMaterial: THREE.PointsMaterial;
  private clock = 0;
  private readonly tmpColor = new THREE.Color();
  /** near-camera drop strength 0…1 (camera near the ground → 1), shared by the runway materials */
  readonly nearDrop = { value: 0 };

  constructor(private frame: LocalFrame, private nav: NavDatabase, options: Partial<AirportsLayerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.group.name = 'airports';
    const asphaltTex = makeAsphaltTexture();
    // the texture alone sets the albedo: sRGB ~100 is linear ~0.13, aged asphalt (a darker material
    // colour multiplied it down to ~0.03 and the pavement rendered near-black at noon)
    this.asphalt = new THREE.MeshStandardMaterial({ map: asphaltTex, color: 0xffffff, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.markings = new THREE.MeshStandardMaterial({ color: 0xf2f2ea, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    patchRunwayNearDrop(this.asphalt, this.nearDrop, RUNWAY_NEAR_DROP_M.slab);
    patchRunwayNearDrop(this.markings, this.nearDrop, RUNWAY_NEAR_DROP_M.markings);
    this.lightSprite = makeLightSprite();
    this.lightMaterial = new THREE.PointsMaterial({ size: 3.2, map: this.lightSprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, alphaTest: 0.01 });
    this.reilMaterial = new THREE.PointsMaterial({ size: 7, map: this.lightSprite, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.rabbitMaterial = new THREE.PointsMaterial({ size: 8, map: this.lightSprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  }

  /** Runway centreline segments for terrain flattening (threshold → end, with pavement width). */
  flatteningSegments(): { a: Geodetic; b: Geodetic; widthM: number; icao: string; ident: string }[] {
    const out: { a: Geodetic; b: Geodetic; widthM: number; icao: string; ident: string }[] = [];
    for (const ap of this.built.values()) for (const rw of ap.airport.runways) out.push({ a: rw.threshold, b: rw.end, widthM: rw.widthM, icao: ap.airport.icao, ident: rw.ident });
    return out;
  }

  /** Rebuild everything in a new floating-origin frame. */
  setFrame(frame: LocalFrame): void {
    this.frame = frame;
    const airports = [...this.built.values()].map((b) => b.airport);
    for (const icao of [...this.built.keys()]) this.disposeAirport(icao);
    for (const ap of airports) this.buildAirport(ap);
  }

  /** Ensure a specific airport exists (e.g. the spawn airport) even before the first refresh. */
  ensureAirport(airport: Airport): void {
    if (!this.built.has(airport.icao)) this.buildAirport(airport);
  }

  isBuilt(icao: string): boolean { return this.built.has(icao); }

  /** The airports currently built (the spawn airport and those near the aircraft). */
  builtAirports(): Airport[] { return [...this.built.values()].map((b) => b.airport); }

  /**
   * @param aircraftGeo aircraft geodetic position
   * @param aircraftPosThree aircraft position in the render frame (for PAPI)
   * @param sunElevationRad sun elevation (lights fade by day)
   */
  update(dt: number, aircraftGeo: Geodetic, aircraftPosThree: Vec3, sunElevationRad: number): void {
    this.sinceRefresh += dt;
    if (this.sinceRefresh >= this.opts.refreshIntervalS) {
      this.sinceRefresh = 0;
      this.refresh(aircraftGeo);
    }
    // Light brightness by sun elevation: full at night, dim by day.
    const sunDeg = (sunElevationRad * 180) / Math.PI;
    this.lightMaterial.opacity = sunDeg < -2 ? 1 : sunDeg > 12 ? 0.3 : 1 - (0.7 * (sunDeg + 2)) / 14;
    // REIL strobes flash together once a second; the approach "rabbit" sweeps toward the runway twice a second
    this.clock += dt;
    const night = this.lightMaterial.opacity;
    this.reilMaterial.opacity = (this.clock % 1) < 0.07 ? night : 0;
    this.rabbitMaterial.opacity = night;
    const phase = (this.clock % 0.5) / 0.5;
    for (const ap of this.built.values()) for (const rw of ap.runways) for (const r of rw.rabbits) this.stepRabbit(r, phase);
    // PAPI colours for runways within 12 km of the aircraft.
    for (const ap of this.built.values()) {
      for (const rw of ap.runways) {
        const c = rw.geom.center;
        const d2 = (c[0] - aircraftPosThree[0]) ** 2 + (c[2] - aircraftPosThree[2]) ** 2;
        if (d2 > 12000 * 12000) continue;
        this.updatePapi(rw.papiA, rw.lights.papiA, aircraftPosThree);
        this.updatePapi(rw.papiB, rw.lights.papiB, aircraftPosThree);
      }
    }
  }

  dispose(): void {
    for (const icao of [...this.built.keys()]) this.disposeAirport(icao);
    this.asphalt.map?.dispose();
    this.asphalt.dispose();
    this.markings.dispose();
    this.lightSprite.dispose();
    this.lightMaterial.dispose();
    this.reilMaterial.dispose();
    this.rabbitMaterial.dispose();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private refresh(aircraftGeo: Geodetic): void {
    const near = this.nav.nearestAirports(aircraftGeo, this.opts.maxAirports, this.opts.buildRadiusNm).filter((a) => a.runways.length > 0);
    const keep = new Set(near.map((a) => a.icao));
    for (const [icao, obj] of this.built) {
      if (keep.has(icao)) continue;
      const d = distanceNm(aircraftGeo, obj.airport.position);
      if (d > this.opts.disposeRadiusNm) this.disposeAirport(icao);
    }
    for (const ap of near) if (!this.built.has(ap.icao)) this.buildAirport(ap);
  }

  private buildAirport(airport: Airport): void {
    const group = new THREE.Group();
    group.name = `airport:${airport.icao}`;
    const runways: RunwayObjects[] = [];
    const lightPoints: THREE.Points[] = [];
    for (const rw of airport.runways) {
      if (!Number.isFinite(rw.threshold.lat) || !Number.isFinite(rw.end.lat) || rw.widthM <= 0) continue;
      const geom = runwayGeometry(rw, this.frame);
      group.add(this.buildSlab(geom, rw));
      group.add(this.buildMarkings(geom, rw));
      const lights = runwayLights(geom);
      if (rw.lighted) {
        const pts = this.buildLightPoints(lights);
        group.add(pts);
        lightPoints.push(pts);
      }
      const papiA = this.buildPapi(lights.papiA), papiB = this.buildPapi(lights.papiB);
      group.add(papiA, papiB);
      const rabbits: THREE.Points[] = [];
      if (rw.lighted) {
        const major = airport.type === 'large' || airport.type === 'medium';
        const al = approachLights(geom, { alsA: major && rw.lengthM >= 1800, alsB: major && rw.lengthM >= 1800, centreline: rw.lengthM >= 2400 });
        const steady = this.buildColoredPoints([...al.barsA, ...al.barsB, ...al.centreline], COLOR_WHITE, this.lightMaterial, 'approach-lights');
        if (steady) { group.add(steady); lightPoints.push(steady); }
        const reil = this.buildColoredPoints([...al.reilA, ...al.reilB], COLOR_WHITE, this.reilMaterial, 'reil');
        if (reil) group.add(reil);
        for (const seq of [al.rabbitA, al.rabbitB]) {
          const r = this.buildColoredPoints(seq, COLOR_WHITE, this.rabbitMaterial, 'rabbit');
          if (r) { group.add(r); rabbits.push(r); }
        }
      }
      runways.push({ geom, lights, papiA, papiB, rabbits });
    }
    this.group.add(group);
    this.built.set(airport.icao, { airport, group, runways, lightPoints });
  }

  private disposeAirport(icao: string): void {
    const obj = this.built.get(icao);
    if (!obj) return;
    obj.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (mat && mat !== this.asphalt && mat !== this.markings && mat !== this.lightMaterial && mat !== this.reilMaterial && mat !== this.rabbitMaterial) {
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat.dispose();
      }
    });
    this.group.remove(obj.group);
    this.built.delete(icao);
  }

  /**
   * Pavement: a strip between the four corners (slope baked in) in segments of at most 250 m, each
   * raised by the earth-curvature bulge of the arc over the end-to-end chord so long runways follow
   * the curved, flattened terrain (a single quad sags 0.26 m mid-runway on a 3.6 km runway).
   * Wound counter-clockwise seen from above (normals up).
   */
  private buildSlab(g: RunwayGeometry, rw: Runway): THREE.Mesh {
    const [al, ar, br, bl] = g.corners;
    const n = Math.max(1, Math.ceil(g.lengthM / 250));
    const repeatU = Math.max(1, Math.round(g.widthM / 12));
    const repeatV = Math.max(1, Math.round(g.lengthM / 12));
    const pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n, b = runwayBulge(g.lengthM, t);
      for (let k = 0; k < 3; k++) {
        pos[i * 6 + k] = al[k] + (bl[k] - al[k]) * t;
        pos[i * 6 + 3 + k] = ar[k] + (br[k] - ar[k]) * t;
      }
      pos[i * 6 + 1] += b; pos[i * 6 + 4] += b;
      uv[i * 4] = 0; uv[i * 4 + 1] = t * repeatV; uv[i * 4 + 2] = repeatU; uv[i * 4 + 3] = t * repeatV;
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const l0 = i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
      idx.push(l0, r0, r1, l0, r1, l1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = this.asphalt;
    const mesh = new THREE.Mesh(geo, rw.surface === 'grass' ? grassMaterial() : mat);
    mesh.receiveShadow = true;
    mesh.name = `runway:${rw.ident}`;
    return mesh;
  }

  /** White markings as merged quads in runway/end-local coordinates. */
  private buildMarkings(g: RunwayGeometry, rw: Runway): THREE.Group {
    const group = new THREE.Group();
    const quads: number[] = [];
    const lift = 0.03;
    const slopeAt = (t: number) => g.ends[0].pos[1] + (g.ends[1].pos[1] - g.ends[0].pos[1]) * t;
    const horiz = Math.hypot(g.ends[1].pos[0] - g.ends[0].pos[0], g.ends[1].pos[2] - g.ends[0].pos[2]);
    // Quad in runway coordinates: s along from A (m), c across from centreline (m, + right of A→B travel);
    // long quads are split into ≤ 250 m pieces that follow the pavement's curvature bulge
    const pushQuad = (s0: number, s1: number, c0: number, c1: number) => {
      const a = g.ends[0].pos;
      const p = (s: number, c: number): Vec3 => [a[0] + g.along[0] * s + g.across[0] * c, slopeAt(s / horiz) + runwayBulge(horiz, s / horiz) + lift, a[2] + g.along[2] * s + g.across[2] * c];
      const pieces = Math.max(1, Math.ceil((s1 - s0) / 250));
      for (let i = 0; i < pieces; i++) {
        const sa = s0 + ((s1 - s0) * i) / pieces, sb = s0 + ((s1 - s0) * (i + 1)) / pieces;
        const p0 = p(sa, c0), p1 = p(sa, c1), p2 = p(sb, c1), p3 = p(sb, c0);
        quads.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
      }
    };
    const W = g.widthM, L = horiz;
    // Edge stripes
    pushQuad(0, L, -W / 2 + 0.3, -W / 2 + 1.2);
    pushQuad(0, L, W / 2 - 1.2, W / 2 - 0.3);
    // Per-end markings (mirrored for end B)
    const perEnd = (fromB: boolean) => {
      const disp = fromB ? g.ends[1].displacedM : g.ends[0].displacedM;
      // s measured from this end's threshold along the landing direction
      const S = (s: number) => (fromB ? L - disp - s : disp + s);
      const seg = (s0: number, s1: number, c0: number, c1: number) => {
        const a = S(s0), b = S(s1);
        pushQuad(Math.min(a, b), Math.max(a, b), fromB ? -c1 : c0, fromB ? -c0 : c1);
      };
      // Threshold stripes ("piano keys")
      const n = W < 20 ? 4 : W < 25 ? 6 : W < 35 ? 8 : W < 50 ? 12 : 16;
      const stripeW = 1.75, keyLen = L >= 1200 ? 45 : 30;
      const span = W - 2 * 1.5;
      const pitch = span / n;
      for (let i = 0; i < n; i++) {
        const c = -span / 2 + pitch * (i + 0.5);
        seg(6, 6 + keyLen, c - stripeW / 2, c + stripeW / 2);
      }
      // Displaced threshold arrows (simple chevrons as bars)
      if (disp > 20) {
        for (let s = 10; s < disp - 10; s += 30) seg(-disp + s, -disp + s + 12, -1, 1);
      }
      // Aiming point bars
      if (L >= 1500) {
        const aim = L >= 2400 ? 300 : L >= 1800 ? 250 : 150;
        seg(aim, aim + 45, -16, -7);
        seg(aim, aim + 7 - 16 + 16, 7, 16);
        seg(aim, aim + 45, 7, 16);
        // Touchdown zone stripes for long runways
        if (L >= 2400) {
          const sets: [number, number][] = [[150, 3], [450, 3], [600, 2], [750, 2], [900, 1]];
          for (const [s, count] of sets) {
            for (let k = 0; k < count; k++) {
              const inner = 9 + k * 3.5;
              seg(s, s + 22.5, -(inner + 1.8), -inner);
              seg(s, s + 22.5, inner, inner + 1.8);
            }
          }
        }
      }
      // Centreline dashes from past the numbers to mid-runway
      for (let s = 95; s < (L - 2 * disp) / 2; s += 50) seg(s, Math.min(s + 30, L / 2), -0.45, 0.45);
    };
    perEnd(false);
    perEnd(true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.markings);
    mesh.name = `markings:${rw.ident}`;
    group.add(mesh);
    // Designator numbers as canvas decals
    group.add(this.buildDesignator(g, false, slopeAt, horiz));
    group.add(this.buildDesignator(g, true, slopeAt, horiz));
    return group;
  }

  private buildDesignator(g: RunwayGeometry, fromB: boolean, slopeAt: (t: number) => number, horiz: number): THREE.Mesh {
    const end = fromB ? g.ends[1] : g.ends[0];
    const text = end.ident || '';
    const tex = makeTextTexture(text);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, alphaTest: 0.2 });
    patchRunwayNearDrop(mat, this.nearDrop, RUNWAY_NEAR_DROP_M.designator);
    const h = 18, w = Math.max(9, 9 * text.length);
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    // Place 63 m from the (displaced) threshold, centred; the plane's +Y (texture up) must point along the landing direction.
    const s = 63 + h / 2;
    const dir = end.dir;
    const along = fromB ? horiz - end.displacedM - s : end.displacedM + s;
    const a = g.ends[0].pos;
    const px = a[0] + g.along[0] * along, pz = a[2] + g.along[2] * along;
    mesh.position.set(px, slopeAt(along / horiz) + 0.04, pz);
    // Default PlaneGeometry lies in XY facing +Z with texture-up = +Y. Lay it flat (tilt −90° about X so
    // texture-up points to −Z = north), then yaw about Y so texture-up points along the landing direction.
    const yaw = Math.atan2(dir[0], -dir[2]); // true heading of the landing direction
    mesh.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw));
    mesh.name = `designator:${text}`;
    return mesh;
  }

  private buildLightPoints(l: RunwayLights): THREE.Points {
    const pts: Vec3[] = [...l.edgeWhite, ...l.thresholdA, ...l.thresholdB];
    const pos = new Float32Array(pts.length * 3);
    const col = new Float32Array(pts.length * 3);
    let i = 0;
    const push = (p: Vec3, c: THREE.Color) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; i++; };
    for (const p of l.edgeWhite) push(p, COLOR_WHITE);
    for (const p of l.thresholdA) push(p, COLOR_GREEN);
    for (const p of l.thresholdB) push(p, COLOR_GREEN);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(geo, this.lightMaterial);
    points.frustumCulled = true;
    points.name = 'runway-lights';
    return points;
  }

  private buildColoredPoints(pts: Vec3[], c: THREE.Color, material: THREE.PointsMaterial, name: string): THREE.Points | null {
    if (!pts.length) return null;
    const pos = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3);
    pts.forEach((v, i) => { pos.set(v, i * 3); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(geo, material);
    points.name = name;
    return points;
  }

  /** Light one flasher of a sequence at a time (phase 0..1 sweeps from the far end to the threshold). */
  private stepRabbit(points: THREE.Points, phase: number): void {
    const attr = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const n = attr.count;
    const lit = Math.min(n - 1, Math.floor(phase * n * 1.6)); // sweep in the first ~60 % of the cycle, then dark
    for (let i = 0; i < n; i++) {
      const on = phase * 1.6 < 1 && i === lit ? 1 : 0;
      attr.setXYZ(i, on, on, on);
    }
    attr.needsUpdate = true;
  }

  private buildPapi(p: Vec3[]): THREE.Points {
    const pos = new Float32Array(p.length * 3), col = new Float32Array(p.length * 3);
    p.forEach((v, i) => { pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2]; col[i * 3] = 1; col[i * 3 + 1] = 1; col[i * 3 + 2] = 1; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 4, map: this.lightSprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const points = new THREE.Points(geo, mat);
    points.name = 'papi';
    return points;
  }

  private updatePapi(points: THREE.Points, positions: Vec3[], observer: Vec3): void {
    if (positions.length < 4) return;
    const ind = papiIndication(observer, positions[0]);
    const attr = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < 4; i++) {
      const c = ind[i] ? COLOR_WHITE : COLOR_RED;
      attr.setXYZ(i, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }
}

// ───────────────────────────── textures ─────────────────────────────

const hasDocument = typeof document !== 'undefined';

function makeAsphaltTexture(): THREE.Texture {
  if (!hasDocument) {
    const t = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#5c5c5c';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 80 + rnd() * 40;
    img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n + 2;
  }
  ctx.putImageData(img, 0, 0);
  // tyre rubber smear hint
  ctx.fillStyle = 'rgba(30,30,30,0.08)';
  for (let k = 0; k < 6; k++) ctx.fillRect(rnd() * size, 0, 6 + rnd() * 10, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeLightSprite(): THREE.Texture {
  if (!hasDocument) {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function makeTextTexture(text: string): THREE.Texture {
  if (!hasDocument) {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const w = Math.max(1, text.length) * 128, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f4f4ec';
  ctx.font = 'bold 230px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 10);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let grassMat: THREE.MeshStandardMaterial | null = null;
function grassMaterial(): THREE.MeshStandardMaterial {
  if (!grassMat) grassMat = new THREE.MeshStandardMaterial({ color: 0x4f6b35, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return grassMat;
}

function distanceNm(a: Geodetic, b: Geodetic): number {
  const d2r = Math.PI / 180;
  const x = (b.lon - a.lon) * d2r * Math.cos(((a.lat + b.lat) / 2) * d2r);
  const y = (b.lat - a.lat) * d2r;
  return (Math.sqrt(x * x + y * y) * 6371000) / 1852;
}
