/**
 * Per-frame lighting / atmosphere values published by `SkySystem` for other renderers (terrain,
 * ocean, aircraft, instruments) so they can implement fog and sun lighting identically.
 *
 * Colour conventions:
 *  - `sunColor`, `skyColorZenith`, `skyColorHorizon`, `fogColor`, `sunRadiance`, `sunGlowColor` are LINEAR
 *    radiance values in the scale of the Preetham sky shader, i.e. BEFORE tone mapping. Custom shaders
 *    should mix them in before `#include <tonemapping_fragment>` (as the sky dome and cloud planes do).
 *  - `fogColorEncoded` is the same horizon colour after ACES tone mapping (current exposure) and sRGB
 *    encoding — the value the GPU receives as the built-in fog uniform, because Three.js applies
 *    built-in fog AFTER tone mapping and colour-space conversion. `scene.fog.color` holds it tagged as
 *    sRGB (`setRGB(r, g, b, SRGBColorSpace)`), since r187 re-encodes `fog.color` to the output colour
 *    space on upload; never copy the raw triple into a `Color` that three will encode again.
 */
import * as THREE from 'three';
import { HAZE_G, hgPhase } from './lighting';

export interface SkyLighting {
  /** unit vector toward the (refracted) sun, render frame (x East, y Up, z South) */ sunDirThree: THREE.Vector3;
  /** linear sun light colour normalised to max channel 1 (hue only) */ sunColor: THREE.Color;
  /** DirectionalLight intensity (0 at night) */ sunIntensity: number;
  /** linear sky radiance straight up */ skyColorZenith: THREE.Color;
  /** linear sky radiance averaged around the horizon at +1° */ skyColorHorizon: THREE.Color;
  /**
   * linear aerial-perspective colour that ground objects (terrain, ocean, aircraft, runways) fade to, seen at
   * 90° from the sun, in three's light units (see `hazeColor`): a blue-grey a little brighter than the lit
   * ground and always darker than the sky behind it; blended toward cloud grey inside cloud
   */ fogColor: THREE.Color;
  /**
   * β0 (m⁻¹) of the exponential extinction profile β(h) = fogDensity · exp(−h · fogHeightFalloff), h = height
   * above `groundY`. Outside cloud it is Koschmieder 3.912 / visibility; inside cloud the profile flattens and
   * β0 is chosen so β at the camera blends toward the in-cloud extinction (fly-through fog).
   */ fogDensity: number;
  /** 1 / scale height (m⁻¹, ≥ `MIN_FOG_INV_H`): haze 1/400…1/8000, a ground-fog layer 1/fogTop, ≈ 0 inside cloud */ fogHeightFalloff: number;
  /** current renderer tone-mapping exposure */ exposure: number;
  /** hemisphere + ambient light intensity sum (skylight level) */ ambientIntensity: number;

  // ── extras beyond the baseline contract ──
  /** tone-mapped, sRGB-encoded fog colour: raw display values the built-in fog shader receives */ fogColorEncoded: THREE.Color;
  /** `FogExp2.density` currently assigned to `scene.fog` */ fogExp2Density: number;
  /** linear direct-sun radiance for custom shaders (sunE · Fex · 0.04), 0 at night */ sunRadiance: THREE.Color;
  /** linear haze colour looking straight at the sun (Mie glow); custom fog mixes `fogColor` toward it by `hazeSunLobe(cos θ)` */ sunGlowColor: THREE.Color;
  /** linear colour objects seen against the sky (cloud planes) fade to: the horizon sky radiance, blended toward cloud grey inside cloud */ skyFogColor: THREE.Color;
  /** linear ambient irradiance of an up-facing surface (HemisphereLight sky colour × intensity + ambient floor), three light units */ ambientIrradiance: THREE.Color;
  /** unit vector toward the moon */ moonDirThree: THREE.Vector3;
  /** moon DirectionalLight intensity */ moonIntensity: number;
  moonColor: THREE.Color;
  /** geometric sun elevation, deg */ sunElevationDeg: number;
  /** combined cloud cover 0..1 */ cloudCover: number;
  /** star-field visibility 0..1 */ starVisibility: number;
  /** cloud density at the camera 0..1 (fly-through) */ inCloud: number;
  /** ground height under the camera in render-frame y, estimated from the aircraft AGL */ groundY: number;
}

export function createSkyLighting(): SkyLighting {
  return {
    sunDirThree: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(1, 1, 1), sunIntensity: 0,
    skyColorZenith: new THREE.Color(0.1, 0.2, 0.4), skyColorHorizon: new THREE.Color(0.5, 0.6, 0.7),
    fogColor: new THREE.Color(0.5, 0.6, 0.7), fogDensity: 3.912 / 50_000, fogHeightFalloff: 1 / 1200,
    exposure: 0.6, ambientIntensity: 0,
    fogColorEncoded: new THREE.Color(0.7, 0.8, 0.9), fogExp2Density: 1.978 / 50_000,
    sunRadiance: new THREE.Color(0, 0, 0), sunGlowColor: new THREE.Color(0.5, 0.6, 0.7),
    skyFogColor: new THREE.Color(0.5, 0.6, 0.7), ambientIrradiance: new THREE.Color(0.3, 0.4, 0.6),
    moonDirThree: new THREE.Vector3(0, -1, 0), moonIntensity: 0, moonColor: new THREE.Color(0xb8c4ff),
    sunElevationDeg: 0, cloudCover: 0, starVisibility: 0, inCloud: 0, groundY: 0,
  };
}

/**
 * GLSL helper for custom (terrain / ocean) shaders: exponential height fog with the closed-form
 * optical depth of Quilez's "better fog". Feed `fogDensity` as `beta0`, `fogHeightFalloff` as `invH`,
 * `groundY` as the height reference, and mix toward `fogColor` (+ a `sunGlowColor` lobe) BEFORE tone mapping:
 *
 *   float f = heightFogFactor(cameraPosition, dir, dist, uFogBeta, uFogInvH, uGroundY);
 *   vec3 fc = mix(uFogColor, uSunGlow, hazeSunLobe(dot(dir, uSunDir)));   // HAZE_LOBE_GLSL
 *   color = mix(color, fc, f);
 */
export const HEIGHT_FOG_GLSL = /* glsl */ `
float heightFogOpticalDepth( vec3 origin, vec3 dir, float dist, float beta0, float invH, float groundY ) {
  // ∫ beta0·exp(−h·invH) ds = beta0·e^(−h0·invH)·dist·(1 − e^(−k))/k, k = dist·dir.y·invH (finite for any input)
  float k = dist * dir.y * invH;
  float e0 = exp( - min( max( origin.y - groundY, 0.0 ) * invH, 80.0 ) );
  float g = abs( k ) < 1e-3 ? 1.0 - k * ( 0.5 - k / 6.0 ) : ( 1.0 - exp( - clamp( k, -80.0, 80.0 ) ) ) / k;
  return beta0 * e0 * dist * g;
}
float heightFogFactor( vec3 origin, vec3 dir, float dist, float beta0, float invH, float groundY ) {
  return 1.0 - exp( - heightFogOpticalDepth( origin, dir, dist, beta0, invH, groundY ) );
}
`;

/**
 * GLSL twin of `hazeSunLobe` (lighting.ts): weight 0…1 of the sun-ward haze colour at cos θ from the sun —
 * the Henyey–Greenstein (g = HAZE_G) excess over its 90° value, normalised at θ = 0.
 */
export const HAZE_LOBE_GLSL = /* glsl */ `
float hazeSunLobe( float cosTheta ) {
  const float g = ${HAZE_G.toFixed(3)};
  float p = ( 1.0 - g * g ) / ( 12.5663706 * pow( max( 1.0 + g * g - 2.0 * g * clamp( cosTheta, -1.0, 1.0 ), 1e-6 ), 1.5 ) );
  return clamp( ( p - ${hgPhase(0, HAZE_G).toFixed(7)} ) / ${(hgPhase(1, HAZE_G) - hgPhase(0, HAZE_G)).toFixed(7)}, 0.0, 1.0 );
}
`;
