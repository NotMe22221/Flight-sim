/**
 * Cockpit shell seen from the pilot's eye: a lining that follows the fuselage profile with the
 * same window cut-outs as the skin (reveals facing into each opening, slim A-pillars), fabric
 * door panels with armrests, a padded glareshield hood over the instrument panel planes, floor,
 * firewall, seats, yokes that follow pitch/roll inputs, rudder pedals, throttle and mixture.
 */
import * as THREE from 'three';
import type { AircraftState, ControlInputs } from '../core/types';
import type { C172Layout } from './c172Layout';
import type { LoftProfile } from './loft';
import type { ModelMaterials } from './materials';
import { buildLoftCap } from './fuselage';
import { buildSkin, inside, outlineField, outside } from './skin';

export type PanelVariant = 'steam' | 'g1000';

/** Instrument panel plane: assign the instruments texture to `material.map`. */
export type PanelMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/** What {@link AircraftModel} needs from a cockpit (C172 side by side, Cub tandem). */
export interface CockpitAssembly {
  readonly group: THREE.Group;
  /** steam panel plane (2:1 like its 1024×512 texture); the instruments module sets `material.map` */
  readonly panelMesh: PanelMesh;
  /** G1000 plane (hidden unless the variant is 'g1000'; the Cub has none and keeps it hidden) */
  readonly panelMeshG1000: PanelMesh;
  /** pilot control columns: the C172's two yokes, the Cub's front and rear sticks */
  readonly yokeGroups: readonly THREE.Group[];
  /** animate the controls from the pilot inputs (and the state: flap handle, fuel gauges) */
  update(inputs: ControlInputs, state?: AircraftState): void;
  setPanelLighting(daylight: number, panelLight: number): void;
  setPanelVariant(v: PanelVariant): void;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Glareshield hood: a padded profile (lip over the panel top, top surface running forward to
 * the windshield) swept across the cabin; the ends drop and recede to clear the A-pillars.
 */
function buildHood(gs: C172Layout['glareshield'], panelTop: { y: number; z: number }): THREE.BufferGeometry {
  const { lipY, lipZ, frontY, frontZ, width: W } = gs;
  const prof: Array<[number, number]> = [
    [panelTop.z - 0.006, panelTop.y - 0.004],
    [lipZ - 0.012, lipY - 0.022],
    [lipZ + 0.002, lipY - 0.012],
    [lipZ + 0.006, lipY - 0.002],
    [lipZ, lipY + 0.006],
    [lipZ - 0.03, lipY + 0.008],
    [(lipZ + frontZ) / 2 - 0.015, (lipY + frontY) / 2 + 0.004],
    [frontZ, frontY],
    [frontZ - 0.01, frontY - 0.025],
  ];
  const m = prof.length, nx = 48;
  const pos: number[] = [];
  const idx: number[] = [];
  const zr = lipZ - 0.03;
  const ends: number[][] = [[], []];
  for (let i = 0; i <= nx; i++) {
    const x = -W / 2 + (W * i) / nx;
    const s = smooth(0.36, W / 2, Math.abs(x));
    for (const [z, y] of prof) {
      const zz = z < zr ? zr + (z - zr) * (1 - 0.55 * s) : z;
      if (i === 0 || i === nx) ends[i === 0 ? 0 : 1].push(x, y - 0.045 * s * s, zz);
      pos.push(x, y - 0.045 * s * s, zz);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < m - 1; k++) {
      const a = i * m + k, b = a + 1, c = a + m, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // end caps (fans over the closed profile)
  const base = pos.length / 3;
  pos.push(...ends[0], ...ends[1]);
  for (let k = 1; k < m - 1; k++) {
    idx.push(base, base + k + 1, base + k); // left end faces −X
    idx.push(base + m, base + m + k, base + m + k + 1); // right end faces +X
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Light on the unlit (MeshBasicMaterial, not tone-mapped) instrument panels at night, as a linear factor on
 * the texture as drawn (1 = daylight). The night scene around the panel is dark (sRGB ≈ 0–60), so the warm
 * post lights bring the gauge faces, their markings and the panel background to ≈ 30 % (white markings
 * ≈ 150 / 255 on black faces: readable, no longer the daylight panel they were at 0.7); with the lights off
 * the faces keep a dim floor. The G1000 screens are backlit LCDs: at night they dim to 35 %.
 */
export const PANEL_NIGHT = { postLights: 0.3, floor: 0.1, g1000: 0.35 } as const;

/**
 * Instrument lighting shared by the cockpits. The panel planes are unlit (MeshBasicMaterial),
 * so their colour is the light on the gauges: daylight (0 night … 1 day) or the warm post
 * lights (`panelLight` 0..1), whichever is brighter, with a dim floor so the faces never go
 * fully black (`PANEL_NIGHT`). The G1000 screens are emissive: they dim with the daylight to
 * `PANEL_NIGHT.g1000`.
 */
export function applyPanelLighting(steam: PanelMesh, g1000: PanelMesh, daylight: number, panelLight: number): void {
  const d = Math.max(0, Math.min(1, daylight || 0));
  const p = PANEL_NIGHT.postLights * Math.max(0, Math.min(1, panelLight || 0));
  // the floor (≈ 35 % perceived) keeps a night spawn with the panel lights off readable
  const base = PANEL_NIGHT.floor + (1 - PANEL_NIGHT.floor) * d;
  steam.material.color.setRGB(Math.max(base, p), Math.max(base, p * 0.9), Math.max(base, p * 0.72));
  const glass = PANEL_NIGHT.g1000 + (1 - PANEL_NIGHT.g1000) * d;
  g1000.material.color.setRGB(glass, glass, glass);
}

export class CockpitInterior implements CockpitAssembly {
  readonly group = new THREE.Group();
  /** steam-gauge panel plane (0.96 × 0.48 m, 2:1 like its texture); the instruments module sets `material.map` */
  readonly panelMesh: PanelMesh;
  /** G1000 panel plane (0.96 × 0.35 m, PFD + MFD), hidden until {@link setPanelVariant}('g1000') */
  readonly panelMeshG1000: PanelMesh;
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
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name?: string): THREE.Mesh => {
      const m = new THREE.Mesh(keep(geo), mat);
      if (name) m.name = name;
      g.add(m);
      return m;
    };
    const F = layout.fuselage, C = layout.cabin, eye = layout.eye;

    // --- lining with window cut-outs (doors first, so cells inside a door panel are skipped) ---
    const winFields = layout.windows.map(outlineField);
    const doorFields = layout.doors.map(outlineField);
    const lin = { dz: 0.04, radial: 72, offset: -0.03, inside: true } as const;
    const nd = doorFields.length;
    const main = buildSkin(cabinProfile, {
      ...lin, z0: F.firewallZ, z1: F.cabinEndZ - 0.05,
      keep: [...doorFields.map(outside), ...winFields.map(outside)],
      reveal: { constraints: winFields.map((_, i) => nd + i), to: -0.012 },
    });
    add(main.geometry, mats.interior, 'lining');
    add(main.reveal, mats.interior, 'reveals');
    for (const df of doorFields) {
      const d = buildSkin(cabinProfile, {
        ...lin, z0: F.firewallZ, z1: 0.5,
        keep: [inside(df), ...winFields.map(outside)],
        reveal: { constraints: winFields.map((_, i) => 1 + i), to: -0.012 },
      });
      add(d.geometry, mats.doorPanel, 'doorPanel');
      add(d.reveal, mats.interior, 'doorReveals');
    }
    layout.windows.forEach((w, i) => {
      const glass = add(buildSkin(cabinProfile, { ...lin, z0: F.cowlEndZ, z1: F.cabinEndZ - 0.05, offset: -0.004, keep: [inside(winFields[i])] }).geometry, mats.glassInterior, `interiorGlass:${w.name}`);
      glass.renderOrder = 2;
    });

    // --- floor, firewall, rear bulkhead (below the rear window) ---
    const floor = add(new THREE.BoxGeometry(0.92, 0.02, F.cabinEndZ - 0.05 - F.firewallZ), mats.interiorDark, 'floor');
    floor.position.set(0, C.floorY, (F.firewallZ + F.cabinEndZ - 0.05) / 2);
    // top edge kept 3 cm under the cowl deck so it cannot poke through the skin ahead of the windshield
    const firewallTop = C.deckY - 0.03;
    const firewall = add(new THREE.PlaneGeometry(1.06, firewallTop - C.floorY), mats.interiorDark, 'firewall');
    firewall.position.set(0, (firewallTop + C.floorY) / 2, F.firewallZ + 0.01);
    add(buildLoftCap(cabinProfile, F.cabinEndZ - 0.05, -1, 48, C.deckY + 0.02), mats.interior, 'bulkhead');

    // --- glareshield hood + panel ---
    const pnl = layout.panel;
    const tilt = pnl.tiltRad;
    const panelTop = { y: pnl.center.y + (pnl.height / 2) * Math.cos(tilt), z: pnl.center.z - (pnl.height / 2) * Math.sin(tilt) };
    add(buildHood(layout.glareshield, panelTop), mats.trimDark, 'glareshield');
    // Panel board 1.5 cm behind the instrument planes (no z-fighting). Its top edge stays under
    // the glareshield lip (a board standing above the hood would hide the cowl from the seat);
    // it runs 0.1 m below the planes, with the lower switch panel under it.
    const boardTop = pnl.height / 2 - 0.006, boardBottom = -pnl.height / 2 - 0.1;
    const boardMid = (boardTop + boardBottom) / 2;
    const frame = add(new THREE.BoxGeometry(1.03, boardTop - boardBottom, 0.02), mats.panelFrame, 'panelBoard');
    // along the tilted panel: local +Y = (0, cos, −sin), local +Z (towards the pilot) = (0, sin, cos)
    frame.position.set(0, pnl.center.y + boardMid * Math.cos(tilt) - 0.025 * Math.sin(tilt), pnl.center.z - boardMid * Math.sin(tilt) - 0.025 * Math.cos(tilt));
    frame.rotation.x = -tilt;
    const panelBottomY = pnl.center.y - (pnl.height / 2) * Math.cos(tilt);
    const lower = add(new THREE.BoxGeometry(1.0, 0.14, 0.03), mats.panelFrame, 'lowerPanel');
    lower.position.set(0, panelBottomY - 0.12, pnl.center.z + 0.02);
    this.panelMesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(pnl.width, pnl.height)), mats.panel);
    this.panelMesh.name = 'panel:steam';
    this.panelMesh.position.copy(pnl.center);
    this.panelMesh.rotation.x = -tilt;
    g.add(this.panelMesh);
    this.panelMeshG1000 = new THREE.Mesh(keep(new THREE.PlaneGeometry(pnl.width, pnl.g1000Height)), mats.panelG1000);
    this.panelMeshG1000.name = 'panel:g1000';
    this.panelMeshG1000.position.copy(pnl.g1000Center);
    this.panelMeshG1000.rotation.x = -tilt;
    this.panelMeshG1000.visible = false;
    g.add(this.panelMeshG1000);
    // pedestal between the seats with the push-pull engine knobs on the lower centre panel
    const pedestal = add(new THREE.BoxGeometry(0.16, panelBottomY - 0.19 - C.floorY, 0.22), mats.panelFrame, 'pedestal');
    pedestal.position.set(0.02, (panelBottomY - 0.19 + C.floorY) / 2, pnl.center.z + 0.1);
    const knobY = panelBottomY - 0.1;
    const knobZ = pnl.center.z + 0.04;
    const knob = (x: number, mat: THREE.Material): THREE.Group => {
      const k = new THREE.Group();
      const shaft = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 8)), mats.metal);
      shaft.rotation.x = Math.PI / 2; shaft.position.z = -0.06;
      const head = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.019, 0.019, 0.028, 14)), mat);
      head.rotation.x = Math.PI / 2;
      k.add(shaft, head);
      k.position.set(x, knobY, knobZ);
      g.add(k);
      return k;
    };
    this.throttle = knob(-0.04, mats.knobBlack);
    this.mixture = knob(0.07, mats.knobRed);
    this.knobBaseZ = knobZ;

    this.yokeBaseZ = eye.z - 0.4;
    this.pedalBaseZ = F.firewallZ + 0.16;
    const parts = this.buildFurniture(layout, mats, keep);
    this.pedalLeft = parts.pedalLeft;
    this.pedalRight = parts.pedalRight;
  }

  /** Seats, door armrests, yokes and rudder pedals. */
  private buildFurniture(layout: C172Layout, mats: ModelMaterials, keep: <T extends THREE.BufferGeometry>(geo: T) => T): { pedalLeft: THREE.Mesh; pedalRight: THREE.Mesh } {
    const g = this.group, C = layout.cabin, eye = layout.eye;
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0): THREE.Mesh => {
      const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      g.add(m);
      return m;
    };
    // front seats (cushion top ≈ 0.27 m above the floor) and the rear bench
    for (const x of [eye.x, -eye.x]) {
      box(0.46, 0.1, 0.48, mats.seat, x, C.floorY + 0.22, eye.z + 0.12);
      box(0.46, 0.66, 0.09, mats.seat, x, C.floorY + 0.62, eye.z + 0.4, -0.16);
      box(0.3, 0.16, 0.08, mats.seat, x, C.floorY + 1.0, eye.z + 0.46, -0.16);
    }
    box(0.92, 0.1, 0.46, mats.seat, 0, C.floorY + 0.22, 1.02);
    box(0.92, 0.6, 0.1, mats.seat, 0, C.floorY + 0.58, 1.33, -0.2);
    // door armrests and handles
    for (const s of [-1, 1]) {
      box(0.06, 0.05, 0.42, mats.interiorDark, s * 0.49, C.sillY - 0.11, -0.12);
      box(0.03, 0.025, 0.12, mats.metal, s * 0.505, C.sillY - 0.05, 0.12);
    }

    // yokes: hub ahead of each seat at chest height, the shaft entering the panel just below the
    // lower six-pack row (it must not cross the instruments); long enough to stay in the panel at
    // full back stick
    const yokeZ = this.yokeBaseZ;
    const hornGeo = keep(new THREE.TorusGeometry(0.12, 0.014, 8, 20, Math.PI));
    const gripGeo = keep(new THREE.CylinderGeometry(0.017, 0.017, 0.1, 10));
    const hubGeo = keep(new THREE.BoxGeometry(0.11, 0.07, 0.05));
    const shaftGeo = keep(new THREE.CylinderGeometry(0.014, 0.014, 0.36, 10));
    for (const x of [eye.x, -eye.x]) {
      const y = new THREE.Group();
      y.position.set(x, eye.y - 0.5, yokeZ);
      const horn = new THREE.Mesh(hornGeo, mats.interiorDark); // half torus, opening downward
      const gripL = new THREE.Mesh(gripGeo, mats.interiorDark); gripL.position.set(-0.12, -0.05, 0);
      const gripR = new THREE.Mesh(gripGeo, mats.interiorDark); gripR.position.set(0.12, -0.05, 0);
      const hub = new THREE.Mesh(hubGeo, mats.interiorDark);
      const shaft = new THREE.Mesh(shaftGeo, mats.metal);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = -0.18;
      y.add(horn, gripL, gripR, hub, shaft);
      g.add(y);
      this.yokes.push(y);
    }

    // rudder pedals
    const pedalGeo = keep(new THREE.BoxGeometry(0.1, 0.15, 0.02));
    const pedalLeft = new THREE.Mesh(pedalGeo, mats.metal);
    const pedalRight = new THREE.Mesh(pedalGeo, mats.metal);
    pedalLeft.position.set(eye.x - 0.13, C.floorY + 0.14, this.pedalBaseZ);
    pedalRight.position.set(eye.x + 0.13, C.floorY + 0.14, this.pedalBaseZ);
    pedalLeft.rotation.x = -0.4; pedalRight.rotation.x = -0.4;
    g.add(pedalLeft, pedalRight);
    return { pedalLeft, pedalRight };
  }

  /** Animate controls from the pilot inputs. */
  update(inputs: ControlInputs): void {
    // `|| 0` maps NaN to 0
    const pitch = Math.max(-1, Math.min(1, inputs.pitch || 0));
    const roll = Math.max(-1, Math.min(1, inputs.roll || 0));
    const yaw = Math.max(-1, Math.min(1, inputs.yaw || 0));
    for (const y of this.yokes) {
      y.position.z = this.yokeBaseZ + 0.07 * pitch; // stick back ⇒ toward the pilot (+Z)
      y.rotation.z = -1.3 * roll;                  // roll right ⇒ clockwise seen by the pilot
    }
    this.pedalRight.position.z = this.pedalBaseZ - 0.06 * yaw; // nose right ⇒ right pedal forward (−Z)
    this.pedalLeft.position.z = this.pedalBaseZ + 0.06 * yaw;
    this.throttle.position.z = this.knobBaseZ + 0.09 * (1 - Math.max(0, Math.min(1, inputs.throttle || 0)));
    this.mixture.position.z = this.knobBaseZ + 0.09 * (1 - Math.max(0, Math.min(1, inputs.mixture || 0)));
  }

  /**
   * Instrument lighting. The panel planes are unlit (MeshBasicMaterial), so their colour is the
   * light on the gauges: daylight (0 night … 1 day) or the warm post lights (`panelLight`
   * 0..1), whichever is brighter, with a dim floor so the faces never go fully black. The
   * G1000 screens are emissive: they dim to `PANEL_NIGHT.g1000` at night. Linear factors; 1 = as drawn.
   */
  setPanelLighting(daylight: number, panelLight: number): void {
    applyPanelLighting(this.panelMesh, this.panelMeshG1000, daylight, panelLight);
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
