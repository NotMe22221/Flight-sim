/**
 * The world around the aircraft: floating-origin frame, streamed terrain, 3D airports and the
 * Environment the flight model sees. Owns rebasing so every system moves together.
 */
import * as THREE from 'three';
import type { Environment, Geodetic, NavDatabase, Vec3 } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { AirportsLayer } from './AirportsLayer';
import { SimEnvironment } from './environment';
import { PavementIndex, PavementRegistry, type PavementSource } from './pavement';
import { makeRebase, needsRebase, type RebaseTransform } from './rebase';

const EARTH_R = 6371000;
const D2R = Math.PI / 180;

interface RunwayRect { cN: number; cE: number; aN: number; aE: number; halfLen: number; halfWidth: number }

export interface WorldWind {
  windNED(north: number, east: number, down: number, out: Vec3): Vec3;
}

export class World {
  frame: LocalFrame;
  readonly env: SimEnvironment;
  readonly airports: AirportsLayer;
  readonly group = new THREE.Group();
  private runwayRects: RunwayRect[] = [];
  private runwayKey = '';
  private flattenTimer = 0;
  /** airport pavement (scenery aprons / taxiways) flattened into the terrain, see pavement.ts */
  readonly pavement = new PavementRegistry();
  private pavementSource: (() => PavementSource | null) | null = null;
  private pavementIndex = new PavementIndex([]);
  private readonly geoScratch = { lat: 0, lon: 0, alt: 0 };
  /** ground under the aircraft at the last `groundShift` call, and the terrain revision it was sampled in */
  private shiftN = 0;
  private shiftE = 0;
  private shiftG: number | null = null;
  private shiftRev = -1;

  constructor(
    readonly terrain: TerrainSystem | null,
    readonly nav: NavDatabase,
    private wind: WorldWind | null,
    lat0: number,
    lon0: number,
  ) {
    this.frame = new LocalFrame(lat0, lon0, 0);
    this.airports = new AirportsLayer(this.frame, nav);
    this.group.name = 'world';
    if (terrain) this.group.add(terrain.group);
    this.group.add(this.airports.group);
    this.env = new SimEnvironment(this.frame.info, {
      groundHeight: (n, e) => this.groundHeight(n, e),
      groundNormal: (n, e, out) => this.groundNormal(n, e, out),
      windNED: (n, e, d, out) => (this.wind ? this.wind.windNED(n, e, d, out) : zero(out)),
    });
  }

  setWind(w: WorldWind | null): void { this.wind = w; }

  /** Up-coordinate of mean sea level at a NED point (curvature drop from the tangent plane). */
  seaLevelUp(n: number, e: number): number {
    return -this.frame.alt0 - (n * n + e * e) / (2 * EARTH_R);
  }

  /**
   * Ground "up" coordinate under a NED point, never below the sea surface except on runways (fields
   * below sea level, e.g. EHAM at −3 m, keep their real elevation). Null before terrain data exists.
   */
  groundHeight(n: number, e: number): number | null {
    const sea = this.seaLevelUp(n, e);
    const h = this.terrain?.heightAtLocalNED(n, e) ?? null;
    if (h === null) return null;
    return h < sea && !this.onRunway(n, e) ? sea : h;
  }

  private groundNormal(n: number, e: number, out: Vec3): Vec3 | null {
    const h = this.terrain?.heightAtLocalNED(n, e) ?? null;
    if (h === null || (h < this.seaLevelUp(n, e) && !this.onRunway(n, e))) { out[0] = 0; out[1] = 0; out[2] = -1; return out; }
    return this.terrain?.groundNormalNED(n, e, out) ?? null;
  }

  /** Is the NED point on a runway rectangle (with the small shoulder margin)? */
  private onRunway(n: number, e: number): boolean {
    for (const r of this.runwayRects) {
      const dn = n - r.cN, de = e - r.cE;
      const along = dn * r.aN + de * r.aE;
      const across = -dn * r.aE + de * r.aN;
      if (Math.abs(along) <= r.halfLen && Math.abs(across) <= r.halfWidth) return true;
    }
    return false;
  }

  /** Surface type at a NED point for tyre friction and water detection (runways, aprons and taxiways are paved). */
  surfaceAt(n: number, e: number): Environment['surface'] {
    if (this.onRunway(n, e)) return 'paved';
    if (!this.pavementIndex.empty) {
      const g = this.frame.nedToGeodetic(n, e, 0, this.geoScratch);
      if (this.pavementIndex.contains(g.lat, g.lon)) return 'paved';
    }
    const h = this.terrain?.heightAtLocalNED(n, e) ?? null;
    if (h !== null && h < this.seaLevelUp(n, e) - 0.3) return 'water';
    return 'grass';
  }

  /** Start a new flight at a point: new frame, terrain and airports re-expressed, fallback ground set. */
  setOrigin(lat: number, lon: number, fallbackElevationM: number): void {
    this.shiftG = null;
    this.frame = new LocalFrame(lat, lon, 0);
    this.terrain?.setFrame(this.frame);
    this.airports.setFrame(this.frame);
    this.env.setFrame(this.frame.info, fallbackElevationM - this.frame.alt0);
    this.rebuildRunwayRects();
  }

  /** Rebase when the aircraft is far from the origin. Returns the transform applied, or null. */
  maybeRebase(aircraftPosNED: Vec3): RebaseTransform | null {
    if (!needsRebase(aircraftPosNED)) return null;
    const t = makeRebase(this.frame, aircraftPosNED);
    const groundUp = this.env.groundHeight(aircraftPosNED[0], aircraftPosNED[1]);
    this.shiftG = null;
    this.frame = t.newFrame;
    this.terrain?.setFrame(this.frame);
    this.airports.setFrame(this.frame);
    // the ground under the aircraft keeps the same MSL height in the new frame
    this.env.setFrame(this.frame.info, groundUp + 0 - this.frame.alt0);
    this.rebuildRunwayRects();
    return t;
  }

  /** Per-frame update: terrain LOD/streaming, airport set, runway flattening and surface map. */
  update(dt: number, cameraPosThree: THREE.Vector3, camera: THREE.PerspectiveCamera, aircraftGeo: Geodetic, aircraftPosThree: Vec3, sunElevationRad: number): void {
    this.terrain?.update(cameraPosThree, camera, dt);
    this.airports.update(dt, aircraftGeo, aircraftPosThree, sunElevationRad);
    // runway pavement comes down to the wheels near the camera only while the camera is near the ground
    const g = this.groundHeight(-cameraPosThree.z, cameraPosThree.x);
    if (g !== null) this.airports.nearDrop.value = runwayNearDropFor(cameraPosThree.y - g);
    this.flattenTimer += dt;
    if (this.flattenTimer > 2) {
      this.flattenTimer = 0;
      this.syncRunways();
      this.syncPavement();
    }
  }

  /**
   * Where the scenery's pavement comes from (called lazily: the scenery plugin attaches after the
   * world exists). Null → no pavement flattening.
   */
  setPavementSource(source: (() => PavementSource | null) | null): void { this.pavementSource = source; }

  /**
   * Push the scenery's aprons / taxiways near the current airports to terrain flattening (when
   * they changed). Runs every 2 s from update(); call it with `force` on a spawn, after the spawn
   * airport is built and before the terrain prefetch, so the spawn tiles load already flattened.
   */
  syncPavement(force = false): void {
    const src = this.pavementSource ? this.pavementSource() : null;
    const specs = this.pavement.sync(src, this.airports.builtAirports(), force);
    if (!specs) return;
    this.terrain?.setPavement?.(specs);
    this.pavementIndex = new PavementIndex(specs);
  }

  /**
   * Height change (m, up positive) of the ground under the aircraft caused by terrain data
   * changing (a tile loading, reloading flattened, refining or being evicted) since the previous
   * call — 0 when nothing changed. The caller lifts an aircraft standing on the ground by this
   * much, so a reload never launches it or drives the gear into the ground. Sampled at the previous
   * call's point, so the aircraft's own motion is not mistaken for a change.
   */
  groundShift(n: number, e: number): number {
    const rev = this.terrain?.revision?.() ?? 0;
    let shift = 0;
    // (a jump of more than a few metres since the last call is a teleport — slew, replay — not motion)
    const near = Math.abs(n - this.shiftN) + Math.abs(e - this.shiftE) < 5;
    if (rev !== this.shiftRev && this.shiftG !== null && near) {
      const g = this.env.groundHeight(this.shiftN, this.shiftE);
      if (Number.isFinite(g)) shift = g - this.shiftG;
    }
    this.shiftRev = rev;
    this.shiftN = n; this.shiftE = e;
    const g = this.env.groundHeight(n, e);
    this.shiftG = Number.isFinite(g) ? g : null;
    return Math.abs(shift) > 1e-4 ? shift : 0;
  }

  /** Push the current airport runways to terrain flattening and the surface map (when they changed). */
  syncRunways(): void {
    const segs = this.airports.flatteningSegments();
    const key = segs.map((s) => `${s.icao}:${s.ident}`).join('|');
    if (key === this.runwayKey) return;
    this.runwayKey = key;
    this.terrain?.setRunways(segs.map((s) => ({ a: s.a, b: s.b, widthM: s.widthM })));
    this.rebuildRunwayRects();
  }

  private rebuildRunwayRects(): void {
    const segs = this.airports.flatteningSegments();
    this.runwayRects = segs.map((s) => {
      const a = this.frame.geodeticToNED(s.a.lat, s.a.lon, s.a.alt);
      const b = this.frame.geodeticToNED(s.b.lat, s.b.lon, s.b.alt);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return { cN: (a[0] + b[0]) / 2, cE: (a[1] + b[1]) / 2, aN: (b[0] - a[0]) / len, aE: (b[1] - a[1]) / len, halfLen: len / 2 + 10, halfWidth: s.widthM / 2 + 3 };
    });
  }

  /** Geodetic → render position in the current frame. */
  toThree(g: Geodetic, out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.frame.geodeticToThree(g.lat, g.lon, g.alt);
    return out.set(p[0], p[1], p[2]);
  }

  /** Destination of a bearing/distance from a point (for spawns on final). */
  static offset(g: Geodetic, bearingDeg: number, distM: number): Geodetic {
    const b = bearingDeg * D2R;
    const dLat = (distM * Math.cos(b)) / 111320;
    const dLon = (distM * Math.sin(b)) / (111320 * Math.cos(g.lat * D2R));
    return { lat: g.lat + dLat, lon: g.lon + dLon, alt: g.alt };
  }

  dispose(): void {
    this.airports.dispose();
    this.terrain?.dispose();
  }
}

function zero(out: Vec3): Vec3 { out[0] = 0; out[1] = 0; out[2] = 0; return out; }

/** Runway near-camera drop strength for a camera `h` m above the ground: 1 below 20 m, 0 above 60 m. */
export function runwayNearDropFor(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const t = Math.min(1, Math.max(0, (h - 20) / 40));
  return 1 - t * t * (3 - 2 * t);
}
