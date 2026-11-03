/**
 * Shared materials for the aircraft model. Created once per model and disposed together.
 * Window glass uses MeshPhysicalMaterial with clearcoat and alpha blending (no transmission
 * pass, which would need a scene render-to-texture per frame).
 */
import * as THREE from 'three';
import { createHaloTexture, createLiveryTexture, createPanelPlaceholderTexture, createPropBlurTexture } from './textures';

export interface ModelMaterials {
  /** white livery paint with the cheat-line/registration map (fuselage) */
  paint: THREE.MeshStandardMaterial;
  /** same paint without the map (wings, tail, spinner, pants) */
  paintPlain: THREE.MeshStandardMaterial;
  /** blue accent (wing-tip caps, fin tip) */
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  glassInterior: THREE.MeshPhysicalMaterial;
  metal: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  hub: THREE.MeshStandardMaterial;
  blade: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  interiorDark: THREE.MeshStandardMaterial;
  seat: THREE.MeshStandardMaterial;
  panelFrame: THREE.MeshStandardMaterial;
  /**
   * Unlit, white, not tone-mapped. The instruments module assigns its texture to `.map`
   * (a dark placeholder is bound until then, so no `needsUpdate` is required).
   */
  panel: THREE.MeshBasicMaterial;
  panelG1000: THREE.MeshBasicMaterial;
  propDisc: THREE.MeshBasicMaterial;
  navRed: THREE.MeshBasicMaterial;
  navGreen: THREE.MeshBasicMaterial;
  navWhite: THREE.MeshBasicMaterial;
  haloRed: THREE.SpriteMaterial;
  haloGreen: THREE.SpriteMaterial;
  haloWhite: THREE.SpriteMaterial;
  knobBlack: THREE.MeshStandardMaterial;
  knobRed: THREE.MeshStandardMaterial;
  dispose(): void;
}

export interface MaterialOptions {
  registration?: string;
  /** u-range of the registration decal along the fuselage */
  regU?: [number, number];
  /** u where the cowl ends (anti-glare panel) */
  cowlUEnd?: number;
}

export function createModelMaterials(opts: MaterialOptions = {}): ModelMaterials {
  const livery = createLiveryTexture(opts.registration ?? 'N172FS', opts.regU?.[0] ?? 0.55, opts.regU?.[1] ?? 0.78, opts.cowlUEnd ?? 0.14);
  const blur = createPropBlurTexture();
  const halo = createHaloTexture();

  const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, map: livery, roughness: 0.38, metalness: 0.08 });
  const paintPlain = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4, metalness: 0.08 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1f4e9c, roughness: 0.4, metalness: 0.1 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x7f93a8, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
    transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
  });
  const glassInterior = new THREE.MeshPhysicalMaterial({
    color: 0xb8c4d0, roughness: 0.06, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1,
    transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
  });
  const metal = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.45, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0 });
  const hub = new THREE.MeshStandardMaterial({ color: 0xa8aaad, roughness: 0.5, metalness: 0.7 });
  const blade = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.55, metalness: 0.5 });
  const interior = new THREE.MeshStandardMaterial({ color: 0x6b6d70, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  const interiorDark = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.9, metalness: 0 });
  const seat = new THREE.MeshStandardMaterial({ color: 0x5c3f2a, roughness: 0.8, metalness: 0 });
  const panelFrame = new THREE.MeshStandardMaterial({ color: 0x2b2c2e, roughness: 0.85, metalness: 0.1 });
  // Until the instruments module assigns a map, a dark placeholder map shows instead of a white
  // rectangle. The colour must stay white: MeshBasicMaterial multiplies map × color.
  const panelPlaceholder = createPanelPlaceholderTexture();
  const panel = new THREE.MeshBasicMaterial({ color: 0xffffff, map: panelPlaceholder, toneMapped: false });
  const panelG1000 = new THREE.MeshBasicMaterial({ color: 0xffffff, map: panelPlaceholder, toneMapped: false });
  const propDisc = new THREE.MeshBasicMaterial({ map: blur, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const navRed = new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false });
  const navGreen = new THREE.MeshBasicMaterial({ color: 0x20ff40, toneMapped: false });
  const navWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const haloOpts = { map: halo, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false };
  const haloRed = new THREE.SpriteMaterial({ ...haloOpts, color: 0xff3030 });
  const haloGreen = new THREE.SpriteMaterial({ ...haloOpts, color: 0x30ff60 });
  const haloWhite = new THREE.SpriteMaterial({ ...haloOpts, color: 0xffffff });
  const knobBlack = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
  const knobRed = new THREE.MeshStandardMaterial({ color: 0xc01818, roughness: 0.6 });

  const all: THREE.Material[] = [paint, paintPlain, trim, glass, glassInterior, metal, rubber, hub, blade, interior, interiorDark, seat, panelFrame, panel, panelG1000, propDisc, navRed, navGreen, navWhite, haloRed, haloGreen, haloWhite, knobBlack, knobRed];
  return {
    paint, paintPlain, trim, glass, glassInterior, metal, rubber, hub, blade, interior, interiorDark, seat, panelFrame, panel, panelG1000, propDisc,
    navRed, navGreen, navWhite, haloRed, haloGreen, haloWhite, knobBlack, knobRed,
    dispose() {
      for (const m of all) m.dispose();
      livery?.dispose();
      blur.dispose();
      halo.dispose();
      panelPlaceholder.dispose();
    },
  };
}
