/**
 * Procedural Web Audio for the simulator (docs/research/06 PART A). See README.md.
 * Entry point: `AudioSystem` (implements `AudioMixer` from core/types).
 */
export { AudioSystem, type AudioSystemOptions } from './AudioSystem';
export {
  AudioGraph, type AudioBuses, type AudioContextFactory, BUS_NAMES, type BusName, DEFAULT_BUS_VOLUMES, DEFAULT_MASTER_VOLUME,
  defaultContextFactory, type GraphState, type NoiseBank, NOISE_LOOP_S,
} from './graph';
export { dbToGain, gainToDb, setAt, smoothTo, SmoothParam, TAU, TAU_FAST, TAU_SLOW, xfadeIn, xfadeOut } from './params';
export { type AudioProfile, audioProfileFromConfig, C172_AUDIO_PROFILE } from './profile';
export { EngineSynth, type EngineSynthInput, EXHAUST_RESONANCES } from './EngineSynth';
export { ENGINE_FSM, EngineStartFsm, type EnginePhase } from './EngineStartFsm';
export { PROP_VIEW_GAIN, PropellerLayer } from './PropellerLayer';
export { EnvironmentSynth } from './Environment';
export type { SurfaceKind } from './environmentLaws';
export { MARKER_TONES, type MarkerBeacon, STALL_HORN, stallHornIntensity, Warnings } from './Warnings';
export { type UiSound } from './uiSounds';
export { ROLE_PRESETS, type RolePreset, Speech, type SpeechOptions, type SpeechRole, type SpeechSynthesisLike } from './Speech';
export { chunkText, MAX_CHUNK_CHARS } from './speechText';
export { VIEW, ViewStage } from './ViewStage';
export {
  airAbsorptionCutoffHz, bladePassHz, crankFrequencyHz, cycleFrequencyHz, dopplerRatio, engineLoudness, firingFrequencyHz,
  harmonicAmp, helicalTipMach, inverseDistanceGain, mapLoad, propToneLevel, propVortexHz, tipSpeedMs,
} from './engineMath';
