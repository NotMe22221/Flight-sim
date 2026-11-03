/** Allocation of the AircraftState object the flight model updates in place every step. */
import type { AircraftConfig, AircraftState } from '../core/types';

export function createAircraftState(cfg: AircraftConfig): AircraftState {
  const wheels = cfg.gear.filter((g) => g.type === 'wheel');
  return {
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
    onGround: true,
    crashed: false,
    aero: { alpha: 0, beta: 0, alphaDot: 0, tas: 0, cas: 0, ias: 0, eas: 0, mach: 0, qbar: 0, coefficients: { CL: 0, CD: 0, CY: 0, Cl: 0, Cm: 0, Cn: 0 }, stallWarning: false, stalled: false },
    atmosphere: { temperatureK: 288.15, pressurePa: 101325, densityKgM3: 1.225, speedOfSound: 340.29 },
    engine: { running: false, rpm: 0, manifoldPressureInHg: 29.92, fuelFlowKgS: 0, egtK: 288, chtK: 288, oilTempK: 288, oilPressurePa: 0, powerW: 0, thrustN: 0, torqueNm: 0, pctPower: 0 },
    surfaces: { elevatorRad: 0, aileronLeftRad: 0, aileronRightRad: 0, rudderRad: 0, flapDeg: 0, trimRad: 0, speedbrake: 0 },
    gear: wheels.map(() => ({ compressionM: 0, normalForceN: 0, onGround: false, wheelSpeedMs: 0, steerRad: 0, extension: 1 })),
    fuelKg: cfg.mass.tanks.map((t) => t.contentsKg),
    totalMassKg: cfg.mass.emptyMassKg,
    cgM: [0, 0, 0],
    windNED: [0, 0, 0],
    warnings: { stall: false, overspeed: false, overG: false, gearOverspeed: false, flapOverspeed: false, lowFuel: false },
  };
}
