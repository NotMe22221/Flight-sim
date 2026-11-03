/**
 * The re-seat Simulator.physicsStep applies when terrain under a standing or taxiing aircraft
 * reloads with new heights (pavement flattening, a finer LOD): World.groundShift + a vertical
 * Fdm.rebase. Without it a 0.5 m rise drives the gear through its travel ('gear collapse' crash)
 * and a drop lets the aircraft fall.
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type Airport, type NavDatabase, type Navaid, type Vec3 } from '../core/types';
import { C172S } from '../fdm/aircraft/c172';
import { Fdm } from '../fdm/fdm';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { World } from '../world/World';

const LAT = 37.6172, LON = -122.3867;
const ap: Airport = { icao: 'KSFO', name: 'SFO', position: { lat: 37.62, lon: -122.375, alt: 4 }, elevationM: 4, type: 'large', country: 'US', runways: [] };
const nav: NavDatabase = {
  loadRegion: async () => {}, getAirport: () => ap, nearestAirports: () => [ap], nearestNavaids: (): Navaid[] => [],
  searchAirports: () => [ap], findNavaidByFrequency: () => undefined, findIlsByFrequency: () => undefined,
};

/** Flat terrain at `ground.h` m (local up) whose revision bumps when the test moves it. */
function fakeTerrain(ground: { h: number; rev: number }): TerrainSystem {
  return {
    group: new (class { add() {} })() as never,
    heightAtLocalNED: () => ground.h,
    groundNormalNED: (_n: number, _e: number, out: Vec3) => { out[0] = 0; out[1] = 0; out[2] = -1; return out; },
    revision: () => ground.rev,
    setFrame: () => {}, setRunways: () => {}, setPavement: () => {}, update: () => {}, dispose: () => {},
  } as unknown as TerrainSystem;
}

function run(opts: { reseat: boolean; jumpM: number; speedMs: number }) {
  const ground = { h: 4, rev: 1 };
  const world = new World(fakeTerrain(ground), nav, null, LAT, LON);
  const fdm = new Fdm(C172S, { seed: 1 });
  const u = defaultControlInputs();
  u.parkingBrake = opts.speedMs === 0;
  fdm.reset({ geo: { lat: LAT, lon: LON, alt: 4 }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: opts.speedMs > 0 }, world.env);
  const shiftNED: Vec3 = [0, 0, 0];
  const step = () => {
    const s = fdm.state;
    // what Simulator.physicsStep does before every Fdm.step
    const shift = world.groundShift(s.posNED[0], s.posNED[1]);
    if (opts.reseat && shift !== 0 && s.onGround) { shiftNED[2] = shift; fdm.rebase([1, 0, 0, 0], shiftNED); }
    world.env.surface = 'paved';
    fdm.step(1 / 120, u, world.env);
  };
  if (opts.speedMs > 0) { u.throttle = 0.3; u.mixture = 1; u.magnetos = 3; }
  for (let i = 0; i < 240; i++) step(); // settle on the gear
  if (opts.speedMs > 0) for (let i = 0; i < 1200 && fdm.state.groundSpeedMs < opts.speedMs; i++) step();
  const hBefore = -fdm.state.posNED[2] - ground.h;
  ground.h += opts.jumpM; ground.rev++; // the tile under the aircraft reloads with new heights
  let maxVz = 0;
  for (let i = 0; i < 360; i++) {
    step();
    maxVz = Math.max(maxVz, Math.abs(fdm.state.velNED[2]));
  }
  return { crashed: fdm.state.crashed, reason: fdm.crashReason, maxVz, onGround: fdm.state.onGround, heightChange: -fdm.state.posNED[2] - ground.h - hBefore };
}

describe('ground re-seat when terrain under the aircraft reloads', () => {
  it('a parked aircraft rides a 0.5 m rise and a 0.5 m drop without a crash, a bounce or a fall', () => {
    for (const jumpM of [0.5, -0.5]) {
      const r = run({ reseat: true, jumpM, speedMs: 0 });
      expect(r.crashed).toBe(false);
      expect(r.onGround).toBe(true);
      expect(r.maxVz).toBeLessThan(0.05);
      expect(Math.abs(r.heightChange)).toBeLessThan(0.01);
    }
  });

  it('a taxiing aircraft is not launched or damaged either', () => {
    const r = run({ reseat: true, jumpM: 0.5, speedMs: 4 });
    expect(r.crashed).toBe(false);
    expect(r.onGround).toBe(true);
    expect(r.maxVz).toBeLessThan(0.2);
  });

  it('without the re-seat the same reload damages or launches the aircraft (why it exists)', () => {
    const up = run({ reseat: false, jumpM: 0.5, speedMs: 0 });
    expect(up.crashed || up.maxVz > 1).toBe(true);
    const down = run({ reseat: false, jumpM: -0.5, speedMs: 0 });
    expect(down.maxVz).toBeGreaterThan(1);
  });
});
