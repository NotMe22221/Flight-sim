/**
 * Autopilot module barrel: the GFC-700-style autopilot / flight director, the MSFS-style piloting
 * assists and their tuning tables. Pure TypeScript (no Three.js, no DOM). The closed-loop test
 * plants (`testPlant.ts`, `testSim.ts`, `testGroundRoll.ts`) are test-only and not exported.
 * See README.md in this directory for the frame call order and the gain table.
 */
export {
  GfcAutopilot,
  type GfcAutopilotState,
  type GfcAutopilotOptions,
  type DisconnectReason,
  type ApButton,
  type NavSource,
  type AltAlert,
  type NavInputs,
} from './Autopilot';
export {
  FlightAssists,
  defaultAssistsConfig,
  stallAlphaFromConfig,
  assistsConfigFor,
  isTailDragger,
  type AssistsConfig,
  type AssistFlags,
  type AutoRudderConfig,
  type TakeoffAssistConfig,
  type AntiStallConfig,
} from './assists';
export {
  defaultAutopilotConfig,
  mergeConfig,
  type AutopilotConfig,
  type AutopilotLimits,
  type AutopilotGains,
  type AutopilotProtections,
  type AutopilotBehaviour,
  type DeepPartial,
} from './config';
export { Pid, type PidConfig } from './pid';
export { LowPass, Washout, Differentiator, RateLimiter, slew } from './filters';
export { bankForTurnRate, effectiveBankLimit, headingToBank, gpsInterceptTrack, vorInterceptTrack, locInterceptTrack, cdiToDots } from './lateral';
export { altitudeToVs, altCaptureDistance, glideslopeVs, levelFlightPitch } from './vertical';
export { loadFactorPitchRate, alphaLimitedPitch, wingsFirst } from './level';
