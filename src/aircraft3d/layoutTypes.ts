/**
 * Types shared by every airframe layout (C172, Super Cub) and the config narrowing used by
 * {@link AircraftModel}. Model-local metres: nose −Z, up +Y, right wing +X, origin at the
 * empty CG (docs/DESIGN.md).
 */
import type * as THREE from 'three';
import type { AircraftConfig, GearSpec, PropellerSpec, Vec3 } from '../core/types';
import type { LoftStation } from './loft';
import type { SkinOutline } from './skin';

/** Which procedural airframe and cockpit is built (`AircraftConfig.airframe`, default 'c172'). */
export type AirframeKind = NonNullable<AircraftConfig['airframe']>;

/** The subset of {@link AircraftConfig} the 3D model needs. A full AircraftConfig is accepted too. */
export interface AircraftModelConfig {
  geometry: AircraftConfig['geometry'];
  propeller?: PropellerSpec;
  gear: GearSpec[];
  /** airframe to build (default 'c172') */
  airframe?: AirframeKind;
  /** fuel tanks: the Cub's wing-root sight gauges read `AircraftState.fuelKg[i] / capacityKg` */
  tanks?: { name: string; pos: Vec3; capacityKg: number }[];
}

/** Narrow a full AircraftConfig (or pass a model config through). */
export function toModelConfig(config: AircraftConfig | AircraftModelConfig): AircraftModelConfig {
  if ('propulsion' in config) {
    return {
      geometry: config.geometry, propeller: config.propulsion.propeller, gear: config.gear,
      airframe: config.airframe, tanks: config.mass.tanks.map((t) => ({ name: t.name, pos: t.pos, capacityKg: t.capacityKg })),
    };
  }
  return config;
}

export interface GearLayout {
  /** index into AircraftState.gear / config.gear */
  index: number;
  name: string;
  /** strut attachment on the airframe (model local) */
  attach: THREE.Vector3;
  /** unloaded tyre contact point (model local) */
  contact: THREE.Vector3;
  tyreRadius: number;
  maxSteerRad: number;
  /** wheel width */
  width: number;
}

/** Propeller placement; the spinner / blade-plane fields default to the C172's. */
export interface PropLayout {
  hub: THREE.Vector3;
  diameter: number;
  blades: number;
  sense: 1 | -1;
  /** spinner base radius, length and base position along z relative to the hub (default 0.165, 0.265, −0.02) */
  spinner?: { radius: number; length: number; baseZ: number };
  /** blade plane along z relative to the hub (default −0.12: 12 cm ahead of the hub station) */
  bladeZ?: number;
}

export interface LightLayout {
  navLeft: THREE.Vector3; navRight: THREE.Vector3; navTail: THREE.Vector3; beacon: THREE.Vector3;
  strobeLeft: THREE.Vector3; strobeRight: THREE.Vector3;
  landing: THREE.Vector3; taxi: THREE.Vector3;
}

/** Instrument panel plane (2:1 like its 1024×512 texture) and the G1000 plane (PFD+MFD). */
export interface PanelLayout {
  center: THREE.Vector3; width: number; height: number; tiltRad: number;
  g1000Center: THREE.Vector3; g1000Height: number;
}

/** Glareshield: rear lip over the panel, top surface running to the windshield. */
export interface GlareshieldLayout { lipY: number; lipZ: number; frontY: number; frontZ: number; width: number }

/** Small fuselage details (positions on the skin are found from the fuselage profile). */
export interface FuselageDetails {
  /** nose-bowl cooling inlets: centre |x|, y, radius, vertical stretch */
  noseInlets: { x: number; y: number; r: number; squash: number };
  /** exhaust stack under the cowl: x, station z, length, radius, direction (down and aft) */
  exhaust: { x: number; z: number; length: number; radius: number; dir: THREE.Vector3 };
  /** COM whip on the tailcone top: station z, length, base radius, direction (raked aft) */
  antenna: { z: number; length: number; radius: number; dir: THREE.Vector3 };
}

/** What `buildFuselage` reads: one loft from the spinner to the tail with window cut-outs. */
export interface FuselageLayout {
  /** total length range used for livery u mapping */
  zNose: number; zTail: number;
  fuselage: {
    stations: LoftStation[];
    /** windshield base: the cowl (visible from the cockpit too) ends here */
    cowlEndZ: number;
    /** the cabin shell (replaced by the cockpit lining in the cockpit view) ends here */
    cabinEndZ: number;
    /** firewall (front of the cockpit lining, behind the panel) */
    firewallZ: number;
  };
  /** window outlines (glass on the skin, holes in the skin and the lining) */
  windows: SkinOutline[];
  /** door outlines (exterior seam lines) */
  doors: SkinOutline[];
  details: FuselageDetails;
}
