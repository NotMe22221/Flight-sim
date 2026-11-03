/**
 * Sky, atmosphere and weather renderer (Tier A). Owns the Preetham sky dome, sun/moon/stars,
 * lights (sun, moon, hemisphere, ambient floor), tone-mapping exposure, scene fog, the PMREM
 * environment map, cloud-layer planes and precipitation. Driven entirely by the `SimSnapshot`
 * (UTC clock, aircraft lat/lon, weather) and the camera position each frame.
 *
 * Publishes `lighting` (`SkyLighting`) so terrain/ocean shaders can implement height fog and sun
 * lighting identically, and `sun` (`SunState` from core/types) for the UI/instruments.
 *
 * Structured for Tier B: replace the `Sky` dome + CPU Preetham with precomputed scattering and
 * `CloudLayers` with a volumetric renderer without touching the public surface.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep } from '../core/math';
import type { SimSnapshot, SunState, Vec3, WeatherState } from '../core/types';
import { dirFromAzEl, moonPosition, sunPosition } from '../geo/solar';
import { CloudLayers, type CloudLayersOptions } from './clouds';
import { installBuiltinHeightFog, setBuiltinHeightFog } from './builtinFog';
import {
  DEFAULT_EXPOSURE, type ExposureOptions, GROUND_ALBEDO, MIN_FOG_INV_H, NIGHT_AMBIENT_COLOR, SKYLIGHT_SATURATION, SUN_INTENSITY_BASE, adaptExposure,
  ambientFloor, capBySky, cloudCoverAbove, cloudCoverFraction, encodeDisplayColor, exposureForIlluminance, fogBetaFromVisibility, hazeColor, hazeScaleHeight,
  hemisphereIntensity, luminance, mieFromVisibility, mixVec3, moonLightIntensity, normalizeColor, saturateColor, skylightBalance, skylightIrradiance,
  starVisibility, sunLightIntensity, surfaceIlluminance, turbidityFromVisibility,
} from './lighting';
import { MoonDisc } from './moon';
import { Precipitation, type PrecipitationOptions } from './precipitation';
import { DEFAULT_PREETHAM, INSCATTER_KNEE, NIGHT_GLOW_GLSL, type PreethamParams, PreethamSky, SKY_RADIANCE_SCALE, TWILIGHT_GLSL, skyExtraDayFade, twilightColors } from './preetham';
import { defaultWeather } from './presets';
import { SKY_UNIFORMS, type SkySharedUniforms, cloudShadowAt, createSkySharedUniforms } from './skyUniforms';
import { StarField } from './stars';
import { type SkyLighting, createSkyLighting } from './types';
import { windAt } from './wind';

/**
 * Least share of the skylight kept on the hemisphere light for built-in materials while the baked environment
 * lights them. Since the calibration the environment IS the skylight by day (the dome, desaturated, over a lit
 * ground), so it carries all of it; the hemisphere light fills in at twilight, where the skylight curve is
 * brighter than the dome.
 */
const HEMI_SHARE_WITH_ENV = 0;
/** share of the skylight kept on the hemisphere light when someone else's environment map (unknown scale) is bound */
const HEMI_SHARE_FOREIGN_ENV = 0.25;
/**
 * Upper bound of scene.environmentIntensity for the baked sky: the intensity itself follows the terrain's
 * skylight (`skylightBalance`), but reflections are never brighter than the sky they mirror.
 */
const ENV_MAP_INTENSITY_MAX = 1;
/** saturation kept in the in-cloud fog colour (luminance-preserving; 1 = the zenith/horizon sky mix) */
const IN_CLOUD_SATURATION = 0.15;
/** the dome's own skylight fades in over these sun elevations (deg): below, Sky.js's constant floor is not twilight */
const DOME_SKYLIGHT_FADE_DEG: readonly [number, number] = [-4, 2];

export interface SkySystemOptions {
  /** exposure targets (day ≈ 0.5–0.7, night ≈ 1.5) and adaptation time */
  exposure?: Partial<ExposureOptions>;
  /** renderer tone mapping (default ACESFilmic) */
  toneMapping?: THREE.ToneMapping;
  /** enable the sun shadow map (default true) */
  shadows?: boolean;
  shadowMapSize?: number;
  /** half-size of the orthographic shadow frustum around the aircraft, m */
  shadowRadiusM?: number;
  /** number of stars */
  stars?: number;
  seed?: number;
  /** bake a PMREM environment map from the sky (default true; needs a real WebGL renderer) */
  environmentMap?: boolean;
  /** rebake when the sun moved more than this, deg */
  envRebakeDeg?: number;
  /** minimum real seconds between rebakes */
  envRebakeMinS?: number;
  /** sun DirectionalLight intensity at the zenith before extinction (`SUN_INTENSITY_BASE` 12: ≈ 5 × the dome's skylight at a 40° sun) */
  sunIntensity?: number;
  /** Preetham rayleigh (default 1) and Mie forward lobe (default 0.8) */
  rayleigh?: number;
  mieDirectionalG?: number;
  /** extinction coefficient inside a cloud at density 1 (m⁻¹): 0.03 ⇒ ≈130 m visibility */
  inCloudBeta?: number;
  clouds?: CloudLayersOptions;
  precipitation?: PrecipitationOptions;
  /**
   * uniforms published every frame for terrain/ocean shaders (ambient irradiance, sky colours, cloud
   * shadows); default the process-wide `SKY_UNIFORMS` that `TerrainSystem` reads, `null` to publish nothing
   */
  sharedUniforms?: SkySharedUniforms | null;
  /** give three's built-in materials the terrain's height fog (patches the fog shader chunks; default true) */
  builtinHeightFog?: boolean;
}

/**
 * The subset of the snapshot the sky needs. `frame` (optional) gives the floating origin's `alt0`:
 * render y is height above that origin, so MSL = y + alt0 (frames from `world/rebase` use alt0 = 0).
 */
export type SkySnapshot = Pick<SimSnapshot, 'time' | 'aircraft' | 'weather'> & Partial<Pick<SimSnapshot, 'frame'>>;

const SUN_DISTANCE_M = 600;
/** Sun shadow depth bias as a distance along the light, m (the old −0.0004 over the ~700 m ground range). */
const SHADOW_BIAS_M = 0.28;

/**
 * Far plane of the orthographic sun shadow camera (placed `lightDistM` from the aircraft toward the
 * sun, half-size `radiusM`): it must reach every ground point inside the frustum. The ground straight
 * down-sun of the aircraft lies AGL/sin(el) beyond it, and the down-sun half of the square slopes
 * away by another radius/tan(el). Shadow-map receivers beyond the far plane (runway slabs, scenery
 * pavement) read as fully shadowed with the reversed-Z depth buffer, which drew sharp-edged dark
 * wedges on runways a few hundred metres from the aircraft. `sinEl` = sin(sun elevation);
 * capped so a grazing sun keeps a usable depth range.
 */
export function sunShadowFar(lightDistM: number, radiusM: number, aglM: number, sinEl: number): number {
  const s = Math.min(Math.max(sinEl, 0.07), 1); // ≥ 4° (the sun light fades out below that)
  const cos = Math.sqrt(1 - s * s);
  const far = lightDistM + (Math.max(aglM, 0) + 60) / s + (radiusM * cos) / s + 100;
  return Math.min(far, 60_000);
}

/**
 * Drawn angular diameter of the Moon (true: 0.52°). A 60–90° screen FOV minifies the sky ≈ 1.5–2 × against
 * the eye, which left a crescent a few pixels wide; drawn at about twice its size it reads like the Moon.
 */
const MOON_APPARENT_DIAMETER_DEG = 1.0;
/** visibility used when the weather carries none (NaN): ICAO "10 km or more" */
const VISIBILITY_FALLBACK_M = 10_000;
const MOON_LIGHT_COLOR = 0xb8c4ff;
/** share of the horizon hue in the skylight colour (the rest is the zenith hue) */
const SKYLIGHT_HORIZON_SHARE = 0.5;
const WHITE: Vec3 = [1, 1, 1];
/** night-sky radiance at the horizon (warm light-pollution glow) and at the zenith (airglow), linear dome scale */
const NIGHT_GLOW_HORIZON: Vec3 = [0.024, 0.021, 0.02];
const NIGHT_GLOW_ZENITH: Vec3 = [0.0015, 0.0025, 0.0065];

export class SkySystem {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  /** per-frame lighting values for other renderers */
  readonly lighting: SkyLighting = createSkyLighting();
  /** sun/moon state in the shared contract (mutated in place) */
  readonly sun: SunState = { elevationRad: 0, azimuthRad: 0, dirThree: [0, 1, 0], moonElevationRad: 0, moonAzimuthRad: 0, moonPhase: 0 };
  readonly sky: Sky;
  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly ambientLight: THREE.AmbientLight;
  readonly stars: StarField;
  readonly moon: MoonDisc;
  readonly clouds: CloudLayers;
  readonly precipitation: Precipitation;
  readonly fog: THREE.FogExp2;
  readonly exposureOptions: ExposureOptions;
  /** the CPU twin of the sky shader (for custom sampling) */
  readonly preetham = new PreethamSky();

  private weather: WeatherState;
  private readonly opts: Required<Pick<SkySystemOptions, 'shadows' | 'shadowRadiusM' | 'environmentMap' | 'envRebakeDeg' | 'envRebakeMinS' | 'sunIntensity' | 'inCloudBeta' | 'builtinHeightFog'>>;
  /** uniforms published for other shaders (null: none) */
  readonly sharedUniforms: SkySharedUniforms | null;
  private readonly params: PreethamParams;
  private exposure: number;
  /** false until the first update (and after `resetAdaptation`): exposure snaps instead of adapting */
  private adapted = false;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: THREE.Mesh;
  /** grey shell over the baked sky as cover closes (reflections/IBL under an overcast are grey, not blue) */
  private readonly envOvercast: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  /** lit ground under the baked sky (the lower hemisphere of the environment: light from below, not more sky) */
  private readonly envGround: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly lastBakeSunDir = new THREE.Vector3(0, -1, 0);
  private lastBakeTurbidity = -1;
  private lastBakeMie = -1;
  private lastBakeCover = -1;
  private sinceBakeS = Infinity;
  private baked = false;
  /** luminance of the baked environment's irradiance on an up-facing surface at intensity 1 (dome scale) */
  private envIrradianceLum = 0;
  /** that irradiance (linear RGB): the dome desaturated by `SKYLIGHT_SATURATION`, the overcast shell blended over it */
  private readonly envIrradiance: Vec3 = [0, 0, 0];
  private readonly skyBalance = { envIntensity: 0, hemiShare: 1 };
  /** the clear dome's irradiance on an up-facing surface (CPU twin, recomputed when the sun or the air changes) */
  private readonly domeIrradiance: Vec3 = [0, 0, 0];
  private readonly domeKey = { x: NaN, y: NaN, z: NaN, turbidity: NaN, mie: NaN };
  /** the frame's skylight on an up-facing surface (linear RGB, without the night floor) */
  private readonly skyIrradiance: Vec3 = [0, 0, 0];
  /** irradiance a down-facing surface gets from the lit ground (linear RGB) */
  private readonly groundIrradiance: Vec3 = [0, 0, 0];
  /** saturation the dome is baked with into the environment (the skylight's, `SKYLIGHT_SATURATION` greyed by cloud) */
  private envSaturation = SKYLIGHT_SATURATION;
  private readonly tmpD: Vec3 = [0, 0, 0];
  private lastShadowFar = -1;
  /** external drifts (from a WeatherSystem) so cloud visuals and FDM density share one field */
  private cloudDrifts: readonly number[] | null = null;
  private readonly prevCamPos = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private readonly camVelRaw = new THREE.Vector3();
  private hasPrevCam = false;

  // scratch (no per-frame allocation)
  private readonly sunDir: Vec3 = [0, 1, 0];
  private readonly moonDir: Vec3 = [0, 1, 0];
  private readonly tmpA: Vec3 = [0, 0, 0];
  private readonly tmpB: Vec3 = [0, 0, 0];
  private readonly tmpC: Vec3 = [0, 0, 0];
  private readonly twZenith: Vec3 = [0, 0, 0];
  private readonly twBand: Vec3 = [0, 0, 0];
  private readonly transmittance: Vec3 = [1, 1, 1];
  private readonly zenith: Vec3 = [0, 0, 0];
  private readonly horizon: Vec3 = [0, 0, 0];
  private readonly horizonSun: Vec3 = [0, 0, 0];
  private readonly cloudGrey: Vec3 = [0, 0, 0];
  private readonly haze: Vec3 = [0, 0, 0];
  private readonly horizon90: Vec3 = [0, 0, 0];
  private readonly hazeSun: Vec3 = [0, 0, 0];
  private readonly glowEncoded = new THREE.Color();
  /** cloud-shadow layers when `sharedUniforms` is null (the sun light still needs them) */
  private readonly localShadow: SkySharedUniforms = createSkySharedUniforms();
  private readonly windNED: Vec3 = [0, 0, 0];
  private readonly windThree = new THREE.Vector3();
  private readonly aircraftPos = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, options: SkySystemOptions = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.opts = {
      shadows: options.shadows ?? true,
      shadowRadiusM: options.shadowRadiusM ?? 200,
      environmentMap: options.environmentMap ?? true,
      envRebakeDeg: options.envRebakeDeg ?? 1,
      envRebakeMinS: options.envRebakeMinS ?? 0.5,
      sunIntensity: options.sunIntensity ?? SUN_INTENSITY_BASE,
      inCloudBeta: options.inCloudBeta ?? 0.03,
      builtinHeightFog: options.builtinHeightFog ?? true,
    };
    this.sharedUniforms = options.sharedUniforms === undefined ? SKY_UNIFORMS : options.sharedUniforms;
    if (this.opts.builtinHeightFog) installBuiltinHeightFog();
    this.exposureOptions = { ...DEFAULT_EXPOSURE, ...options.exposure };
    this.exposure = this.exposureOptions.day;
    this.params = { ...DEFAULT_PREETHAM, rayleigh: options.rayleigh ?? 1, mieDirectionalG: options.mieDirectionalG ?? 0.8 };
    this.weather = defaultWeather();

    renderer.toneMapping = options.toneMapping ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.exposure;

    // ── sky dome ──
    this.sky = new Sky();
    this.sky.name = 'sky';
    this.sky.scale.setScalar(50_000);
    this.sky.renderOrder = 1; // after opaque terrain so covered pixels are rejected by the depth test
    this.sky.frustumCulled = false;
    patchSkyDepth(this.sky.material);
    patchSkyDome(this.sky.material);
    const u = this.sky.material.uniforms;
    u.turbidity.value = this.params.turbidity;
    u.rayleigh.value = this.params.rayleigh;
    u.mieCoefficient.value = this.params.mieCoefficient;
    u.mieDirectionalG.value = this.params.mieDirectionalG;
    u.cloudCoverage.value = 0; // we render our own layers
    scene.add(this.sky);
    // second instance (shared material) at the origin for the PMREM bake
    this.envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    this.envSky.scale.setScalar(100);
    this.envScene.add(this.envSky);
    this.envOvercast = new THREE.Mesh(
      new THREE.SphereGeometry(50, 16, 8),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false, toneMapped: false }),
    );
    this.envOvercast.renderOrder = 2;
    this.envScene.add(this.envOvercast);
    // the lower hemisphere: drawn over the dome (Sky.js continues the horizon sky below it, which lit the
    // aircraft's belly and shaded sides with more blue sky) and the overcast shell
    this.envGround = new THREE.Mesh(
      new THREE.SphereGeometry(45, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false }),
    );
    this.envGround.renderOrder = 3;
    this.envScene.add(this.envGround);

    // ── lights ──
    this.sunLight = new THREE.DirectionalLight(0xffffff, 0);
    this.sunLight.name = 'sunLight';
    this.sunLight.castShadow = this.opts.shadows;
    const size = options.shadowMapSize ?? 2048;
    this.sunLight.shadow.mapSize.set(size, size);
    const r = this.opts.shadowRadiusM;
    const cam = this.sunLight.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = SUN_DISTANCE_M * 2;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.3;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    // PCFSoftShadowMap is deprecated since r186 (it logs a warning and falls back to PCF)
    if (this.opts.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }

    this.moonLight = new THREE.DirectionalLight(MOON_LIGHT_COLOR, 0);
    this.moonLight.name = 'moonLight';
    scene.add(this.moonLight);
    scene.add(this.moonLight.target);

    this.hemiLight = new THREE.HemisphereLight(0x8fb6ff, 0x60533c, 0.6);
    this.hemiLight.name = 'skyLight';
    scene.add(this.hemiLight);
    this.ambientLight = new THREE.AmbientLight(0x2a3550, 0);
    this.ambientLight.name = 'ambientFloor';
    scene.add(this.ambientLight);

    // ── fog ──
    this.fog = new THREE.FogExp2(0xc8d8e8, this.lighting.fogExp2Density);
    scene.fog = this.fog;

    // ── celestial / weather renderables ──
    this.stars = new StarField(options.stars ?? 3000, options.seed ?? 12345);
    scene.add(this.stars.points);
    this.moon = new MoonDisc(MOON_APPARENT_DIAMETER_DEG);
    scene.add(this.moon.mesh);
    this.clouds = new CloudLayers(options.clouds);
    scene.add(this.clouds.group);
    this.precipitation = new Precipitation(options.precipitation);
    scene.add(this.precipitation.mesh);
  }

  /** current tone-mapping exposure */
  get currentExposure(): number { return this.exposure; }
  /** the weather used for the last update */
  get currentWeather(): WeatherState { return this.weather; }

  /** Skip eye adaptation on the next `update` (snap to the target exposure), e.g. after a time jump or teleport. */
  resetAdaptation(): void { this.adapted = false; }

  /** Replace the weather (the next `update` also reads `snapshot.weather` when present). */
  setWeather(w: WeatherState): void { this.weather = w; }

  /**
   * Use a `WeatherSystem`'s cloud drift offsets so `cloudDensityAt` in the FDM and the rendered
   * planes sample the identical noise field. Pass `null` to let the clouds integrate drift themselves.
   */
  setCloudDrifts(drifts: readonly number[] | null): void { this.cloudDrifts = drifts; }

  /** Cloud density 0..1 at a render-frame point (for FDM bumpiness / visibility). */
  cloudDensityAt(posThree: THREE.Vector3): number { return this.clouds.cloudDensityAt(posThree); }

  /**
   * Call when the floating origin moved. `originShiftThree` is the NEW origin's position expressed in
   * the OLD render frame (from `RebaseTransform.translationNED` t: `(t[1], −t[2], −t[0])`), i.e. every
   * render-frame position changes by −originShiftThree. When cloud drifts are shared with a
   * `WeatherSystem` (`setCloudDrifts`), also call `WeatherSystem.notifyRebase(shift.x, shift.z)`.
   */
  notifyRebase(originShiftThree: THREE.Vector3): void {
    this.clouds.notifyRebase(originShiftThree);
    this.hasPrevCam = false;
  }

  /**
   * Per-frame update.
   * @param snapshot sim time (UTC), aircraft (lat/lon/position/AGL) and weather
   * @param cameraPosThree camera position in the render frame
   * @param dt real seconds since the last frame (exposure adaptation, env-bake throttle, particles)
   */
  update(snapshot: SkySnapshot, cameraPosThree: THREE.Vector3, dt: number): void {
    const { time, aircraft } = snapshot;
    if (snapshot.weather) this.weather = snapshot.weather;
    const w = this.weather;
    const L = this.lighting;
    const lat = aircraft.geo.lat, lon = aircraft.geo.lon;
    const camPos = cameraPosThree;
    /** MSL altitude of render y = 0 */
    const alt0 = snapshot.frame?.alt0 ?? 0;
    /** sim seconds this frame (weather evolution follows the sim clock; 0 while paused) */
    const simDt = dt * Math.max(time.timeScale, 0);
    /** visibility (m); a missing value (NaN from a bad report) must not poison the adapted exposure */
    const vis = Number.isFinite(w.visibilityM) ? w.visibilityM : VISIBILITY_FALLBACK_M;

    // ── camera velocity (for rain streaks) ──
    if (this.hasPrevCam && dt > 1e-4) {
      this.camVelRaw.subVectors(camPos, this.prevCamPos).divideScalar(dt);
      if (this.camVelRaw.lengthSq() > 1e6) this.camVelRaw.set(0, 0, 0); // teleport / rebase
      this.camVel.lerp(this.camVelRaw, 1 - Math.exp(-dt / 0.15));
    }
    this.prevCamPos.copy(camPos);
    this.hasPrevCam = true;

    // ── sun / moon ──
    const sp = sunPosition(time.utcMs, lat, lon);
    const mp = moonPosition(time.utcMs, lat, lon);
    const D2R = Math.PI / 180;
    dirFromAzEl(sp.azimuth, sp.apparentElevation, this.sunDir);
    dirFromAzEl(mp.azimuth, mp.elevation, this.moonDir);
    this.sun.elevationRad = sp.elevation * D2R;
    this.sun.azimuthRad = sp.azimuth * D2R;
    this.sun.dirThree[0] = this.sunDir[0]; this.sun.dirThree[1] = this.sunDir[1]; this.sun.dirThree[2] = this.sunDir[2];
    this.sun.moonElevationRad = mp.elevation * D2R;
    this.sun.moonAzimuthRad = mp.azimuth * D2R;
    this.sun.moonPhase = mp.phase;
    L.sunDirThree.set(this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    L.moonDirThree.set(this.moonDir[0], this.moonDir[1], this.moonDir[2]);
    L.sunElevationDeg = sp.elevation;
    const el = sp.elevation;

    // ── sky model parameters from weather ──
    const turbidity = turbidityFromVisibility(vis, w.aerosol);
    const mie = mieFromVisibility(vis, w.aerosol);
    this.params.turbidity = turbidity;
    this.params.mieCoefficient = mie;
    this.preetham.setSun(this.sunDir, this.params);
    // night sky: airglow + light pollution near the horizon (a little brighter under moonlight), and the
    // twilight (deep-blue dome, warm band toward the sun) that carries the dome from Sky.js's sunset, whose sun
    // term is cut off ≈ 1–2° below the horizon, down into the night glow. Both are composed with the sunlit
    // in-scatter by a smooth maximum (no effect on a day sky) and fade out by day; keyed on the apparent
    // elevation like the dome. The dome shader evaluates the same terms (patchSkyDome).
    const elApp = sp.apparentElevation;
    const dayFade = skyExtraDayFade(elApp);
    const moonUp = clamp(mp.illuminatedFraction, 0, 1) * smoothstep(-2, 10, mp.elevation);
    const kh = dayFade * (1 + 1.5 * moonUp), kz = dayFade * (1 + 3 * moonUp);
    this.tmpA[0] = NIGHT_GLOW_HORIZON[0] * kh; this.tmpA[1] = NIGHT_GLOW_HORIZON[1] * kh; this.tmpA[2] = NIGHT_GLOW_HORIZON[2] * kh;
    this.tmpB[0] = NIGHT_GLOW_ZENITH[0] * kz; this.tmpB[1] = NIGHT_GLOW_ZENITH[1] * kz; this.tmpB[2] = NIGHT_GLOW_ZENITH[2] * kz;
    this.preetham.setNightGlow(this.tmpA, this.tmpB);
    twilightColors(elApp, this.twZenith, this.twBand);
    this.preetham.setTwilight(this.twZenith, this.twBand);
    const u = this.sky.material.uniforms;
    u.turbidity.value = turbidity;
    u.mieCoefficient.value = mie;
    (u.sunPosition.value as THREE.Vector3).set(this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    (u.nightGlowHorizon?.value as THREE.Vector3 | undefined)?.set(this.tmpA[0], this.tmpA[1], this.tmpA[2]);
    (u.nightGlowZenith?.value as THREE.Vector3 | undefined)?.set(this.tmpB[0], this.tmpB[1], this.tmpB[2]);
    (u.twilightZenith?.value as THREE.Vector3 | undefined)?.set(this.twZenith[0], this.twZenith[1], this.twZenith[2]);
    (u.twilightBand?.value as THREE.Vector3 | undefined)?.set(this.twBand[0], this.twBand[1], this.twBand[2]);
    this.sky.position.copy(camPos);

    // ── CPU sky samples ──
    this.preetham.zenith(this.zenith);
    this.preetham.horizonAverage(this.horizon);
    this.preetham.horizonTowardSun(this.horizonSun);
    this.preetham.sunTransmittance(this.transmittance);
    // the sky at the horizon 90° from the sun's azimuth: what the perpendicular haze is seen against
    const shl = Math.hypot(this.sunDir[0], this.sunDir[2]);
    const px = shl > 1e-6 ? -this.sunDir[2] / shl : 1, pz = shl > 1e-6 ? this.sunDir[0] / shl : 0;
    const c1 = Math.cos(D2R), s1 = Math.sin(D2R);
    this.tmpC[0] = px * c1; this.tmpC[1] = s1; this.tmpC[2] = pz * c1;
    this.preetham.radiance(this.tmpC, this.horizon90);
    L.skyColorZenith.setRGB(this.zenith[0], this.zenith[1], this.zenith[2]);
    L.skyColorHorizon.setRGB(this.horizon[0], this.horizon[1], this.horizon[2]);
    L.sunGlowColor.setRGB(this.horizonSun[0], this.horizonSun[1], this.horizonSun[2]);
    const sunRad = this.preetham.sunE * SKY_RADIANCE_SCALE * 0.22; // albedo/π-ish, as Sky.js uses for its clouds
    L.sunRadiance.setRGB(this.transmittance[0] * sunRad, this.transmittance[1] * sunRad, this.transmittance[2] * sunRad);

    // ── ground reference & cloud cover ──
    this.aircraftPos.set(aircraft.posNED[1], -aircraft.posNED[2], -aircraft.posNED[0]);
    L.groundY = this.aircraftPos.y - Math.max(aircraft.altitudeAglM, 0);
    const cloudCover = cloudCoverFraction(w.clouds);
    L.cloudCover = cloudCover;

    // ── clouds (also gives the in-cloud density at the camera) ──
    this.clouds.update(camPos, simDt, L, w.clouds, w.winds, this.cloudDrifts ?? undefined, alt0);
    const inCloud = this.clouds.densityAtCamera;
    L.inCloud = inCloud;
    // cloud-shadow layers (published below; also held locally when nothing is published)
    const shadowU = this.sharedUniforms ?? this.localShadow;
    this.clouds.writeShadowUniforms(shadowU, alt0);
    shadowU.uCloudShadowStrength.value = smoothstep(0, 4, el) * (1 - inCloud);
    shadowU.uCloudShadowNorm.value = 1 / Math.max(1 - 0.85 * clamp(cloudCover, 0, 1), 0.15);

    // ── lights (before the haze, which they light) ──
    normalizeColor(this.transmittance, this.tmpC);
    L.sunColor.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    /** the sun under the cloud cover, before the camera's own cloud dims it (lights the ground below) */
    const sunUnderCover = sunLightIntensity(el, this.transmittance, cloudCover, this.opts.sunIntensity);
    L.sunIntensity = sunUnderCover * (1 - 0.9 * inCloud);
    this.sunLight.color.copy(L.sunColor);
    // built-in materials share one sun light: shadow it by the clouds over the aircraft (the terrain
    // shadows itself per pixel from the same layers)
    this.sunLight.intensity = L.sunIntensity * cloudShadowAt(shadowU, this.aircraftPos.x, this.aircraftPos.y, this.aircraftPos.z, this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    this.sunLight.visible = L.sunIntensity > 1e-4;
    this.sunLight.position.copy(this.aircraftPos).addScaledVector(L.sunDirThree, SUN_DISTANCE_M);
    this.sunLight.target.position.copy(this.aircraftPos);
    const shadowFar = sunShadowFar(SUN_DISTANCE_M, this.opts.shadowRadiusM, aircraft.altitudeAglM, L.sunDirThree.y);
    // grow at once (the ground must never fall beyond the far plane), shrink lazily
    if (shadowFar > this.lastShadowFar || shadowFar < 0.85 * this.lastShadowFar) {
      this.sunLight.shadow.camera.far = shadowFar;
      this.sunLight.shadow.camera.updateProjectionMatrix();
      // the depth bias is in normalised depth: keep it a constant distance as the range changes
      this.sunLight.shadow.bias = -SHADOW_BIAS_M / (shadowFar - this.sunLight.shadow.camera.near);
      this.lastShadowFar = shadowFar;
    }

    // skylight (up-facing irradiance, in the dome's radiance scale like the sun): by day the dome's own
    // irradiance — the sky you see is the sky that lights the ground — desaturated to real skylight's hue
    // (SKYLIGHT_SATURATION); from sunset down the twilight curve (zenith/horizon hue × hemisphereIntensity),
    // which keeps dusk readable where the Preetham dome is nearly black; greyer and brighter under a deck.
    normalizeColor(this.zenith, this.tmpA);
    normalizeColor(this.horizon, this.tmpB);
    // (a low sun's horizon average is mostly its own glow, which lights the ground directionally: keep
    // twilight skylight closer to the zenith blue — cool shadows, warm light)
    mixVec3(this.tmpA, this.tmpB, SKYLIGHT_HORIZON_SHARE * lerp(0.4, 1, smoothstep(2, 20, el)), this.tmpC);
    mixVec3(this.tmpC, WHITE, 0.8 * cloudCover, this.tmpC);
    normalizeColor(this.tmpC, this.tmpC);
    const hi = hemisphereIntensity(el, cloudCover);
    this.tmpD[0] = this.tmpC[0] * hi; this.tmpD[1] = this.tmpC[1] * hi; this.tmpD[2] = this.tmpC[2] * hi;
    this.updateDomeIrradiance();
    this.envSaturation = SKYLIGHT_SATURATION * (1 - 0.8 * clamp(cloudCover, 0, 1));
    saturateColor(this.domeIrradiance, this.envSaturation, this.tmpA);
    const dayK = smoothstep(DOME_SKYLIGHT_FADE_DEG[0], DOME_SKYLIGHT_FADE_DEG[1], el) * (1 + 0.3 * clamp(cloudCover, 0, 1));
    this.tmpA[0] *= dayK; this.tmpA[1] *= dayK; this.tmpA[2] *= dayK;
    const sky = skylightIrradiance(this.tmpA, this.tmpD, this.skyIrradiance);
    const skyLum = luminance(sky);
    normalizeColor(sky, this.tmpC);
    this.hemiLight.color.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    /** hemisphere intensity that carries the whole skylight (built-ins without an environment map) */
    const hemiFull = skyLum / Math.max(luminance(this.tmpC), 1e-6);
    // (the hemisphere intensity and ground colour of built-in materials are set after the environment bake
    // below; the terrain shades from ambientIrradiance, which keeps the full skylight)
    this.hemiLight.intensity = hemiFull;
    // the lit ground (GROUND_ALBEDO) lights down-facing surfaces: the environment's lower hemisphere and the
    // hemisphere light's ground colour (the sun under the cover; the camera's own cloud does not darken it)
    const sunGround = sunUnderCover * Math.max(Math.sin(el * D2R), 0);
    const gi = this.groundIrradiance, sc = L.sunColor;
    gi[0] = GROUND_ALBEDO[0] * (sunGround * sc.r + Math.max(sky[0], 0));
    gi[1] = GROUND_ALBEDO[1] * (sunGround * sc.g + Math.max(sky[1], 0));
    gi[2] = GROUND_ALBEDO[2] * (sunGround * sc.b + Math.max(sky[2], 0));
    this.ambientLight.color.setRGB(NIGHT_AMBIENT_COLOR[0], NIGHT_AMBIENT_COLOR[1], NIGHT_AMBIENT_COLOR[2]);
    this.ambientLight.intensity = ambientFloor(el, mp.illuminatedFraction, mp.elevation);
    L.ambientIntensity = hemiFull + this.ambientLight.intensity;
    const ai = this.ambientLight.intensity;
    L.ambientIrradiance.setRGB(sky[0] + NIGHT_AMBIENT_COLOR[0] * ai, sky[1] + NIGHT_AMBIENT_COLOR[1] * ai, sky[2] + NIGHT_AMBIENT_COLOR[2] * ai);

    L.moonIntensity = moonLightIntensity(mp.elevation, mp.illuminatedFraction, cloudCover, el);
    this.moonLight.intensity = L.moonIntensity;
    this.moonLight.visible = L.moonIntensity > 1e-5;
    this.moonLight.position.copy(this.aircraftPos).addScaledVector(L.moonDirThree, SUN_DISTANCE_M);
    this.moonLight.target.position.copy(this.aircraftPos);

    // ── fog / aerial perspective: β(h) = β0·exp(−h/H), h above the ground under the aircraft ──
    const camAgl = Math.max(camPos.y - L.groundY, 0);
    let H = hazeScaleHeight(vis);
    // a ground fog layer: the reported visibility applies at the surface and the extinction decays over
    // the layer depth, so it thins out above the top yet still hides the ground when seen from above
    if (w.fogTopM > 0) H = Math.min(H, Math.max(w.fogTopM, 30));
    const betaSurface = fogBetaFromVisibility(vis);
    // inside cloud the fog becomes homogeneous (falloff → 0) and β at the camera blends toward the
    // in-cloud extinction, so terrain/cloud shaders fog out exactly like the built-in materials below
    const invH = Math.max((1 - inCloud) / H, MIN_FOG_INV_H);
    const betaCamera = lerp(betaSurface * Math.exp(-camAgl / H), this.opts.inCloudBeta, inCloud);
    L.fogHeightFalloff = invH;
    L.fogDensity = inCloud > 0 ? betaCamera * Math.exp(Math.min(camAgl * invH, 80)) : betaSurface;
    // haze colour: sun, sky and ground light scattered by the haze, lit like the terrain and kept below
    // the sky radiance behind it (so the horizon line shows); inside cloud it blends toward cloud grey
    this.tmpA[0] = L.sunColor.r; this.tmpA[1] = L.sunColor.g; this.tmpA[2] = L.sunColor.b;
    this.tmpB[0] = L.ambientIrradiance.r; this.tmpB[1] = L.ambientIrradiance.g; this.tmpB[2] = L.ambientIrradiance.b;
    capBySky(hazeColor(0, this.tmpA, L.sunIntensity, el, this.tmpB, vis, this.haze), this.horizon90);
    capBySky(hazeColor(1, this.tmpA, L.sunIntensity, el, this.tmpB, vis, this.hazeSun), this.horizonSun);
    mixVec3(this.zenith, this.horizon, 0.5, this.cloudGrey);
    this.cloudGrey[0] = this.cloudGrey[0] * 0.9 + L.sunRadiance.r * 0.08;
    this.cloudGrey[1] = this.cloudGrey[1] * 0.9 + L.sunRadiance.g * 0.08;
    this.cloudGrey[2] = this.cloudGrey[2] * 0.9 + L.sunRadiance.b * 0.08;
    // inside a cloud the light is scattered many times by droplets (no colour preference): near-neutral grey,
    // like the planes' skylight under a closing deck (clouds.ts) — the zenith-blue mix read sky-blue (b/r ≈ 2)
    saturateColor(this.cloudGrey, IN_CLOUD_SATURATION, this.cloudGrey);
    mixVec3(this.haze, this.cloudGrey, inCloud, this.tmpC);
    L.fogColor.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    // the dome is at infinity: a few hundred metres of cloud along any ray hide it, so it fades out early
    if (u.skyFogMix) u.skyFogMix.value = smoothstep(0, 0.35, inCloud);
    (u.skyFogColor?.value as THREE.Vector3 | undefined)?.set(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    mixVec3(this.hazeSun, this.cloudGrey, inCloud, this.tmpC);
    L.sunGlowColor.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    // clouds fade into the sky behind them; below a closing deck that is the haze under it
    mixVec3(this.horizon, this.haze, smoothstep(0.5, 1, cloudCover), this.tmpC);
    mixVec3(this.tmpC, this.cloudGrey, inCloud, this.tmpC);
    L.skyFogColor.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    this.clouds.setFog(L);

    // ── exposure: partial eye adaptation to the light where the camera is ──
    // Only the layers above the camera dim its sun: above an overcast deck the aircraft and the cloud tops are
    // in full sun, and adapting to the overcast below left the eye ≈ 2 × too open (sunlit paint clipped).
    const ambLum = 0.2126 * L.ambientIrradiance.r + 0.7152 * L.ambientIrradiance.g + 0.0722 * L.ambientIrradiance.b;
    const sunAtCamera = sunLightIntensity(el, this.transmittance, cloudCoverAbove(w.clouds, camPos.y + alt0), this.opts.sunIntensity) * (1 - 0.9 * inCloud);
    const target = exposureForIlluminance(surfaceIlluminance(sunAtCamera, el, ambLum), mp.illuminatedFraction, this.exposureOptions);
    this.exposure = this.adapted && Number.isFinite(this.exposure) ? adaptExposure(this.exposure, target, dt, this.exposureOptions.adaptTimeS) : target;
    this.adapted = true;
    this.renderer.toneMappingExposure = this.exposure;
    L.exposure = this.exposure;

    // built-in fog: three applies `fog_fragment` AFTER tone mapping and output encoding, so its colours are
    // display values. Three r187 converts `fog.color` from the working space to the output colour space
    // when uploading the uniform, so hand it the display value AS sRGB (converted back to linear on set) —
    // copying the encoded triple raw would sRGB-encode it twice (washed-out fog). With the height-fog patch
    // (builtinFog.ts) every built-in material uses the terrain's β0/falloff/ground and the sun-ward lobe;
    // `density` (≈ the haze at half the camera height) is three's plain FogExp2 fallback.
    const betaCam = betaSurface * Math.exp(-0.5 * camAgl / H) * (1 - inCloud) + this.opts.inCloudBeta * inCloud;
    L.fogExp2Density = (1.978 / 3.912) * betaCam;
    this.fog.density = L.fogExp2Density;
    this.tmpA[0] = L.fogColor.r; this.tmpA[1] = L.fogColor.g; this.tmpA[2] = L.fogColor.b;
    encodeDisplayColor(this.tmpA, this.exposure, this.tmpB);
    L.fogColorEncoded.setRGB(this.tmpB[0], this.tmpB[1], this.tmpB[2], THREE.LinearSRGBColorSpace);
    this.fog.color.setRGB(this.tmpB[0], this.tmpB[1], this.tmpB[2], THREE.SRGBColorSpace);
    this.tmpA[0] = L.sunGlowColor.r; this.tmpA[1] = L.sunGlowColor.g; this.tmpA[2] = L.sunGlowColor.b;
    encodeDisplayColor(this.tmpA, this.exposure, this.tmpB);
    this.glowEncoded.setRGB(this.tmpB[0], this.tmpB[1], this.tmpB[2], THREE.LinearSRGBColorSpace);
    if (this.opts.builtinHeightFog) setBuiltinHeightFog(L.fogDensity, L.fogHeightFalloff, L.groundY, L.sunDirThree, this.glowEncoded, true);

    // ── uniforms shared with the terrain/ocean shaders ──
    const su = this.sharedUniforms;
    if (su) {
      su.uSkyLinked.value = 1;
      su.uSkyIrradiance.value.copy(L.ambientIrradiance);
      su.uSkyZenith.value.copy(L.skyColorZenith);
      su.uSkyHorizon.value.copy(L.skyColorHorizon);
      su.uSkyExposure.value = this.exposure;
      su.uSkyGroundY.value = L.groundY;
    }

    // ── stars & moon ──
    L.starVisibility = starVisibility(el, cloudCover) * (1 - inCloud);
    this.stars.update(time.utcMs, lat, lon, camPos, L.starVisibility, this.renderer.getPixelRatio?.() ?? 1);
    this.preetham.transmittance(this.moonDir, this.tmpC);
    this.v3.set(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    const dayFactor = smoothstep(-6, 6, el);
    this.moon.update(L.moonDirThree, L.sunDirThree, camPos, this.moonTint.setRGB(this.v3.x, this.v3.y, this.v3.z), dayFactor);
    this.moon.mesh.visible = this.moon.mesh.visible && cloudCover < 0.98 && inCloud < 0.5;

    // ── precipitation ──
    windAt(w.winds, camPos.y + alt0, camAgl, this.windNED);
    this.windThree.set(this.windNED[1], 0, -this.windNED[0]);
    this.precipitation.update(dt, camPos, this.camVel, this.windThree, w, L);

    // ── environment map (the overcast shell follows the cloud planes' skylight grey) ──
    const envGrey = 0.9 * (0.2126 * (this.zenith[0] + this.horizon[0]) + 0.7152 * (this.zenith[1] + this.horizon[1]) + 0.0722 * (this.zenith[2] + this.horizon[2])) * 0.5;
    this.envOvercast.material.color.setRGB(envGrey, envGrey, envGrey);
    this.envOvercast.material.opacity = 0.9 * smoothstep(0.3, 1, cloudCover);
    this.envOvercast.visible = this.envOvercast.material.opacity > 0.01;
    // the lower hemisphere: the lit ground's radiance (albedo/π · irradiance; the environment runs at ≈ intensity 1)
    this.envGround.material.color.setRGB(gi[0] / Math.PI, gi[1] / Math.PI, gi[2] / Math.PI);
    this.sinceBakeS += dt;
    if (this.opts.environmentMap) this.maybeBakeEnvironment(turbidity, mie, cloudCover, time.timeScale);

    // ── skylight on built-in materials ──
    // They receive the sky's light from the baked environment map (image-based lighting) AND the hemisphere
    // light; together these must give the terrain's skylight (ambientIrradiance), or the aircraft and runway
    // paint tint sky-blue at noon (both at full strength) or go dark at dusk (one constant environment scale:
    // the dome dims ≈ 27× toward sunset, the skylight curve ≈ 2×). See `skylightBalance`. The environment's
    // lower hemisphere is the lit ground; the hemisphere light's ground colour carries what it does not.
    const env = this.scene.environment;
    let envShare = 0;
    if (env && this.envTarget && env === this.envTarget.texture) {
      skylightBalance(skyLum, this.envIrradianceLum, HEMI_SHARE_WITH_ENV, ENV_MAP_INTENSITY_MAX, this.skyBalance);
      this.scene.environmentIntensity = this.skyBalance.envIntensity;
      this.hemiLight.intensity = hemiFull * this.skyBalance.hemiShare;
      envShare = this.skyBalance.envIntensity;
    } else if (env) {
      this.hemiLight.intensity = hemiFull * HEMI_SHARE_FOREIGN_ENV; // someone else's environment map: its scale is unknown
      envShare = 1 - HEMI_SHARE_FOREIGN_ENV;
    }
    const hemiI = this.hemiLight.intensity;
    const k = hemiI > 1e-4 ? Math.max(1 - envShare, 0) / hemiI : 0;
    this.hemiLight.groundColor.setRGB(gi[0] * k, gi[1] * k, gi[2] * k);
  }

  /** Integrates the clear dome's up-facing irradiance when the sun moved ≈ 0.25° or the air changed (≈ 512 samples). */
  private updateDomeIrradiance(): void {
    const key = this.domeKey, d = this.preetham.sunDir, p = this.params;
    if (Math.abs(d[0] - key.x) + Math.abs(d[1] - key.y) + Math.abs(d[2] - key.z) < 0.004
      && Math.abs(p.turbidity - key.turbidity) < 0.05 && Math.abs(p.mieCoefficient - key.mie) < 2e-4) return;
    key.x = d[0]; key.y = d[1]; key.z = d[2]; key.turbidity = p.turbidity; key.mie = p.mieCoefficient;
    this.preetham.irradianceUp(this.domeIrradiance);
  }

  /**
   * Irradiance the baked environment gives an up-facing surface (the dome as baked — desaturated, same
   * luminance — with the overcast shell blended over it), from the CPU twin at each bake.
   */
  private measureEnvironment(): void {
    this.updateDomeIrradiance();
    const E = saturateColor(this.domeIrradiance, this.envSaturation, this.envIrradiance);
    const shell = this.envOvercast.visible ? this.envOvercast.material.opacity : 0;
    const grey = this.envOvercast.material.color.r;
    this.envIrradianceLum = (1 - shell) * luminance(E) + shell * Math.PI * grey;
  }
  private readonly moonTint = new THREE.Color();

  private maybeBakeEnvironment(turbidity: number, mie: number, cloudCover: number, timeScale: number): void {
    const L = this.lighting;
    const thresholdDeg = this.opts.envRebakeDeg * (timeScale >= 60 ? 3 : 1);
    const moved = this.lastBakeSunDir.angleTo(L.sunDirThree) > thresholdDeg * (Math.PI / 180);
    const changed = Math.abs(turbidity - this.lastBakeTurbidity) > 0.5 || Math.abs(mie - this.lastBakeMie) > 0.003 || Math.abs(cloudCover - this.lastBakeCover) > 0.15;
    if (this.baked && (!(moved || changed) || this.sinceBakeS < this.opts.envRebakeMinS)) return;
    this.bakeEnvironment();
    this.lastBakeSunDir.copy(L.sunDirThree);
    this.lastBakeTurbidity = turbidity; this.lastBakeMie = mie; this.lastBakeCover = cloudCover;
    this.sinceBakeS = 0;
    this.baked = true;
  }

  /** Rebake `scene.environment` from the sky now (hides the sun disc to avoid PMREM fireflies). */
  bakeEnvironment(): void {
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const u = this.sky.material.uniforms;
    const disc = u.showSunDisc.value as number;
    u.showSunDisc.value = 0;
    // the dome lights surfaces with real skylight's hue (the dome you see keeps its saturation)
    const sat = u.skySaturation as { value: number } | undefined;
    if (sat) sat.value = this.envSaturation;
    // … and the clear dome that `measureEnvironment` integrates, even while the camera is in a cloud
    const fogMix = u.skyFogMix as { value: number } | undefined;
    const fogMix0 = fogMix ? fogMix.value : 0;
    if (fogMix) fogMix.value = 0;
    let rt: THREE.WebGLRenderTarget | null = null;
    try {
      rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    } catch (e) {
      console.warn('[sky] environment bake failed', e);
    }
    u.showSunDisc.value = disc;
    if (sat) sat.value = 1;
    if (fogMix) fogMix.value = fogMix0;
    if (!rt) return;
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = rt;
    this.scene.environment = rt.texture;
    // The baked dome is in the light units (the sun is calibrated against it); `update` balances it against
    // the skylight curve, which is brighter than the dome at twilight (`skylightBalance`).
    this.measureEnvironment();
  }

  dispose(): void {
    // unlink what this sky published process-wide: three's built-in height fog and the shared uniforms
    if (this.opts.builtinHeightFog) setBuiltinHeightFog(0, MIN_FOG_INV_H, 0, this.lighting.sunDirThree, this.glowEncoded, false);
    if (this.sharedUniforms) { this.sharedUniforms.uSkyLinked.value = 0; this.sharedUniforms.uCloudShadowStrength.value = 0; }
    if (this.envTarget && this.scene.environment === this.envTarget.texture) this.scene.environment = null;
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sky.removeFromParent();
    this.envSky.removeFromParent();
    this.envOvercast.geometry.dispose();
    this.envOvercast.material.dispose();
    this.envOvercast.removeFromParent();
    this.envGround.geometry.dispose();
    this.envGround.material.dispose();
    this.envGround.removeFromParent();
    this.sunLight.target.removeFromParent();
    this.sunLight.dispose();
    this.sunLight.removeFromParent();
    this.moonLight.target.removeFromParent();
    this.moonLight.dispose();
    this.moonLight.removeFromParent();
    this.hemiLight.dispose();
    this.hemiLight.removeFromParent();
    this.ambientLight.dispose();
    this.ambientLight.removeFromParent();
    this.stars.dispose();
    this.moon.dispose();
    this.clouds.dispose();
    this.precipitation.dispose();
    if (this.scene.fog === this.fog) this.scene.fog = null;
  }
}

/**
 * Look patches for the r187 `Sky` dome, mirrored by `PreethamSky` (its CPU twin): the in-scatter knee
 * (`INSCATTER_KNEE`, tames the white horizon band), the night-sky glow (`NIGHT_GLOW_GLSL`; uniforms
 * `nightGlowHorizon` / `nightGlowZenith`) and the twilight (`TWILIGHT_GLSL`; `twilightZenith` / `twilightBand`),
 * vec3 linear, composed with the sunlit in-scatter (`Lin`) by the smooth maximum `skyLitMax` before tone
 * mapping. Not mirrored (they never light anything): `skySaturation` (1; the environment bake lowers it) and
 * `skyFogMix` / `skyFogColor` (the dome fading into the in-cloud fog). Idempotent; a step whose anchor is not
 * found is skipped (the dome then renders as plain Sky.js for that part).
 */
/** The dome's composition line (see `patchSkyDome`): twilight + night glow against the sunlit in-scatter. */
export const SKY_LIT_MAX_LINE = 'texColor += skyLitMax( Lin * 0.04, skyNightGlow( direction ) + skyTwilight( direction, vSunDirection ) ) - Lin * 0.04;';

export function patchSkyDome(material: THREE.ShaderMaterial): void {
  let fs = material.fragmentShader;
  if (fs.includes('// sky dome look patch')) return;
  fs = `// sky dome look patch\n${fs}`;
  const linLine = /Lin \*= mix\( vec3\( 1\.0 \),[^\n]*\n/;
  if (linLine.test(fs)) {
    fs = fs.replace(linLine, (m) => `${m}\t\t\tLin *= 1.0 / ( 1.0 + dot( Lin, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${INSCATTER_KNEE.toFixed(1)} );\n`);
  }
  if (fs.includes('gl_FragColor = vec4( texColor, 1.0 );') && fs.includes('void main()')) {
    material.uniforms.nightGlowHorizon = { value: new THREE.Vector3() };
    material.uniforms.nightGlowZenith = { value: new THREE.Vector3() };
    material.uniforms.twilightZenith = { value: new THREE.Vector3() };
    material.uniforms.twilightBand = { value: new THREE.Vector3() };
    // luminance-preserving saturation, 1 on screen; the environment bake lowers it to the skylight's
    material.uniforms.skySaturation = { value: 1 };
    // inside a cloud the dome fades to the in-cloud fog (linear, pre tone mapping like the dome)
    material.uniforms.skyFogMix = { value: 0 };
    material.uniforms.skyFogColor = { value: new THREE.Vector3() };
    fs = fs
      .replace('void main()', `${NIGHT_GLOW_GLSL}\n${TWILIGHT_GLSL}\nuniform float skySaturation;\nuniform float skyFogMix;\nuniform vec3 skyFogColor;\n\t\tvoid main()`)
      .replace('gl_FragColor = vec4( texColor, 1.0 );',
        // texColor = (Lin + L0) · 0.04 + disc + floor: only the sunlit in-scatter takes part in the smooth maximum
        `${SKY_LIT_MAX_LINE}\n\t\t\ttexColor = mix( vec3( dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), texColor, skySaturation );\n\t\t\ttexColor = mix( texColor, skyFogColor, skyFogMix );\n\t\t\tgl_FragColor = vec4( texColor, 1.0 );`);
  }
  material.fragmentShader = fs;
  material.needsUpdate = true;
}

/**
 * The r187 Sky vertex shader forces `gl_Position.z = gl_Position.w` (far plane) which is the NEAR
 * plane under a reversed depth buffer. Patch it so the dome stays at the far plane in both modes
 * (Three injects `USE_REVERSED_DEPTH_BUFFER` into every program when the renderer uses it).
 */
export function patchSkyDepth(material: THREE.ShaderMaterial): void {
  // match the statement AND the rest of its line (r187 has a trailing `// set z to camera.far`
  // comment, which must not end up after `#endif`)
  const needle = /gl_Position\.z = gl_Position\.w;[^\n]*/;
  if (!needle.test(material.vertexShader) || material.vertexShader.includes('USE_REVERSED_DEPTH_BUFFER')) return;
  material.vertexShader = material.vertexShader.replace(
    needle,
    '\n#ifdef USE_REVERSED_DEPTH_BUFFER\n\t\t\tgl_Position.z = 0.0; // far plane under reversed depth\n#else\n\t\t\tgl_Position.z = gl_Position.w; // far plane\n#endif\n',
  );
  material.needsUpdate = true;
}
