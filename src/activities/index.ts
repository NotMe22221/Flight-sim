/**
 * Public API of src/activities: landing challenges and scoring, the objective engine, Flight
 * Training lessons, bush trips, the ActivityRunner and the progress store. Pure TypeScript (no DOM,
 * no Three.js). `activityTestKit.ts` is test-only and deliberately not exported.
 */
export { LANDING_CHALLENGES, type LandingChallenge } from './landingChallenges';
export { scoreLanding, type LandingScore, type RolloutRecord, type RunwayInfo, type TouchdownRecord } from './landingScore';
export { TouchdownDetector, type TouchdownDetectorOptions } from './TouchdownDetector';
export {
  aimAlongM, aimPointM, matchRunwayEnd, onRunway, relativeToRunway, runwayEnds,
  type RunwayEndRef, type RunwayRelative,
} from './runwayFrame';

export {
  ConditionSet, Objective, angleDiffDeg, compileCondition, compileObjective, flatDistanceM, makeObjectiveContext, runwayEndRef, scoreLoss,
  type Condition, type ConditionSpec, type LandingResult, type Line, type ObjectiveContext, type ObjectiveSpec, type ObjectiveState,
  type ObjectiveView, type ProgressSpec, type RunwaySpec,
} from './objectives';
export {
  gradeFor,
  type ActivityDef, type ActivityHost, type ActivityResult, type ActivitySetup, type AirSpawnOptions, type Cue, type ObjectiveResult,
  type RunwaySpawnOptions, type StepDef, type StepResult, type TimePreset,
} from './activityTypes';
export { BASIC_FLIGHT, KHAF_30, KHAF_30_TDZ, KHAF_POS, KSFO_28R, LANDING, LESSONS, TAKEOFF, lessonById } from './lessons';
export {
  BUSH_TRIPS, PACIFIC_COAST, WAYPOINT_RADIUS_M, bushLegActivity, legActivityId, legDistanceNm, legRoute, legRouteNm, navLog, tripById,
  type BushLeg, type BushLegOptions, type BushTrip, type NavLogEntry, type TripAirport, type TripWaypoint,
} from './bushTrips';
export { ActivityRunner, type ActivityRunnerOptions, type ProgressItem, type RunnerPhase } from './ActivityRunner';
export {
  PROGRESS_KEY, ProgressStore, defaultStorage, parseProgress,
  type KeyValueStorage, type LegRecord, type LessonRecord,
} from './progressStore';
export * as speech from './speech';
