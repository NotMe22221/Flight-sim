/**
 * Conventional (tail-wheel) gear of the Super Cub.
 *
 * - Mains: per side a V of two steel legs (the front one carries the bungee shock cords under an
 *   aluminium fairing at its top) meeting at the axle knuckle inboard of the tyre, and the split
 *   axle hinged on the belly centreline. `compressionM` lifts the axle; the legs and the axle
 *   tube are re-aimed at it every frame (allocation-free), the bungee fairing stays put.
 * - Tail wheel: a leaf spring runs aft from under the tail cone to the swivel; the fork and wheel
 *   steer about the swivel axis (`steerRad`, + = wheel turned right) with a little caster trail,
 *   and the spring flexes so the wheel rises by `compressionM`.
 * Fat 8.00-6 main tyres are lathe-turned; every wheel spins with `wheelSpeedMs / tyreRadius`.
 */
import * as THREE from 'three';
import type { GearState } from '../core/types';
import type { CubLayout, CubMainGearLayout, CubTailWheelLayout } from './cubLayout';
import type { GearAssembly } from './gear';
import type { ModelMaterials } from './materials';
import { finiteOr } from './finite';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** A member re-aimed every frame between a fixed point and a moving one (unit cylinder/box along +Y). */
interface Member { mesh: THREE.Mesh; from: THREE.Vector3; to0: THREE.Vector3 }

interface MainLeg { layout: CubMainGearLayout; carrier: THREE.Group; wheel: THREE.Mesh; members: Member[] }

interface TailLeg { layout: CubTailWheelLayout; carrier: THREE.Group; pivot: THREE.Group; wheel: THREE.Mesh; spring: Member }

/**
 * Tyre of radius r and width w: a rounded section (sidewalls bulging past the rim), revolved
 * about +Y and turned so the axle runs along X. The profile runs from the left rim out, across
 * the tread and back in, so the lathe faces point outward.
 */
export function buildTyreGeometry(r: number, w: number, rimR: number, segments = 28): THREE.BufferGeometry {
  const prof: [number, number][] = [
    [0, -0.36], [0.28, -0.49], [0.55, -0.5], [0.75, -0.46], [0.88, -0.36], [0.96, -0.22], [1, -0.08],
    [1, 0.08], [0.96, 0.22], [0.88, 0.36], [0.75, 0.46], [0.55, 0.5], [0.28, 0.49], [0, 0.36],
  ];
  const pts = prof.map(([k, a]) => new THREE.Vector2(rimR + (r - rimR) * k, a * w));
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateZ(Math.PI / 2); // lathe axis +Y → −X
  return g;
}

export class CubGear implements GearAssembly {
  readonly group = new THREE.Group();
  private readonly mains: MainLeg[] = [];
  private readonly tail: TailLeg | null = null;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(gear: CubLayout['gear'], mats: ModelMaterials) {
    this.group.name = 'gear';
    const keep = <T extends THREE.BufferGeometry>(g: T): T => { this.geometries.push(g); return g; };
    // unit members along +Y (base at the origin), scaled to length every frame
    const legGeo = keep(new THREE.CylinderGeometry(0.021, 0.021, 1, 10).translate(0, 0.5, 0));
    const axleGeo = keep(new THREE.CylinderGeometry(0.026, 0.026, 1, 10).translate(0, 0.5, 0));
    const springGeo = keep(new THREE.BoxGeometry(0.05, 1, 0.014).translate(0, 0.5, 0));
    const member = (geo: THREE.BufferGeometry, mat: THREE.Material, from: THREE.Vector3, to0: THREE.Vector3, parent: THREE.Object3D, name: string): Member => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      parent.add(mesh);
      const m = { mesh, from: from.clone(), to0: to0.clone() };
      aim(m, 0);
      return m;
    };

    for (const gl of gear.mains) {
      const root = new THREE.Group();
      root.name = `gear:${gl.name}`;
      const side = gl.contact.x < 0 ? -1 : 1;
      const axle = gl.contact.clone(); axle.y += gl.tyreRadius;
      // the V legs meet at a knuckle just inboard of the tyre; the split axle runs into the hub
      const knuckle = axle.clone(); knuckle.x -= side * (gl.width / 2 + 0.035);
      const members = [
        member(legGeo, mats.paintPlain, gl.attach, knuckle, root, 'frontLeg'),
        member(legGeo, mats.paintPlain, gl.rearAttach, knuckle, root, 'rearLeg'),
        member(axleGeo, mats.paintPlain, gl.axleHinge, knuckle, root, 'splitAxle'),
      ];
      // bungee shock-cord fairing over the top of the front leg (fixed to the fuselage)
      const fairing = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 16, 10)), mats.paintPlain);
      fairing.name = 'bungeeFairing';
      fairing.position.copy(gl.bungee.center);
      fairing.quaternion.setFromUnitVectors(Y_AXIS, tmpA.subVectors(knuckle, gl.attach).normalize());
      fairing.scale.set(gl.bungee.width / 2, gl.bungee.length / 2, gl.bungee.depth / 2);
      root.add(fairing);
      // wheel: tyre + hub (rim, brake disc, hub cap), moving with the compression
      const carrier = new THREE.Group();
      const wheel = new THREE.Mesh(keep(buildTyreGeometry(gl.tyreRadius, gl.width, gl.tyreRadius * 0.36)), mats.rubber);
      wheel.name = 'wheel';
      const hub = new THREE.Mesh(keep(new THREE.CylinderGeometry(gl.tyreRadius * 0.36, gl.tyreRadius * 0.36, gl.width * 0.78, 18).rotateZ(Math.PI / 2)), mats.hub);
      const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(gl.tyreRadius * 0.16, gl.tyreRadius * 0.2, 0.03, 14).rotateZ(Math.PI / 2)), mats.metal);
      cap.position.x = side * (gl.width * 0.39 + 0.012);
      wheel.add(hub, cap);
      wheel.position.copy(axle);
      carrier.add(wheel);
      root.add(carrier);
      this.group.add(root);
      this.mains.push({ layout: gl, carrier, wheel, members });
    }

    const tl = gear.tail;
    if (tl) {
      const root = new THREE.Group();
      root.name = `gear:${tl.name}`;
      const carrier = new THREE.Group();
      const pivot = new THREE.Group();
      pivot.position.copy(tl.attach);
      // swivel housing, steering (tiller) arms, fork and wheel, in the swivel frame
      const housing = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.024, 0.026, 0.05, 12)), mats.metal);
      housing.position.y = -0.01;
      const arms = new THREE.Mesh(keep(new THREE.BoxGeometry(0.17, 0.008, 0.02)), mats.metal);
      arms.position.y = 0.012;
      pivot.add(housing, arms);
      const axleRel = new THREE.Vector3(0, tl.contact.y + tl.tyreRadius - tl.attach.y, tl.contact.z - tl.attach.z);
      const forkGeo = keep(new THREE.BoxGeometry(0.012, 1, 0.026).translate(0, 0.5, 0));
      for (const s of [1, -1]) {
        const top = new THREE.Vector3(s * (tl.width / 2 + 0.01), -0.03, 0);
        const bottom = axleRel.clone(); bottom.x = s * (tl.width / 2 + 0.01);
        const fork = new THREE.Mesh(forkGeo, mats.metal);
        fork.position.copy(top);
        fork.quaternion.setFromUnitVectors(Y_AXIS, tmpA.subVectors(bottom, top).normalize());
        fork.scale.y = top.distanceTo(bottom);
        pivot.add(fork);
      }
      const crown = new THREE.Mesh(keep(new THREE.BoxGeometry(tl.width + 0.045, 0.014, 0.03)), mats.metal);
      crown.position.y = -0.035;
      pivot.add(crown);
      const wheel = new THREE.Mesh(keep(buildTyreGeometry(tl.tyreRadius, tl.width, tl.tyreRadius * 0.45, 20)), mats.rubber);
      wheel.name = 'tailWheel';
      wheel.add(new THREE.Mesh(keep(new THREE.CylinderGeometry(tl.tyreRadius * 0.45, tl.tyreRadius * 0.45, tl.width * 0.8, 14).rotateZ(Math.PI / 2)), mats.hub));
      wheel.position.copy(axleRel);
      pivot.add(wheel);
      carrier.add(pivot);
      root.add(carrier);
      const spring = member(springGeo, mats.metal, tl.springRoot, tl.attach, root, 'leafSpring');
      this.group.add(root);
      this.tail = { layout: tl, carrier, pivot, wheel, spring };
    }
  }

  update(states: readonly GearState[], dt: number): void {
    for (const leg of this.mains) {
      const s = states[leg.layout.index];
      if (!s) continue;
      const c = compression(s, leg.layout.tyreRadius);
      leg.carrier.position.y = c;
      for (const m of leg.members) aim(m, c);
      spin(leg.wheel, s, leg.layout.tyreRadius, dt);
    }
    const t = this.tail;
    if (t) {
      const s = states[t.layout.index];
      if (s) {
        const c = compression(s, t.layout.tyreRadius);
        t.carrier.position.y = c;
        aim(t.spring, c);
        // steerRad > 0 = wheel turned right (about body +z, down) ⇒ negative about model +Y
        t.pivot.rotation.y = -finiteOr(s.steerRad);
        spin(t.wheel, s, t.layout.tyreRadius, dt);
      }
    }
  }

  get noseRoot(): THREE.Group | null { return null; }
  get tailRoot(): THREE.Group | null { return this.tail?.pivot ?? null; }
  carrierFor(index: number): THREE.Group | null {
    if (this.tail && this.tail.layout.index === index) return this.tail.carrier;
    return this.mains.find((l) => l.layout.index === index)?.carrier ?? null;
  }
  wheelFor(index: number): THREE.Mesh | null {
    if (this.tail && this.tail.layout.index === index) return this.tail.wheel;
    return this.mains.find((l) => l.layout.index === index)?.wheel ?? null;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
  }
}

/** NaN / negative → 0, +∞ → the cap (a NaN would otherwise hide the wheel). */
function compression(s: GearState, tyreRadius: number): number {
  return s.compressionM > 0 ? Math.min(s.compressionM, tyreRadius * 2) : 0;
}

/** Re-aim a member from its fixed end to its moving end (raised by c). */
function aim(m: Member, c: number): void {
  tmpB.copy(m.to0); tmpB.y += c;
  tmpA.subVectors(tmpB, m.from);
  const len = tmpA.length();
  m.mesh.position.copy(m.from);
  if (len > 1e-6) m.mesh.quaternion.setFromUnitVectors(Y_AXIS, tmpA.multiplyScalar(1 / len));
  m.mesh.scale.y = Math.max(1e-3, len);
}

/** rolling forward (toward −Z) turns the top of the tyre forward: negative about +X */
function spin(wheel: THREE.Mesh, s: GearState, r: number, dt: number): void {
  wheel.rotation.x -= (finiteOr(s.wheelSpeedMs) / r) * dt;
  if (Math.abs(wheel.rotation.x) > 2 * Math.PI) wheel.rotation.x %= 2 * Math.PI;
}
