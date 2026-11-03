/**
 * Rain / snow: ≤ 4 k instanced quads in a camera-centred box. Positions live entirely in the vertex
 * shader (seed × box + accumulated drift, wrapped), so there is no per-frame CPU work beyond a few
 * uniforms. Rain streaks are stretched along the relative velocity (fall + wind − camera motion);
 * snow flakes are camera-facing round sprites with a sinusoidal flutter.
 */
import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/math';
import type { WeatherState } from '../core/types';
import type { SkyLighting } from './types';

export interface PrecipitationOptions {
  /** instance budget (default 4000) */ maxParticles?: number;
  /** box edge length around the camera, m */ boxM?: number;
  /** rain rate at which the full budget is used, mm/h */ fullRateRain?: number;
  /** snow rate at which the full budget is used, mm/h */ fullRateSnow?: number;
  seed?: number;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aSeed;
attribute float aRand;
uniform vec3 uOffset;
uniform vec3 uBox;
uniform vec3 uCamPos;
uniform vec3 uAxis;
uniform float uLength;
uniform float uWidth;
uniform float uSnow;
uniform float uTime;
uniform float uFlutter;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = mod( aSeed * uBox + uOffset, uBox ) - 0.5 * uBox + uCamPos;
  p.xz += uSnow * uFlutter * vec2( sin( uTime * 1.7 + aRand * 6.2832 ), cos( uTime * 1.3 + aRand * 6.2832 ) );
  vec3 toCam = normalize( uCamPos - p + vec3( 1e-4, 1e-4, 0.0 ) );
  vec3 right = normalize( cross( uAxis, toCam ) );
  vec3 along = uSnow > 0.5 ? normalize( cross( toCam, right ) ) : uAxis;
  vec3 world = p + along * ( position.y * uLength ) + right * ( position.x * uWidth );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSnow;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float a;
  if ( uSnow > 0.5 ) {
    vec2 c = vUv - 0.5;
    float r2 = dot( c, c ) * 4.0;
    if ( r2 > 1.0 ) discard;
    a = ( 1.0 - r2 ) * uAlpha;
  } else {
    a = uAlpha * smoothstep( 0.0, 0.3, vUv.y ) * ( 1.0 - smoothstep( 0.7, 1.0, vUv.y ) ) * ( 1.0 - smoothstep( 0.25, 0.5, abs( vUv.x - 0.5 ) ) );
  }
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Precipitation {
  readonly mesh: THREE.Mesh;
  readonly maxParticles: number;
  readonly boxM: number;
  /** active instance count after the last update */
  activeCount = 0;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly fullRateRain: number;
  private readonly fullRateSnow: number;
  private readonly offset = new THREE.Vector3();
  private readonly vRel = new THREE.Vector3();
  private timeS = 0;

  constructor(options: PrecipitationOptions = {}) {
    this.maxParticles = options.maxParticles ?? 4000;
    this.boxM = options.boxM ?? 60;
    this.fullRateRain = options.fullRateRain ?? 15;
    this.fullRateSnow = options.fullRateSnow ?? 6;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.attributes.position);
    this.geometry.setAttribute('uv', quad.attributes.uv);
    const rnd = mulberry32(options.seed ?? 99);
    const seeds = new Float32Array(this.maxParticles * 3);
    const rands = new Float32Array(this.maxParticles);
    for (let i = 0; i < this.maxParticles; i++) { seeds[i * 3] = rnd(); seeds[i * 3 + 1] = rnd(); seeds[i * 3 + 2] = rnd(); rands[i] = rnd(); }
    this.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    this.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rands, 1));
    this.geometry.instanceCount = 0;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.boxM);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uOffset: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(this.boxM, this.boxM * 0.75, this.boxM) },
        uCamPos: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3(0, -1, 0) },
        uLength: { value: 0.3 }, uWidth: { value: 0.015 }, uSnow: { value: 0 }, uTime: { value: 0 }, uFlutter: { value: 0.3 },
        uColor: { value: new THREE.Color(0.5, 0.55, 0.6) }, uAlpha: { value: 0.35 },
      },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.name = 'precipitation';
  }

  /**
   * @param cameraVel camera velocity in the render frame, m/s (for streak direction)
   * @param windThree wind velocity in the render frame, m/s
   */
  update(dt: number, cameraPos: THREE.Vector3, cameraVel: THREE.Vector3, windThree: THREE.Vector3, weather: WeatherState, L: SkyLighting): void {
    const snow = weather.precipitationType === 'snow';
    const rate = weather.precipitationType === 'none' ? 0 : weather.precipitationRate;
    const frac = clamp(rate / (snow ? this.fullRateSnow : this.fullRateRain), 0, 1);
    this.activeCount = Math.round(frac * this.maxParticles);
    this.geometry.instanceCount = this.activeCount;
    this.mesh.visible = this.activeCount > 0;
    if (!this.mesh.visible) return;
    this.timeS += dt;
    const fall = snow ? -1.0 : -7.5;
    this.vRel.set(windThree.x - cameraVel.x, fall - cameraVel.y, windThree.z - cameraVel.z);
    const speed = this.vRel.length();
    const u = this.material.uniforms;
    const box = u.uBox.value as THREE.Vector3;
    this.offset.addScaledVector(this.vRel, dt);
    // keep the wrap offset small for float precision
    this.offset.x = ((this.offset.x % box.x) + box.x) % box.x;
    this.offset.y = ((this.offset.y % box.y) + box.y) % box.y;
    this.offset.z = ((this.offset.z % box.z) + box.z) % box.z;
    (u.uOffset.value as THREE.Vector3).copy(this.offset);
    (u.uCamPos.value as THREE.Vector3).copy(cameraPos);
    (u.uAxis.value as THREE.Vector3).copy(this.vRel).multiplyScalar(speed > 1e-3 ? 1 / speed : 0);
    if (speed <= 1e-3) (u.uAxis.value as THREE.Vector3).set(0, -1, 0);
    u.uSnow.value = snow ? 1 : 0;
    u.uTime.value = this.timeS;
    if (snow) { u.uLength.value = 0.035; u.uWidth.value = 0.035; u.uAlpha.value = 0.8; }
    else { u.uLength.value = clamp(speed / 60, 0.08, 1.5); u.uWidth.value = 0.015; u.uAlpha.value = 0.35; }
    (u.uColor.value as THREE.Color).copy(L.fogColor).multiplyScalar(snow ? 1.3 : 0.8);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
