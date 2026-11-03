/**
 * Builds a plausible `SimSnapshot` for tests and demos: a C172 in cruise over the Bay at 3 500 ft,
 * 110 KIAS, heading 285° M with a light north-westerly, NAV1 tuned to SFO VOR, AP in HDG/ALT.
 */
import { qFromEuler } from '../../core/math';
import type { AircraftState, AutopilotState, FlightPlan, NavRadioState, SimSnapshot } from '../../core/types';
import { defaultControlInputs } from '../../core/types';
import { DEG, FT, KT } from '../../core/units';

export interface SampleOptions {
  iasKt?: number; altFt?: number; headingMagDeg?: number; magVarDeg?: number; pitchDeg?: number; rollDeg?: number;
  vsFpm?: number; rpm?: number; onGround?: boolean; engineRunning?: boolean; qnhPa?: number; simTimeS?: number;
}

export function makeAircraftState(o: SampleOptions = {}): AircraftState {
  const ias = (o.iasKt ?? 110) * KT, altM = (o.altFt ?? 3500) * FT;
  const magVar = o.magVarDeg ?? 13;
  const hdgMag = (o.headingMagDeg ?? 285) * DEG, hdgTrue = hdgMag + magVar * DEG;
  const roll = (o.rollDeg ?? 0) * DEG, pitch = (o.pitchDeg ?? 2) * DEG;
  const running = o.engineRunning ?? true, onGround = o.onGround ?? false;
  const rpm = o.rpm ?? (running ? 2350 : 0);
  const pressurePa = 101325 * Math.pow(1 - (altM / 0.3048) / 145366.45, 1 / 0.190284);
  const vs = (o.vsFpm ?? 0) * FT / 60;
  return {
    t: o.simTimeS ?? 120,
    posNED: [1200, -800, -altM],
    geo: { lat: 37.65, lon: -122.45, alt: altM },
    velBody: [ias * 1.05, 0, 0],
    velNED: [Math.cos(hdgTrue) * ias, Math.sin(hdgTrue) * ias, -vs],
    qNB: qFromEuler(roll, pitch, hdgTrue),
    euler: [roll, pitch, hdgTrue],
    rates: [0, 0, 0],
    loadFactor: [Math.sin(pitch), 0, 1 / Math.max(Math.cos(roll), 0.2)],
    headingTrueRad: hdgTrue,
    headingMagRad: hdgMag,
    trackRad: hdgTrue + 2 * DEG,
    groundSpeedMs: ias * 1.0,
    verticalSpeedMs: vs,
    altitudeMslM: altM,
    altitudeAglM: altM - 50,
    altitudeIndicatedM: altM,
    qnhSetPa: o.qnhPa ?? 101325,
    onGround,
    crashed: false,
    aero: {
      alpha: 3 * DEG, beta: 0, alphaDot: 0, tas: ias * 1.05, cas: ias * 1.01, ias, eas: ias, mach: 0.17, qbar: 0.5 * 1.1 * ias * ias,
      coefficients: { CL: 0.45, CD: 0.04, CY: 0, Cl: 0, Cm: 0, Cn: 0 }, stallWarning: false, stalled: false,
    },
    atmosphere: { temperatureK: 288.15 - 0.0065 * altM, pressurePa, densityKgM3: 1.1, speedOfSound: 338 },
    engine: {
      running, rpm, manifoldPressureInHg: running ? 23.5 : pressurePa / 3386.39, fuelFlowKgS: running ? 0.0073 : 0,
      egtK: running ? 1000 : 288, chtK: running ? 450 : 288, oilTempK: running ? 355 : 288, oilPressurePa: running ? 60 * 6894.757 : 0,
      powerW: running ? 95000 : 0, thrustN: running ? 1200 : 0, torqueNm: running ? 390 : 0, pctPower: running ? 0.7 : 0,
    },
    surfaces: { elevatorRad: -0.02, aileronLeftRad: 0, aileronRightRad: 0, rudderRad: 0, flapDeg: 0, trimRad: -0.03, speedbrake: 0 },
    gear: [
      { compressionM: 0, normalForceN: 0, onGround, wheelSpeedMs: 0, steerRad: 0, extension: 1 },
      { compressionM: 0, normalForceN: 0, onGround, wheelSpeedMs: 0, steerRad: 0, extension: 1 },
      { compressionM: 0, normalForceN: 0, onGround, wheelSpeedMs: 0, steerRad: 0, extension: 1 },
    ],
    fuelKg: [55, 52],
    totalMassKg: 1050,
    cgM: [0, 0, 0],
    windNED: [-5 * KT, 8 * KT, 0],
    warnings: { stall: false, overspeed: false, overG: false, gearOverspeed: false, flapOverspeed: false, lowFuel: false },
  };
}

export function makeNavRadio(khz = 115800, obs = 95, valid = true): NavRadioState {
  return {
    activeKHz: khz, standbyKHz: 116800, obsDeg: obs, ident: valid ? 'SFO' : '', valid, cdi: 0.3, toFrom: 'from',
    gsDeviation: 0, gsValid: false, isLocalizer: false, dmeNm: 12.4, bearingDeg: 105, radialDeg: 285,
  };
}

export function makeAutopilot(): AutopilotState {
  return {
    engaged: true, flightDirector: true, lateral: 'HDG', vertical: 'ALT', armedLateral: 'NAV', armedVertical: null,
    headingBugDeg: 300, altitudeTargetM: 3500 * FT, verticalSpeedTargetMs: 0, iasTargetMs: 0, pitchTargetRad: 0, rollTargetRad: 0,
    fdPitchRad: 3 * DEG, fdRollRad: 5 * DEG, outPitch: 0, outRoll: 0, outYaw: 0, yawDamper: false, trimCommand: 0,
  };
}

export function makeFlightPlan(): FlightPlan {
  return {
    waypoints: [
      { id: 'KSFO', position: { lat: 37.6188, lon: -122.375, alt: 4 }, type: 'airport' },
      { id: 'SAU', position: { lat: 37.855, lon: -122.523, alt: 0 }, type: 'navaid' },
      { id: 'KOAK', position: { lat: 37.7213, lon: -122.2208, alt: 3 }, type: 'airport' },
    ],
    activeLeg: 1, desiredTrackDeg: 330, crossTrackM: 400, distanceToActiveM: 15000, bearingToActiveDeg: 332, eteS: 420,
  };
}

export function makeSampleSnapshot(o: SampleOptions = {}): SimSnapshot {
  const aircraft = makeAircraftState(o);
  const inputs = defaultControlInputs();
  inputs.throttle = 0.72; inputs.mixture = 0.85; inputs.parkingBrake = false; inputs.pitchTrim = 0.1; inputs.lights.beacon = true; inputs.lights.nav = true;
  return {
    time: { utcMs: Date.UTC(2026, 5, 21, 18, 30, 15), timeScale: 1, simTimeS: aircraft.t },
    aircraft,
    inputs,
    weather: {
      preset: 'few', clouds: [{ baseM: 1500, topM: 1800, coverage: 0.2, density: 0.5, type: 'cumulus' }], winds: [{ altM: 0, directionDeg: 300, speedKt: 9, gustKt: 0 }],
      precipitationRate: 0, precipitationType: 'none', thunderstorm: false, humidity: 0.5, qnhPa: aircraft.qnhSetPa, temperatureC: 18, aerosol: 0.2, visibilityM: 40000, turbulence: 1, fogTopM: 0,
    },
    sun: { elevationRad: 0.8, azimuthRad: 3.5, dirThree: [0.3, 0.7, 0.6], moonElevationRad: -0.5, moonAzimuthRad: 1, moonPhase: 0.3 },
    camera: { mode: 'cockpit', lookYaw: 0, lookPitch: 0, orbitYaw: 0, orbitPitch: 0, orbitDistanceM: 30, fovDeg: 60, dronePosNED: [0, 0, 0], droneYaw: 0, dronePitch: 0 },
    autopilot: makeAutopilot(),
    nav1: makeNavRadio(),
    nav2: makeNavRadio(116800, 40, false),
    plan: makeFlightPlan(),
    frame: { lat0: 37.6135, lon0: -122.357, alt0: 4 },
    paused: false,
    slew: false,
    assists: { autoRudder: false, assistedTakeoff: false, assistedLanding: false, autoMixture: false, unlimitedFuel: false, crashDamage: true, stressDamage: true, gyroDrift: true, landingPathHints: false, taxiRibbon: false, routeRibbon: false, antiStall: false },
    terrainReady: 1,
    fps: 60,
  };
}
