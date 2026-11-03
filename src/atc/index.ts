/**
 * Scripted, menu-driven ATC: FAA phraseology, ATIS from the sim weather, runway-relative
 * pattern geometry and the `AtcController` state machine. Pure logic (no DOM, no Three.js).
 */
export { AtcController, DEFAULT_ATC_TUNING } from './AtcController';
export type { AtcControllerOptions, AtcPhase, AtcTuning, DepartureIntent, LandingClearance, LandingIntent } from './types';
export type { RadioMessage, RadioVoice } from './radio';
export * from './phraseology';
export { makeCallsign, type Callsign } from './callsign';
export { say, joinSpoken, sentence } from './compose';
export { buildAtis, atisName, metarLine, runwayList, skyCondition, visibility, weatherWords, type AtisInput, type AtisReport } from './atis';
export { AtisLetterTracker, atisContentKey } from './atisTracker';
export {
  observeSurface, ceilingLayer, cloudCover, dewpointC, flightCategory, relativeHumidity, reportableVisibilitySM, roundCloudBaseFt,
  type SkyLayer, type SurfaceObservation, type CloudCover,
} from './surfaceObs';
export {
  fieldInfo, facilityShortName, runwaysInUse, allRunwayRefs, patternSideFor, designatorNumber, designatorSide, MULTICOM_MHZ,
  type Facility, type FacilityKind, type FieldInfo, type RunwayRef, type RunwaysInUse,
} from './field';
export {
  classifyPatternLeg, isEstablishedOnFinal, choosePatternEntry, makeRunwayFrame, relativeTo, isOnRunway, isAtHoldShort, rangeBearing,
  PATTERN_LIMITS, FINAL_LIMITS, type PatternLeg, type PatternEntry, type TrafficSide, type RunwayFrame, type RunwayRelativeState,
} from './geometry';
