/**
 * Super Cub cockpit (tandem, flown from the front seat): a lining that follows the fuselage
 * with the same window cut-outs as the skin (windshield, skylight, split door, side windows),
 * upholstered lower side walls, the exposed steel-tube frame, a small flat instrument panel
 * under a short deck, front and rear sticks, rudder pedals, throttle / mixture / carb-heat
 * levers on the left wall, the trim crank and flap handle on the left, the wing-root fuel
 * gauges overhead, front sling seat and rear bench.
 */
import * as THREE from 'three';
import type { AircraftState, ControlInputs } from '../core/types';
import type { CubLayout } from './cubLayout';
import type { LoftProfile } from './loft';
import type { ModelMaterials } from './materials';
import { buildLoftCap } from './fuselage';
import { buildSkin, inside, outlineField, outside } from './skin';
import { applyPanelLighting, type CockpitAssembly, type PanelMesh, type PanelVariant } from './interior';
import { mergeStatic, tubeBetween } from './cubWings';

/** flap angle at which the handle is fully up (PA-18 flaps: 0 … 50°) */
const FLAP_FULL_DEG = 50;
/** stick travel at full deflection, rad (≈ ±12 cm at the grip) */
const STICK_PITCH_RAD = 0.2, STICK_ROLL_RAD = 0.2;

export class CubCockpit implements CockpitAssembly {
  readonly group = new THREE.Group();
  readonly panelMesh: PanelMesh;
  readonly panelMeshG1000: PanelMesh;
  private readonly sticks: THREE.Group[] = [];
  private readonly pedals: THREE.Mesh[] = [];
  private readonly pedalBaseZ: number;
  private readonly throttle: THREE.Group;
  private readonly mixture: THREE.Group;
  private readonly carbHeat: THREE.Group;
  private readonly leverTravel: number;
  private readonly trimCrank: THREE.Group;
  private readonly flapHandle: THREE.Group;
  private readonly flapFull: number;
  private readonly fuelNeedles: THREE.Group[] = [];
  private readonly tankKg: [number, number];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(layout: CubLayout, cabinProfile: LoftProfile, mats: ModelMaterials) {
    const g = this.group;
    g.name = 'interior';
    const keep = <T extends THREE.BufferGeometry>(geo: T): T => { this.geometries.push(geo); return geo; };
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name?: string, parent: THREE.Object3D = g): THREE.Mesh => {
      const m = new THREE.Mesh(keep(geo), mat);
      if (name) m.name = name;
      parent.add(m);
      return m;
    };
    const keepMesh = (m: THREE.Mesh): THREE.Mesh => { keep(m.geometry); return m; };
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, parent: THREE.Object3D = g): THREE.Mesh => {
      const m = add(new THREE.BoxGeometry(w, h, d), mat, undefined, parent);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      return m;
    };
    const F = layout.fuselage, C = layout.cabin, K = layout.cockpit;
    this.tankKg = layout.tankCapacityKg;

    // --- lining with the window cut-outs: fabric above the sill, upholstery below, and dark
    // window channels (a 2.5 cm band round every opening) so the frames read as thin tubes ---
    const winFields = layout.windows.map(outlineField);
    const lin = { dz: 0.035, radial: 84, offset: -0.03, inside: true, z0: F.firewallZ, z1: F.cabinEndZ - 0.05 } as const;
    const splitY = C.sillY - 0.04, frameW = 0.025;
    const clear = winFields.map((f) => (x: number, y: number, z: number) => f(x, y, z) - frameW);
    const upper = buildSkin(cabinProfile, { ...lin, keep: [...clear, (_x, y) => y - splitY] });
    add(upper.geometry, mats.interior, 'lining');
    const lower = buildSkin(cabinProfile, { ...lin, keep: [...clear, (_x, y) => splitY - y] });
    add(lower.geometry, mats.doorPanel, 'sidewalls');
    // the channels: outside every opening but within frameW of at least one of them
    const near = (x: number, y: number, z: number) => frameW - Math.min(...winFields.map((f) => f(x, y, z)));
    const frames = buildSkin(cabinProfile, { ...lin, keep: [...winFields.map(outside), near], reveal: { constraints: winFields.map((_, i) => i), to: -0.012 } });
    add(frames.geometry, mats.panelFrame, 'windowFrames');
    add(frames.reveal, mats.panelFrame, 'reveals');
    layout.windows.forEach((w, i) => {
      const glass = add(buildSkin(cabinProfile, { ...lin, z0: F.cowlEndZ, offset: -0.004, keep: [inside(winFields[i])] }).geometry, mats.glassInterior, `interiorGlass:${w.name}`);
      glass.renderOrder = 2;
    });

    // --- floor, firewall, baggage bulkhead ---
    const floorLen = F.cabinEndZ - 0.05 - F.firewallZ;
    box(0.6, 0.02, floorLen, mats.interiorDark, 0, C.floorY, F.firewallZ + floorLen / 2).name = 'floor';
    const firewallTop = C.deckY - 0.03;
    const firewall = add(new THREE.PlaneGeometry(0.7, firewallTop - C.floorY), mats.interiorDark, 'firewall');
    firewall.position.set(0, (firewallTop + C.floorY) / 2, F.firewallZ + 0.01);
    add(buildLoftCap(cabinProfile, F.cabinEndZ - 0.05, -1, 48), mats.interior, 'bulkhead');

    // --- panel, its board, the padded lip and the short deck up to the windshield ---
    const P = layout.panel, GS = layout.glareshield;
    const tilt = P.tiltRad;
    const boardH = P.height + 0.07;
    const board = box(GS.width, boardH, 0.02, mats.panelFrame, 0, 0, 0, -tilt);
    board.name = 'panelBoard';
    // 1.5 cm behind the instrument plane, top edge just under the lip
    board.position.set(0, P.center.y + (P.height / 2 - boardH / 2 + 0.005) * Math.cos(tilt) - 0.025 * Math.sin(tilt), P.center.z - (P.height / 2 - boardH / 2 + 0.005) * Math.sin(tilt) - 0.025 * Math.cos(tilt));
    this.panelMesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(P.width, P.height)), mats.panel);
    this.panelMesh.name = 'panel:steam';
    this.panelMesh.position.copy(P.center);
    this.panelMesh.rotation.x = -tilt;
    g.add(this.panelMesh);
    // no glass cockpit in the Cub: a hidden stand-in keeps callers of `panelMeshG1000` working
    this.panelMeshG1000 = new THREE.Mesh(keep(new THREE.PlaneGeometry(P.width, P.g1000Height)), mats.panelG1000);
    this.panelMeshG1000.name = 'panel:g1000';
    this.panelMeshG1000.position.copy(P.g1000Center);
    this.panelMeshG1000.rotation.x = -tilt;
    this.panelMeshG1000.visible = false;
    g.add(this.panelMeshG1000);
    const lip = add(new THREE.CylinderGeometry(0.018, 0.018, GS.width, 12).rotateZ(Math.PI / 2), mats.trimDark, 'glareshield');
    lip.position.set(0, GS.lipY - 0.004, GS.lipZ + 0.006);
    const deckLen = GS.lipZ - GS.frontZ;
    box(GS.width - 0.02, 0.012, deckLen, mats.trimDark, 0, (GS.lipY + GS.frontY) / 2 - 0.004, (GS.lipZ + GS.frontZ) / 2, Math.atan2(GS.frontY - GS.lipY, deckLen)).name = 'deck';
    // magnetic compass on the deck, against the windshield
    const compass = add(new THREE.CylinderGeometry(0.032, 0.036, 0.05, 14).rotateX(Math.PI / 2), mats.interiorDark, 'compass');
    compass.position.set(0, GS.frontY + 0.03, GS.frontZ + 0.06);

    // --- seats: front sling seat under the pilot, rear bench ---
    const Sf = K.seats.front, Sr = K.seats.rear;
    box(0.4, 0.08, 0.4, mats.seat, 0, Sf.y - 0.04, Sf.z);
    box(0.4, 0.6, 0.07, mats.seat, 0, Sf.y + 0.3, Sf.z + 0.25, -0.18);
    box(0.3, Sf.y - 0.08 - C.floorY, 0.3, mats.frame, 0, (Sf.y - 0.08 + C.floorY) / 2, Sf.z);
    box(0.5, 0.08, 0.4, mats.seat, 0, Sr.y - 0.04, Sr.z);
    box(0.5, 0.56, 0.08, mats.seat, 0, Sr.y + 0.29, Sr.z + 0.27, -0.2);
    box(0.44, Sr.y - 0.08 - C.floorY, 0.32, mats.frame, 0, (Sr.y - 0.08 + C.floorY) / 2, Sr.z);

    // --- steel-tube frame inside the fabric ---
    g.add(keepMesh(mergeStatic(K.tubes.map(([a, b]) => tubeBetween(a, b, 0.012, mats.frame, 1, 8)), mats.frame, 'tubeFrame')));

    // --- sticks (front for the pilot, rear for the passenger) ---
    for (const st of [K.frontStick, K.rearStick]) {
      const s = new THREE.Group();
      s.position.copy(st.pivot);
      const shaft = add(new THREE.CylinderGeometry(0.011, 0.013, st.length, 10), mats.metal, undefined, s);
      shaft.position.y = st.length / 2;
      const grip = add(new THREE.CylinderGeometry(0.017, 0.016, 0.11, 12), mats.knobBlack, 'grip', s);
      grip.position.y = st.length - 0.04;
      const boot = add(new THREE.ConeGeometry(0.045, 0.1, 12), mats.interiorDark, undefined, s);
      boot.position.y = 0.04;
      g.add(s);
      this.sticks.push(s);
    }

    // --- rudder pedals (front seat, heel brakes) ---
    const Pd = K.pedal;
    for (const x of [-Pd.x, Pd.x]) {
      const p = box(0.08, 0.13, 0.02, mats.metal, x, Pd.y, Pd.z, -0.45);
      p.name = x < 0 ? 'pedalLeft' : 'pedalRight';
      this.pedals.push(p);
    }
    this.pedalBaseZ = Pd.z;

    // --- throttle quadrant on the left wall: throttle (black), mixture (red), carb heat (grey) ---
    const T = K.throttle;
    this.leverTravel = T.travelRad;
    box(0.02, 0.09, 0.2, mats.panelFrame, T.pivot.x - 0.012, T.pivot.y + 0.01, T.pivot.z);
    const lever = (dx: number, len: number, knob: THREE.Material): THREE.Group => {
      const l = new THREE.Group();
      l.position.set(T.pivot.x + dx, T.pivot.y, T.pivot.z);
      const shaft = add(new THREE.BoxGeometry(0.008, len, 0.012), mats.metal, undefined, l);
      shaft.position.y = len / 2;
      const k = add(new THREE.SphereGeometry(0.017, 12, 8), knob, undefined, l);
      k.position.y = len;
      g.add(l);
      return l;
    };
    this.throttle = lever(0.018, T.length, mats.knobBlack);
    this.mixture = lever(0.043, T.length * 0.85, mats.knobRed);
    this.carbHeat = lever(0.066, T.length * 0.7, mats.hub);

    // --- elevator trim crank (left wall) and flap handle (left, by the seat) ---
    const TC = K.trimCrank;
    this.trimCrank = new THREE.Group();
    this.trimCrank.position.copy(TC.center);
    add(new THREE.CylinderGeometry(TC.radius, TC.radius, 0.014, 18).rotateZ(Math.PI / 2), mats.interiorDark, 'trimCrank', this.trimCrank);
    const handle = add(new THREE.CylinderGeometry(0.009, 0.009, 0.045, 8).rotateZ(Math.PI / 2), mats.knobBlack, undefined, this.trimCrank);
    handle.position.set(0.028, TC.radius * 0.75, 0);
    g.add(this.trimCrank);
    const FH = K.flapHandle;
    this.flapFull = FH.fullRad;
    this.flapHandle = new THREE.Group();
    this.flapHandle.position.copy(FH.pivot);
    const bar = add(new THREE.BoxGeometry(0.022, 0.022, FH.length), mats.metal, 'flapHandle', this.flapHandle);
    bar.position.z = -FH.length / 2;
    const fgrip = add(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 10).rotateX(Math.PI / 2), mats.knobBlack, undefined, this.flapHandle);
    fgrip.position.z = -FH.length + 0.04;
    g.add(this.flapHandle);

    // --- fuel gauges in the wing roots, overhead left and right, facing down into the cabin ---
    const FG = K.fuelGauge;
    for (const s of [-1, 1]) {
      const gauge = new THREE.Group();
      gauge.position.set(s * FG.center.x, FG.center.y, FG.center.z);
      // face tilted toward the pilot's head (down and inboard)
      gauge.lookAt(0, layout.eye.y, layout.eye.z); // (no parent yet: local = world)
      add(new THREE.CylinderGeometry(FG.radius + 0.008, FG.radius + 0.008, 0.02, 18).rotateX(Math.PI / 2), mats.interiorDark, undefined, gauge);
      const face = add(new THREE.CircleGeometry(FG.radius, 18), mats.paintPlain, 'fuelGauge', gauge);
      face.position.z = 0.011;
      const needle = new THREE.Group();
      needle.position.z = 0.014;
      const n = add(new THREE.BoxGeometry(0.004, FG.radius * 0.85, 0.002), mats.knobBlack, undefined, needle);
      n.position.y = FG.radius * 0.4;
      gauge.add(needle);
      g.add(gauge);
      this.fuelNeedles.push(needle);
    }
  }

  /** Animate the controls from the pilot inputs, the flap handle and fuel gauges from the state. */
  update(inputs: ControlInputs, state?: AircraftState): void {
    // `|| 0` maps NaN to 0
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x || 0));
    const pitch = clamp(inputs.pitch, -1, 1), roll = clamp(inputs.roll, -1, 1), yaw = clamp(inputs.yaw, -1, 1);
    for (const s of this.sticks) {
      s.rotation.x = STICK_PITCH_RAD * pitch;  // stick back ⇒ the grip moves aft (+Z)
      s.rotation.z = -STICK_ROLL_RAD * roll;   // roll right ⇒ the grip moves right (+X)
    }
    this.pedals[1].position.z = this.pedalBaseZ - 0.05 * yaw; // nose right ⇒ right pedal forward (−Z)
    this.pedals[0].position.z = this.pedalBaseZ + 0.05 * yaw;
    // levers: full forward = −travel/2 (the knob toward −Z)
    const t = this.leverTravel;
    this.throttle.rotation.x = t * (0.5 - clamp(inputs.throttle, 0, 1));
    this.mixture.rotation.x = t * (0.5 - clamp(inputs.mixture, 0, 1));
    this.carbHeat.rotation.x = inputs.carbHeat ? t * 0.5 : -t * 0.5;
    // nose-up trim winds the crank back; three turns end to end
    this.trimCrank.rotation.x = 3 * Math.PI * clamp(inputs.pitchTrim, -1, 1);
    if (state) {
      this.flapHandle.rotation.x = this.flapFull * clamp(state.surfaces.flapDeg / FLAP_FULL_DEG, 0, 1);
      // needle sweeps 240° from empty to full
      for (let i = 0; i < 2; i++) {
        const cap = this.tankKg[i] > 0 ? this.tankKg[i] : 1;
        const f = clamp((state.fuelKg?.[i] ?? 0) / cap, 0, 1);
        this.fuelNeedles[i].rotation.z = (2 * Math.PI / 3) * (1 - 2 * f);
      }
    }
  }

  setPanelLighting(daylight: number, panelLight: number): void {
    applyPanelLighting(this.panelMesh, this.panelMeshG1000, daylight, panelLight);
  }

  /** The Cub has only its steam panel: a 'g1000' request keeps it (no blank panel). */
  setPanelVariant(_v: PanelVariant): void {
    this.panelMesh.visible = true;
    this.panelMeshG1000.visible = false;
  }

  /** front and rear sticks */
  get yokeGroups(): readonly THREE.Group[] { return this.sticks; }
  get stickGroups(): readonly THREE.Group[] { return this.sticks; }

  dispose(): void {
    for (const geo of this.geometries) geo.dispose();
  }
}
