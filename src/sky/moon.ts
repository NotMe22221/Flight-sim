/**
 * Moon disc: a camera-facing quad of the moon's angular size whose fragment shader lights a
 * virtual sphere with the actual sun direction, so the phase and terminator orientation are
 * correct for free. Drawn at the far plane (depth-tested) after the stars.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_Position.z = 0.0;
  #else
    gl_Position.z = gl_Position.w;
  #endif
}`;

const FRAG = /* glsl */ `
uniform vec3 uSunLocal;
uniform vec3 uTint;
uniform float uBrightness;
uniform float uDayFactor;
varying vec2 vUv;
float mhash( vec2 p ) { vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float mnoise( vec2 p ) { vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mhash( i ), mhash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( mhash( i + vec2( 0.0, 1.0 ) ), mhash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y ); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot( p, p );
  if ( r2 > 1.0 ) discard;
  vec3 n = vec3( p, sqrt( 1.0 - r2 ) );
  float lit = smoothstep( - 0.03, 0.12, dot( n, uSunLocal ) );
  // maria: a few octaves of value noise on the disc darken ~35 % of the surface
  float m = mnoise( p * 3.0 + 7.0 ) * 0.6 + mnoise( p * 7.0 + 2.0 ) * 0.4;
  float albedo = mix( 0.55, 1.0, smoothstep( 0.35, 0.6, m ) );
  vec3 col = uTint * uBrightness * albedo * ( lit + 0.015 );
  float edge = smoothstep( 1.0, 0.9, r2 );
  float alpha = edge * max( lit, mix( 0.25, 0.0, uDayFactor ) );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class MoonDisc {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly distance: number;
  private readonly look = new THREE.Matrix4();
  private readonly invQ = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  /** @param angularDiameterDeg the Moon subtends ≈ 0.52° */
  constructor(angularDiameterDeg = 0.52, distanceM = 1000) {
    this.distance = distanceM;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uSunLocal: { value: new THREE.Vector3(0, 0, 1) }, uTint: { value: new THREE.Color(1, 0.98, 0.92) },
        uBrightness: { value: 0.6 }, uDayFactor: { value: 0 },
      },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.scale.setScalar(2 * distanceM * Math.tan((angularDiameterDeg * Math.PI) / 360));
    this.mesh.visible = false;
    this.mesh.name = 'moon';
  }

  /** Linear radiance of the sunlit surface before tone mapping (≈ 0.6 reads well by day and night). */
  set brightness(v: number) { this.material.uniforms.uBrightness.value = v; }
  get brightness(): number { return this.material.uniforms.uBrightness.value as number; }

  /**
   * @param moonDir unit vector toward the moon (render frame)
   * @param sunDir unit vector toward the sun
   * @param tint atmospheric transmittance toward the moon (reddens it near the horizon)
   * @param dayFactor 0 at night … 1 by day (hides the unlit part against the bright sky)
   */
  update(moonDir: THREE.Vector3, sunDir: THREE.Vector3, cameraPos: THREE.Vector3, tint: THREE.Color, dayFactor: number): void {
    const visible = moonDir.y > -0.05;
    this.mesh.visible = visible;
    if (!visible) return;
    this.mesh.position.copy(cameraPos).addScaledVector(moonDir, this.distance);
    // Face the camera: the quad's +Z must point from the moon back to the camera.
    this.up.set(0, 1, 0);
    if (Math.abs(moonDir.y) > 0.99) this.up.set(0, 0, 1);
    this.look.lookAt(cameraPos, this.mesh.position, this.up);
    this.mesh.quaternion.setFromRotationMatrix(this.look);
    this.invQ.copy(this.mesh.quaternion).invert();
    const u = this.material.uniforms;
    (u.uSunLocal.value as THREE.Vector3).copy(this.tmp.copy(sunDir).applyQuaternion(this.invQ));
    (u.uTint.value as THREE.Color).copy(tint).multiply(MOON_BASE_TINT);
    u.uDayFactor.value = dayFactor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

const MOON_BASE_TINT = new THREE.Color(1, 0.98, 0.92);
