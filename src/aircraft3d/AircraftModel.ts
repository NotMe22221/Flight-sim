/**
 * Procedural low-poly aircraft for the render scene: the Cessna 172 (default) or the Piper
 * PA-18 Super Cub, picked by `AircraftConfig.airframe` ('c172' | 'cub').
 *
 * - Authored nose −Z, up +Y, right wing +X, origin at the empty CG (see docs/DESIGN.md).
 * - `setPose()` takes the Three.js position and quaternion produced by the integrator from
 *   the FDM state via {@link bodyQuatToThree} / {@link nedToThreeVec}.
 * - `update()` animates control surfaces (SurfaceState), propeller (rpm), gear
 *   (compression, wheel speed, steering), lights (ControlInputs.lights) and the cockpit
 *   controls, and switches between the exterior cabin shell and the interior shell.
 *
 * No per-frame allocations: everything is built in the constructor.
 */
import * as THREE from 'three';
import type { AircraftConfig, AircraftState, ControlInputs } from '../core/types';
import { c172ModelConfig, resolveC172Layout, toModelConfig, type AircraftModelConfig, type C172Layout } from './c172Layout';
import { CUB_PAINT, resolveCubLayout, type CubLayout } from './cubLayout';
import { buildFuselage, type FuselageAssembly } from './fuselage';
import { buildWings, type WingAssembly } from './wings';
import { buildTail, type TailAssembly } from './tail';
import { buildCubWings } from './cubWings';
import { buildCubTail } from './cubTail';
import { Propeller } from './propeller';
import { LandingGear, type GearAssembly } from './gear';
import { CubGear } from './cubGear';
import { AircraftLights, type LightOptions } from './lights';
import { CockpitInterior, type CockpitAssembly, type PanelMesh, type PanelVariant } from './interior';
import { CubCockpit } from './cubInterior';
import { createModelMaterials, type MaterialOptions, type ModelMaterials } from './materials';
import { finiteOr, safeDt } from './finite';
import { LoftProfile, type LoftStation } from './loft';
import type { FuselageLayout } from './layoutTypes';

/** The resolved placement of the airframe that was built (narrow with `layout.airframe`). */
export type AirframeLayout = C172Layout | CubLayout;

const D2R = Math.PI / 180;

export interface AircraftModelOptions {
  /** registration painted on the fuselage (default 'N172FS') */
  registration?: string;
  /** cast/receive shadows on the airframe (default true) */
  shadows?: boolean;
  /** landing / taxi SpotLight intensity (cd, physically based lights, decay 2) */
  landingLightIntensity?: number;
  taxiLightIntensity?: number;
  /** let the landing light cast shadows (expensive, default false) */
  spotShadows?: boolean;
  /** sun elevation below which it is "night" and spotlights also light the cockpit view (default −3°) */
  nightSunElevationRad?: number;
}

/** Hinged-surface pivot groups; rotation applied by {@link AircraftModel.update}. */
export interface ControlSurfacePivots {
  aileronLeft: THREE.Group;
  aileronRight: THREE.Group;
  flapLeft: THREE.Group;
  flapRight: THREE.Group;
  elevator: THREE.Group;
  rudder: THREE.Group;
}

/** Everything one airframe contributes to the model. */
interface Airframe {
  layout: AirframeLayout;
  materials: ModelMaterials;
  fuselage: FuselageAssembly;
  wings: WingAssembly;
  tail: TailAssembly;
  propeller: Propeller;
  gear: GearAssembly;
  lights: AircraftLights;
  cockpit: CockpitAssembly;
}

/** Material options with the registration placed on the fuselage between stations regZ. */
function liveryOptions(L: FuselageLayout, regZ: [number, number], extra: MaterialOptions): MaterialOptions {
  const len = L.zTail - L.zNose;
  const regSection = new LoftProfile(L.fuselage.stations).sectionAt((regZ[0] + regZ[1]) / 2, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 } as LoftStation);
  const profile = new LoftProfile(L.fuselage.stations);
  const sec = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 } as LoftStation;
  return {
    ...extra,
    regU: [(regZ[0] - L.zNose) / len, (regZ[1] - L.zNose) / len],
    liveryScale: { uM: len / 2048, vM: regSection.height / 512 },
    liverySection: (u) => {
      profile.sectionAt(L.zNose + u * len, sec);
      return { bottom: sec.yCenter - sec.height / 2, height: sec.height, zFromNose: u * len };
    },
  };
}

function buildC172(cfg: AircraftModelConfig, options: AircraftModelOptions, lightOpts: LightOptions): Airframe {
  const layout = resolveC172Layout(cfg);
  const materials = createModelMaterials(liveryOptions(layout, [2.45, 4.2], { registration: options.registration ?? 'N172FS' }));
  const fuselage = buildFuselage(layout, materials);
  const wings = buildWings(layout, materials);
  const tail = buildTail(layout, materials);
  const propeller = new Propeller(layout.prop, materials);
  const gear = new LandingGear(layout.gear, materials);
  const lights = new AircraftLights(layout.lights, materials, lightOpts);
  const cockpit = new CockpitInterior(layout, fuselage.cabinProfile, materials);
  return { layout, materials, fuselage, wings, tail, propeller, gear, lights, cockpit };
}

function buildCub(cfg: AircraftModelConfig, options: AircraftModelOptions, lightOpts: LightOptions): Airframe {
  const layout = resolveCubLayout(cfg);
  const materials = createModelMaterials(liveryOptions(layout, layout.livery.regZ, { scheme: CUB_PAINT, registration: options.registration ?? 'N18FS' }));
  const fuselage = buildFuselage(layout, materials);
  addCubFuselageDetails(layout, fuselage, materials);
  const wings = buildCubWings(layout, materials);
  const tail = buildCubTail(layout, materials);
  const propeller = new Propeller(layout.prop, materials, materials.trim);
  const gear = new CubGear(layout.gear, materials);
  const lights = new AircraftLights(layout.lights, materials, lightOpts);
  const cockpit = new CubCockpit(layout, fuselage.cabinProfile, materials);
  return { layout, materials, fuselage, wings, tail, propeller, gear, lights, cockpit };
}

/** Cub-only skin details: the carburettor air box under the nose and the door handle. */
function addCubFuselageDetails(L: CubLayout, fuselage: FuselageAssembly, mats: ModelMaterials): void {
  const sc = L.details.carbScoop;
  const scoop = new THREE.Mesh(new THREE.BoxGeometry(sc.size.x, sc.size.y, sc.size.z), mats.paintPlain);
  scoop.position.copy(sc.center);
  scoop.name = 'carbScoop';
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(sc.size.x * 0.82, sc.size.y * 0.7), mats.gasket);
  mouth.position.set(sc.center.x, sc.center.y, sc.center.z - sc.size.z / 2 - 0.002);
  mouth.rotation.y = Math.PI;
  fuselage.group.add(scoop, mouth);
  // door handle on the lower half of the split door (right side), with the cabin shell
  const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
  const z = 0.5, y = L.cabin.sillY - 0.09;
  fuselage.cabinProfile.sectionAt(z, sec);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.025, 0.12), mats.metal);
  handle.position.set(sec.width / 2 + 0.006, y, z);
  handle.name = 'doorHandle';
  fuselage.cabinShell.add(handle);
}

export class AircraftModel {
  /** add this to the scene; `setPose` drives it */
  readonly root = new THREE.Group();
  /** exterior airframe (fuselage, wings, tail, gear, prop, lights) */
  readonly exterior = new THREE.Group();
  /** cockpit shell, only shown in cockpit view */
  readonly interior: THREE.Group;
  /**
   * steam instrument panel plane, 2:1 like its 1024 × 512 texture (C172 0.96 × 0.48 m, Cub
   * 0.60 × 0.30 m); assign `material.map`
   */
  readonly panelMesh: PanelMesh;
  /** G1000 plane (0.96 × 0.35 m, PFD + MFD), hidden unless {@link setPanelVariant}('g1000'); the Cub has none (always hidden) */
  readonly panelMeshG1000: PanelMesh;
  /** pilot eye point in model-local coordinates (from config.geometry.eyePoint) */
  readonly eyePointLocal: THREE.Vector3;
  /** which airframe was built ('c172' unless the config says 'cub') */
  readonly airframe: AirframeLayout['airframe'];
  readonly layout: AirframeLayout;
  readonly materials: ModelMaterials;
  readonly propeller: Propeller;
  readonly gear: GearAssembly;
  readonly lights: AircraftLights;
  readonly cockpit: CockpitAssembly;
  readonly surfaces: ControlSurfacePivots;
  /** cabin skin + exterior glass; hidden while the camera is inside */
  readonly cabinShell: THREE.Group;

  private exteriorEnabled = true;
  private interiorEnabled = true;
  private night = false;
  /** 0 (night) … 1 (day), from {@link setSunElevation} */
  private daylight = 1;
  /** 1 (night) … 0 (day), a quicker ramp around sunset for the exterior lights' pools and halos */
  private nightLights = 0;
  /** last `ControlInputs.lights.panel` seen by {@link update} */
  private panelLight = 0;
  private readonly nightElevation: number;
  private disposed = false;

  constructor(config: AircraftConfig | AircraftModelConfig = c172ModelConfig(), options: AircraftModelOptions = {}) {
    const cfg = toModelConfig(config);
    const lightOpts: LightOptions = {
      landingIntensity: options.landingLightIntensity,
      taxiIntensity: options.taxiLightIntensity,
      spotShadows: options.spotShadows,
    };
    const a = cfg.airframe === 'cub' ? buildCub(cfg, options, lightOpts) : buildC172(cfg, options, lightOpts);
    this.layout = a.layout;
    this.airframe = a.layout.airframe;
    const L = this.layout;
    this.materials = a.materials;
    this.nightElevation = options.nightSunElevationRad ?? -3 * D2R;
    this.root.name = 'aircraft';
    this.exterior.name = 'exterior';

    const { fuselage, wings, tail } = a;
    this.propeller = a.propeller;
    this.gear = a.gear;
    this.lights = a.lights;
    this.cockpit = a.cockpit;
    this.cabinShell = fuselage.cabinShell;
    this.surfaces = {
      aileronLeft: wings.aileronLeft, aileronRight: wings.aileronRight,
      flapLeft: wings.flapLeft, flapRight: wings.flapRight,
      elevator: tail.elevator, rudder: tail.rudder,
    };
    this.exterior.add(fuselage.group, wings.group, tail.group, this.propeller.group, this.gear.group, this.lights.group);
    this.interior = this.cockpit.group;
    this.interior.visible = false;
    this.panelMesh = this.cockpit.panelMesh;
    this.panelMeshG1000 = this.cockpit.panelMeshG1000;
    this.eyePointLocal = L.eye.clone();
    this.root.add(this.exterior, this.interior);

    const shadows = options.shadows ?? true;
    const m = this.materials;
    const interiorMeshes = new Set<THREE.Object3D>();
    this.interior.traverse((o) => interiorMeshes.add(o));
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = o.material as THREE.Material;
      const transparentish = mat === m.glass || mat === m.glassInterior || mat === m.propDisc || mat === m.navRed || mat === m.navGreen || mat === m.navWhite || mat === m.cabinInner;
      o.castShadow = shadows && !transparentish;
      // The sun's shadow map spans hundreds of metres (texels of ~0.2 m): on the cockpit
      // interior that only produces blotches, so the cabin casts (ground shadow from inside)
      // but does not receive; it is shaded by its materials instead.
      o.receiveShadow = shadows && !transparentish && !interiorMeshes.has(o);
    });
  }

  /** Place the model from the integrator's render-frame pose (see frames.ts). */
  setPose(posThree: THREE.Vector3, qThree: THREE.Quaternion): void {
    this.root.position.copy(posThree);
    this.root.quaternion.copy(qThree);
  }

  /**
   * Animate from the latest (interpolated) state. Allocation-free; non-finite samples are
   * treated as 0 so one bad frame cannot poison the propeller / wheel accumulators.
   * @param dt              real seconds since the previous call (≥ 0)
   * @param cameraIsCockpit hide the cabin shell / show the interior, and darken the
   *        landing/taxi spotlights in daylight (intensity 0; the light count stays constant).
   */
  update(state: AircraftState, inputs: ControlInputs, dt: number, cameraIsCockpit: boolean): void {
    const s = state.surfaces;
    const sf = this.surfaces;
    const step = safeDt(dt);
    // positive = trailing edge down (δe > 0 nose down; per-surface aileron deflection)
    sf.aileronLeft.rotation.x = finiteOr(s.aileronLeftRad);
    sf.aileronRight.rotation.x = finiteOr(s.aileronRightRad);
    const flap = finiteOr(s.flapDeg) * D2R;
    sf.flapLeft.rotation.x = flap;
    sf.flapRight.rotation.x = flap;
    sf.elevator.rotation.x = finiteOr(s.elevatorRad);
    // δr > 0 = trailing edge left; the hinge axis points up so a negative rotation swings the TE left
    sf.rudder.rotation.y = -finiteOr(s.rudderRad);

    this.propeller.update(finiteOr(state.engine.rpm), step, cameraIsCockpit);
    this.gear.update(state.gear, step);
    this.lights.update(step, inputs.lights, !cameraIsCockpit || this.night, this.nightLights);
    this.cockpit.update(inputs, state);
    this.panelLight = inputs.lights?.panel ?? 0;
    this.cockpit.setPanelLighting(this.daylight, this.panelLight);

    this.cabinShell.visible = this.exteriorEnabled && !cameraIsCockpit;
    this.interior.visible = this.interiorEnabled && cameraIsCockpit;
  }

  /** Master visibility of the exterior airframe and of the cockpit shell. */
  setVisibility(exterior: boolean, interior: boolean): void {
    this.exteriorEnabled = exterior;
    this.interiorEnabled = interior;
    this.exterior.visible = exterior;
    this.cabinShell.visible = exterior && !this.interior.visible;
    if (!interior) this.interior.visible = false;
  }

  /**
   * Feed the sun elevation (rad): spotlights are also enabled in the cockpit view at night,
   * and the cabin's bounce-light fill, the unlit prop blur disc and the light on the (unlit)
   * instrument faces follow the daylight (sun −6° … +15°); at night the panel needs
   * `ControlInputs.lights.panel`.
   */
  setSunElevation(elevationRad: number): void {
    if (!Number.isFinite(elevationRad)) return;
    this.night = elevationRad < this.nightElevation;
    const tn = Math.max(0, Math.min(1, (elevationRad / D2R + 4) / 10));
    this.nightLights = 1 - tn * tn * (3 - 2 * tn);
    const t = Math.max(0, Math.min(1, (elevationRad / D2R + 6) / 21));
    this.daylight = t * t * (3 - 2 * t);
    this.materials.setDaylight(this.daylight);
    this.cockpit.setPanelLighting(this.daylight, this.panelLight);
  }

  get isNight(): boolean { return this.night; }

  /** Choose which instrument panel plane is shown. */
  setPanelVariant(v: PanelVariant): void { this.cockpit.setPanelVariant(v); }

  /** Release all GPU resources (geometries, materials, textures, lights). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const seen = new Set<THREE.BufferGeometry>();
    this.root.traverse((o) => {
      // Sprite geometry is a single buffer shared by every Sprite in the app: never dispose it
      if (o instanceof THREE.Sprite) return;
      const geo = (o as THREE.Mesh).geometry;
      if (geo instanceof THREE.BufferGeometry && !seen.has(geo)) { seen.add(geo); geo.dispose(); }
    });
    this.propeller.dispose();
    this.gear.dispose();
    this.lights.dispose();
    this.cockpit.dispose();
    this.materials.dispose();
    this.root.removeFromParent();
  }
}
