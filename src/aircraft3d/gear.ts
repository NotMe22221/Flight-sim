/**
 * Tricycle landing gear with wheel pants. Nose gear telescopes and steers; the tubular main
 * legs flex (scaled along their axis) so the wheels rise by `GearState.compressionM`.
 * Wheels spin with `wheelSpeedMs / tyreRadius`.
 */
import * as THREE from 'three';
import type { GearState } from '../core/types';
import type { C172Layout, GearLayout } from './c172Layout';
import type { ModelMaterials } from './materials';
import { finiteOr } from './finite';

interface Leg {
  layout: GearLayout;
  /** steering pivot (nose) or the leg root (mains) at the attach point */
  root: THREE.Group;
  /** moves with compression */
  carrier: THREE.Group;
  legMesh: THREE.Mesh;
  wheel: THREE.Mesh;
  /** unit direction from attach to axle and its length (mains) */
  dir: THREE.Vector3;
  length: number;
  isNose: boolean;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

/**
 * Unit teardrop speed fairing (wheel pant): lathe about the length axis, rounded nose at
 * z = −0.42, tapering to a point at z = +0.58 (length 1, max radius 0.5).
 */
function buildPantGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const s = i / n; // 0 nose → 1 tail
    const r = s < 0.42 ? 0.5 * Math.sqrt(1 - ((0.42 - s) / 0.42) ** 2) : 0.5 * (1 - ((s - 0.42) / 0.58) ** 1.6);
    pts.push(new THREE.Vector2(Math.max(r, 1e-4), 0.42 - s));
  }
  // LatheGeometry faces outward only for a profile with increasing y: list tail → nose
  pts.reverse();
  const g = new THREE.LatheGeometry(pts, 20);
  g.rotateX(-Math.PI / 2); // lathe axis +Y → nose toward −Z
  return g;
}

export class LandingGear {
  readonly group = new THREE.Group();
  private readonly legs: Leg[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(gear: C172Layout['gear'], mats: ModelMaterials) {
    this.group.name = 'gear';
    if (gear.nose) this.legs.push(this.buildLeg(gear.nose, true, mats));
    for (const m of gear.mains) this.legs.push(this.buildLeg(m, false, mats));
  }

  private buildLeg(gl: GearLayout, isNose: boolean, mats: ModelMaterials): Leg {
    const root = new THREE.Group();
    root.name = `gear:${gl.name}`;
    root.position.copy(gl.attach);
    const axle = tmp.copy(gl.contact).sub(gl.attach); axle.y += gl.tyreRadius; // axle relative to attach
    const dir = axle.clone().normalize();
    const length = axle.length();
    const carrier = new THREE.Group();

    let legMesh: THREE.Mesh;
    if (isNose) {
      // fixed upper strut + telescoping lower strut
      const upperGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.3, 10);
      this.geometries.push(upperGeo);
      const upper = new THREE.Mesh(upperGeo, mats.metal);
      upper.position.y = -0.15;
      root.add(upper);
      const lowerLen = Math.max(0.1, -axle.y - 0.1);
      const lowerGeo = new THREE.CylinderGeometry(0.03, 0.03, lowerLen, 10);
      this.geometries.push(lowerGeo);
      legMesh = new THREE.Mesh(lowerGeo, mats.metal);
      legMesh.position.set(0, axle.y + lowerLen / 2, 0);
      carrier.add(legMesh);
      // fork
      const forkGeo = new THREE.BoxGeometry(0.12, 0.16, 0.05);
      this.geometries.push(forkGeo);
      const fork = new THREE.Mesh(forkGeo, mats.metal);
      fork.position.set(0, axle.y + 0.06, 0);
      carrier.add(fork);
    } else {
      // tubular spring leg from the belly to the axle, origin at the attach point
      const legGeo = new THREE.CylinderGeometry(0.035, 0.03, length, 10);
      legGeo.translate(0, -length / 2, 0); // extends along −Y from the origin
      this.geometries.push(legGeo);
      legMesh = new THREE.Mesh(legGeo, mats.paintPlain);
      legMesh.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().negate()); // −Y → dir
      legMesh.scale.set(1, 1, 0.6);
      root.add(legMesh);
    }

    // wheel + hub + pant at the axle
    const wheelGeo = new THREE.CylinderGeometry(gl.tyreRadius, gl.tyreRadius, gl.width, 22);
    wheelGeo.rotateZ(Math.PI / 2);
    this.geometries.push(wheelGeo);
    const wheel = new THREE.Mesh(wheelGeo, mats.rubber);
    wheel.name = 'wheel';
    const hubGeo = new THREE.CylinderGeometry(gl.tyreRadius * 0.55, gl.tyreRadius * 0.55, gl.width + 0.012, 16);
    hubGeo.rotateZ(Math.PI / 2);
    this.geometries.push(hubGeo);
    wheel.add(new THREE.Mesh(hubGeo, mats.hub));
    const pantGeo = buildPantGeometry();
    this.geometries.push(pantGeo);
    const pant = new THREE.Mesh(pantGeo, mats.paintPlain);
    // teardrop fairing over the upper ~2/3 of the tyre (the tread shows below it)
    pant.scale.set(gl.width * 1.7, gl.tyreRadius * 2.05, gl.tyreRadius * (isNose ? 3.6 : 4.2));
    pant.position.set(0, gl.tyreRadius * 0.38, gl.tyreRadius * 0.25);
    pant.name = 'pant';

    const wheelGroup = new THREE.Group();
    wheelGroup.add(wheel, pant);
    if (isNose) {
      wheelGroup.position.copy(axle);
      carrier.add(wheelGroup);
      root.add(carrier);
    } else {
      wheelGroup.position.copy(axle);
      carrier.add(wheelGroup);
      root.add(carrier);
    }
    this.group.add(root);
    return { layout: gl, root, carrier, legMesh, wheel, dir, length, isNose };
  }

  /** Apply the FDM gear states (indexed like config.gear). */
  update(states: readonly GearState[], dt: number): void {
    for (const leg of this.legs) {
      const s = states[leg.layout.index];
      if (!s) continue;
      // NaN / negative → 0, +∞ → the cap (a NaN would otherwise hide the wheel)
      const c = s.compressionM > 0 ? Math.min(s.compressionM, leg.layout.tyreRadius * 2) : 0;
      if (leg.isNose) {
        leg.carrier.position.y = c;
        // steerRad > 0 = wheel turned right (about body +z, down) ⇒ negative about model +Y
        leg.root.rotation.y = -finiteOr(s.steerRad);
      } else {
        // shorten the leg so the axle rises by c (vertical component of the leg direction)
        const dy = -leg.dir.y * leg.length; // positive drop
        const k = dy > 1e-6 ? Math.max(0.2, (dy - c) / dy) : 1;
        leg.legMesh.scale.y = k;
        leg.carrier.position.set(leg.dir.x * leg.length * (k - 1), leg.dir.y * leg.length * (k - 1), leg.dir.z * leg.length * (k - 1));
      }
      // rolling forward (toward −Z) turns the top of the tyre forward: negative about +X
      leg.wheel.rotation.x -= (finiteOr(s.wheelSpeedMs) / leg.layout.tyreRadius) * dt;
      if (Math.abs(leg.wheel.rotation.x) > 2 * Math.PI) leg.wheel.rotation.x %= 2 * Math.PI;
    }
  }

  /** For tests: the nose steering pivot (null without a nose wheel). */
  get noseRoot(): THREE.Group | null { return this.legs.find((l) => l.isNose)?.root ?? null; }
  /** For tests: carriers (move with compression) by config index. */
  carrierFor(index: number): THREE.Group | null { return this.legs.find((l) => l.layout.index === index)?.carrier ?? null; }
  wheelFor(index: number): THREE.Mesh | null { return this.legs.find((l) => l.layout.index === index)?.wheel ?? null; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
  }
}
