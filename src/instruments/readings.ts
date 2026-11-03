/**
 * Converts the FDM's `AircraftState` (plus inputs/autopilot/assists from the `SimSnapshot`) into
 * what the instruments actually display, including the instrument dynamics: VSI lag, altimeter
 * from the Kollsman setting, ASI needle damping, gyro spin-up/erection/drift, turn-coordinator
 * blend and ball, engine-gauge lags, systems (vacuum, electrical, fuel senders) and annunciators.
 *
 * Everything here is pure TypeScript with no DOM access, so it is unit-tested in Node.
 */
import { clamp, deltaDeg, wrap360 } from '../core/math';
import type { SimSnapshot } from '../core/types';
import { INHG, M_TO_FT, MS_TO_FPM, MS_TO_KT, RAD } from '../core/units';
import { FUEL, OIL_PRESS, SUCTION } from './c172';
import { MagneticCompass, defaultCompassConfig } from './compass';
import { Derivative, HoldTimer, Lag } from './filters';
import { AttitudeGyro, HeadingGyro, TurnGyro, ballWidths } from './gyros';
import { ElectricalSystem, FuelGauge, HourMeters, OilFallback, suctionInHg } from './systems';

// ───────────────────────────── Altimetry (pure) ─────────────────────────────

/** ISA sea-level pressure, Pa. */
export const P0_PA = 101325;
/** ISA pressure-altitude exponent R·L/g0. */
export const ISA_EXP = 0.190284;
/** T0/L in feet. */
export const ISA_K_FT = 145366.45;

/** Pressure altitude (ft) of a static pressure in the ISA: 145 366.45·(1 − (p/p0)^0.190284). */
export function pressureAltitudeFt(staticPa: number): number {
  return ISA_K_FT * (1 - Math.pow(staticPa / P0_PA, ISA_EXP));
}

/** Kollsman correction (ft) for an altimeter setting: the pressure altitude of the setting itself. */
export function kollsmanCorrectionFt(settingPa: number): number {
  return pressureAltitudeFt(settingPa);
}

/**
 * Indicated altitude (ft) for a static pressure and altimeter setting. With the setting left at
 * 1013.25 hPa in an atmosphere whose QNH is 1003 hPa the altimeter at sea level reads ≈ +280 ft.
 */
export function indicatedAltitudeFt(staticPa: number, settingPa: number): number {
  return pressureAltitudeFt(staticPa) - kollsmanCorrectionFt(settingPa);
}

/** Static pressure (Pa) at an ISA pressure altitude (ft); used when the FDM supplies no pressure. */
export function isaPressurePa(pressureAltFt: number): number {
  return P0_PA * Math.pow(Math.max(0, 1 - pressureAltFt / ISA_K_FT), 1 / ISA_EXP);
}

// ───────────────────────────── Contracts ─────────────────────────────

export interface InstrumentReadings {
  iasKt: number; casKt: number; tasKt: number; gsKt: number;
  /** vacuum attitude indicator (with spin-up / erection error) */
  attitude: { pitchDeg: number; rollDeg: number; valid: boolean; spin: number };
  /** solid-state AHRS truth for glass displays; valid while the avionics bus is live */
  ahrs: { pitchDeg: number; rollDeg: number; valid: boolean };
  /** avionics bus live (> 20 V) */
  avionicsOn: boolean;
  altimeter: { indicatedFt: number; pressureAltFt: number; settingInHg: number; settingHPa: number; modeCFt: number };
  turn: { rateStd: number; ballWidths: number; valid: boolean };
  heading: {
    /** directional gyro reading (magnetic + drift) */ dgDeg: number; dgValid: boolean;
    bugDeg: number; bugErrorDeg: number;
    /** whiskey compass card */ compassDeg: number;
    /** truth values for glass displays (AHRS/magnetometer) */ magDeg: number; trueDeg: number; trackMagDeg: number; magVarDeg: number;
  };
  vsiFpm: number;
  engine: { running: boolean; rpm: number; mapInHg: number; fuelFlowGph: number; oilTempF: number; oilPressPsi: number; egtF: number; chtF: number; pctPower: number };
  /** usable gallons [left, right] as the float gauges show them */
  fuelGal: [number, number];
  fuelTotalGal: number;
  suctionInHg: number; ampsA: number; voltsV: number; oatC: number;
  flapsDeg: number; flapsIndex: number; gearDown: boolean;
  /** −1 (nose down) .. +1 (nose up) trim wheel position */ trimNorm: number; rudderTrimNorm: number; aileronTrimNorm: number;
  throttle: number; mixture: number; propeller: number;
  hobbsHours: number; tachHours: number;
  annunciators: {
    lowVolts: boolean; lowFuelL: boolean; lowFuelR: boolean; oilPress: boolean; vacuum: boolean; pitotHeatOff: boolean;
    stallWarn: boolean; overspeed: boolean; overG: boolean; flapOverspeed: boolean; gearOverspeed: boolean;
  };
  trends: { iasKtPer6s: number; altFtPer6s: number; headingDegPer6s: number };
  wind: { fromMagDeg: number; fromTrueDeg: number; speedKt: number; headwindKt: number; crosswindKt: number };
  clock: { utcMs: number; simTimeS: number; timerS: number };
  onGround: boolean;
}

export interface InstrumentConfig {
  asiTauS: number; altimeterTauS: number; vsiTauS: number; ballTauS: number; tcTauS: number;
  rpmTauS: number; mapTauS: number; fuelFlowTauS: number; egtTauS: number; oilTauS: number; oatTauS: number; flapsTauS: number;
  /** vacuum needed for full gyro speed */ minVacuumInHg: number;
  dgDriftDegPerMin: number; dgRandomWalkDegPerSqrtMin: number; dgSeed: number;
  compassDipDeg: number;
  ballDegPerWidth: number;
  lowFuelGal: number; lowFuelHoldS: number;
  /** 0 disables needle quantisation */ altimeterQuantumFt: number;
  trendTauS: number;
}

export const defaultInstrumentConfig = (): InstrumentConfig => ({
  asiTauS: 0.12, altimeterTauS: 0.1, vsiTauS: 2.5, ballTauS: 0.3, tcTauS: 1.0,
  rpmTauS: 0.15, mapTauS: 0.1, fuelFlowTauS: 1, egtTauS: 3, oilTauS: 2, oatTauS: 10, flapsTauS: 0.2,
  minVacuumInHg: 4.5,
  dgDriftDegPerMin: 0.25, dgRandomWalkDegPerSqrtMin: 0.3, dgSeed: 1234,
  compassDipDeg: 61,
  ballDegPerWidth: 4,
  lowFuelGal: FUEL.lowGal, lowFuelHoldS: FUEL.lowHoldS,
  altimeterQuantumFt: 0,
  trendTauS: 1.0,
});

/** A zeroed readings object (allocated once; `InstrumentModel.update` writes into it). */
export function createReadings(): InstrumentReadings {
  return {
    iasKt: 0, casKt: 0, tasKt: 0, gsKt: 0,
    attitude: { pitchDeg: 0, rollDeg: 0, valid: false, spin: 0 },
    ahrs: { pitchDeg: 0, rollDeg: 0, valid: false },
    avionicsOn: false,
    altimeter: { indicatedFt: 0, pressureAltFt: 0, settingInHg: 29.92, settingHPa: 1013, modeCFt: 0 },
    turn: { rateStd: 0, ballWidths: 0, valid: false },
    heading: { dgDeg: 0, dgValid: false, bugDeg: 0, bugErrorDeg: 0, compassDeg: 0, magDeg: 0, trueDeg: 0, trackMagDeg: 0, magVarDeg: 0 },
    vsiFpm: 0,
    engine: { running: false, rpm: 0, mapInHg: 29.92, fuelFlowGph: 0, oilTempF: 60, oilPressPsi: 0, egtF: 60, chtF: 60, pctPower: 0 },
    fuelGal: [0, 0], fuelTotalGal: 0,
    suctionInHg: 0, ampsA: 0, voltsV: 0, oatC: 15,
    flapsDeg: 0, flapsIndex: 0, gearDown: true, trimNorm: 0, rudderTrimNorm: 0, aileronTrimNorm: 0,
    throttle: 0, mixture: 1, propeller: 1,
    hobbsHours: 0, tachHours: 0,
    annunciators: { lowVolts: false, lowFuelL: false, lowFuelR: false, oilPress: false, vacuum: false, pitotHeatOff: false, stallWarn: false, overspeed: false, overG: false, flapOverspeed: false, gearOverspeed: false },
    trends: { iasKtPer6s: 0, altFtPer6s: 0, headingDegPer6s: 0 },
    wind: { fromMagDeg: 0, fromTrueDeg: 0, speedKt: 0, headwindKt: 0, crosswindKt: 0 },
    clock: { utcMs: 0, simTimeS: 0, timerS: 0 },
    onGround: true,
  };
}

const PSI = 6894.757; // Pa per psi
const kToF = (k: number): number => (k - 273.15) * 1.8 + 32;
const sane = (v: number, lo: number): boolean => Number.isFinite(v) && v > lo;

// ───────────────────────────── Model ─────────────────────────────

/**
 * Stateful instrument model. Call `update(snapshot, dt)` once per rendered frame; the returned
 * object is the same instance every time (no allocation). Call `reset()` after a flight reset so
 * the needles do not sweep in from stale values.
 */
export class InstrumentModel {
  readonly readings = createReadings();
  readonly ai: AttitudeGyro;
  readonly dg: HeadingGyro;
  readonly tc: TurnGyro;
  readonly compass: MagneticCompass;
  readonly electrical = new ElectricalSystem();
  readonly fuelL = new FuelGauge();
  readonly fuelR = new FuelGauge();
  readonly oilFallback = new OilFallback();
  readonly hours = new HourMeters();

  private readonly asi: Lag; private readonly alt: Lag; private readonly vsi: Lag; private readonly ball: Lag;
  private readonly rpm: Lag; private readonly map: Lag; private readonly ff: Lag; private readonly egt: Lag; private readonly cht: Lag;
  private readonly oilT: Lag; private readonly oilP: Lag; private readonly oat: Lag; private readonly flaps: Lag;
  private readonly iasTrend: Derivative;
  private readonly lowFuelL: HoldTimer; private readonly lowFuelR: HoldTimer;
  private lastFlapDeg = NaN;
  private initialised = false;
  private timerRunning = false;
  private timerStartS = 0;
  private timerHeldS = 0;

  constructor(public readonly cfg: InstrumentConfig = defaultInstrumentConfig()) {
    this.ai = new AttitudeGyro();
    this.dg = new HeadingGyro({ driftDegPerMin: cfg.dgDriftDegPerMin, randomWalkDegPerSqrtMin: cfg.dgRandomWalkDegPerSqrtMin, seed: cfg.dgSeed });
    this.tc = new TurnGyro(cfg.tcTauS);
    this.compass = new MagneticCompass({ ...defaultCompassConfig(), dipDeg: cfg.compassDipDeg });
    this.asi = new Lag(cfg.asiTauS); this.alt = new Lag(cfg.altimeterTauS); this.vsi = new Lag(cfg.vsiTauS); this.ball = new Lag(cfg.ballTauS);
    this.rpm = new Lag(cfg.rpmTauS); this.map = new Lag(cfg.mapTauS, 29.92); this.ff = new Lag(cfg.fuelFlowTauS); this.egt = new Lag(cfg.egtTauS, 60); this.cht = new Lag(cfg.egtTauS, 60);
    this.oilT = new Lag(cfg.oilTauS, 60); this.oilP = new Lag(0.5); this.oat = new Lag(cfg.oatTauS, 15); this.flaps = new Lag(cfg.flapsTauS);
    this.iasTrend = new Derivative(cfg.trendTauS);
    this.lowFuelL = new HoldTimer(cfg.lowFuelHoldS); this.lowFuelR = new HoldTimer(cfg.lowFuelHoldS);
  }

  /** Snap every filter to the current truth (spawn / flight reset). Gyros start spun-up if the engine runs. */
  reset(s: SimSnapshot): void {
    const ac = s.aircraft, running = ac.engine.running;
    const oatC = sane(ac.atmosphere.temperatureK, 1) ? ac.atmosphere.temperatureK - 273.15 : 15;
    const magDeg = wrap360(ac.headingMagRad * RAD);
    this.asi.reset(ac.aero.ias * MS_TO_KT); this.vsi.reset(ac.verticalSpeedMs * MS_TO_FPM); this.ball.reset(0);
    this.alt.reset(indicatedAltitudeFt(this.staticPa(s), this.settingPa(s)));
    this.ai.reset(ac.euler[1] * RAD, ac.euler[0] * RAD, running ? 1 : 0);
    this.dg.reset(magDeg, running ? 1 : 0);
    this.tc.reset(running ? 1 : 0);
    this.compass.reset(magDeg);
    this.electrical.reset(running);
    this.fuelL.reset(ac.fuelKg[0] ?? 0); this.fuelR.reset(ac.fuelKg[1] ?? ac.fuelKg[0] ?? 0);
    this.oilFallback.reset(oatC, running);
    this.rpm.reset(ac.engine.rpm); this.map.reset(sane(ac.engine.manifoldPressureInHg, 0) ? ac.engine.manifoldPressureInHg : 29.92);
    this.ff.reset(sane(ac.engine.fuelFlowKgS, -1) ? (ac.engine.fuelFlowKgS * 3600) / FUEL.kgPerGal : 0);
    this.egt.reset(sane(ac.engine.egtK, 200) ? kToF(ac.engine.egtK) : 1.8 * oatC + 32);
    this.cht.reset(sane(ac.engine.chtK, 200) ? kToF(ac.engine.chtK) : 1.8 * oatC + 32);
    this.oilT.reset(sane(ac.engine.oilTempK, 200) ? kToF(ac.engine.oilTempK) : this.oilFallback.tempF.value);
    this.oilP.reset(sane(ac.engine.oilPressurePa, 0) ? ac.engine.oilPressurePa / PSI : this.oilFallback.pressPsi);
    this.oat.reset(oatC); this.flaps.reset(ac.surfaces.flapDeg); this.lastFlapDeg = ac.surfaces.flapDeg;
    this.iasTrend.reset(ac.aero.ias * MS_TO_KT);
    this.lowFuelL.reset(); this.lowFuelR.reset();
    this.initialised = true;
  }

  /** Set the directional gyro to the magnetic compass (the knob on the DG). */
  alignHeadingIndicator(): void { this.dg.align(this.compass.headingDeg); }

  /** Cage / uncage the attitude indicator. */
  cageAttitude(caged: boolean): void { this.ai.caged = caged; }

  /** Elapsed timer (PFD TMR/REF). */
  startTimer(): void { if (!this.timerRunning) { this.timerRunning = true; this.timerStartS = this.readings.clock.simTimeS - this.timerHeldS; } }
  stopTimer(): void { if (this.timerRunning) { this.timerHeldS = this.readings.clock.simTimeS - this.timerStartS; this.timerRunning = false; } }
  resetTimer(): void { this.timerHeldS = 0; this.timerStartS = this.readings.clock.simTimeS; }

  /** Advance the instrument dynamics by `dt` seconds of sim time and return the shared readings object. */
  update(s: SimSnapshot, dt: number): InstrumentReadings {
    if (!this.initialised) this.reset(s);
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    const r = this.readings, ac = s.aircraft, inp = s.inputs, cfg = this.cfg;
    const running = ac.engine.running;
    const rollRad = ac.euler[0], pitchRad = ac.euler[1];

    // ── pitot-static
    const iasRaw = sane(ac.aero.ias, -1) ? ac.aero.ias * MS_TO_KT : sane(ac.aero.cas, -1) ? ac.aero.cas * MS_TO_KT : ac.aero.tas * MS_TO_KT;
    r.iasKt = Math.max(0, this.asi.step(iasRaw, dt));
    r.casKt = Math.max(0, ac.aero.cas * MS_TO_KT);
    r.tasKt = Math.max(0, ac.aero.tas * MS_TO_KT);
    r.gsKt = Math.max(0, ac.groundSpeedMs * MS_TO_KT);
    const ps = this.staticPa(s), setting = this.settingPa(s);
    const a = r.altimeter;
    a.pressureAltFt = pressureAltitudeFt(ps);
    let ind = this.alt.step(indicatedAltitudeFt(ps, setting), dt);
    if (cfg.altimeterQuantumFt > 0) ind = Math.round(ind / cfg.altimeterQuantumFt) * cfg.altimeterQuantumFt;
    a.indicatedFt = ind;
    a.settingInHg = setting / INHG;
    a.settingHPa = setting / 100;
    a.modeCFt = Math.round(a.pressureAltFt / 100) * 100;
    r.vsiFpm = this.vsi.step(ac.verticalSpeedMs * MS_TO_FPM, dt);

    // ── systems first: the gyros need their power sources
    const flapsMoving = Number.isFinite(this.lastFlapDeg) && Math.abs(ac.surfaces.flapDeg - this.lastFlapDeg) > 1e-3;
    this.lastFlapDeg = ac.surfaces.flapDeg;
    this.electrical.step(inp, running, ac.engine.rpm, flapsMoving, dt);
    r.voltsV = this.electrical.voltsV; r.ampsA = this.electrical.ampsA;
    const busLive = r.voltsV > 20;
    r.avionicsOn = busLive;
    r.ahrs.pitchDeg = pitchRad * RAD; r.ahrs.rollDeg = rollRad * RAD; r.ahrs.valid = busLive;
    r.suctionInHg = suctionInHg(running, ac.engine.rpm);
    const vacPower = r.suctionInHg / cfg.minVacuumInHg;

    // ── gyros
    this.ai.step(pitchRad * RAD, rollRad * RAD, ac.rates[0], vacPower, dt);
    r.attitude.pitchDeg = this.ai.pitchDeg; r.attitude.rollDeg = this.ai.rollDeg; r.attitude.valid = this.ai.valid; r.attitude.spin = this.ai.gyro.spin;
    const ny = ac.loadFactor[1], nz = ac.loadFactor[2];
    this.tc.step(ac.rates[0], ac.rates[2], busLive, dt);
    r.turn.rateStd = this.tc.rateStd; r.turn.valid = this.tc.valid;
    const ballRaw = ballWidths(ny, nz, cfg.ballDegPerWidth);
    r.turn.ballWidths = this.ball.step(ballRaw, dt);

    // ── headings
    const h = r.heading;
    h.magDeg = wrap360(ac.headingMagRad * RAD);
    h.trueDeg = wrap360(ac.headingTrueRad * RAD);
    h.magVarDeg = deltaDeg(h.trueDeg, h.magDeg);
    h.trackMagDeg = wrap360(ac.trackRad * RAD - h.magVarDeg);
    h.dgDeg = this.dg.step(h.magDeg, vacPower, s.assists.gyroDrift, dt);
    h.dgValid = this.dg.valid;
    h.bugDeg = wrap360(s.autopilot.headingBugDeg);
    h.bugErrorDeg = deltaDeg(h.bugDeg, h.dgDeg);
    const longAccelG = ac.loadFactor[0] - Math.sin(pitchRad);
    h.compassDeg = this.compass.step(h.magDeg, rollRad, Math.atan2(-ny, Math.max(nz, 0.05)), longAccelG, dt);

    // ── engine
    const e = r.engine, fe = ac.engine;
    e.running = running;
    e.rpm = Math.max(0, this.rpm.step(fe.rpm, dt));
    e.mapInHg = this.map.step(sane(fe.manifoldPressureInHg, 0) ? fe.manifoldPressureInHg : ps / INHG, dt);
    e.fuelFlowGph = Math.max(0, this.ff.step(sane(fe.fuelFlowKgS, -1) ? (fe.fuelFlowKgS * 3600) / FUEL.kgPerGal : 0, dt));
    e.pctPower = clamp(fe.pctPower, 0, 1.2);
    const oatC = this.oat.step(sane(ac.atmosphere.temperatureK, 1) ? ac.atmosphere.temperatureK - 273.15 : 15, dt);
    r.oatC = oatC;
    this.oilFallback.step(running, fe.rpm, fe.pctPower, oatC, dt);
    e.oilTempF = this.oilT.step(sane(fe.oilTempK, 200) ? kToF(fe.oilTempK) : this.oilFallback.tempF.value, dt);
    e.oilPressPsi = Math.max(0, this.oilP.step(sane(fe.oilPressurePa, 0) ? fe.oilPressurePa / PSI : this.oilFallback.pressPsi, dt));
    e.egtF = this.egt.step(sane(fe.egtK, 200) ? kToF(fe.egtK) : 1.8 * oatC + 32, dt);
    e.chtF = this.cht.step(sane(fe.chtK, 200) ? kToF(fe.chtK) : 1.8 * oatC + 32, dt);
    this.hours.step(e.oilPressPsi, e.rpm, dt);
    r.hobbsHours = this.hours.hobbsHours; r.tachHours = this.hours.tachHours;

    // ── fuel
    const kgL = ac.fuelKg[0] ?? 0, kgR = ac.fuelKg.length > 1 ? ac.fuelKg[1] : kgL;
    r.fuelGal[0] = this.fuelL.step(kgL, rollRad, pitchRad, dt);
    r.fuelGal[1] = this.fuelR.step(kgR, rollRad, pitchRad, dt);
    r.fuelTotalGal = r.fuelGal[0] + r.fuelGal[1];

    // ── controls
    r.flapsDeg = this.flaps.step(ac.surfaces.flapDeg, dt);
    r.flapsIndex = inp.flapsIndex;
    r.gearDown = inp.gearDown;
    r.trimNorm = clamp(inp.pitchTrim, -1, 1); r.rudderTrimNorm = clamp(inp.rudderTrim, -1, 1); r.aileronTrimNorm = clamp(inp.aileronTrim, -1, 1);
    r.throttle = clamp(inp.throttle, 0, 1); r.mixture = clamp(inp.mixture, 0, 1); r.propeller = clamp(inp.propeller, 0, 1);
    r.onGround = ac.onGround;

    // ── annunciators
    const an = r.annunciators, w = ac.warnings;
    an.lowVolts = this.electrical.lowVolts;
    an.lowFuelL = this.lowFuelL.step(busLive && r.fuelGal[0] < cfg.lowFuelGal, dt);
    an.lowFuelR = this.lowFuelR.step(busLive && r.fuelGal[1] < cfg.lowFuelGal, dt);
    an.oilPress = busLive && e.oilPressPsi < OIL_PRESS.redLo;
    an.vacuum = busLive && r.suctionInHg < SUCTION.lowWarn;
    an.pitotHeatOff = busLive && !inp.pitotHeat;
    an.stallWarn = busLive && (w.stall || ac.aero.stallWarning);
    an.overspeed = w.overspeed; an.overG = w.overG; an.flapOverspeed = w.flapOverspeed; an.gearOverspeed = w.gearOverspeed;

    // ── trends for glass displays
    r.trends.iasKtPer6s = this.iasTrend.step(iasRaw, dt) * 6;
    r.trends.altFtPer6s = ac.verticalSpeedMs * MS_TO_FPM / 10;
    r.trends.headingDegPer6s = ac.rates[2] * RAD * 6;

    // ── wind (windNED is the velocity the air moves toward; pilots quote the direction it comes from)
    const wN = ac.windNED[0], wE = ac.windNED[1];
    const wd = r.wind;
    wd.speedKt = Math.hypot(wN, wE) * MS_TO_KT;
    wd.fromTrueDeg = wd.speedKt > 0.05 ? wrap360(Math.atan2(-wE, -wN) * RAD) : 0;
    wd.fromMagDeg = wrap360(wd.fromTrueDeg - h.magVarDeg);
    const psi = ac.headingTrueRad;
    wd.headwindKt = -(wN * Math.cos(psi) + wE * Math.sin(psi)) * MS_TO_KT;
    wd.crosswindKt = -(-wN * Math.sin(psi) + wE * Math.cos(psi)) * MS_TO_KT;

    // ── clock
    r.clock.utcMs = s.time.utcMs; r.clock.simTimeS = s.time.simTimeS;
    r.clock.timerS = this.timerRunning ? s.time.simTimeS - this.timerStartS : this.timerHeldS;
    return r;
  }

  private staticPa(s: SimSnapshot): number {
    const p = s.aircraft.atmosphere.pressurePa;
    if (sane(p, 1000)) return p;
    return isaPressurePa(s.aircraft.altitudeMslM * M_TO_FT);
  }

  private settingPa(s: SimSnapshot): number {
    const q = s.aircraft.qnhSetPa;
    return sane(q, 50000) ? q : P0_PA;
  }
}
