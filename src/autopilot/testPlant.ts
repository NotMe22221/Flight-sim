/**
 * Tiny linearised C172 point-mass + attitude plant for closed-loop autopilot tests in Node.
 * It is NOT the flight model: it has first-order roll/pitch-rate responses to the controls,
 * a lift/drag point-mass path (so VS, speed, load factor and stall are consistent), a
 * coordinated-turn heading rate g·tan(φ)/V, a lagged sideslip response to rudder/aileron and
 * ISA atmosphere. It fills a complete `AircraftState` in place every step (no allocation).
 *
 * Attitude model (authorities quoted at 100 kt and proportional to airspeed, like Clδa·2V/b):
 *   ṗ = (p_cmd − p)/τ_roll,  p_cmd = rollAuthority · δa                (τ 0.1 s, 90°/s)
 *   q̇ = (q_cmd − q)/τ_pitch, q_cmd = pitchAuthority · δe − Kα · (α − α_trim)   (τ 0.5 s, 15°/s)
 *   δe = stick + trimFraction · trim ; α_trim is the angle of attack that trims level flight at
 *   the trim speed, so the plant is hands-off stable (speed stability emerges from the lift balance).
 * Path model: α = θ − γ, L = q̄·S·CL(α) (linear up to CLmax, then a post-stall drop),
 *   γ̇ = (L·cosφ − W·cosγ)/(m·V), ψ̇ = L·sinφ/(m·V·cosγ), V̇ = (T − D)/m − g·sinγ.
 * Sideslip: β → β_bias − kr·δr + ka·δa with a 0.7 s lag (adverse yaw from aileron).
 */
import type { AircraftState, ControlInputs, FlightPlan, NavRadioState, Vec3 } from '../core/types';
import { clamp, qConj, qFromEuler, wrapPi, wrapTwoPi } from '../core/math';
import { DEG, G0, KT, NM } from '../core/units';

export interface TestPlantConfig {
  massKg: number;
  wingAreaM2: number;
  CL0: number;
  CLalpha: number;
  CLmax: number;
  CD0: number;
  kInduced: number;
  /** stall warning margin below the stall angle of attack, rad */
  stallWarnMarginRad: number;
  /** engine power at full throttle, W; propeller efficiency; static thrust cap, N */
  maxPowerW: number;
  propEfficiency: number;
  staticThrustN: number;
  /** speed at which the quoted control authorities apply; they scale with V / authorityRefSpeedMs (clamped 0.3..2) */
  authorityRefSpeedMs: number;
  /** roll-rate response: authority at full aileron (rad/s) and time constant (s) */
  rollAuthorityRadS: number;
  rollTauS: number;
  /** pitch-rate response: authority at full elevator (rad/s) and time constant (s) */
  pitchAuthorityRadS: number;
  pitchTauS: number;
  /** angle-of-attack stiffness, 1/s (0 → pure rate-command plant) */
  alphaStiffnessPerS: number;
  /** elevator-equivalent of full trim travel */
  trimElevatorFraction: number;
  /** sideslip response to rudder and aileron (rad per unit input) and lag */
  betaPerRudderRad: number;
  betaPerAileronRad: number;
  betaTauS: number;
  /** steady sideslip with neutral controls (e.g. P-factor slip in a full-power climb), rad */
  betaBiasRad: number;
  /** never-exceed speed for the overspeed warning, m/s */
  vneMs: number;
  /** ground elevation under the aircraft, m */
  groundElevationM: number;
  /** steady wind velocity NED, m/s (direction the air moves toward) */
  windNED: Vec3;
}

export const defaultTestPlantConfig = (): TestPlantConfig => ({
  massKg: 1111,
  wingAreaM2: 16.165,
  CL0: 0.25,
  CLalpha: 4.6,
  CLmax: 1.5,
  CD0: 0.032,
  kInduced: 0.08,
  stallWarnMarginRad: 3 * DEG,
  maxPowerW: 134000,
  propEfficiency: 0.75,
  staticThrustN: 2600,
  authorityRefSpeedMs: 100 * KT,
  rollAuthorityRadS: 90 * DEG,
  rollTauS: 0.1,
  pitchAuthorityRadS: 15 * DEG,
  pitchTauS: 0.5,
  alphaStiffnessPerS: 1.0,
  trimElevatorFraction: 0.4,
  betaPerRudderRad: 0.17,
  betaPerAileronRad: 0.07,
  betaTauS: 0.7,
  betaBiasRad: 0,
  vneMs: 163 * KT,
  groundElevationM: 0,
  windNED: [0, 0, 0],
});

export interface TestPlantInit {
  /** true airspeed m/s */ speedMs: number;
  altitudeM: number;
  /** true heading rad */ headingRad: number;
  northM?: number;
  eastM?: number;
  /** initial bank rad (default 0) */ rollRad?: number;
  /** initial flight-path angle rad (default 0 → level, pitch = alpha) */ gammaRad?: number;
}

/** ISA atmosphere (troposphere). */
export const isa = (altM: number): { T: number; p: number; rho: number; a: number } => {
  const T = 288.15 - 0.0065 * Math.max(altM, 0);
  const p = 101325 * Math.pow(T / 288.15, 5.2559);
  const rho = p / (287.05 * T);
  return { T, p, rho, a: Math.sqrt(1.4 * 287.05 * T) };
};

/** A fully populated AircraftState with neutral values (level flight, engine running). */
export const makeAircraftState = (): AircraftState => ({
  t: 0,
  posNED: [0, 0, 0],
  geo: { lat: 0, lon: 0, alt: 0 },
  velBody: [0, 0, 0],
  velNED: [0, 0, 0],
  qNB: [1, 0, 0, 0],
  euler: [0, 0, 0],
  rates: [0, 0, 0],
  loadFactor: [0, 0, 1],
  headingTrueRad: 0,
  headingMagRad: 0,
  trackRad: 0,
  groundSpeedMs: 0,
  verticalSpeedMs: 0,
  altitudeMslM: 0,
  altitudeAglM: 0,
  altitudeIndicatedM: 0,
  qnhSetPa: 101325,
  onGround: false,
  crashed: false,
  aero: {
    alpha: 0, beta: 0, alphaDot: 0, tas: 0, cas: 0, ias: 0, eas: 0, mach: 0, qbar: 0,
    coefficients: { CL: 0, CD: 0, CY: 0, Cl: 0, Cm: 0, Cn: 0 },
    stallWarning: false, stalled: false,
  },
  atmosphere: { temperatureK: 288.15, pressurePa: 101325, densityKgM3: 1.225, speedOfSound: 340.3 },
  engine: {
    running: true, rpm: 2400, manifoldPressureInHg: 24, fuelFlowKgS: 0.0025, egtK: 1000, chtK: 450,
    oilTempK: 360, oilPressurePa: 400000, powerW: 100000, thrustN: 1500, torqueNm: 400, pctPower: 0.75,
  },
  surfaces: { elevatorRad: 0, aileronLeftRad: 0, aileronRightRad: 0, rudderRad: 0, flapDeg: 0, trimRad: 0, speedbrake: 0 },
  gear: [],
  fuelKg: [60, 60],
  totalMassKg: 1111,
  cgM: [0, 0, 0],
  windNED: [0, 0, 0],
  warnings: { stall: false, overspeed: false, overG: false, gearOverspeed: false, flapOverspeed: false, lowFuel: false },
});

export const makeNavRadioState = (): NavRadioState => ({
  activeKHz: 110300, standbyKHz: 113900, obsDeg: 0, ident: '', valid: false, cdi: 0, toFrom: 'off',
  gsDeviation: 0, gsValid: false, isLocalizer: false, dmeNm: 0, bearingDeg: 0, radialDeg: 0,
});

export const makeFlightPlan = (): FlightPlan => ({
  waypoints: [], activeLeg: 0, desiredTrackDeg: 0, crossTrackM: 0, distanceToActiveM: 0, bearingToActiveDeg: 0, eteS: 0,
});

export class TestPlant {
  readonly cfg: TestPlantConfig;
  readonly state: AircraftState = makeAircraftState();
  /** true airspeed m/s */ V = 0;
  /** flight-path angle rad */ gamma = 0;
  /** attitude */ roll = 0; pitch = 0; heading = 0;
  /** Euler roll / pitch rates rad/s */ p = 0; q = 0;
  beta = 0;
  /** angle of attack that gives zero pitching moment with zero elevator */
  alphaTrim = 0;
  private north = 0; private east = 0; private alt = 0;
  private prevAlpha = 0;
  private readonly qTmp = qFromEuler(0, 0, 0);

  constructor(init: TestPlantInit, cfg: Partial<TestPlantConfig> = {}) {
    this.cfg = { ...defaultTestPlantConfig(), ...cfg };
    this.reset(init);
  }

  /** Angle of attack for level 1-g flight at speed V and the current altitude. */
  alphaForLevelFlight(speedMs: number): number {
    const { rho } = isa(this.alt);
    const qbar = 0.5 * rho * speedMs * speedMs;
    const CL = (this.cfg.massKg * G0) / (qbar * this.cfg.wingAreaM2);
    return (CL - this.cfg.CL0) / this.cfg.CLalpha;
  }

  /** Throttle setting that balances drag in level flight at the current speed. */
  levelThrottle(): number {
    const { rho } = isa(this.alt);
    const qbar = 0.5 * rho * this.V * this.V;
    const CL = (this.cfg.massKg * G0) / (qbar * this.cfg.wingAreaM2);
    const D = qbar * this.cfg.wingAreaM2 * (this.cfg.CD0 + this.cfg.kInduced * CL * CL);
    return clamp(this.thrustToThrottle(D), 0, 1);
  }

  /** Make the plant hands-off trimmed for level flight at `speedMs`. */
  setTrimSpeed(speedMs: number): void { this.alphaTrim = this.alphaForLevelFlight(speedMs); }

  reset(init: TestPlantInit): void {
    this.V = init.speedMs;
    this.alt = init.altitudeM;
    this.north = init.northM ?? 0;
    this.east = init.eastM ?? 0;
    this.heading = wrapTwoPi(init.headingRad);
    this.roll = init.rollRad ?? 0;
    this.gamma = init.gammaRad ?? 0;
    const alpha = this.alphaForLevelFlight(this.V) * (this.roll !== 0 ? 1 / Math.cos(this.roll) : 1);
    this.pitch = alpha + this.gamma;
    this.p = 0; this.q = 0; this.beta = 0;
    this.alphaTrim = this.alphaForLevelFlight(this.V);
    this.prevAlpha = alpha;
    this.state.t = 0;
    this.fillState(0, alpha, 0, 1, 0, 0, 0);
  }

  private thrustToThrottle(thrustN: number): number {
    const { rho } = isa(this.alt);
    const pAvail = this.cfg.maxPowerW * (rho / 1.225);
    // T = min(η·P/V, Tstatic)
    const tPerThrottle = Math.min((this.cfg.propEfficiency * pAvail) / Math.max(this.V, 15), this.cfg.staticThrustN);
    return thrustN / tPerThrottle;
  }

  /** Lift coefficient vs angle of attack with a post-stall drop. */
  private CL(alpha: number): { CL: number; stalled: boolean } {
    const c = this.cfg;
    const alphaStall = (c.CLmax - c.CL0) / c.CLalpha;
    if (alpha <= alphaStall) return { CL: c.CL0 + c.CLalpha * alpha, stalled: false };
    return { CL: Math.max(c.CLmax - 2.0 * (alpha - alphaStall), 0.5), stalled: true };
  }

  /** Advance the plant by dt seconds with the given control inputs. */
  step(dt: number, u: ControlInputs): void {
    const c = this.cfg;
    const da = clamp(u.roll, -1, 1);
    const de = clamp(clamp(u.pitch, -1, 1) + c.trimElevatorFraction * clamp(u.pitchTrim, -1, 1), -1, 1);
    const dr = clamp(u.yaw, -1, 1);
    const throttle = clamp(u.throttle, 0, 1);

    const alpha = this.pitch - this.gamma;
    const { rho, a: sos } = isa(this.alt);
    const qbar = 0.5 * rho * this.V * this.V;
    const { CL, stalled } = this.CL(alpha);
    const L = qbar * c.wingAreaM2 * CL;
    const CD = c.CD0 + c.kInduced * CL * CL + 0.17 * Math.abs(this.beta) * Math.abs(this.beta);
    const D = qbar * c.wingAreaM2 * CD;
    const pAvail = c.maxPowerW * (rho / 1.225) * throttle;
    const T = Math.min((c.propEfficiency * pAvail) / Math.max(this.V, 15), c.staticThrustN * throttle);
    const m = c.massKg;

    // rates: exact first-order lags for a constant command over the step; control power ∝ V
    const auth = clamp(this.V / c.authorityRefSpeedMs, 0.3, 2);
    const pCmd = c.rollAuthorityRadS * auth * da;
    const qCmd = c.pitchAuthorityRadS * auth * de - c.alphaStiffnessPerS * (alpha - this.alphaTrim);
    this.p += (pCmd - this.p) * (1 - Math.exp(-dt / c.rollTauS));
    this.q += (qCmd - this.q) * (1 - Math.exp(-dt / c.pitchTauS));
    const betaSS = c.betaBiasRad - c.betaPerRudderRad * dr + c.betaPerAileronRad * da;
    this.beta += (betaSS - this.beta) * (1 - Math.exp(-dt / c.betaTauS));

    // path
    const cosG = Math.cos(this.gamma);
    const gammaDot = (L * Math.cos(this.roll) - m * G0 * cosG) / (m * Math.max(this.V, 5));
    const psiDot = (L * Math.sin(this.roll)) / (m * Math.max(this.V, 5) * Math.max(cosG, 0.2));
    const vDot = (T - D) / m - G0 * Math.sin(this.gamma);

    this.roll = wrapPi(this.roll + this.p * dt);
    this.pitch += this.q * dt;
    this.gamma = clamp(this.gamma + gammaDot * dt, -80 * DEG, 80 * DEG);
    this.heading = wrapTwoPi(this.heading + psiDot * dt);
    this.V = Math.max(this.V + vDot * dt, 5);

    const vN = this.V * Math.cos(this.gamma) * Math.cos(this.heading) + c.windNED[0];
    const vE = this.V * Math.cos(this.gamma) * Math.sin(this.heading) + c.windNED[1];
    const vD = -this.V * Math.sin(this.gamma) + c.windNED[2];
    this.north += vN * dt;
    this.east += vE * dt;
    this.alt -= vD * dt;

    const alphaNew = this.pitch - this.gamma;
    const alphaDot = (alphaNew - this.prevAlpha) / dt;
    this.prevAlpha = alphaNew;
    this.state.t += dt;
    this.fillState(throttle, alphaNew, alphaDot, L / (m * G0), T, CL, CD, qbar, sos, psiDot, vN, vE, vD, stalled, de, da, dr, clamp(u.pitchTrim, -1, 1));
  }

  private fillState(throttle: number, alpha: number, alphaDot: number, nz: number, thrust: number, CL: number, CD: number,
    qbar = 0, sos = 340.3, psiDot = 0, vN = this.V * Math.cos(this.heading), vE = this.V * Math.sin(this.heading), vD = 0, stalled = false,
    de = 0, da = 0, dr = 0, trim = 0): void {
    const s = this.state;
    const c = this.cfg;
    const atm = isa(this.alt);
    const sigma = atm.rho / 1.225;
    const ias = this.V * Math.sqrt(sigma);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);

    s.posNED[0] = this.north; s.posNED[1] = this.east; s.posNED[2] = -this.alt;
    s.geo.lat = this.north / 111320; s.geo.lon = this.east / 111320; s.geo.alt = this.alt;
    const cb = Math.cos(this.beta);
    s.velBody[0] = this.V * Math.cos(alpha) * cb; s.velBody[1] = this.V * Math.sin(this.beta); s.velBody[2] = this.V * Math.sin(alpha) * cb;
    s.velNED[0] = vN; s.velNED[1] = vE; s.velNED[2] = vD;
    qFromEuler(this.roll, this.pitch, this.heading, this.qTmp);
    qConj(this.qTmp, s.qNB);
    s.euler[0] = this.roll; s.euler[1] = this.pitch; s.euler[2] = this.heading;
    // body rates from Euler rates (p about x, q about y, r about z)
    s.rates[0] = this.p - psiDot * sp;
    s.rates[1] = this.q * cr + psiDot * cp * sr;
    s.rates[2] = -this.q * sr + psiDot * cp * cr;
    s.loadFactor[0] = 0; s.loadFactor[1] = 0; s.loadFactor[2] = nz;
    s.headingTrueRad = this.heading;
    s.headingMagRad = this.heading;
    s.trackRad = wrapTwoPi(Math.atan2(vE, vN));
    s.groundSpeedMs = Math.hypot(vN, vE);
    s.verticalSpeedMs = -vD;
    s.altitudeMslM = this.alt;
    s.altitudeIndicatedM = this.alt;
    s.altitudeAglM = this.alt - c.groundElevationM;
    s.onGround = false;
    s.crashed = this.alt < c.groundElevationM;
    const alphaStall = (c.CLmax - c.CL0) / c.CLalpha;
    s.aero.alpha = alpha; s.aero.beta = this.beta; s.aero.alphaDot = alphaDot;
    s.aero.tas = this.V; s.aero.cas = ias; s.aero.ias = ias; s.aero.eas = ias;
    s.aero.mach = this.V / sos; s.aero.qbar = qbar;
    s.aero.coefficients.CL = CL; s.aero.coefficients.CD = CD;
    s.aero.stallWarning = alpha >= alphaStall - c.stallWarnMarginRad;
    s.aero.stalled = stalled;
    s.atmosphere.temperatureK = atm.T; s.atmosphere.pressurePa = atm.p; s.atmosphere.densityKgM3 = atm.rho; s.atmosphere.speedOfSound = atm.a;
    s.engine.rpm = 1800 + 900 * throttle; s.engine.powerW = c.maxPowerW * throttle; s.engine.thrustN = thrust; s.engine.pctPower = throttle;
    s.engine.manifoldPressureInHg = 12 + 16 * throttle;
    s.surfaces.elevatorRad = -25 * DEG * de; // δe > 0 is TE down (nose down); our input + is nose up
    s.surfaces.aileronLeftRad = 17.5 * DEG * da;
    s.surfaces.aileronRightRad = -17.5 * DEG * da;
    s.surfaces.rudderRad = -16 * DEG * dr;
    s.surfaces.trimRad = -10 * DEG * trim;
    s.totalMassKg = c.massKg;
    s.windNED[0] = c.windNED[0]; s.windNED[1] = c.windNED[1]; s.windNED[2] = c.windNED[2];
    s.warnings.stall = s.aero.stallWarning;
    s.warnings.overspeed = ias > c.vneMs;
  }
}

// ───────────────────────────── nav-signal helpers for closed-loop tests ─────────────────────────────

/** Straight course in the local NED frame for GPS/NAV tests. */
export interface TestCourse {
  startNorthM: number;
  startEastM: number;
  endNorthM: number;
  endEastM: number;
}

/**
 * Fill a FlightPlan from the aircraft position relative to a straight course (active leg =
 * start→end). Cross-track error is positive right of course.
 */
export const updateTestPlan = (ac: AircraftState, course: TestCourse, out: FlightPlan): FlightPlan => {
  const dN = course.endNorthM - course.startNorthM, dE = course.endEastM - course.startEastM;
  const trk = Math.atan2(dE, dN);
  const rN = ac.posNED[0] - course.startNorthM, rE = ac.posNED[1] - course.startEastM;
  const xtk = -rN * Math.sin(trk) + rE * Math.cos(trk);
  const toN = course.endNorthM - ac.posNED[0], toE = course.endEastM - ac.posNED[1];
  out.desiredTrackDeg = wrapTwoPi(trk) / DEG;
  out.crossTrackM = xtk;
  out.distanceToActiveM = Math.hypot(toN, toE);
  out.bearingToActiveDeg = wrapTwoPi(Math.atan2(toE, toN)) / DEG;
  out.eteS = out.distanceToActiveM / Math.max(ac.groundSpeedMs, 1);
  if (out.waypoints.length < 2) {
    out.waypoints.length = 0;
    out.waypoints.push({ id: 'A', position: { lat: 0, lon: 0, alt: 0 }, type: 'user' }, { id: 'B', position: { lat: 0, lon: 0, alt: 0 }, type: 'user' });
    out.activeLeg = 0;
  }
  return out;
};

/** ILS geometry in the local NED frame. */
export interface TestIls {
  /** localizer antenna (far end of the runway) */
  locNorthM: number;
  locEastM: number;
  /** glideslope antenna (abeam the touchdown zone) */
  gsNorthM: number;
  gsEastM: number;
  /** elevation of the glide path origin, m */
  gsElevationM: number;
  /** inbound front course, true rad */
  courseRad: number;
  /** glide path angle rad */
  glideRad: number;
  /** localizer full-scale half-width (deg); default 2.5 */
  locFullScaleDeg?: number;
  /** glideslope full-scale half-width (deg); default 0.7 */
  gsFullScaleDeg?: number;
}

/**
 * Fill a NavRadioState as a receiver tuned to the ILS would show it: CDI + = fly right,
 * GS deviation + = fly up, DME = slant-free distance to the glideslope antenna.
 */
export const updateTestIls = (ac: AircraftState, ils: TestIls, out: NavRadioState): NavRadioState => {
  const locFs = (ils.locFullScaleDeg ?? 2.5) * DEG;
  const gsFs = (ils.gsFullScaleDeg ?? 0.7) * DEG;
  const dN = ac.posNED[0] - ils.locNorthM, dE = ac.posNED[1] - ils.locEastM;
  const brgFromLoc = Math.atan2(dE, dN);
  // Angle between the back-course direction (course + π) and the aircraft, positive when the
  // aircraft sits left of the inbound course (then it must fly right).
  const dev = wrapPi(brgFromLoc - (ils.courseRad + Math.PI));
  const gN = ac.posNED[0] - ils.gsNorthM, gE = ac.posNED[1] - ils.gsEastM;
  const distGs = Math.hypot(gN, gE);
  const h = ac.altitudeMslM - ils.gsElevationM;
  const pathAngle = Math.atan2(h, Math.max(distGs, 1));
  out.valid = true;
  out.isLocalizer = true;
  out.ident = 'ITST';
  out.obsDeg = wrapTwoPi(ils.courseRad) / DEG;
  out.cdi = clamp(dev / locFs, -1, 1);
  out.toFrom = 'to';
  out.gsValid = true;
  out.gsDeviation = clamp((ils.glideRad - pathAngle) / gsFs, -1, 1);
  out.dmeNm = distGs / NM;
  out.bearingDeg = wrapTwoPi(Math.atan2(-dE, -dN)) / DEG;
  out.radialDeg = wrapTwoPi(brgFromLoc) / DEG;
  return out;
};
