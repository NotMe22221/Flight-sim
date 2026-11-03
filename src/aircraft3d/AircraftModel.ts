/**
 * Procedural low-poly Cessna 172 for the render scene.
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
import { buildFuselage } from './fuselage';
import { buildWings } from './wings';
import { buildTail } from './tail';
import { Propeller } from './propeller';
import { LandingGear } from './gear';
import { AircraftLights } from './lights';
import { CockpitInterior, type PanelMesh, type PanelVariant } from './interior';
import { createModelMaterials, type ModelMaterials } from './materials';
import { finiteOr, safeDt } from './finite';
import { LoftProfile } from './loft';

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

export class AircraftModel {
  /** add this to the scene; `setPose` drives it */
  readonly root = new THREE.Group();
  /** exterior airframe (fuselage, wings, tail, gear, prop, lights) */
  readonly exterior = new THREE.Group();
  /** cockpit shell, only shown in cockpit view */
  readonly interior: THREE.Group;
  /** instrument panel plane (steam six-pack size, 1.0 × 0.45 m); assign `material.map` */
  readonly panelMesh: PanelMesh;
  /** G1000-sized alternative (1.0 × 0.36 m), hidden unless {@link setPanelVariant}('g1000') */
  readonly panelMeshG1000: PanelMesh;
  /** pilot eye point in model-local coordinates (from config.geometry.eyePoint) */
  readonly eyePointLocal: THREE.Vector3;
  readonly layout: C172Layout;
  readonly materials: ModelMaterials;
  readonly propeller: Propeller;
  readonly gear: LandingGear;
  readonly lights: AircraftLights;
  readonly cockpit: CockpitInterior;
  readonly surfaces: ControlSurfacePivots;
  /** cabin skin + exterior glass; hidden while the camera is inside */
  readonly cabinShell: THREE.Group;

  private exteriorEnabled = true;
  private interiorEnabled = true;
  private night = false;
  private readonly nightElevation: number;
  private disposed = false;

  constructor(config: AircraftConfig | AircraftModelConfig = c172ModelConfig(), options: AircraftModelOptions = {}) {
    const cfg = toModelConfig(config);
    this.layout = resolveC172Layout(cfg);
    const L = this.layout;
    const len = L.zTail - L.zNose;
    const regZ: [number, number] = [2.45, 4.2];
    const regSection = new LoftProfile(L.fuselage.stations).sectionAt((regZ[0] + regZ[1]) / 2, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 });
    this.materials = createModelMaterials({
      registration: options.registration ?? 'N172FS',
      regU: [(regZ[0] - L.zNose) / len, (regZ[1] - L.zNose) / len],
      liveryScale: { uM: len / 2048, vM: regSection.height / 512 },
    });
    this.nightElevation = options.nightSunElevationRad ?? -3 * D2R;
    this.root.name = 'aircraft';
    this.exterior.name = 'exterior';

    const fuselage = buildFuselage(L, this.materials);
    const wings = buildWings(L, this.materials);
    const tail = buildTail(L, this.materials);
    this.propeller = new Propeller(L.prop, this.materials);
    this.gear = new LandingGear(L.gear, this.materials);
    this.lights = new AircraftLights(L.lights, this.materials, {
      landingIntensity: options.landingLightIntensity,
      taxiIntensity: options.taxiLightIntensity,
      spotShadows: options.spotShadows,
    });
    this.cockpit = new CockpitInterior(L, fuselage.cabinProfile, this.materials);
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
    this.lights.update(step, inputs.lights, !cameraIsCockpit || this.night);
    this.cockpit.update(inputs);

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
   * and the cabin's bounce-light fill follows the daylight.
   */
  setSunElevation(elevationRad: number): void {
    this.night = elevationRad < this.nightElevation;
    const t = Math.max(0, Math.min(1, (elevationRad / D2R + 6) / 21));
    this.materials.setCabinBounce(t * t * (3 - 2 * t));
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
