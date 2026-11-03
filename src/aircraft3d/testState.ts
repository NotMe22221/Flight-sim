/**
 * Test fixture: a complete, inert AircraftState (on the ground, engine off) and helpers.
 * Not part of the runtime API.
 */
import type { AircraftState } from '../core/types';

export function makeTestState(): AircraftState {
  const gear = () => ({ compressionM: 0, normalForceN: 0, onGround: true, wheelSpeedMs: 0, steerRad: 0, extension: 1 });
  return {
    t: 0, posNED: [0, 0, -1.2], geo: { lat: 37.6, lon: -122.36, alt: 5 },
    velBody: [0, 0, 0], velNED: [0, 0, 0], qNB: [1, 0, 0, 0], euler: [0, 0, 0], rates: [0, 0, 0], loadFactor: [0, 0, 1],
    headingTrueRad: 0, headingMagRad: 0, trackRad: 0, groundSpeedMs: 0, verticalSpeedMs: 0,
    altitudeMslM: 5, altitudeAglM: 1.2, altitudeIndicatedM: 5, qnhSetPa: 101325, onGround: true, crashed: false,
    aero: { alpha: 0, beta: 0, alphaDot: 0, tas: 0, cas: 0, ias: 0, eas: 0, mach: 0, qbar: 0, coefficients: { CL: 0, CD: 0, CY: 0, Cl: 0, Cm: 0, Cn: 0 }, stallWarning: false, stalled: false },
    atmosphere: { temperatureK: 288.15, pressurePa: 101325, densityKgM3: 1.225, speedOfSound: 340 },
    engine: { running: false, rpm: 0, manifoldPressureInHg: 29.9, fuelFlowKgS: 0, egtK: 300, chtK: 300, oilTempK: 300, oilPressurePa: 0, powerW: 0, thrustN: 0, torqueNm: 0, pctPower: 0 },
    surfaces: { elevatorRad: 0, aileronLeftRad: 0, aileronRightRad: 0, rudderRad: 0, flapDeg: 0, trimRad: 0, speedbrake: 0 },
    gear: [gear(), gear(), gear()],
    fuelKg: [70, 70], totalMassKg: 1000, cgM: [0, 0, 0], windNED: [0, 0, 0],
    warnings: { stall: false, overspeed: false, overG: false, gearOverspeed: false, flapOverspeed: false, lowFuel: false },
  };
}
