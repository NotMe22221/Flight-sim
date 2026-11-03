import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import { VIEW, ViewStage } from './ViewStage';
import { makeCamera, makeRunningGraph } from './testing/fixtures';
import type { MockAudioNode, MockAudioParam } from './testing/mockAudioContext';

async function setup() {
  const { mock, graph, ctx } = await makeRunningGraph();
  const b = graph.buses!;
  const stage = new ViewStage(ctx, b.bus.engine, b.bus.environment, b.master, b.cabin);
  return { mock, graph, stage, cabin: b.cabin.gain as unknown as MockAudioParam };
}

describe('ViewStage', () => {
  it('cockpit: engine muffled at ~1.2 kHz; exterior: bright', async () => {
    const { stage, cabin } = await setup();
    const ac = makeAircraftState({ velNED: [50, 0, 0] });
    stage.update(ac, makeCamera('cockpit'));
    expect(stage.exterior).toBe(false);
    expect(stage.engineCutoffHz).toBe(VIEW.cabinEngineCutoffHz);
    expect(stage.engineCutoffHz).toBeCloseTo(1200, 6);
    expect(stage.envCutoffHz).toBe(VIEW.cabinEnvCutoffHz);
    expect(cabin.target).toBe(1);
    stage.update(ac, makeCamera('chase'));
    expect(stage.exterior).toBe(true);
    expect(stage.engineCutoffHz).toBeGreaterThanOrEqual(10000);
    expect(stage.doppler).toBe(1); // chase camera moves with the aircraft
    expect(cabin.target).toBeCloseTo(VIEW.cockpitBusExterior, 9);
  });

  it('distant fixed camera: air absorption darkens the sound', async () => {
    const { stage } = await setup();
    const ac = makeAircraftState({ posNED: [3000, 0, -300], velNED: [0, 0, 0] });
    stage.setListener([0, 0, -2]);
    stage.update(ac, makeCamera('tower'));
    expect(stage.distanceM).toBeCloseTo(Math.hypot(3000, 298), 3);
    expect(stage.engineCutoffHz).toBeLessThan(4000);
  });

  it('Doppler from camera-relative velocity: approaching raises, receding lowers', async () => {
    const { stage } = await setup();
    const cam = makeCamera('drone', { dronePosNED: [500, 0, -100] });
    stage.update(makeAircraftState({ posNED: [0, 0, -100], velNED: [60, 0, 0] }), cam);
    const c = 340.29;
    expect(stage.doppler).toBeCloseTo(c / (c - 60), 3);
    stage.update(makeAircraftState({ posNED: [1000, 0, -100], velNED: [60, 0, 0] }), cam);
    expect(stage.doppler).toBeCloseTo(c / (c + 60), 3);
  });

  it('drone camera pans toward the aircraft side', async () => {
    const { mock, stage } = await setup();
    // drone at origin looking north, aircraft due east → pan right
    stage.update(makeAircraftState({ posNED: [0, 200, 0] }), makeCamera('drone', { droneYaw: 0 }));
    const panner = mock.nodesOfKind<{ pan: MockAudioParam } & import('./testing/mockAudioContext').MockAudioNode>('stereoPanner')[0];
    expect(panner.pan.target).toBeCloseTo(0.8, 6);
  });

  it('ducks the engine while ATC speaks, without direct .value writes', async () => {
    const { mock, stage } = await setup();
    stage.update(makeAircraftState(), makeCamera('cockpit'));
    const levels = () => mock.nodesOfKind<import('./testing/mockAudioContext').MockGainNode>('gain').map((g) => g.gain.target);
    expect(levels()).toContain(VIEW.cabinEngineLevel);
    stage.setDuck(true);
    expect(levels()).toContain(VIEW.cabinEngineLevel * VIEW.duck);
    stage.setDuck(false);
    expect(mock.audibleDirectWrites()).toEqual([]);
  });

  it('dispose detaches the stage from the engine / environment buses (no dead filters left hanging)', async () => {
    const { graph, stage } = await setup();
    const b = graph.buses!;
    const eng = b.bus.engine as unknown as MockAudioNode, env = b.bus.environment as unknown as MockAudioNode;
    expect(eng.outputs.length).toBe(1);
    expect(env.outputs.length).toBe(1);
    stage.dispose();
    expect(eng.outputs).toEqual([]);
    expect(env.outputs).toEqual([]);
    expect(() => stage.dispose()).not.toThrow(); // idempotent
  });
});
