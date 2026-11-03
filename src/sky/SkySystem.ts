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
import {
  DEFAULT_EXPOSURE, type ExposureOptions, MIN_FOG_INV_H, adaptExposure, ambientFloor, cloudCoverFraction, encodeDisplayColor, fogBetaFromVisibility,
  hazeScaleHeight, hemisphereIntensity, mieFromVisibility, mixVec3, moonLightIntensity, normalizeColor, starVisibility, sunLightIntensity,
  targetExposure, turbidityFromVisibility,
} from './lighting';
import { MoonDisc } from './moon';
import { Precipitation, type PrecipitationOptions } from './precipitation';
import { DEFAULT_PREETHAM, type PreethamParams, PreethamSky, SKY_RADIANCE_SCALE } from './preetham';
import { defaultWeather } from './presets';
import { StarField } from './stars';
import { type SkyLighting, createSkyLighting } from './types';
import { windAt } from './wind';

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
  /** base sun DirectionalLight intensity at the zenith (≈ 3 ⇒ 100 klx under exposure 0.6) */
  sunIntensity?: number;
  /** Preetham rayleigh (default 1) and Mie forward lobe (default 0.8) */
  rayleigh?: number;
  mieDirectionalG?: number;
  /** extinction coefficient inside a cloud at density 1 (m⁻¹): 0.03 ⇒ ≈130 m visibility */
  inCloudBeta?: number;
  clouds?: CloudLayersOptions;
  precipitation?: PrecipitationOptions;
}

/**
 * The subset of the snapshot the sky needs. `frame` (optional) gives the floating origin's `alt0`:
 * render y is height above that origin, so MSL = y + alt0 (frames from `world/rebase` use alt0 = 0).
 */
export type SkySnapshot = Pick<SimSnapshot, 'time' | 'aircraft' | 'weather'> & Partial<Pick<SimSnapshot, 'frame'>>;

const SUN_DISTANCE_M = 600;
const MOON_LIGHT_COLOR = 0xb8c4ff;

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
  private readonly opts: Required<Pick<SkySystemOptions, 'shadows' | 'shadowRadiusM' | 'environmentMap' | 'envRebakeDeg' | 'envRebakeMinS' | 'sunIntensity' | 'inCloudBeta'>>;
  private readonly params: PreethamParams;
  private exposure: number;
  /** false until the first update (and after `resetAdaptation`): exposure snaps instead of adapting */
  private adapted = false;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: THREE.Mesh;
  private readonly lastBakeSunDir = new THREE.Vector3(0, -1, 0);
  private lastBakeTurbidity = -1;
  private lastBakeMie = -1;
  private lastBakeCover = -1;
  private sinceBakeS = Infinity;
  private baked = false;
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
  private readonly transmittance: Vec3 = [1, 1, 1];
  private readonly zenith: Vec3 = [0, 0, 0];
  private readonly horizon: Vec3 = [0, 0, 0];
  private readonly horizonSun: Vec3 = [0, 0, 0];
  private readonly cloudGrey: Vec3 = [0, 0, 0];
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
      sunIntensity: options.sunIntensity ?? 3,
      inCloudBeta: options.inCloudBeta ?? 0.03,
    };
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
    this.moon = new MoonDisc();
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
    const turbidity = turbidityFromVisibility(w.visibilityM, w.aerosol);
    const mie = mieFromVisibility(w.visibilityM, w.aerosol);
    this.params.turbidity = turbidity;
    this.params.mieCoefficient = mie;
    this.preetham.setSun(this.sunDir, this.params);
    const u = this.sky.material.uniforms;
    u.turbidity.value = turbidity;
    u.mieCoefficient.value = mie;
    (u.sunPosition.value as THREE.Vector3).set(this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    this.sky.position.copy(camPos);

    // ── CPU sky samples ──
    this.preetham.zenith(this.zenith);
    this.preetham.horizonAverage(this.horizon);
    this.preetham.horizonTowardSun(this.horizonSun);
    this.preetham.sunTransmittance(this.transmittance);
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

    // ── fog / aerial perspective: β(h) = β0·exp(−h/H), h above the ground under the aircraft ──
    const camAgl = Math.max(camPos.y - L.groundY, 0);
    let H = hazeScaleHeight(w.visibilityM);
    // a ground fog layer: the reported visibility applies at the surface and the extinction decays over
    // the layer depth, so it thins out above the top yet still hides the ground when seen from above
    if (w.fogTopM > 0) H = Math.min(H, Math.max(w.fogTopM, 30));
    const betaSurface = fogBetaFromVisibility(w.visibilityM);
    // inside cloud the fog becomes homogeneous (falloff → 0) and β at the camera blends toward the
    // in-cloud extinction, so terrain/cloud shaders fog out exactly like the built-in FogExp2 below
    const invH = Math.max((1 - inCloud) / H, MIN_FOG_INV_H);
    const betaCamera = lerp(betaSurface * Math.exp(-camAgl / H), this.opts.inCloudBeta, inCloud);
    L.fogHeightFalloff = invH;
    L.fogDensity = inCloud > 0 ? betaCamera * Math.exp(Math.min(camAgl * invH, 80)) : betaSurface;
    // fog colour: horizon sky, blended toward a cloud grey (ambient) inside cloud
    mixVec3(this.zenith, this.horizon, 0.5, this.cloudGrey);
    this.cloudGrey[0] = this.cloudGrey[0] * 0.9 + L.sunRadiance.r * 0.08;
    this.cloudGrey[1] = this.cloudGrey[1] * 0.9 + L.sunRadiance.g * 0.08;
    this.cloudGrey[2] = this.cloudGrey[2] * 0.9 + L.sunRadiance.b * 0.08;
    mixVec3(this.horizon, this.cloudGrey, inCloud, this.tmpA);
    L.fogColor.setRGB(this.tmpA[0], this.tmpA[1], this.tmpA[2]);
    this.clouds.setFog(L);

    // ── exposure ──
    const target = targetExposure(el, cloudCover, mp.illuminatedFraction, this.exposureOptions);
    this.exposure = this.adapted ? adaptExposure(this.exposure, target, dt, this.exposureOptions.adaptTimeS) : target;
    this.adapted = true;
    this.renderer.toneMappingExposure = this.exposure;
    L.exposure = this.exposure;

    // built-in fog: density at (half) the camera height so standard materials get a plausible haze;
    // colour must be tone mapped + encoded because Three applies fog after tone mapping and output
    // encoding. Three r187 converts `fog.color` from the working space to the output colour space
    // when uploading the uniform, so hand it the display value AS sRGB (converted back to linear on
    // set) — copying the encoded triple raw would sRGB-encode it twice (washed-out fog).
    const betaCam = betaSurface * Math.exp(-0.5 * camAgl / H) * (1 - inCloud) + this.opts.inCloudBeta * inCloud;
    L.fogExp2Density = (1.978 / 3.912) * betaCam;
    this.fog.density = L.fogExp2Density;
    encodeDisplayColor(this.tmpA, this.exposure, this.tmpB);
    L.fogColorEncoded.setRGB(this.tmpB[0], this.tmpB[1], this.tmpB[2], THREE.LinearSRGBColorSpace);
    this.fog.color.setRGB(this.tmpB[0], this.tmpB[1], this.tmpB[2], THREE.SRGBColorSpace);

    // ── lights ──
    normalizeColor(this.transmittance, this.tmpC);
    L.sunColor.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    L.sunIntensity = sunLightIntensity(el, this.transmittance, cloudCover, this.opts.sunIntensity) * (1 - 0.9 * inCloud);
    this.sunLight.color.copy(L.sunColor);
    this.sunLight.intensity = L.sunIntensity;
    this.sunLight.visible = L.sunIntensity > 1e-4;
    this.sunLight.position.copy(this.aircraftPos).addScaledVector(L.sunDirThree, SUN_DISTANCE_M);
    this.sunLight.target.position.copy(this.aircraftPos);
    const shadowFar = SUN_DISTANCE_M + clamp(aircraft.altitudeAglM, 0, 3000) + 100;
    if (Math.abs(shadowFar - this.lastShadowFar) > 50) {
      this.sunLight.shadow.camera.far = shadowFar;
      this.sunLight.shadow.camera.updateProjectionMatrix();
      this.lastShadowFar = shadowFar;
    }

    normalizeColor(this.zenith, this.tmpC);
    this.hemiLight.color.setRGB(this.tmpC[0], this.tmpC[1], this.tmpC[2]);
    normalizeColor(this.horizon, this.tmpC);
    this.hemiLight.groundColor.setRGB(this.tmpC[0] * 0.35, this.tmpC[1] * 0.35, this.tmpC[2] * 0.35);
    this.hemiLight.intensity = hemisphereIntensity(el, cloudCover);
    this.ambientLight.intensity = ambientFloor(el, mp.illuminatedFraction, mp.elevation);
    L.ambientIntensity = this.hemiLight.intensity + this.ambientLight.intensity;

    L.moonIntensity = moonLightIntensity(mp.elevation, mp.illuminatedFraction, cloudCover, el);
    this.moonLight.intensity = L.moonIntensity;
    this.moonLight.visible = L.moonIntensity > 1e-5;
    this.moonLight.position.copy(this.aircraftPos).addScaledVector(L.moonDirThree, SUN_DISTANCE_M);
    this.moonLight.target.position.copy(this.aircraftPos);

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

    // ── environment map ──
    this.sinceBakeS += dt;
    if (this.opts.environmentMap) this.maybeBakeEnvironment(turbidity, mie, cloudCover, time.timeScale);
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
    let rt: THREE.WebGLRenderTarget | null = null;
    try {
      rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    } catch (e) {
      console.warn('[sky] environment bake failed', e);
    }
    u.showSunDisc.value = disc;
    if (!rt) return;
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = rt;
    this.scene.environment = rt.texture;
  }

  dispose(): void {
    if (this.envTarget && this.scene.environment === this.envTarget.texture) this.scene.environment = null;
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sky.removeFromParent();
    this.envSky.removeFromParent();
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
