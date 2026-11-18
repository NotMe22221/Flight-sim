/**
 * Airport windsock: a 6 m pole and a 3.6 m orange-and-white sock (five bands, as the FAA standard
 * L-807 sock) that streams downwind. Like a real one it is fully extended at 15 kt and hangs nearly
 * straight down in calm air; it swings toward a new wind direction with some lag and flutters in gusts.
 * Built in a local frame: +y up, sock along +x before rotation.
 */
import * as THREE from 'three';

const POLE_M = 6;
const SOCK_M = 3.6;
const FULL_KT = 15;
const KT = 0.514444;

/** Droop below horizontal (rad) for a wind speed: ~80° in calm, 0 from 15 kt. */
export function windsockDroopRad(speedMs: number): number {
  const f = Math.max(0, Math.min(1, speedMs / (FULL_KT * KT)));
  return (80 * Math.PI / 180) * (1 - f) ** 1.5;
}

/** Yaw (Object3D rotation.y, render frame x E, y U, z S) that points local +x along a true bearing. */
export function yawForBearingRad(bearingRad: number): number { return Math.PI / 2 - bearingRad; }

let sharedGeo: { pole: THREE.BufferGeometry; sock: THREE.BufferGeometry } | null = null;
let sharedMat: { pole: THREE.MeshStandardMaterial; sock: THREE.MeshStandardMaterial } | null = null;

function geometries() {
  if (sharedGeo) return sharedGeo;
  const pole = new THREE.CylinderGeometry(0.06, 0.09, POLE_M + 1.5, 6);
  pole.translate(0, (POLE_M + 1.5) / 2 - 1.5, 0); // 1.5 m below the base: never floats on uneven ground
  // a truncated cone along +x, 0.9 m mouth to 0.45 m tail, five colour bands
  const sock = new THREE.CylinderGeometry(0.225, 0.45, SOCK_M, 10, 5, true);
  sock.rotateZ(-Math.PI / 2); // cylinder axis y → x, the wide end (bottom, -y) at -x
  sock.translate(SOCK_M / 2, 0, 0);
  const pos = sock.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const orange = new THREE.Color(0xff5a0a).convertSRGBToLinear(), white = new THREE.Color(0xf2f2ee).convertSRGBToLinear();
  for (let i = 0; i < pos.count; i++) {
    const band = Math.min(4, Math.floor((pos.getX(i) / SOCK_M) * 5 + 1e-4));
    // vertices on a band border belong to the band starting there; the shared ring takes the outer band's colour
    const c = band % 2 === 0 ? orange : white;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  sock.setAttribute('color', new THREE.BufferAttribute(col, 3));
  sharedGeo = { pole, sock };
  return sharedGeo;
}

function materials() {
  if (sharedMat) return sharedMat;
  sharedMat = {
    pole: new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.6, metalness: 0.4 }),
    sock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
  };
  return sharedMat;
}

export class Windsock {
  readonly group = new THREE.Group();
  private readonly yaw = new THREE.Group();
  private readonly droop = new THREE.Group();
  private heading = Math.random() * Math.PI * 2;
  private droopRad = windsockDroopRad(0);
  private t = Math.random() * 100;

  constructor(position: THREE.Vector3) {
    const g = geometries(), m = materials();
    this.group.name = 'windsock';
    this.group.position.copy(position);
    const pole = new THREE.Mesh(g.pole, m.pole);
    const sock = new THREE.Mesh(g.sock, m.sock);
    pole.castShadow = sock.castShadow = true;
    this.yaw.position.y = POLE_M;
    this.yaw.add(this.droop);
    this.droop.add(sock);
    this.group.add(pole, this.yaw);
    this.apply();
  }

  /** Current yaw toward which the sock points (true bearing, rad) and droop (rad), for tests. */
  get pose(): { bearingRad: number; droopRad: number } { return { bearingRad: this.heading, droopRad: this.droopRad }; }

  /**
   * @param windN wind velocity north (m/s, the direction the air moves)
   * @param windE wind velocity east (m/s)
   */
  update(dtS: number, windN: number, windE: number): void {
    if (!(dtS > 0)) return;
    this.t += dtS;
    const speed = Math.hypot(windN, windE);
    const target = Math.atan2(windE, windN); // bearing the air flows toward
    // light winds barely turn it; it follows a steady breeze within a second or two
    const k = 1 - Math.exp(-dtS * (0.4 + Math.min(speed, 8) * 0.3));
    if (speed > 0.3) {
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * k;
    }
    this.droopRad += (windsockDroopRad(speed) - this.droopRad) * (1 - Math.exp(-dtS * 2));
    this.apply(speed);
  }

  private apply(speed = 0): void {
    // flutter: a few degrees of yaw and droop wobble, faster in stronger wind
    const f = Math.min(1, speed / (FULL_KT * KT));
    const w = this.t * (3 + 6 * f);
    this.yaw.rotation.y = yawForBearingRad(this.heading) + 0.05 * f * Math.sin(w * 1.3);
    this.droop.rotation.z = -(this.droopRad + 0.04 * (0.3 + f) * Math.sin(w));
  }

  dispose(): void { this.group.removeFromParent(); }
}
