/**
 * Tier A cloud layers: one large world-positioned plane per `CloudLayer`, shaded with 3-octave
 * value-noise fbm (coverage threshold with a soft edge, detail erosion), lit cheaply by the sun
 * (brighter toward the sun, darker underside), drifting with the wind at its altitude and fading
 * into the same height fog as the terrain. The plane sits at the layer base when the camera is below,
 * at the top when above, and follows the camera's altitude while inside (fly-through = fog, see
 * `densityAtCamera`). Planes re-centre under the camera every frame; the noise is sampled from
 * world coordinates minus the accumulated wind drift, so they never "swim".
 *
 * Frames: render x = East, z = South; layer altitudes are MSL and render y is height above the
 * floating origin, so `MSL = y + altitudeOffsetM` (the frame's `alt0`, 0 for frames built by
 * `world/rebase`). Floating-origin moves are absorbed into the drift offsets (`notifyRebase`).
 *
 * Tier B (volumetric ray-marching) can replace this class behind the same public surface.
 */
import * as THREE from 'three';
import { clamp, smoothstep as smoothstepT } from '../core/math';
import type { CloudLayer, WindLayer } from '../core/types';
import { CLOUD_NOISE_GLSL, cloudDensityAt, cloudLayerDensityAt, cloudTypeParams } from './cloudMath';
import { MAX_SHADOW_LAYERS, type SkySharedUniforms } from './skyUniforms';
import { HEIGHT_FOG_GLSL, type SkyLighting } from './types';
import { windAt } from './wind';

export interface CloudLayersOptions {
  /** half-size of each plane, m (200 km across reaches the horizon from any GA altitude) */ radiusM?: number;
  /** fbm octaves for shape and detail (3 = cheap; 5 = richer) */ octaves?: number;
  /** maximum simultaneous layers */ maxLayers?: number;
  /** plane subdivisions (fog is per-fragment, so 1 is enough) */ segments?: number;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uSkyAmbient;
uniform vec3 uHorizonColor;
uniform float uCoverage;
uniform float uDensity;
uniform float uBase;
uniform float uTop;
uniform float uFeatureInv;
uniform float uSigmaT;
uniform float uBrightness;
uniform float uErosion;
uniform vec2 uDrift;
uniform float uFogBeta;
uniform float uFogInvH;
uniform float uGroundY;
uniform float uRadius;
varying vec3 vWorld;
${CLOUD_NOISE_GLSL}
${HEIGHT_FOG_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 toP = vWorld - cameraPosition;
  float dist = length( toP );
  vec3 d = toP / max( dist, 1e-3 );
  vec2 p = ( vWorld.xz - uDrift ) * uFeatureInv;
  float shape = cloudFbm( p );
  float detail = cloudFbm( p * 7.0 + 3.7 );
  float dens = cloudCoverageMask( shape, uCoverage );
  dens = clamp( dens - ( 1.0 - dens ) * detail * uErosion, 0.0, 1.0 );
  float thickness = ( uTop - uBase ) * dens * uDensity;
  float od = thickness * uSigmaT / max( abs( d.y ), 0.08 );
  float alpha = 1.0 - exp( - od );
  float sunT = exp( - thickness * uSigmaT * 0.6 );
  float powder = 1.0 - exp( - 2.0 * od );
  float cosT = dot( d, uSunDir );
  float hg = 0.0795775 * ( 1.0 - 0.36 ) / pow( 1.0 + 0.36 - 1.2 * cosT, 1.5 );
  vec3 col = uSkyAmbient * 0.8 + uSunRadiance * uBrightness * ( sunT * 0.9 + hg * 2.5 * powder * ( 1.0 - alpha ) );
  if ( ! gl_FrontFacing ) col = col * 0.55 + uSkyAmbient * 0.25;
  float fogF = heightFogFactor( cameraPosition, d, dist, uFogBeta, uFogInvH, uGroundY );
  col = mix( col, uHorizonColor, fogF );
  alpha *= smoothstep( 0.0, 0.015, abs( d.y ) );
  float horiz = length( vWorld.xz - cameraPosition.xz );
  alpha *= 1.0 - smoothstep( uRadius * 0.7, uRadius, horiz );
  if ( alpha < 0.002 ) discard;
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface CloudPlane {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  u: Record<string, THREE.IUniform>;
}

export class CloudLayers {
  /** add this to the scene */
  readonly group = new THREE.Group();
  readonly radiusM: number;
  readonly octaves: number;
  readonly maxLayers: number;
  /** cloud density at the camera 0..1 (last `update`) */
  densityAtCamera = 0;
  /** index of the layer the camera is inside, or −1 */
  insideLayer = -1;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly planes: CloudPlane[] = [];
  /** accumulated noise-field offsets [dx, dz, …] per layer (render frame, m), incl. rebase shifts */
  private readonly drifts: number[] = [];
  /** MSL altitude of render y = 0 (the frame's alt0) used by the last `update` */
  private altitudeOffsetM = 0;
  private readonly windNED: [number, number, number] = [0, 0, 0];
  private layers: readonly CloudLayer[] = [];

  constructor(options: CloudLayersOptions = {}) {
    this.radiusM = options.radiusM ?? 100_000;
    this.octaves = options.octaves ?? 3;
    this.maxLayers = options.maxLayers ?? 4;
    const seg = options.segments ?? 1;
    this.geometry = new THREE.PlaneGeometry(2 * this.radiusM, 2 * this.radiusM, seg, seg);
    this.geometry.rotateX(-Math.PI / 2); // +Z normal → +Y (up)
    this.group.name = 'cloudLayers';
  }

  private createPlane(): CloudPlane {
    const uniforms: Record<string, THREE.IUniform> = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunRadiance: { value: new THREE.Color() },
      uSkyAmbient: { value: new THREE.Color() }, uHorizonColor: { value: new THREE.Color() },
      uCoverage: { value: 0 }, uDensity: { value: 1 }, uBase: { value: 0 }, uTop: { value: 1 },
      uFeatureInv: { value: 1 / 2500 }, uSigmaT: { value: 0.006 }, uBrightness: { value: 1 }, uErosion: { value: 0.4 },
      uDrift: { value: new THREE.Vector2() },
      uFogBeta: { value: 1e-4 }, uFogInvH: { value: 1 / 1200 }, uGroundY: { value: 0 }, uRadius: { value: this.radiusM },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms,
      defines: { CLOUD_OCTAVES: this.octaves },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = 'cloudLayer';
    this.group.add(mesh);
    return { mesh, material, u: uniforms };
  }

  /**
   * @param cameraPos camera position, render frame
   * @param dt sim seconds (drift integration; 0 while paused)
   * @param layers current cloud layers (MSL)
   * @param winds wind layers (for the drift of each noise field)
   * @param drifts optional externally integrated drifts ([dx, dz, …] per layer, e.g. `WeatherSystem.cloudDrifts`)
   *               so the FDM's `cloudDensityAt` and the visuals use the identical field. The owner of
   *               external drifts handles floating-origin shifts itself (`WeatherSystem.notifyRebase`).
   * @param altitudeOffsetM MSL altitude of render y = 0 (the local frame's `alt0`)
   */
  update(cameraPos: THREE.Vector3, dt: number, L: SkyLighting, layers: readonly CloudLayer[], winds: readonly WindLayer[], drifts?: readonly number[], altitudeOffsetM = 0): void {
    this.layers = layers;
    this.altitudeOffsetM = altitudeOffsetM;
    const camMsl = cameraPos.y + altitudeOffsetM;
    const n = Math.min(layers.length, this.maxLayers);
    while (this.planes.length < n) this.planes.push(this.createPlane());
    for (let i = n; i < this.planes.length; i++) this.planes[i].mesh.visible = false;

    // drift of every layer's noise field (all layers, so `cloudDensityAt` stays consistent beyond maxLayers)
    const groundMsl = L.groundY + altitudeOffsetM;
    for (let i = 0; i < layers.length; i++) {
      if (drifts) { this.drifts[i * 2] = drifts[i * 2] ?? 0; this.drifts[i * 2 + 1] = drifts[i * 2 + 1] ?? 0; continue; }
      const mid = 0.5 * (layers[i].baseM + layers[i].topM);
      windAt(winds, mid, Math.max(mid - groundMsl, 10), this.windNED);
      this.drifts[i * 2] = (this.drifts[i * 2] ?? 0) + this.windNED[1] * dt; // E
      this.drifts[i * 2 + 1] = (this.drifts[i * 2 + 1] ?? 0) - this.windNED[0] * dt; // S = −N
    }
    this.drifts.length = layers.length * 2;

    this.densityAtCamera = 0;
    this.insideLayer = -1;
    for (let i = 0; i < n; i++) {
      const layer = layers[i];
      const p = this.planes[i];
      const visible = layer.coverage > 0.005 && layer.density > 0.005 && layer.topM > layer.baseM;
      p.mesh.visible = visible;
      if (!visible) continue;
      const tp = cloudTypeParams(layer.type);
      const u = p.u;
      u.uCoverage.value = clamp(layer.coverage, 0, 1);
      u.uDensity.value = Math.max(layer.density, 0);
      u.uBase.value = layer.baseM; u.uTop.value = layer.topM;
      u.uFeatureInv.value = 1 / tp.featureSizeM; u.uSigmaT.value = tp.sigmaT; u.uBrightness.value = tp.brightness; u.uErosion.value = tp.erosion;
      (u.uDrift.value as THREE.Vector2).set(this.drifts[i * 2], this.drifts[i * 2 + 1]);
      (u.uSunDir.value as THREE.Vector3).copy(L.sunDirThree);
      (u.uSunRadiance.value as THREE.Color).copy(L.sunRadiance);
      // skylight on the layer: the clear-sky blue turns neutral as the sky closes over (a deck lit by a
      // deck), so an overcast base reads grey instead of blue-white
      const amb = (u.uSkyAmbient.value as THREE.Color).copy(L.skyColorZenith).lerp(L.skyColorHorizon, 0.5);
      const grey = 0.2126 * amb.r + 0.7152 * amb.g + 0.0722 * amb.b;
      const k = 0.85 * smoothstepT(0.3, 1, L.cloudCover);
      amb.setRGB(amb.r + (grey - amb.r) * k, amb.g + (grey - amb.g) * k, amb.b + (grey - amb.b) * k);
      (u.uHorizonColor.value as THREE.Color).copy(L.skyFogColor);
      u.uFogBeta.value = L.fogDensity; u.uFogInvH.value = L.fogHeightFalloff; u.uGroundY.value = L.groundY;
      // plane altitude: base when below, top when above, camera altitude while inside
      const yMsl = clamp(camMsl, layer.baseM, layer.topM);
      p.mesh.position.set(cameraPos.x, yMsl - altitudeOffsetM, cameraPos.z);
      if (camMsl > layer.baseM && camMsl < layer.topM) {
        const d = cloudLayerDensityAt(layer, cameraPos.x, camMsl, cameraPos.z, this.drifts[i * 2], this.drifts[i * 2 + 1], this.octaves);
        if (d > this.densityAtCamera) { this.densityAtCamera = d; this.insideLayer = i; }
      }
    }
  }

  /**
   * Refresh the aerial-perspective uniforms (fog colour, β0, falloff, ground height) of the visible
   * planes. `SkySystem` calls this after computing the frame's fog, which depends on `densityAtCamera`
   * from `update`, so the planes never lag the terrain fog by a frame.
   */
  setFog(L: SkyLighting): void {
    for (const p of this.planes) {
      if (!p.mesh.visible) continue;
      (p.u.uHorizonColor.value as THREE.Color).copy(L.skyFogColor);
      p.u.uFogBeta.value = L.fogDensity; p.u.uFogInvH.value = L.fogHeightFalloff; p.u.uGroundY.value = L.groundY;
    }
  }

  /**
   * Publish the layers for cloud shadows on the ground (`SKY_UNIFORMS_GLSL.skyCloudShadow`): the same noise
   * field (coverage, feature size, drift) as the planes, sampled at each layer's middle along the sun ray.
   * Call after `update` (uses this frame's layers and drifts). `altitudeOffsetM` = the frame's alt0.
   */
  writeShadowUniforms(u: SkySharedUniforms, altitudeOffsetM = this.altitudeOffsetM): void {
    let n = 0;
    for (let i = 0; i < this.layers.length && n < MAX_SHADOW_LAYERS; i++) {
      const layer = this.layers[i];
      if (!(layer.coverage > 0.005 && layer.density > 0.005 && layer.topM > layer.baseM)) continue;
      const tp = cloudTypeParams(layer.type);
      u.uCloudShadowA.value[n].set(clamp(layer.coverage, 0, 1), 1 / tp.featureSizeM, 0, (layer.topM - layer.baseM) * Math.max(layer.density, 0) * tp.sigmaT);
      u.uCloudShadowB.value[n].set(0.5 * (layer.baseM + layer.topM) - altitudeOffsetM, this.drifts[i * 2] ?? 0, this.drifts[i * 2 + 1] ?? 0, 0);
      n++;
    }
    u.uCloudShadowCount.value = n;
  }

  /** Cloud density 0..1 at a render-frame point (same field as the shader, max over layers). */
  cloudDensityAt(pos: THREE.Vector3): number {
    return cloudDensityAt(this.layers, pos.x, pos.y + this.altitudeOffsetM, pos.z, this.drifts, this.octaves);
  }

  /**
   * The floating origin moved by `originShiftThree` (the new origin's position in the OLD render
   * frame), so every render-frame position changed by −shift. Shift the self-integrated drifts the
   * same way so the noise field stays attached to the ground. (Drifts supplied to `update` by a
   * `WeatherSystem` are overwritten next frame; that system shifts its own in `notifyRebase`.)
   */
  notifyRebase(originShiftThree: THREE.Vector3): void {
    for (let i = 0; i < this.drifts.length; i += 2) {
      this.drifts[i] -= originShiftThree.x;
      this.drifts[i + 1] -= originShiftThree.z;
    }
  }

  dispose(): void {
    for (const p of this.planes) { p.material.dispose(); p.mesh.removeFromParent(); }
    this.planes.length = 0;
    this.geometry.dispose();
    this.group.removeFromParent();
  }
}
