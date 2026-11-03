/**
 * Sky, atmosphere and weather module (Tier A).
 *
 * Three.js renderables: `SkySystem` (sky dome, sun/moon/stars, lights, fog, env map, clouds, precipitation).
 * Pure (Node-testable): `WeatherSystem`, presets, METAR, Open-Meteo, wind/gusts, Preetham CPU port,
 * lighting curves, cloud density maths.
 */
export { SkySystem, patchSkyDepth, patchSkyDome, type SkySystemOptions, type SkySnapshot } from './SkySystem';
export { type SkyLighting, createSkyLighting, HEIGHT_FOG_GLSL, HAZE_LOBE_GLSL } from './types';
export { SKY_UNIFORMS, SKY_UNIFORMS_GLSL, MAX_SHADOW_LAYERS, createSkySharedUniforms, cloudShadowAt, type SkySharedUniforms } from './skyUniforms';
export { installBuiltinHeightFog, setBuiltinHeightFog, builtinHeightFogInstalled } from './builtinFog';
export { applyIblScale, iblScaleOf, patchIblScaleSource, IBL_SCALE_ANCHOR, IBL_SCALE_GLSL, type IblScaleState } from './iblScale';
export { CloudLayers, type CloudLayersOptions } from './clouds';
export { Precipitation, type PrecipitationOptions } from './precipitation';
export { StarField, generateStarCatalog, equatorialToLocalMatrix, equatorialDir, gmstDeg, blackbodyRGB, type StarCatalog } from './stars';
export { MoonDisc } from './moon';
export { WeatherSystem, assignWeather, type WeatherSystemOptions, type AircraftAirState } from './WeatherSystem';
export { WEATHER_PRESETS, WEATHER_PRESET_IDS, COVERAGE, weatherFromPreset, cloneWeather, defaultWeather, presetName, type WeatherPresetDefinition } from './presets';
export { parseMetar, weatherFromMetar, relativeHumidity, type MetarReport, type MetarCloudGroup } from './metar';
export { fetchOpenMeteo, fetchMetarText, openMeteoToWeatherState, openMeteoUrl, nearestHourIndex, OPEN_METEO_ATTRIBUTION, type FetchOptions, type OpenMeteoResponse } from './liveWeather';
export { windAt, windVectorNED, logProfileFactor, gustExcessAt, gustEnvelope, GustModel, type GustModelOptions, DEFAULT_GUST_OPTIONS, Z0_DEFAULT, LOG_PROFILE_MAX } from './wind';
export { PreethamSky, DEFAULT_PREETHAM, type PreethamParams, SKY_RADIANCE_SCALE, INSCATTER_KNEE, NIGHT_GLOW_GLSL, NIGHT_GLOW_SCALE_HEIGHT } from './preetham';
export {
  targetExposure, adaptExposure, sunLightIntensity, hemisphereIntensity, moonLightIntensity, ambientFloor, starVisibility,
  turbidityFromVisibility, mieFromVisibility, fogBetaFromVisibility, fogExp2DensityFromVisibility, hazeScaleHeight,
  heightFogOpticalDepth, MIN_FOG_INV_H,
  hazeColor, capBySky, hazeSunLobe, hgPhase, rayleighPhase, mieFraction, HAZE_G, DEFAULT_HAZE, type HazeOptions,
  exposureForIlluminance, surfaceIlluminance, skylightBalance, DAY_ILLUMINANCE, NIGHT_AMBIENT_COLOR,
  acesFilmic, linearToSrgb, encodeDisplayColor, cloudCoverFraction, colorTemperatureK, luminance, normalizeColor,
  DEFAULT_EXPOSURE, type ExposureOptions,
} from './lighting';
export { cloudDensityAt, cloudLayerDensityAt, cloudTypeParams, coverageMask, verticalProfile, fbm2, valueNoise2, hash2, CLOUD_NOISE_GLSL, type CloudTypeParams } from './cloudMath';
