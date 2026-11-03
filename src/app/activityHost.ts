/**
 * ActivityHost for the simulator: how lessons and bush-trip legs set up their flights
 * (src/activities ActivityRunner). Spawns go through the Simulator's own spawn paths.
 */
import type { ActivityHost } from '../activities';
import type { Simulator } from './Simulator';

export function makeActivityHost(sim: Simulator, speak?: (text: string) => void): ActivityHost {
  return {
    async spawnAtRunway(icao, runway, opts = {}) {
      await sim.nav.load();
      const ap = sim.nav.getAirport(icao);
      if (!ap) throw new Error(`${icao} is not in the airport database`);
      await sim.nav.loadRegion(ap.position, 30);
      await sim.spawnAtRunway(ap, runway, { coldAndDark: opts.coldAndDark, fuelFraction: opts.fuelFraction, payloadKg: opts.payloadKg });
      if (opts.parkingBrake !== undefined) sim.input.controls.parkingBrake = opts.parkingBrake;
    },
    spawnInAir: (lat, lon, altM, headingDeg, iasMs, opts) => sim.spawnInAir(lat, lon, altM, headingDeg, iasMs, opts),
    setWeatherPreset: (id) => sim.setWeatherPreset(id),
    setTimePreset: (p) => sim.setTimePreset(p),
    loadRoute: (wps) => sim.planner.setWaypoints(wps),
    clearRoute: () => sim.planner.clear(),
    speak,
  };
}
