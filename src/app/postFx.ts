/**
 * Post-processing (Settings > Graphics > Bloom): the scene is rendered into a half-float HDR target
 * (multisampled when the quality profile has antialiasing, with a 32-bit float depth buffer so the
 * reversed-Z depth keeps its precision), bright pixels (the sun, runway and approach lights, landing
 * lights, the glint on water) bloom over it, and three's OutputPass applies the renderer's tone
 * mapping, exposure and sRGB conversion to the screen.
 *
 * Materials that include `tonemapping_fragment` / `colorspace_fragment` output linear HDR into a render
 * target by themselves (three disables both for off-screen targets), so nothing is tone-mapped twice.
 * Off: the scene renders straight to the canvas exactly as before.
 */
import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Bloom tuning: only light sources and the sun are bright enough (white paint is ≈ 1 before exposure). */
export const BLOOM = { strength: 0.32, radius: 0.35, threshold: 1.6, maxInput: 6 } as const;

export class PostFx {
  /** on: scene → HDR target → bloom → tone-mapped screen; off: direct render */
  enabled = false;
  private rt: THREE.WebGLRenderTarget | null = null;
  private bloom: UnrealBloomPass | null = null;
  private output: OutputPass | null = null;
  private readonly size = new THREE.Vector2();
  private samples: number;

  constructor(private readonly renderer: THREE.WebGLRenderer, antialias: boolean) {
    this.samples = antialias ? 4 : 0;
  }

  /** MSAA in the HDR target follows the quality profile's antialiasing. */
  setAntialias(on: boolean): void {
    const s = on ? 4 : 0;
    if (s === this.samples) return;
    this.samples = s;
    this.disposeTargets();
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    if (!this.enabled) { r.render(scene, camera); return; }
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x)), h = Math.max(1, Math.floor(this.size.y));
    const rt = this.target(w, h);
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(scene, camera);
    this.bloom!.render(r, rt, rt, 0, false);
    this.output!.render(r, rt, rt, 0, false);
    r.setRenderTarget(prev);
  }

  private target(w: number, h: number): THREE.WebGLRenderTarget {
    if (this.rt && this.rt.width === w && this.rt.height === h) return this.rt;
    if (!this.rt) {
      const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: this.samples, depthBuffer: true, depthTexture: depth });
      this.rt.texture.name = 'postfx-hdr';
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      // the sky's sun disc and its aureole reach thousands in HDR: unclamped they bloomed into a white glare
      // over a quarter of the screen. The bright pass caps what may bloom (lights still glow, the sun a little)
      const hp = this.bloom.materialHighPassFilter;
      hp.fragmentShader = hp.fragmentShader.replace('gl_FragColor = mix( outputColor, texel, alpha );',
        `gl_FragColor = mix( outputColor, vec4( min( texel.rgb, vec3( ${BLOOM.maxInput.toFixed(1)} ) ), texel.a ), alpha );`);
      hp.needsUpdate = true;
      this.output = new OutputPass();
      this.output.renderToScreen = true;
    } else {
      this.rt.setSize(w, h);
    }
    this.bloom!.setSize(w, h);
    return this.rt;
  }

  private disposeTargets(): void {
    this.rt?.depthTexture?.dispose();
    this.rt?.dispose();
    this.bloom?.dispose();
    this.output?.dispose();
    this.rt = null; this.bloom = null; this.output = null;
  }

  dispose(): void { this.disposeTargets(); }
}
