/**
 * Cockpit shell seen from the pilot's eye: lining that hugs the cabin loft (with glass where
 * the windows are), floor, firewall, glareshield, instrument panel planes, seats, yokes that
 * follow pitch/roll inputs, rudder pedals, throttle and mixture knobs.
 */
import * as THREE from 'three';
import type { ControlInputs } from '../core/types';
import type { C172Layout } from './c172Layout';
import { LoftProfile, buildLoftPatch } from './loft';
import type { ModelMaterials } from './materials';

export type PanelVariant = 'steam' | 'g1000';

export class CockpitInterior {
  readonly group = new THREE.Group();
  /** steam-gauge panel plane (1.0 × 0.45 m); the instruments module sets `material.map` */
  readonly panelMesh: THREE.Mesh;
  /** G1000-sized panel plane (1.0 × 0.36 m), hidden until {@link setPanelVariant}('g1000') */
  readonly panelMeshG1000: THREE.Mesh;
  private readonly yokes: THREE.Group[] = [];
  private readonly yokeBaseZ: number;
  private readonly pedalLeft: THREE.Mesh;
  private readonly pedalRight: THREE.Mesh;
  private readonly pedalBaseZ: number;
  private readonly throttle: THREE.Group;
  private readonly mixture: THREE.Group;
  private readonly knobBaseZ: number;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(layout: C172Layout, cabinProfile: LoftProfile, mats: ModelMaterials) {
    const g = this.group;
    g.name = 'interior';
    const keep = <T extends THREE.BufferGeometry>(geo: T): T => { this.geometries.push(geo); return geo; };

    // --- lining and interior glass hugging the cabin loft ---
    for (const p of layout.lining) {
      const m = new THREE.Mesh(keep(buildLoftPatch(cabinProfile, { z0: p.z0, z1: p.z1, t0: p.t0, t1: p.t1, offset: -0.03, inside: true })), mats.interior);
      m.receiveShadow = true;
      g.add(m);
    }
    for (const w of layout.windows) {
      const m = new THREE.Mesh(keep(buildLoftPatch(cabinProfile, { z0: w.z0, z1: w.z1, t0: w.t0, t1: w.t1, offset: -0.02, inside: true })), mats.glassInterior);
      m.name = `interiorGlass:${w.name}`;
      m.renderOrder = 2;
      g.add(m);
    }
    // thin pillars along window edges (A/B posts) for a window-frame look
    const postGeo = keep(new THREE.BoxGeometry(0.03, 0.62, 0.035));
    for (const side of [-1, 1]) {
      for (const z of [-0.45, 0.46, 1.1]) {
        const post = new THREE.Mesh(postGeo, mats.interiorDark);
        post.position.set(side * 0.5, 0.52, z);
        g.add(post);
      }
    }

    // --- floor, firewall, rear bulkhead ---
    const floor = new THREE.Mesh(keep(new THREE.BoxGeometry(1.0, 0.02, 2.5)), mats.interiorDark);
    floor.position.set(0, -0.45, 0.3);
    floor.receiveShadow = true;
    g.add(floor);
    const firewall = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.08, 1.1)), mats.interiorDark);
    firewall.position.set(0, 0.0, -1.1);
    g.add(firewall);
    const bulkhead = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.9, 1.1)), mats.interiorDark);
    bulkhead.position.set(0, 0.25, 1.68);
    bulkhead.rotation.y = Math.PI;
    g.add(bulkhead);

    // --- glareshield + panel ---
    const gs = layout.glareshield;
    const glare = new THREE.Mesh(keep(new THREE.BoxGeometry(gs.width, 0.035, gs.depth)), mats.interiorDark);
    glare.position.copy(gs.center);
    g.add(glare);
    const pnl = layout.panel;
    const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(pnl.width + 0.06, pnl.height + 0.06, 0.03)), mats.panelFrame);
    frame.position.copy(pnl.center).z -= 0.02;
    frame.rotation.x = -pnl.tiltRad;
    g.add(frame);
    this.panelMesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(pnl.width, pnl.height)), mats.panel);
    this.panelMesh.name = 'panel:steam';
    this.panelMesh.position.copy(pnl.center);
    this.panelMesh.rotation.x = -pnl.tiltRad;
    g.add(this.panelMesh);
    this.panelMeshG1000 = new THREE.Mesh(keep(new THREE.PlaneGeometry(pnl.width, pnl.g1000Height)), mats.panelG1000);
    this.panelMeshG1000.name = 'panel:g1000';
    this.panelMeshG1000.position.copy(pnl.center);
    this.panelMeshG1000.rotation.x = -pnl.tiltRad;
    this.panelMeshG1000.visible = false;
    g.add(this.panelMeshG1000);
    // lower panel / pedestal with the push-pull knobs
    const pedestal = new THREE.Mesh(keep(new THREE.BoxGeometry(0.34, 0.26, 0.12)), mats.panelFrame);
    pedestal.position.set(0.02, pnl.center.y - pnl.height / 2 - 0.12, pnl.center.z + 0.02);
    g.add(pedestal);
    const knob = (x: number, mat: THREE.Material): THREE.Group => {
      const k = new THREE.Group();
      const shaft = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.007, 0.007, 0.12, 8)), mats.metal);
      shaft.rotation.x = Math.PI / 2; shaft.position.z = -0.06;
      const head = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 12)), mat);
      head.rotation.x = Math.PI / 2;
      k.add(shaft, head);
      k.position.set(x, pedestal.position.y + 0.02, pedestal.position.z + 0.08);
      g.add(k);
      return k;
    };
    this.throttle = knob(-0.05, mats.knobBlack);
    this.mixture = knob(0.07, mats.knobRed);
    this.knobBaseZ = pedestal.position.z + 0.08;

    // --- seats ---
    const panGeo = keep(new THREE.BoxGeometry(0.46, 0.12, 0.5));
    const backGeo = keep(new THREE.BoxGeometry(0.46, 0.62, 0.09));
    for (const x of [layout.eye.x, -layout.eye.x]) {
      const pan = new THREE.Mesh(panGeo, mats.seat);
      pan.position.set(x, layout.eye.y - 0.78, layout.eye.z + 0.15);
      const back = new THREE.Mesh(backGeo, mats.seat);
      back.position.set(x, layout.eye.y - 0.42, layout.eye.z + 0.33);
      back.rotation.x = -0.15;
      g.add(pan, back);
    }

    // --- yokes ---
    const yokeZ = layout.eye.z - 0.35;
    this.yokeBaseZ = yokeZ;
    const hornGeo = keep(new THREE.TorusGeometry(0.12, 0.014, 8, 18, Math.PI));
    const gripGeo = keep(new THREE.CylinderGeometry(0.016, 0.016, 0.09, 8));
    const shaftGeo = keep(new THREE.CylinderGeometry(0.014, 0.014, 0.4, 8));
    for (const x of [layout.eye.x, -layout.eye.x]) {
      const y = new THREE.Group();
      y.position.set(x, layout.eye.y - 0.36, yokeZ);
      const horn = new THREE.Mesh(hornGeo, mats.interiorDark); // half torus, opening downward
      const gripL = new THREE.Mesh(gripGeo, mats.interiorDark); gripL.position.set(-0.12, -0.045, 0);
      const gripR = new THREE.Mesh(gripGeo, mats.interiorDark); gripR.position.set(0.12, -0.045, 0);
      const hub = new THREE.Mesh(keep(new THREE.BoxGeometry(0.1, 0.06, 0.04)), mats.interiorDark);
      y.add(horn, gripL, gripR, hub);
      const shaft = new THREE.Mesh(shaftGeo, mats.metal);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = -0.2;
      y.add(shaft);
      g.add(y);
      this.yokes.push(y);
    }

    // --- rudder pedals ---
    const pedalGeo = keep(new THREE.BoxGeometry(0.1, 0.15, 0.02));
    this.pedalBaseZ = layout.panel.center.z + 0.1;
    this.pedalLeft = new THREE.Mesh(pedalGeo, mats.metal);
    this.pedalRight = new THREE.Mesh(pedalGeo, mats.metal);
    this.pedalLeft.position.set(layout.eye.x - 0.13, -0.33, this.pedalBaseZ);
    this.pedalRight.position.set(layout.eye.x + 0.13, -0.33, this.pedalBaseZ);
    this.pedalLeft.rotation.x = -0.4; this.pedalRight.rotation.x = -0.4;
    g.add(this.pedalLeft, this.pedalRight);
  }

  /** Animate controls from the pilot inputs. */
  update(inputs: ControlInputs): void {
    const pitch = Math.max(-1, Math.min(1, inputs.pitch));
    const roll = Math.max(-1, Math.min(1, inputs.roll));
    const yaw = Math.max(-1, Math.min(1, inputs.yaw));
    for (const y of this.yokes) {
      y.position.z = this.yokeBaseZ + 0.07 * pitch; // stick back ⇒ toward the pilot (+Z)
      y.rotation.z = -1.3 * roll;                  // roll right ⇒ clockwise seen by the pilot
    }
    this.pedalRight.position.z = this.pedalBaseZ - 0.06 * yaw; // nose right ⇒ right pedal forward (−Z)
    this.pedalLeft.position.z = this.pedalBaseZ + 0.06 * yaw;
    this.throttle.position.z = this.knobBaseZ + 0.09 * (1 - Math.max(0, Math.min(1, inputs.throttle)));
    this.mixture.position.z = this.knobBaseZ + 0.09 * (1 - Math.max(0, Math.min(1, inputs.mixture)));
  }

  setPanelVariant(v: PanelVariant): void {
    this.panelMesh.visible = v === 'steam';
    this.panelMeshG1000.visible = v === 'g1000';
  }

  /** For tests */
  get yokeGroups(): readonly THREE.Group[] { return this.yokes; }

  dispose(): void {
    for (const geo of this.geometries) geo.dispose();
  }
}
