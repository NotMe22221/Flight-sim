/**
 * WebGL renderer setup for a world that spans 0.05 m (cockpit) to 600 km (horizon).
 *
 * Depth precision strategy (docs/research/03 §0):
 *   1. Reversed-Z float depth when `EXT_clip_control` exists (Chrome, Edge, Safari 18+).
 *   2. Logarithmic depth otherwise (Firefox today). Custom ShaderMaterials must include the
 *      `logdepthbuf_*` chunks to stay correct on this path; check `depthMode` when writing one.
 */
import * as THREE from 'three';

export type DepthMode = 'reversed' | 'logarithmic';

export interface QualityProfile {
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  anisotropy: number;
}

export const QUALITY: Record<'low' | 'medium' | 'high' | 'ultra', QualityProfile> = {
  low: { pixelRatioCap: 1, shadows: false, shadowMapSize: 1024, antialias: false, anisotropy: 2 },
  medium: { pixelRatioCap: 1.25, shadows: true, shadowMapSize: 1024, antialias: true, anisotropy: 4 },
  high: { pixelRatioCap: 1.75, shadows: true, shadowMapSize: 2048, antialias: true, anisotropy: 8 },
  ultra: { pixelRatioCap: 2, shadows: true, shadowMapSize: 4096, antialias: true, anisotropy: 16 },
};

/** True when the browser can do reversed-Z (probed on a throwaway context). */
export function supportsReversedDepth(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!gl.getExtension('EXT_clip_control');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  depthMode: DepthMode;
  /** max anisotropy the GPU supports */
  maxAnisotropy: number;
  setQuality(q: keyof typeof QUALITY, renderScale?: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export function createRenderer(container: HTMLElement, quality: keyof typeof QUALITY = 'high'): RendererBundle {
  const reversed = supportsReversedDepth();
  const depthMode: DepthMode = reversed ? 'reversed' : 'logarithmic';
  const profile = QUALITY[quality];
  const renderer = new THREE.WebGLRenderer({
    antialias: profile.antialias,
    powerPreference: 'high-performance',
    reversedDepthBuffer: reversed,
    logarithmicDepthBuffer: !reversed,
    preserveDrawingBuffer: false,
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  renderer.shadowMap.enabled = profile.shadows;
  // r187 removed PCFSoftShadowMap (it warns on the first shadow render and falls back to PCF)
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'sim-canvas';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);

  let renderScale = 1;
  let current = profile;
  const applyPixelRatio = () => {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    renderer.setPixelRatio(Math.min(dpr, current.pixelRatioCap) * renderScale);
  };
  applyPixelRatio();

  const bundle: RendererBundle = {
    renderer,
    depthMode,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    setQuality(q, scale) {
      current = QUALITY[q];
      if (scale !== undefined) renderScale = Math.min(Math.max(scale, 0.5), 2);
      renderer.shadowMap.enabled = current.shadows;
      applyPixelRatio();
      renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
    },
    resize(width, height) {
      applyPixelRatio();
      renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    },
    dispose() {
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  bundle.resize(container.clientWidth, container.clientHeight);
  return bundle;
}
