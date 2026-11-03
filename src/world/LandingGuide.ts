/**
 * "Landing path" assist (MSFS assistance option): on approach, a line of translucent gates along
 * the 3° glidepath to the aim point of the runway the aircraft is lined up with. Gates already
 * flown through are hidden. Everything is placed from geodetic coordinates through the current
 * LocalFrame each update, so floating-origin rebases need no handling.
 */
import * as THREE from 'three';
import type { Airport, Geodetic } from '../core/types';
import { aimPointM, relativeToRunway, runwayEnds, type RunwayEndRef, type RunwayRelative } from '../activities/runwayFrame';
import { destinationPoint, nedToThree, type LocalFrame } from '../geo/wgs84';

const D2R = Math.PI / 180;
export const GLIDE_DEG = 3;
/** distances before the aim point at which gates stand, m */
export const GATE_DISTANCES_M: readonly number[] = Array.from({ length: 23 }, (_, i) => 250 + i * 350);
const GATE_W = 60, GATE_H = 38, BAR = 2.4;
/** gates shrink towards the runway so the line reads as a funnel */
export const gateScale = (distBeforeAimM: number): number => Math.min(1.35, Math.max(0.35, 0.35 + distBeforeAimM / 6000));

/** Approach geometry limits for showing the guide. */
const MAX_RANGE_M = 16_000;
const MAX_HEADING_DIFF = 35;
const MAX_HEIGHT_M = 1500;

/**
 * The runway end the aircraft is approaching: in front of it within 16 km, lined up within 35°
 * of the landing direction, inside a cone around the extended centreline, best aligned first.
 */
export function selectApproachEnd(pos: Geodetic, trackDeg: number, airports: readonly Airport[], rel: RunwayRelative = { alongM: 0, crossM: 0 }): RunwayEndRef | null {
  let best: RunwayEndRef | null = null;
  let bestScore = Infinity;
  for (const ap of airports) {
    for (const rw of ap.runways) {
      for (const end of runwayEnds(ap, rw)) {
        const dh = Math.abs(((trackDeg - end.headingDeg) % 360 + 540) % 360 - 180);
        if (dh > MAX_HEADING_DIFF) continue;
        relativeToRunway(pos, end, rel);
        if (rel.alongM > aimPointM(end.lengthM) || rel.alongM < -MAX_RANGE_M) continue;
        if (Math.abs(rel.crossM) > 600 + 0.25 * Math.abs(rel.alongM)) continue;
        if (pos.alt - end.threshold.alt > MAX_HEIGHT_M) continue;
        const score = Math.abs(rel.crossM) + 40 * dh;
        if (score < bestScore) { bestScore = score; best = end; }
      }
    }
  }
  return best;
}

/** Geodetic centre of the gate `distBeforeAimM` before the aim point, on the glidepath. */
export function gateCentre(end: RunwayEndRef, distBeforeAimM: number, out?: Geodetic): Geodetic {
  const along = aimPointM(end.lengthM) - distBeforeAimM;
  const g = destinationPoint(end.threshold, end.headingDeg, along);
  const alt = end.threshold.alt + distBeforeAimM * Math.tan(GLIDE_DEG * D2R);
  if (out) { out.lat = g.lat; out.lon = g.lon; out.alt = alt; return out; }
  return { lat: g.lat, lon: g.lon, alt };
}

/** A rectangular frame (four bars) in the XY plane, centred on the origin. */
function gateGeometry(): THREE.BufferGeometry {
  const bars = [
    new THREE.BoxGeometry(GATE_W, BAR, BAR).translate(0, GATE_H / 2, 0),
    new THREE.BoxGeometry(GATE_W, BAR, BAR).translate(0, -GATE_H / 2, 0),
    new THREE.BoxGeometry(BAR, GATE_H, BAR).translate(GATE_W / 2, 0, 0),
    new THREE.BoxGeometry(BAR, GATE_H, BAR).translate(-GATE_W / 2, 0, 0),
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  for (const b of bars) {
    const base = pos.length / 3;
    const p = b.getAttribute('position');
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = b.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    b.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class LandingGuide {
  readonly group = new THREE.Group();
  /** the runway end currently guided to, or null */
  end: RunwayEndRef | null = null;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly rel: RunwayRelative = { alongM: 0, crossM: 0 };
  private readonly g: Geodetic = { lat: 0, lon: 0, alt: 0 };
  private readonly ned: [number, number, number] = [0, 0, 0];
  private readonly three: [number, number, number] = [0, 0, 0];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly yAxis = new THREE.Vector3(0, 1, 0);
  private reselectT = 0;

  constructor() {
    this.group.name = 'landing-guide';
    this.material = new THREE.MeshBasicMaterial({ color: 0xe060ff, transparent: true, opacity: 0.7, depthWrite: false, fog: false });
    this.mesh = new THREE.InstancedMesh(gateGeometry(), this.material, GATE_DISTANCES_M.length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /**
   * @param enabled assist on and a flight in progress
   * @param pos aircraft position, trackDeg its ground track (true)
   */
  update(dt: number, enabled: boolean, pos: Geodetic, trackDeg: number, onGround: boolean, airports: readonly Airport[], frame: LocalFrame): void {
    if (!enabled || onGround) { this.group.visible = false; this.end = null; return; }
    this.reselectT -= dt;
    if (this.reselectT <= 0 || !this.end) {
      this.reselectT = 1;
      this.end = selectApproachEnd(pos, trackDeg, airports, this.rel);
    }
    const end = this.end;
    if (!end) { this.group.visible = false; return; }
    relativeToRunway(pos, end, this.rel);
    const aim = aimPointM(end.lengthM);
    const flown = aim - this.rel.alongM; // aircraft distance before the aim point
    this.q.setFromAxisAngle(this.yAxis, -end.headingDeg * D2R);
    let shown = 0;
    for (let i = 0; i < GATE_DISTANCES_M.length; i++) {
      const d = GATE_DISTANCES_M[i];
      if (d > flown - 60) { this.mesh.setMatrixAt(i, this.hidden); continue; } // already flown through
      gateCentre(end, d, this.g);
      frame.geodeticToNED(this.g.lat, this.g.lon, this.g.alt, this.ned);
      nedToThree(this.ned, this.three);
      this.p.set(this.three[0], this.three[1], this.three[2]);
      this.s.setScalar(gateScale(d));
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      shown++;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.visible = shown > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
