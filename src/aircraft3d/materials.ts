/**
 * Shared materials for the aircraft model. Created once per model and disposed together.
 * Window glass uses MeshPhysicalMaterial with clearcoat and alpha blending (no transmission
 * pass, which would need a scene render-to-texture per frame).
 */
import * as THREE from 'three';
import { applyIblScale } from '../sky/iblScale';
import { C172_LIVERY, createHaloTexture, createLiveryTexture, createPanelPlaceholderTexture, createPropBlurTexture, type LiveryScheme, type LiverySection } from './textures';

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
  /** cockpit lining (headliner, side walls), single colour plastic */
  interior: THREE.MeshStandardMaterial;
  interiorDark: THREE.MeshStandardMaterial;
  /** padded anti-glare glareshield, window reveals */
  trimDark: THREE.MeshStandardMaterial;
  /** fabric door panels below the side windows */
  doorPanel: THREE.MeshStandardMaterial;
  /** window rubber and door seams (exterior) */
  gasket: THREE.MeshStandardMaterial;
  /** inner face of the cabin skin seen through the windows from outside */
  cabinInner: THREE.MeshStandardMaterial;
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
  /** painted steel tube frame seen inside a fabric-covered cabin (Cub) */
  frame: THREE.MeshStandardMaterial;
  /** daylight fill on the cabin materials, 0 (night) … 1 (day) */
  setCabinBounce(k: number): void;
  /**
   * Daylight 0 (night) … 1 (day): the cabin bounce fill, and the unlit (MeshBasic) prop blur
   * disc, which would otherwise glow at night.
   */
  setDaylight(k: number): void;
  dispose(): void;
}

/** Airframe colours: the fuselage livery plus the plain paint (wings, tail) and the trim accent. */
export interface PaintScheme {
  livery: LiveryScheme;
  /** wings, tail, spinner, pants (hex) */
  plain: number;
  /** accent colour (hex) */
  trim: number;
  /** fuselage colour when no livery texture can be drawn (Node tests) */
  fallback: number;
}

/**
 * Share of the sky's environment light (image-based light, diffuse and reflections alike) each cabin surface
 * receives: the cabin is mostly enclosed and sees the sky only through its windows. Applied with
 * `applyIblScale` (three r187 replaces `material.envMapIntensity` by `scene.environmentIntensity` for materials
 * lit by `scene.environment`, so the value cannot go on the material itself); relative to the sky's
 * environment intensity (≈ 1 by day).
 */
export const CABIN_IBL_SHARE = {
  interior: 0.35, interiorDark: 0.35, trimDark: 0.12, doorPanel: 0.3, cabinInner: 0.15, seat: 0.35, panelFrame: 0.35, frame: 0.35,
} as const;

/** The C172's white scheme (also the default). */
export const C172_PAINT: PaintScheme = { livery: C172_LIVERY, plain: 0xf4f4f2, trim: 0x1f4e9c, fallback: 0xffffff };

export interface MaterialOptions {
  /** colours (default {@link C172_PAINT}) */
  scheme?: PaintScheme;
  registration?: string;
  /** u-range of the registration decal along the fuselage */
  regU?: [number, number];
  /** metres per livery texel along u / v at the registration (keeps the letters' shape) */
  liveryScale?: { uM: number; vM: number };
  /** fuselage section along the livery u (for the scheme's straight `lines`) */
  liverySection?: LiverySection;
}

export function createModelMaterials(opts: MaterialOptions = {}): ModelMaterials {
  const scheme = opts.scheme ?? C172_PAINT;
  const livery = createLiveryTexture(opts.registration ?? 'N172FS', opts.regU?.[0] ?? 0.55, opts.regU?.[1] ?? 0.78, opts.liveryScale, scheme.livery, opts.liverySection);
  const blur = createPropBlurTexture();
  const halo = createHaloTexture();

  const paint = new THREE.MeshStandardMaterial({ color: livery ? 0xffffff : scheme.fallback, map: livery, roughness: 0.38, metalness: 0.08 });
  const paintPlain = new THREE.MeshStandardMaterial({ color: scheme.plain, roughness: 0.4, metalness: 0.08 });
  const trim = new THREE.MeshStandardMaterial({ color: scheme.trim, roughness: 0.4, metalness: 0.1 });
  // exterior glass: tinted, reflective; the dark cabin behind it makes the windows read dark
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x55687a, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  });
  // seen from the cockpit: almost clear, just a faint sheen
  const glassInterior = new THREE.MeshPhysicalMaterial({
    color: 0xb8c4d0, roughness: 0.08, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.1,
    transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false,
  });
  const metal = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.45, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0 });
  const hub = new THREE.MeshStandardMaterial({ color: 0xa8aaad, roughness: 0.5, metalness: 0.7 });
  const blade = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.55, metalness: 0.5 });
  // The cabin is mostly enclosed: the sky environment map (unoccluded) is turned well down on
  // interior surfaces (CABIN_IBL_SHARE), and they do not receive the coarse sun shadow map (see AircraftModel).
  // A small warm emissive term stands in for light bounced around the cabin (no GI); it is
  // scaled with daylight by setCabinBounce().
  const bounce = new THREE.Color(0x2c2a26);
  const interior = new THREE.MeshStandardMaterial({ color: 0xa39f97, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, emissive: bounce });
  const interiorDark = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.9, metalness: 0 });
  // matte black padding: little sky reflection (CABIN_IBL_SHARE.trimDark), or the grazing-angle Fresnel tints it blue
  const trimDark = new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const doorPanel = new THREE.MeshStandardMaterial({ color: 0x7b766d, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, emissive: bounce });
  const gasket = new THREE.MeshStandardMaterial({ color: 0x1a1b1c, roughness: 0.7, metalness: 0 });
  const cabinInner = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 1, metalness: 0, side: THREE.BackSide });
  const seat = new THREE.MeshStandardMaterial({ color: 0x6c645a, roughness: 0.85, metalness: 0, emissive: bounce });
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
  const frame = new THREE.MeshStandardMaterial({ color: 0x8a8d86, roughness: 0.7, metalness: 0.2, emissive: bounce });
  const cabin = { interior, interiorDark, trimDark, doorPanel, cabinInner, seat, panelFrame, frame };
  for (const name of Object.keys(CABIN_IBL_SHARE) as (keyof typeof CABIN_IBL_SHARE)[]) applyIblScale(cabin[name], CABIN_IBL_SHARE[name]);

  const setCabinBounce = (k: number): void => {
    const v = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
    interior.emissiveIntensity = v; doorPanel.emissiveIntensity = v; seat.emissiveIntensity = v; frame.emissiveIntensity = v;
  };

  const all: THREE.Material[] = [paint, paintPlain, trim, glass, glassInterior, metal, rubber, hub, blade, interior, interiorDark, trimDark, doorPanel, gasket, cabinInner, seat, panelFrame, panel, panelG1000, propDisc, navRed, navGreen, navWhite, haloRed, haloGreen, haloWhite, knobBlack, knobRed, frame];
  return {
    paint, paintPlain, trim, glass, glassInterior, metal, rubber, hub, blade, interior, interiorDark, trimDark, doorPanel, gasket, cabinInner, seat, panelFrame, panel, panelG1000, propDisc,
    navRed, navGreen, navWhite, haloRed, haloGreen, haloWhite, knobBlack, knobRed, frame,
    setCabinBounce,
    setDaylight(k: number) {
      const v = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
      setCabinBounce(v);
      propDisc.color.setScalar(0.06 + 0.94 * v);
    },
    dispose() {
      for (const m of all) m.dispose();
      livery?.dispose();
      blur.dispose();
      halo.dispose();
      panelPlaceholder.dispose();
    },
  };
}
