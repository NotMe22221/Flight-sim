/**
 * Tier A cloud layers: one large world-positioned plane per `CloudLayer`, shaded with 3-octave
 * value-noise fbm (coverage threshold with a soft edge, detail erosion), lit cheaply by the sun
 * (brighter toward the sun, darker underside), drifting with the wind at its altitude and fading
 * into the same height fog as the terrain. The plane sits at the layer base when the camera is below,
 * at the top when above, and follows the camera's altitude while inside (fly-through = fog, see
 * `densityAtCamera`). Planes re-centre under the camera every frame; the noise is sampled from
 * world coordinates so they never "swim".
 *
 * Tier B (volumetric ray-marching) can replace this class behind the same public surface.
 */
import * as THREE from 'three';
import { clamp } from '../core/math';
import type { CloudLayer, WindLayer } from '../core/types';
import { CLOUD_NOISE_GLSL, cloudDensityAt, cloudTypeParams } from './cloudMath';
import type { SkyLighting } from './types';
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
uniform vec2 uWorldOffset;
uniform float uFogBeta;
uniform float uFogInvH;
uniform float uGroundY;
uniform float uRadius;
varying vec3 vWorld;
${CLOUD_NOISE_GLSL}
float fogOD( vec3 o, vec3 d, float t ) {
  float dy = abs( d.y ) < 1e-4 ? 1e-4 : d.y;
  float h0 = max( o.y - uGroundY, 0.0 );
  return uFogBeta / uFogInvH * exp( - h0 * uFogInvH ) * ( 1.0 - exp( - t * dy * uFogInvH ) ) / dy;
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 toP = vWorld - cameraPosition;
  float dist = length( toP );
  vec3 d = toP / max( dist, 1e-3 );
  vec2 p = ( vWorld.xz + uWorldOffset - uDrift ) * uFeatureInv;
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
  float fogF = 1.0 - exp( - fogOD( cameraPosition, d, dist ) );
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
  private readonly worldOffset = new THREE.Vector2();
  private readonly drifts: number[] = [];
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
      uDrift: { value: new THREE.Vector2() }, uWorldOffset: { value: new THREE.Vector2() },
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
   * @param layers current cloud layers (MSL)
   * @param winds wind layers (for the drift of each noise field)
   * @param dt sim seconds
   * @param drifts optional externally integrated drifts ([dx, dz, …] per layer, e.g. `WeatherSystem.cloudDrifts`)
   *               so the FDM's `cloudDensityAt` and the visuals use the identical field
   */
  update(cameraPos: THREE.Vector3, dt: number, L: SkyLighting, layers: readonly CloudLayer[], winds: readonly WindLayer[], drifts?: readonly number[]): void {
    this.layers = layers;
    const n = Math.min(layers.length, this.maxLayers);
    while (this.planes.length < n) this.planes.push(this.createPlane());
    for (let i = n; i < this.planes.length; i++) this.planes[i].mesh.visible = false;

    this.densityAtCamera = 0;
    this.insideLayer = -1;
    for (let i = 0; i < n; i++) {
      const layer = layers[i];
      // drift
      if (drifts) { this.drifts[i * 2] = drifts[i * 2] ?? 0; this.drifts[i * 2 + 1] = drifts[i * 2 + 1] ?? 0; }
      else {
        const mid = 0.5 * (layer.baseM + layer.topM);
        windAt(winds, mid, Math.max(mid - L.groundY, 10), this.windNED);
        this.drifts[i * 2] = (this.drifts[i * 2] ?? 0) + this.windNED[1] * dt; // E
        this.drifts[i * 2 + 1] = (this.drifts[i * 2 + 1] ?? 0) - this.windNED[0] * dt; // S = −N
      }
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
      (u.uWorldOffset.value as THREE.Vector2).copy(this.worldOffset);
      (u.uSunDir.value as THREE.Vector3).copy(L.sunDirThree);
      (u.uSunRadiance.value as THREE.Color).copy(L.sunRadiance);
      (u.uSkyAmbient.value as THREE.Color).copy(L.skyColorZenith).lerp(L.skyColorHorizon, 0.5);
      (u.uHorizonColor.value as THREE.Color).copy(L.fogColor);
      u.uFogBeta.value = L.fogDensity; u.uFogInvH.value = L.fogHeightFalloff; u.uGroundY.value = L.groundY;
      // plane altitude: base when below, top when above, camera altitude while inside
      const y = clamp(cameraPos.y, layer.baseM, layer.topM);
      p.mesh.position.set(cameraPos.x, y, cameraPos.z);
      if (cameraPos.y > layer.baseM && cameraPos.y < layer.topM) {
        const d = cloudDensityAt([layer], cameraPos.x + this.worldOffset.x, cameraPos.y, cameraPos.z + this.worldOffset.y, [this.drifts[i * 2], this.drifts[i * 2 + 1]], this.octaves);
        if (d > this.densityAtCamera) { this.densityAtCamera = d; this.insideLayer = i; }
      }
    }
    this.drifts.length = n * 2;
  }

  /** Cloud density 0..1 at a render-frame point (same field as the shader, max over layers). */
  cloudDensityAt(pos: THREE.Vector3): number {
    return cloudDensityAt(this.layers, pos.x + this.worldOffset.x, pos.y, pos.z + this.worldOffset.y, this.drifts, this.octaves);
  }

  /**
   * The floating origin moved: world coordinates of everything shifted by `-delta` (render frame).
   * Accumulate the opposite so the noise field stays attached to the ground.
   */
  notifyRebase(deltaThree: THREE.Vector3): void {
    this.worldOffset.x += deltaThree.x;
    this.worldOffset.y += deltaThree.z;
  }

  dispose(): void {
    for (const p of this.planes) { p.material.dispose(); p.mesh.removeFromParent(); }
    this.planes.length = 0;
    this.geometry.dispose();
    this.group.removeFromParent();
  }
}
