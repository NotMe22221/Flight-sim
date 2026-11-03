/**
 * Shared materials of the scenery (one set for all tiles). Lit surfaces are
 * MeshStandardMaterial / MeshLambertMaterial so the sky module's sun, hemisphere, ambient and
 * fog apply. The only shader change is an `onBeforeCompile` on the light points that clamps the
 * point size to a minimum number of pixels; it keeps three's own chunks (logdepthbuf included),
 * so it works with both the logarithmic and the reversed depth buffer.
 */
import * as THREE from 'three';
import { makeFacadeImages, makePavementImage, makePlainImage, makePoolImage, makeRoofImage, makeSpriteImage, toTexture } from './textures';

/**
 * Image-based lighting share. The sky's PMREM environment is several times brighter than its
 * sun DirectionalLight, so at full strength every surface turns sky-blue; a small share keeps
 * a hint of sky reflection while the sun and hemisphere light do the shading (as for terrain).
 */
export const ENV_INTENSITY = 0.06;
/** Relative depth bias of draped surfaces (fraction of the view distance) so they win over the terrain mesh. */
export const DRAPE_DEPTH_BIAS = 0.0025;

/** Saturation kept in the sky ambient (hemisphere) light of scenery materials (see `patchMaterial`). */
export const AMBIENT_SATURATION = 0.35;

export interface MaterialPatch {
  /** relative depth bias uniform; the geometry carries an `aBias` weight attribute */
  depthBias?: { value: number };
  /** saturation kept in the ambient irradiance uniform (0 grey … 1 unchanged) */
  ambientSat?: { value: number };
}

/**
 * Small, chunk-preserving shader patches (three's own chunks stay in place, logdepthbuf
 * included, so the logarithmic and the reversed depth buffer both work):
 *  - depth bias: after `project_vertex`, pull the vertex toward the camera by
 *    `bias × aBias` of its view distance (screen position unchanged, only depth), so draped
 *    pavement wins over the terrain mesh it follows; `aBias` is 0 next to runways so pavement
 *    there stays under the runway slabs;
 *  - ambient saturation: after `lights_fragment_begin`, pull the ambient + hemisphere
 *    irradiance toward its luminance. The sky's hemisphere light is the normalised zenith colour,
 *    saturated blue, which otherwise tints every roof and apron (the terrain shader uses a
 *    neutral-ish ambient); direct sun light is untouched.
 */
export function patchMaterial(m: THREE.Material, p: MaterialPatch, key: string): void {
  m.onBeforeCompile = (shader) => {
    if (p.depthBias) {
      shader.uniforms.sceneryDepthBias = p.depthBias;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float sceneryDepthBias;\nattribute float aBias;\nvoid main() {')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tmvPosition.xyz *= 1.0 - sceneryDepthBias * aBias;\n\tgl_Position = projectionMatrix * mvPosition;');
    }
    if (p.ambientSat && shader.fragmentShader.includes('#include <lights_fragment_begin>')) {
      shader.uniforms.sceneryAmbientSat = p.ambientSat;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float sceneryAmbientSat;\nvoid main() {')
        .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n\tirradiance = mix( vec3( dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), irradiance, sceneryAmbientSat );');
    }
  };
  m.customProgramCacheKey = () => key;
}

export class SceneryMaterials {
  readonly walls: THREE.MeshStandardMaterial;
  readonly plain: THREE.MeshStandardMaterial;
  readonly roofs: THREE.MeshStandardMaterial;
  readonly surfaces: THREE.MeshStandardMaterial;
  readonly markings: THREE.MeshStandardMaterial;
  readonly trees: THREE.MeshLambertMaterial;
  readonly streetlights: THREE.PointsMaterial;
  readonly airportLights: THREE.PointsMaterial;
  readonly pools: THREE.MeshBasicMaterial;
  readonly textures: THREE.Texture[] = [];
  /** minimum light point size in pixels (shared uniform) */
  readonly minPointPx = { value: 2.5 };
  /** relative depth bias of draped surfaces (shared uniform) */
  readonly depthBias = { value: DRAPE_DEPTH_BIAS };
  /** saturation kept in the sky ambient light (shared uniform) */
  readonly ambientSat = { value: AMBIENT_SATURATION };
  private night = -1;

  constructor(anisotropy = 4) {
    const facade = makeFacadeImages(256);
    const tex = (t: THREE.DataTexture) => { this.textures.push(t); return t; };
    const facadeMap = tex(toTexture(facade.albedo, { srgb: true, repeat: true, anisotropy }));
    const facadeEmissive = tex(toTexture(facade.emissive, { srgb: true, repeat: true, anisotropy }));
    const facadeRough = tex(toTexture(facade.rough, { srgb: false, repeat: true, anisotropy }));
    const plainMap = tex(toTexture(makePlainImage(128), { srgb: true, repeat: true, anisotropy }));
    const roofMap = tex(toTexture(makeRoofImage(128), { srgb: true, repeat: true, anisotropy }));
    const paveMap = tex(toTexture(makePavementImage(256), { srgb: true, repeat: true, anisotropy: Math.max(anisotropy, 8) }));
    const sprite = tex(toTexture(makeSpriteImage(64), { srgb: false, repeat: false }));
    const pool = tex(toTexture(makePoolImage(64), { srgb: false, repeat: false }));

    this.walls = new THREE.MeshStandardMaterial({
      name: 'scenery-walls', map: facadeMap, roughnessMap: facadeRough, emissiveMap: facadeEmissive, emissive: 0xffffff, emissiveIntensity: 0,
      vertexColors: true, roughness: 1, metalness: 0.05, envMapIntensity: ENV_INTENSITY * 1.5,
    });
    this.plain = new THREE.MeshStandardMaterial({ name: 'scenery-plain', map: plainMap, vertexColors: true, roughness: 0.85, metalness: 0.1, envMapIntensity: ENV_INTENSITY });
    this.roofs = new THREE.MeshStandardMaterial({ name: 'scenery-roofs', map: roofMap, vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: ENV_INTENSITY });
    this.surfaces = new THREE.MeshStandardMaterial({
      name: 'scenery-pavement', map: paveMap, vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: ENV_INTENSITY,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.markings = new THREE.MeshStandardMaterial({
      name: 'scenery-markings', vertexColors: true, roughness: 0.7, metalness: 0, envMapIntensity: ENV_INTENSITY,
      polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -1.5,
    });
    patchMaterial(this.walls, { ambientSat: this.ambientSat }, 'scenery-walls-1');
    patchMaterial(this.plain, { ambientSat: this.ambientSat }, 'scenery-plain-1');
    patchMaterial(this.roofs, { ambientSat: this.ambientSat }, 'scenery-roofs-1');
    patchMaterial(this.surfaces, { depthBias: this.depthBias, ambientSat: this.ambientSat }, 'scenery-surfaces-1');
    patchMaterial(this.markings, { depthBias: this.depthBias, ambientSat: this.ambientSat }, 'scenery-markings-1');
    this.trees = new THREE.MeshLambertMaterial({ name: 'scenery-trees', vertexColors: true });
    patchMaterial(this.trees, { ambientSat: this.ambientSat }, 'scenery-trees-1');
    this.streetlights = this.pointsMaterial('scenery-streetlights', sprite, 12);
    this.airportLights = this.pointsMaterial('scenery-airport-lights', sprite, 5.5);
    this.pools = new THREE.MeshBasicMaterial({
      name: 'scenery-light-pools', map: pool, color: 0xffe2b8, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: true,
    });
    patchMaterial(this.pools, { depthBias: this.depthBias }, 'scenery-pools-1');
  }

  private pointsMaterial(name: string, sprite: THREE.Texture, size: number): THREE.PointsMaterial {
    const m = new THREE.PointsMaterial({
      name, size, map: sprite, vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, alphaTest: 0.002,
    });
    const minPx = this.minPointPx;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.sceneryMinPointPx = minPx;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float sceneryMinPointPx;\nvoid main() {')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tgl_PointSize = max( gl_PointSize, sceneryMinPointPx );');
    };
    m.customProgramCacheKey = () => 'scenery-points-minpx-1';
    return m;
  }

  /** Night factor 0 (day) … 1 (night): lit windows, light points and floodlight pools. */
  setNight(f: number): void {
    if (Math.abs(f - this.night) < 1e-3) return;
    this.night = f;
    this.walls.emissiveIntensity = 0.9 * f;
    this.streetlights.opacity = f;
    this.airportLights.opacity = Math.min(1, 0.15 + f);
    this.pools.opacity = 0.2 * f;
  }

  get nightFactor(): number { return Math.max(0, this.night); }

  dispose(): void {
    for (const m of [this.walls, this.plain, this.roofs, this.surfaces, this.markings, this.trees, this.streetlights, this.airportLights, this.pools]) m.dispose();
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}

/** Low-poly tree geometries (crown + trunk with vertex colours), authored 1 m tall; instances scale them. */
export function makeTreeGeometries(): { conifer: THREE.BufferGeometry; broadleaf: THREE.BufferGeometry } {
  const colorize = (g: THREE.BufferGeometry, rgb: [number, number, number], shade = 0): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    const pos = g.getAttribute('position');
    for (let i = 0; i < n; i++) {
      const k = 1 - shade * (1 - Math.min(1, Math.max(0, pos.getY(i))));
      c[i * 3] = rgb[0] * k; c[i * 3 + 1] = rgb[1] * k; c[i * 3 + 2] = rgb[2] * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const lin = (r: number, g: number, b: number): [number, number, number] => {
    const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  };
  const trunk = (h: number, r: number) => {
    const t = new THREE.CylinderGeometry(r * 0.7, r, h, 4, 1, true);
    t.translate(0, h / 2, 0);
    return colorize(t.toNonIndexed(), lin(0.3, 0.22, 0.15));
  };
  // conifer: two stacked cones
  const c1 = new THREE.ConeGeometry(0.3, 0.62, 6, 1, true); c1.translate(0, 0.12 + 0.31, 0);
  const c2 = new THREE.ConeGeometry(0.22, 0.5, 6, 1, true); c2.translate(0, 0.45 + 0.25, 0);
  const coniferParts = [trunk(0.16, 0.035), colorize(c1.toNonIndexed(), lin(0.16, 0.27, 0.14), 0.35), colorize(c2.toNonIndexed(), lin(0.18, 0.3, 0.15), 0.25)];
  // broadleaf: squashed icosahedron crown on a trunk
  const crown = new THREE.IcosahedronGeometry(0.36, 0);
  crown.scale(1, 0.85, 1);
  crown.translate(0, 0.62, 0);
  const broadParts = [trunk(0.34, 0.045), colorize(crown.toNonIndexed(), lin(0.28, 0.37, 0.17), 0.3)];
  return { conifer: merge(coniferParts), broadleaf: merge(broadParts) };
}

/** Merge non-indexed geometries with position / normal / color into one (flat normals recomputed). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.getAttribute('position'), c = p.getAttribute('color');
    for (let i = 0; i < a.count; i++, o++) {
      pos[o * 3] = a.getX(i); pos[o * 3 + 1] = a.getY(i); pos[o * 3 + 2] = a.getZ(i);
      col[o * 3] = c.getX(i); col[o * 3 + 1] = c.getY(i); col[o * 3 + 2] = c.getZ(i);
    }
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
