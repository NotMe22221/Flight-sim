/**
 * Two-blade fixed-pitch propeller with spinner. Below ~400 rpm the blades are rendered and
 * spun at the true rate; above, they fade out and a translucent blurred disc fades in.
 */
import * as THREE from 'three';
import type { C172Layout } from './c172Layout';
import { buildWingPanel, type AirfoilSpec } from './airfoil';
import type { ModelMaterials } from './materials';
import { smoothstep } from '../core/math';

const BLADE_AIRFOIL: AirfoilSpec = { thickness: 0.09, camber: 0.035, camberPos: 0.4 };
const D2R = Math.PI / 180;

export class Propeller {
  readonly group = new THREE.Group();
  /** blade angle, rad (about the prop axis) */
  angle = 0;
  private readonly blades = new THREE.Group();
  private readonly disc: THREE.Mesh;
  private readonly discMaterial: THREE.MeshBasicMaterial;
  private readonly sense: 1 | -1;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(prop: C172Layout['prop'], mats: ModelMaterials) {
    this.group.name = 'propeller';
    this.group.position.copy(prop.hub);
    this.sense = prop.sense;
    const r = prop.diameter / 2;

    // spinner: lathe profile (radius, length) revolved about Y, then pointed toward −Z
    const pts = [new THREE.Vector2(0.0, 0.26), new THREE.Vector2(0.07, 0.21), new THREE.Vector2(0.125, 0.14), new THREE.Vector2(0.155, 0.06), new THREE.Vector2(0.165, 0.0), new THREE.Vector2(0.0, 0.0)];
    const spinnerGeo = new THREE.LatheGeometry(pts, 20);
    spinnerGeo.rotateX(-Math.PI / 2);
    this.geometries.push(spinnerGeo);
    const spinner = new THREE.Mesh(spinnerGeo, mats.paintPlain);
    spinner.name = 'spinner';
    spinner.position.z = -0.02;
    this.blades.add(spinner);

    // blades: span along +X (radial), pitch measured from the disc plane
    const pitch = (deg: number) => -(Math.PI / 2 - deg * D2R);
    const bladeGeo = buildWingPanel({
      airfoil: BLADE_AIRFOIL,
      sections: [
        { x: 0.1, chord: 0.1, le: { x: 0, y: 0, z: -0.025 }, twist: pitch(30) },
        { x: r * 0.45, chord: 0.135, le: { x: 0, y: 0, z: -0.034 }, twist: pitch(19) },
        { x: r * 0.8, chord: 0.11, le: { x: 0, y: 0, z: -0.028 }, twist: pitch(12) },
        { x: r, chord: 0.06, le: { x: 0, y: 0, z: -0.015 }, twist: pitch(9) },
      ],
      capRoot: true, capTip: true, points: 8,
    });
    this.geometries.push(bladeGeo);
    for (let i = 0; i < prop.blades; i++) {
      const b = new THREE.Mesh(bladeGeo, mats.blade);
      b.rotation.z = (2 * Math.PI * i) / prop.blades;
      b.position.z = -0.12;
      b.name = `blade${i}`;
      this.blades.add(b);
    }
    this.group.add(this.blades);

    // blur disc in the blade plane
    const discGeo = new THREE.CircleGeometry(r, 48);
    this.geometries.push(discGeo);
    this.discMaterial = mats.propDisc;
    this.disc = new THREE.Mesh(discGeo, this.discMaterial);
    this.disc.position.z = -0.12;
    this.disc.visible = false;
    this.disc.renderOrder = 3;
    this.disc.name = 'propDisc';
    this.group.add(this.disc);
  }

  /** Advance by dt with the engine at `rpm`. */
  update(rpm: number, dt: number): void {
    const omega = (rpm * 2 * Math.PI) / 60;
    this.angle -= this.sense * omega * dt;
    if (this.angle > 2 * Math.PI || this.angle < -2 * Math.PI) this.angle %= 2 * Math.PI;
    const discK = smoothstep(330, 520, rpm);
    const bladesVisible = rpm < 450;
    this.blades.visible = bladesVisible;
    if (bladesVisible) this.blades.rotation.z = this.angle;
    this.disc.visible = discK > 0.001;
    this.discMaterial.opacity = 0.85 * discK;
    // slow shimmer of the blur pattern (the real rate would alias)
    this.disc.rotation.z -= this.sense * 2.5 * dt;
  }

  /** true when the disc (not blades) is being shown */
  get discVisible(): boolean { return this.disc.visible; }
  get bladesVisible(): boolean { return this.blades.visible; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
  }
}
