/**
 * Shared cross-module contracts. Every module implements against these so that
 * modules can be built independently. Keep this file free of Three.js imports.
 *
 * CONVENTIONS (see docs/DESIGN.md):
 *  - SI units everywhere internally: m, kg, s, rad, N, Pa, K. Convert at the UI boundary.
 *  - Physics world frame: local NED tangent plane (N = north, E = east, D = down) at a
 *    floating origin (`LocalFrame`). Positions in float64 (plain JS numbers).
 *  - Body frame: FRD (x forward, y right, z down). Rates p, q, r about x, y, z.
 *  - Attitude quaternion `qNB` rotates NED vectors into body: v_b = q ⊗ v_n ⊗ q*. Scalar-first.
 *  - Three.js render frame: x = East, y = Up, z = South.   (x3, y3, z3) = (E, -D, -N).
 *    A quaternion q_bn = conj(qNB) with components (w, qN, qE, qD) becomes the Three.js
 *    object quaternion (x: qE, y: -qD, z: -qN, w) when the model is authored nose -Z, up +Y, right wing +X.
 *  - Aero sign conventions (JSBSim): δe > 0 trailing edge down (nose down), δa > 0 left aileron
 *    TE down (roll right), δr > 0 TE left (nose left). Flaps in degrees.
 *  - Angles in rad except where a field name ends in Deg; headings true unless named Mag.
 */

export type Vec3 = [number, number, number];
/** Scalar-first quaternion [w, x, y, z]. */
export type Quat = [number, number, number, number];

export interface Geodetic {
  /** degrees */ lat: number;
  /** degrees */ lon: number;
  /** metres above the WGS84 ellipsoid (we treat DEM heights as ellipsoidal; ~MSL for our purposes) */ alt: number;
}

/** Local tangent frame description (the floating origin). Implemented in src/geo/wgs84.ts. */
export interface LocalFrameInfo {
  lat0: number;
  lon0: number;
  alt0: number;
}

// ───────────────────────────────── Pilot inputs ─────────────────────────────────

export type FuelSelector = 'off' | 'left' | 'right' | 'both';

/** Continuous + discrete pilot inputs consumed by the flight model every physics step. */
export interface ControlInputs {
  /** -1 (nose down / stick forward) .. +1 (nose up / stick back) */
  pitch: number;
  /** -1 (roll left) .. +1 (roll right) */
  roll: number;
  /** -1 (nose left) .. +1 (nose right) */
  yaw: number;
  /** -1 .. +1, nose-down negative; applied as an elevator offset */
  pitchTrim: number;
  rudderTrim: number;
  aileronTrim: number;
  /** index into AircraftConfig.controls.flaps.detentsDeg */
  flapsIndex: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 (1 = full rich) */
  mixture: number;
  /** 0..1 (constant-speed props only; ignored for fixed pitch) */
  propeller: number;
  /** 0..1 toe brakes */
  brakeLeft: number;
  brakeRight: number;
  parkingBrake: boolean;
  /** 0 off, 1 right, 2 left, 3 both */
  magnetos: 0 | 1 | 2 | 3;
  starter: boolean;
  fuelSelector: FuelSelector;
  gearDown: boolean;
  /** 0..1 */
  speedbrake: number;
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean; panel: number };
  pitotHeat: boolean;
  carbHeat: boolean;
}

export const defaultControlInputs = (): ControlInputs => ({
  pitch: 0, roll: 0, yaw: 0,
  pitchTrim: 0, rudderTrim: 0, aileronTrim: 0,
  flapsIndex: 0, throttle: 0, mixture: 1, propeller: 1,
  brakeLeft: 0, brakeRight: 0, parkingBrake: true,
  magnetos: 3, starter: false, fuelSelector: 'both', gearDown: true, speedbrake: 0,
  lights: { nav: false, beacon: true, strobe: false, landing: false, taxi: false, panel: 0 },
  pitotHeat: false, carbHeat: false,
});

// ───────────────────────────────── Environment seen by the FDM ─────────────────────────────────

export type TurbulenceIntensity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // MIL-F-8785C POE index; 0 = none, 3 light, 4 moderate, 5 severe

export interface Environment {
  frame: LocalFrameInfo;
  /**
   * Ground height (metres, local "up" = -D coordinate) under local NED point (north, east).
   * Includes earth curvature consistently with the rendered terrain. Never returns NaN;
   * returns a fallback (spawn elevation) when data is not loaded.
   */
  groundHeight(north: number, east: number): number;
  /** Unit ground normal in NED (so a flat surface gives [0,0,-1]). */
  groundNormal(north: number, east: number, out: Vec3): Vec3;
  /** Mean wind + shear + discrete gusts at a local NED position, m/s, NED components (wind *velocity*, i.e. the direction air moves toward). */
  windNED(north: number, east: number, down: number, out: Vec3): Vec3;
  turbulence: { w20Kt: number; intensity: TurbulenceIntensity; seed: number };
  /** ISA temperature offset at the surface, K */
  deltaTisaK: number;
  /** Altimeter setting / sea-level pressure, Pa */
  qnhPa: number;
  /** Surface type under the aircraft, affects rolling friction */
  surface: 'paved' | 'grass' | 'water' | 'unknown';
}

// ───────────────────────────────── Aircraft configuration ─────────────────────────────────

export interface Table1DSpec { xs: number[]; ys: number[] }
export interface Table2DSpec { rows: number[]; cols: number[]; data: number[] }

export interface PistonEngineSpec {
  type: 'piston';
  ratedPowerW: number;
  ratedRPM: number;
  idleRPM: number;
  displacementM3: number;
  /** volumetric efficiency */ VE: number;
  /** indicated specific fuel consumption, lb/hp/hr */ ISFC: number;
  /** nominal full-throttle manifold pressure at sea level, inHg (used for calibration and gauges) */
  maxMAPinHg: number;
  minMAPinHg: number;
  /** Coulomb (rpm-independent) friction torque, N·m */ frictionA: number;
  /** viscous friction torque per rad/s, N·m·s */ frictionB: number;
  /** rotating inertia of crank + accessories, kg·m² */ inertia: number;
  mixtureEfficiency: Table1DSpec; // fuel/air ratio → efficiency
  cylinders: number;
  /** starter torque, N·m (cranking speed emerges from friction + compression) */ starterTorqueNm: number;
  /** effective throttle-body flow area with the throttle closed (idle leak), m² */ throttleAreaIdleM2: number;
  /** effective throttle-body flow area wide open, m² */ throttleAreaMaxM2: number;
  /** intake manifold volume, m³ (sets the manifold-pressure time constant) */ manifoldVolumeM3: number;
  /** rpm below which combustion cannot sustain itself */ minFiringRPM: number;
}

export interface TurbofanEngineSpec {
  type: 'turbofan';
  ratedThrustN: number;
  /** thrust-specific fuel consumption kg/(N·s) */ tsfc: number;
  idleN1: number;
  spoolTauS: number;
  /** thrust fraction vs Mach (rows) × altitude m (cols) */ milThrust: Table2DSpec;
  reverserFraction: number;
}

export interface PropellerSpec {
  diameterM: number;
  blades: number;
  inertia: number; // kg·m²
  Ct: Table1DSpec; // vs advance ratio J
  Cp: Table1DSpec;
  /** +1 clockwise seen from behind (US engines) */ sense: 1 | -1;
  /** P-factor lateral shift constant, m per rad of inflow angle */ pFactorM: number;
  /** hub position relative to the empty CG, body frame, m */ position: Vec3;
  fixedPitch: boolean;
  minPitchDeg?: number;
  maxPitchDeg?: number;
}

export interface GearSpec {
  name: string;
  /** unloaded contact point (bottom of tyre) relative to empty CG, body frame, m */
  pos: Vec3;
  type: 'wheel' | 'structure';
  /** N/m */ k: number;
  /** N·s/m compression */ cComp: number;
  /** N·s/m rebound */ cRebound: number;
  tyreRadius: number;
  muStatic: number;
  muDynamic: number;
  muRolling: number;
  pacejka: { B: number; C: number; E: number };
  maxSteerDeg: number;
  /** castering nose/tail wheel */ casters: boolean;
  brakeGroup: 'none' | 'left' | 'right' | 'both';
  retractable: boolean;
}

export interface AircraftConfig {
  id: string;
  name: string;
  manufacturer: string;
  category: 'ga-piston' | 'turboprop' | 'jet' | 'airliner';
  meta: { sources: string[]; license: string; notes?: string };
  geometry: {
    /** wing area m² */ S: number;
    /** span m */ b: number;
    /** mean aerodynamic chord m */ cbar: number;
    /** aerodynamic reference point relative to empty CG, body frame m */ arpOffset: Vec3;
    /** height of MAC above the ground when sitting on the gear, m (for h/b ground effect) */ macHeightOnGround: number;
    /** overall length / height for cameras & collisions */ lengthM: number; heightM: number;
    /** pilot eye point relative to empty CG, body frame m */ eyePoint: Vec3;
  };
  mass: {
    emptyMassKg: number;
    /** empty CG position relative to the reference datum, body frame m (x positive forward) */
    emptyCG: Vec3;
    emptyInertia: { Ixx: number; Iyy: number; Izz: number; Ixz: number };
    stations: { name: string; pos: Vec3; massKg: number; maxKg: number }[];
    tanks: { name: string; pos: Vec3; capacityKg: number; usableKg: number; contentsKg: number; selector: 'left' | 'right' | 'center' }[];
    maxTakeoffKg: number;
  };
  aero: {
    /** CL vs alpha (rad): rows = alpha, cols = [normal, post-stall branch] */
    CL: { table: Table2DSpec; hystOnRad: number; hystOffRad: number; dFlap: Table1DSpec; dElev: number; q: number; adot: number; CD90: number };
    /** CD: table rows = alpha rad, cols = flap detents deg; plus CD0 added */
    CD: { CD0: number; alphaFlapTable: Table2DSpec; dFlap: Table1DSpec; dElevAbs: number; betaAbs: number; gearDown: number; speedbrake: number };
    CY: { beta: number; p: number; r: number; da: number; dr: number };
    Cl: { beta: number; p: number; r: number; da: number; dr: number };
    Cm: { Cm0: number; alpha: number; q: number; adot: number; de: number; dFlap: Table1DSpec; highAlphaScale: Table1DSpec; deHighAlphaScale: Table1DSpec };
    Cn: { beta: number; p: number; r: number; da: number; dr: number; slipstream: number };
    groundEffect: { hOverB: number[]; kCL: number[]; kCD: number[] };
    controlsUseSlipstreamQ: { elevator: boolean; rudder: boolean };
    /** alpha (rad) beyond which the table blends into the flat-plate model */ blendStartRad: number; blendEndRad: number;
  };
  propulsion: {
    engine: PistonEngineSpec | TurbofanEngineSpec;
    propeller?: PropellerSpec;
    /** engine positions (for multi-engine jets), body frame relative to empty CG */
    enginePositions: Vec3[];
  };
  gear: GearSpec[];
  controls: {
    elevator: { minDeg: number; maxDeg: number; tauS: number; rateDegPerS: number };
    aileron: { upDeg: number; downDeg: number; tauS: number; rateDegPerS: number };
    rudder: { maxDeg: number; tauS: number; rateDegPerS: number };
    flaps: { detentsDeg: number[]; transitS: number[] };
    trim: { elevatorFraction: [number, number]; rateNormPerS: number };
    nosewheelSteerDeg: number;
  };
  limits: {
    VneKt: number; VnoKt: number; VaKt: number; VfeKt: number[]; VsoKt: number; Vs1Kt: number;
    VxKt: number; VyKt: number; VrKt: number; VgKt: number; VloKt?: number; VleKt?: number;
    nzMax: number; nzMin: number; maxRPM: number; redlineRPM: number;
  };
  /** instrument panel / avionics descriptor used by the instruments module */
  panel: 'c172-steam' | 'c172-g1000' | 'airliner-pfd';
}

// ───────────────────────────────── Flight model ─────────────────────────────────

export interface SpawnState {
  geo: Geodetic;
  /** true heading rad */ headingRad: number;
  /** true airspeed m/s; 0 for ground spawn */ speedMs: number;
  onGround: boolean;
  /** engine running at spawn */ engineRunning: boolean;
  /** flight path angle rad for airborne trim */ gammaRad?: number;
}

export interface GearState {
  compressionM: number;
  normalForceN: number;
  onGround: boolean;
  /** forward wheel speed m/s */ wheelSpeedMs: number;
  steerRad: number;
  /** 0..1 for retractable gear */ extension: number;
}

export interface EngineState {
  running: boolean;
  rpm: number;
  manifoldPressureInHg: number;
  /** kg/s */ fuelFlowKgS: number;
  /** K */ egtK: number;
  /** K */ chtK: number;
  oilTempK: number;
  oilPressurePa: number;
  powerW: number;
  thrustN: number;
  torqueNm: number;
  /** 0..1 of rated */ pctPower: number;
  /** turbofan only */ n1?: number; n2?: number;
}

export interface SurfaceState {
  elevatorRad: number;
  aileronLeftRad: number;
  aileronRightRad: number;
  rudderRad: number;
  flapDeg: number;
  /** elevator trim contribution rad */ trimRad: number;
  speedbrake: number;
}

export interface AeroState {
  alpha: number;
  beta: number;
  alphaDot: number;
  /** true airspeed m/s */ tas: number;
  cas: number;
  ias: number;
  eas: number;
  mach: number;
  qbar: number;
  coefficients: { CL: number; CD: number; CY: number; Cl: number; Cm: number; Cn: number };
  stallWarning: boolean;
  stalled: boolean;
}

export interface AtmosphereSample {
  temperatureK: number;
  pressurePa: number;
  densityKgM3: number;
  speedOfSound: number;
}

/** Complete snapshot of the aircraft, produced by the flight model every step. */
export interface AircraftState {
  /** sim time s */ t: number;
  /** position in the local NED frame, m */ posNED: Vec3;
  geo: Geodetic;
  /** body-axis velocity u,v,w m/s (inertial, not air-relative) */ velBody: Vec3;
  velNED: Vec3;
  /** qNB: NED → body, scalar first */ qNB: Quat;
  /** [roll, pitch, yaw(true)] rad */ euler: Vec3;
  /** p, q, r rad/s */ rates: Vec3;
  /** body accelerations incl. gravity reaction, in g: nx, ny, nz (nz +1 in level flight) */ loadFactor: Vec3;
  headingTrueRad: number;
  headingMagRad: number;
  /** ground track true rad */ trackRad: number;
  groundSpeedMs: number;
  /** +up m/s (geometric) */ verticalSpeedMs: number;
  altitudeMslM: number;
  altitudeAglM: number;
  /** barometric altitude from QNH set in `qnhSetPa` */ altitudeIndicatedM: number;
  qnhSetPa: number;
  onGround: boolean;
  crashed: boolean;
  aero: AeroState;
  atmosphere: AtmosphereSample;
  engine: EngineState;
  surfaces: SurfaceState;
  gear: GearState[];
  fuelKg: number[];
  totalMassKg: number;
  cgM: Vec3;
  /** wind velocity NED at the aircraft, m/s, incl. turbulence */ windNED: Vec3;
  warnings: { stall: boolean; overspeed: boolean; overG: boolean; gearOverspeed: boolean; flapOverspeed: boolean; lowFuel: boolean };
}

export interface FlightModel {
  readonly config: AircraftConfig;
  /** latest full state; updated in place every step */
  readonly state: AircraftState;
  reset(spawn: SpawnState, env: Environment): void;
  /** Advance one fixed time step (RK4 internally). */
  step(dt: number, inputs: ControlInputs, env: Environment): void;
  /**
   * Solve for a trimmed state at the current position: given CAS and flight-path angle,
   * sets attitude, velocity, elevator trim and throttle. Returns false if no trim found.
   */
  trim(targetCasMs: number, gammaRad: number, env: Environment): boolean;
  /** Re-express the state in a new floating origin: pos' = R(pos - t) handled by caller passing full transform. */
  rebase(rotationQuat: Quat, translationNED: Vec3): void;
  /** Deterministic serialization for save/replay. */
  serialize(): string;
  deserialize(json: string): void;
}

// ───────────────────────────────── Weather / sky ─────────────────────────────────

export type WeatherPresetId = 'clear' | 'few' | 'scattered' | 'broken' | 'high-level' | 'overcast' | 'rain' | 'snow' | 'storm';

export interface CloudLayer {
  /** base altitude MSL m */ baseM: number;
  /** top altitude MSL m */ topM: number;
  /** 0..1 */ coverage: number;
  /** 0..1 */ density: number;
  type: 'cumulus' | 'stratus' | 'cirrus';
}

export interface WindLayer {
  /** altitude MSL m */ altM: number;
  /** direction the wind blows FROM, true deg */ directionDeg: number;
  speedKt: number;
  gustKt: number;
}

export interface WeatherState {
  preset: WeatherPresetId | 'custom' | 'live';
  clouds: CloudLayer[];
  winds: WindLayer[];
  /** mm/h */ precipitationRate: number;
  precipitationType: 'none' | 'rain' | 'snow';
  thunderstorm: boolean;
  /** 0..1 */ humidity: number;
  qnhPa: number;
  /** surface temperature at sea level reference, °C */ temperatureC: number;
  /** aerosol / haze 0..1 (affects visibility) */ aerosol: number;
  /** metres */ visibilityM: number;
  turbulence: TurbulenceIntensity;
  /** fog layer top AGL m (0 = none) */ fogTopM: number;
}

export interface TimeState {
  /** UTC epoch ms of the simulated world clock */ utcMs: number;
  /** 1 = real time; 0 = paused */ timeScale: number;
  /** elapsed sim seconds since start */ simTimeS: number;
}

export interface SunState {
  /** elevation above the horizon rad (negative at night) */ elevationRad: number;
  /** azimuth true rad, clockwise from north */ azimuthRad: number;
  /** unit vector toward the sun in Three.js frame (x E, y U, z S) */ dirThree: Vec3;
  moonElevationRad: number;
  moonAzimuthRad: number;
  moonPhase: number;
}

// ───────────────────────────────── Navigation ─────────────────────────────────

export interface Runway {
  /** e.g. "28R" */ ident: string;
  /** threshold (landing end) geodetic */ threshold: Geodetic;
  /** opposite end */ end: Geodetic;
  /** true heading deg */ headingDeg: number;
  lengthM: number;
  widthM: number;
  surface: 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'water' | 'other';
  lighted: boolean;
  displacedThresholdM: number;
  /** ILS if present */ ils?: { frequencyMHz: number; ident: string; glideslopeDeg: number; locCourseDeg: number };
}

export interface Airport {
  icao: string;
  iata?: string;
  name: string;
  position: Geodetic;
  /** field elevation m */ elevationM: number;
  type: 'large' | 'medium' | 'small' | 'heliport' | 'seaplane';
  municipality?: string;
  country: string;
  runways: Runway[];
  /** tower / ground / atis frequencies MHz if known */
  frequencies?: { type: string; mhz: number }[];
}

export interface Navaid {
  id: string;
  type: 'VOR' | 'VOR-DME' | 'VORTAC' | 'DME' | 'NDB' | 'TACAN';
  name: string;
  position: Geodetic;
  frequencyKHz: number;
  /** declination of the VOR rose, deg East positive */ magneticVariationDeg: number;
  rangeNm: number;
}

export interface NavDatabase {
  loadRegion(center: Geodetic, radiusNm: number): Promise<void>;
  getAirport(icao: string): Airport | undefined;
  nearestAirports(pos: Geodetic, maxCount: number, maxNm: number): Airport[];
  nearestNavaids(pos: Geodetic, maxCount: number, maxNm: number): Navaid[];
  searchAirports(query: string, limit: number): Airport[];
  findNavaidByFrequency(khz: number, pos: Geodetic): Navaid | undefined;
  findIlsByFrequency(khz: number, pos: Geodetic): { airport: Airport; runway: Runway } | undefined;
}

export interface NavRadioState {
  /** active frequency kHz */ activeKHz: number;
  standbyKHz: number;
  /** selected course / OBS deg magnetic */ obsDeg: number;
  /** tuned station id or '' */ ident: string;
  /** signal received */ valid: boolean;
  /** lateral deviation -1..1 (full scale), + = fly right */ cdi: number;
  toFrom: 'to' | 'from' | 'off';
  /** vertical deviation -1..1 (+ = fly up), only for ILS */ gsDeviation: number;
  gsValid: boolean;
  isLocalizer: boolean;
  /** DME distance nm */ dmeNm: number;
  /** bearing to station magnetic deg */ bearingDeg: number;
  /** radial from station magnetic deg */ radialDeg: number;
}

export interface Waypoint {
  id: string;
  position: Geodetic;
  type: 'airport' | 'navaid' | 'fix' | 'user';
  altConstraintM?: number;
}

export interface FlightPlan {
  waypoints: Waypoint[];
  activeLeg: number;
  /** desired track for active leg deg true */ desiredTrackDeg: number;
  /** cross-track error m (+ right of course) */ crossTrackM: number;
  /** distance to active waypoint m */ distanceToActiveM: number;
  bearingToActiveDeg: number;
  eteS: number;
}

// ───────────────────────────────── Autopilot ─────────────────────────────────

export type LateralMode = 'OFF' | 'ROL' | 'HDG' | 'NAV' | 'APR' | 'LOC' | 'GPS';
export type VerticalMode = 'OFF' | 'PIT' | 'ALT' | 'VS' | 'FLC' | 'GS' | 'ALTS';

export interface AutopilotState {
  engaged: boolean;
  flightDirector: boolean;
  lateral: LateralMode;
  vertical: VerticalMode;
  armedLateral: LateralMode | null;
  armedVertical: VerticalMode | null;
  /** targets */
  headingBugDeg: number;
  altitudeTargetM: number;
  verticalSpeedTargetMs: number;
  iasTargetMs: number;
  pitchTargetRad: number;
  rollTargetRad: number;
  /** flight-director command bars rad */
  fdPitchRad: number;
  fdRollRad: number;
  /** servo outputs -1..1 to blend into ControlInputs when engaged */
  outPitch: number;
  outRoll: number;
  outYaw: number;
  /** autothrottle if present */ outThrottle?: number;
  yawDamper: boolean;
  /** pitch trim command the servo is applying */ trimCommand: number;
}

export interface Autopilot {
  readonly state: AutopilotState;
  update(dt: number, ac: AircraftState, nav: { nav1: NavRadioState; nav2: NavRadioState; plan: FlightPlan | null }): void;
  /** merge servo commands into the pilot's inputs (pilot overrides disconnect) */
  apply(inputs: ControlInputs): ControlInputs;
  engage(on: boolean): void;
  setLateral(mode: LateralMode): void;
  setVertical(mode: VerticalMode): void;
  setHeadingBug(deg: number): void;
  setAltitudeTarget(m: number): void;
  setVerticalSpeedTarget(ms: number): void;
  setIasTarget(ms: number): void;
}

// ───────────────────────────────── Camera ─────────────────────────────────

export type CameraMode = 'cockpit' | 'chase' | 'external-orbit' | 'drone' | 'tower' | 'flyby' | 'wing';

export interface CameraState {
  mode: CameraMode;
  /** free-look offsets in cockpit rad */ lookYaw: number;
  lookPitch: number;
  /** external orbit */ orbitYaw: number;
  orbitPitch: number;
  orbitDistanceM: number;
  fovDeg: number;
  /** drone position in local NED when mode = drone */ dronePosNED: Vec3;
  droneYaw: number;
  dronePitch: number;
}

// ───────────────────────────────── Discrete actions (input → sim) ─────────────────────────────────

export type SimAction =
  | 'pause' | 'toggleMenu' | 'toggleMap' | 'toggleHud' | 'toggleCheckList' | 'toggleAtc' | 'toggleWeatherPanel' | 'toggleHelp'
  | 'cameraCockpit' | 'cameraChase' | 'cameraExternal' | 'cameraDrone' | 'cameraTower' | 'cameraNext' | 'cameraReset'
  | 'zoomIn' | 'zoomOut'
  | 'flapsUp' | 'flapsDown' | 'flapsFull' | 'flapsRetract'
  | 'gearToggle' | 'gearUp' | 'gearDown'
  | 'parkingBrakeToggle' | 'brakesHold'
  | 'throttleCut' | 'throttleFull' | 'throttleInc' | 'throttleDec' | 'throttleIncSmall' | 'throttleDecSmall'
  | 'mixtureRich' | 'mixtureLean' | 'mixtureInc' | 'mixtureDec'
  | 'trimNoseUp' | 'trimNoseDown' | 'rudderTrimLeft' | 'rudderTrimRight' | 'aileronTrimLeft' | 'aileronTrimRight'
  | 'engineAutoStart' | 'engineShutdown' | 'starter' | 'magnetosNext' | 'magnetosPrev'
  | 'lightsNav' | 'lightsBeacon' | 'lightsStrobe' | 'lightsLanding' | 'lightsTaxi' | 'lightsPanel' | 'lightsAll'
  | 'pitotHeat' | 'carbHeat'
  | 'apToggle' | 'apHdg' | 'apNav' | 'apApr' | 'apAlt' | 'apVs' | 'apFlc' | 'apLvl' | 'fdToggle' | 'yawDamper'
  | 'apHdgInc' | 'apHdgDec' | 'apAltInc' | 'apAltDec' | 'apVsInc' | 'apVsDec' | 'apIasInc' | 'apIasDec' | 'apHdgSync' | 'apAltSync'
  | 'nav1Swap' | 'nav1Inc' | 'nav1Dec' | 'obs1Inc' | 'obs1Dec' | 'nav2Swap' | 'com1Swap'
  | 'altimeterInc' | 'altimeterDec' | 'altimeterStd' | 'headingBugInc' | 'headingBugDec'
  | 'timeFaster' | 'timeSlower' | 'timeNormal' | 'timeDawn' | 'timeNoon' | 'timeDusk' | 'timeNight'
  | 'slewToggle' | 'resetFlight' | 'activeRunwayRespawn' | 'screenshot' | 'repairRefuel'
  | 'assistAutoRudderToggle' | 'assistTakeoffToggle' | 'assistLandingToggle'
  | 'atcOption1' | 'atcOption2' | 'atcOption3' | 'atcOption4' | 'atcOption5' | 'atcOption6' | 'atcOption7' | 'atcOption8' | 'atcOption9' | 'atcOption0';

/** Continuous axes an input device can drive (-1..1 or 0..1). */
export type SimAxis = 'pitch' | 'roll' | 'yaw' | 'throttle' | 'mixture' | 'propeller' | 'brakeLeft' | 'brakeRight' | 'lookYaw' | 'lookPitch' | 'cameraZoom';

export interface InputSnapshot {
  axes: Record<SimAxis, number>;
  /** actions fired since the previous poll (edge-triggered) */
  actions: SimAction[];
  /** actions whose key/button is currently held (level-triggered, e.g. brakes, rudder keys) */
  held: Set<SimAction>;
  /** pointer delta for free-look this frame, px */
  pointerDx: number;
  pointerDy: number;
  /** mouse yoke mode */
  mouseYoke: boolean;
}

// ───────────────────────────────── Audio ─────────────────────────────────

export interface AudioMixer {
  /** must be called from a user gesture */ resume(): Promise<void>;
  update(dt: number, ac: AircraftState, camera: CameraState, weather: WeatherState): void;
  setMasterVolume(v: number): void;
  setVolume(bus: 'engine' | 'environment' | 'cockpit' | 'ui' | 'atc', v: number): void;
  playUi(sound: 'click' | 'switch' | 'warn' | 'confirm' | 'error'): void;
  speak(text: string, voice?: 'atc' | 'pilot' | 'copilot'): void;
  stopSpeaking(): void;
  readonly ready: boolean;
}

// ───────────────────────────────── Full snapshot the renderer/UI reads ─────────────────────────────────

export type AssistLevel = 'all' | 'middle' | 'true-to-life';

export interface AssistanceOptions {
  autoRudder: boolean;
  assistedTakeoff: boolean;
  assistedLanding: boolean;
  autoMixture: boolean;
  unlimitedFuel: boolean;
  crashDamage: boolean;
  stressDamage: boolean;
  gyroDrift: boolean;
  landingPathHints: boolean;
  taxiRibbon: boolean;
  routeRibbon: boolean;
}

export interface SimSnapshot {
  time: TimeState;
  aircraft: AircraftState;
  inputs: ControlInputs;
  weather: WeatherState;
  sun: SunState;
  camera: CameraState;
  autopilot: AutopilotState;
  nav1: NavRadioState;
  nav2: NavRadioState;
  plan: FlightPlan | null;
  frame: LocalFrameInfo;
  paused: boolean;
  slew: boolean;
  assists: AssistanceOptions;
  /** terrain loading progress 0..1 */ terrainReady: number;
  fps: number;
}

// ───────────────────────────────── Events ─────────────────────────────────

export interface SimEvents {
  'aircraft:touchdown': { verticalSpeedMs: number; gForce: number; lateralDriftMs: number; centerlineOffsetM: number | null; runway: string | null };
  'aircraft:liftoff': { iasMs: number };
  'aircraft:crash': { reason: string };
  'aircraft:stallWarning': { on: boolean };
  'aircraft:gear': { down: boolean };
  'aircraft:flaps': { index: number };
  'engine:started': Record<string, never>;
  'engine:stopped': { reason: string };
  'camera:changed': { mode: CameraMode };
  'weather:changed': { state: WeatherState };
  'time:changed': { state: TimeState };
  'flight:reset': { spawn: SpawnState };
  'atc:message': { from: 'atc' | 'pilot'; text: string; frequencyMHz?: number };
  'atc:options': { options: string[] };
  'ui:toast': { text: string; kind?: 'info' | 'warn' | 'error' | 'success'; durationMs?: number };
  'terrain:progress': { ready: number };
  'frame:rebased': { frame: LocalFrameInfo };
  'autopilot:changed': { state: AutopilotState };
  'landing:scored': { score: number; details: Record<string, number | string> };
}

export type SimEventName = keyof SimEvents;
