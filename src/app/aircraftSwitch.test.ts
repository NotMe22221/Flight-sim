/**
 * Aircraft switching in the real Simulator (Node): the renderer, the sky and the 3D model are
 * replaced by light fakes (WebGL), everything else is the real thing — flight model, steam panel
 * (on a mock canvas), input, autopilot, assists, replay, catalog and the ActivityHost.
 */
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AircraftConfig } from '../core/types';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { CUB_STEAM_LAYOUT } from '../instruments/cub';
import { C172_STEAM_LAYOUT } from '../instruments/SteamPanel';
import { MockCanvas } from '../instruments/testing/mockCanvas';
import { AIRCRAFT, C172S_G1000, aircraftById, aircraftForActivity, radioCallsign, sameAirframe } from './aircraftCatalog';
import { makeActivityHost } from './activityHost';
import type { Simulator as SimulatorT } from './Simulator';

const fakes = vi.hoisted(() => ({ models: [] as { config: { id: string }; disposed: number }[] }));

vi.mock('./renderer', () => ({
  createRenderer: () => ({
    renderer: { domElement: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) }, shadowMap: { enabled: false }, render() {}, info: { render: {}, memory: {} } },
    depthMode: 'standard', maxAnisotropy: 8, resize() {}, setQuality() {}, dispose() {},
  }),
}));

vi.mock('../sky', async (orig) => {
  const actual = await orig<typeof import('../sky')>();
  const T = await import('three');
  class FakeSky {
    sun = { elevationRad: 0.5, azimuthRad: 0, dirThree: [0, 1, 0], moonElevationRad: 0, moonAzimuthRad: 0, moonPhase: 0 };
    lighting = { sunDirThree: new T.Vector3(0, 1, 0), sunColor: new T.Color(), sunIntensity: 1, ambientIrradiance: new T.Color(), fogColor: new T.Color(), fogDensity: 0, fogHeightFalloff: 0, sunGlowColor: new T.Color() };
    sunLight = new T.DirectionalLight();
    clouds = { group: new T.Group() };
    update() {} notifyRebase() {} resetAdaptation() {} dispose() {}
  }
  return { ...actual, SkySystem: FakeSky };
});

vi.mock('../aircraft3d', async (orig) => {
  const actual = await orig<typeof import('../aircraft3d')>();
  const T = await import('three');
  class FakeModel {
    readonly root = new T.Group();
    readonly panelMesh = new T.Mesh(new T.PlaneGeometry(0.6, 0.3), new T.MeshBasicMaterial());
    readonly panelMeshG1000 = new T.Mesh(new T.PlaneGeometry(0.96, 0.35), new T.MeshBasicMaterial());
    readonly eyePointLocal = new T.Vector3();
    readonly airframe: 'c172' | 'cub';
    variant = 'steam';
    disposed = 0;
    constructor(readonly config: AircraftConfig) { this.airframe = config.airframe ?? 'c172'; fakes.models.push(this); }
    setPose() {} update() {} setVisibility() {} setSunElevation() {}
    setPanelVariant(v: string) { this.variant = v; }
    dispose() { this.disposed++; }
  }
  return { ...actual, AircraftModel: FakeModel };
});

type FakeModelT = { config: AircraftConfig; disposed: number; root: THREE.Group; variant: string; panelMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; panelMeshG1000: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> };

let Simulator: typeof SimulatorT;
const sims: SimulatorT[] = [];

beforeAll(async () => {
  // Node: the steam panel draws on an OffscreenCanvas (here the recording mock); the simulator listens for window resizes
  const g = globalThis as Record<string, unknown>;
  g.OffscreenCanvas ??= MockCanvas;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
  g.cancelAnimationFrame ??= () => {};
  ({ Simulator } = await import('./Simulator'));
});

afterEach(() => { for (const s of sims.splice(0)) s.dispose(); });

function makeSim(): SimulatorT {
  const container = { clientWidth: 1280, clientHeight: 720, appendChild() {}, addEventListener() {} } as unknown as HTMLElement;
  const sim = new Simulator({ container, baseUrl: '/', terrain: false });
  sims.push(sim);
  return sim;
}

const model = (s: SimulatorT) => s.model as unknown as FakeModelT;

describe('aircraft catalog', () => {
  it('lists the 172S, the 172S G1000 and the Super Cub; ids and families resolve', () => {
    expect(AIRCRAFT.map((a) => a.id)).toEqual(['c172s', 'c172s-g1000', 'pa18-150']);
    expect(aircraftById('pa18-150')).toBe(PA18_150);
    expect(aircraftById('pa18')).toBe(PA18_150);
    expect(aircraftById('c172')).toBe(C172S);
    expect(aircraftById('nope')).toBeUndefined();
    expect(sameAirframe(C172S, C172S_G1000)).toBe(true);
    expect(sameAirframe(C172S, PA18_150)).toBe(false);
    // activities: a 172 lesson keeps the G1000 the pilot chose, the Cub trip switches, unknown keeps
    expect(aircraftForActivity('c172', C172S_G1000)).toBe(C172S_G1000);
    expect(aircraftForActivity('c172', PA18_150)).toBe(C172S);
    expect(aircraftForActivity('pa18-150', C172S)).toBe(PA18_150);
    expect(aircraftForActivity(undefined, PA18_150)).toBe(PA18_150);
    expect(radioCallsign(PA18_150)).toEqual({ callsign: 'N18FS', aircraftType: 'Super Cub' });
    expect(radioCallsign(C172S_G1000).callsign).toBe('N172FS');
  });
});

describe('Simulator aircraft switching', () => {
  it('starts in the 172S with its six-pack panel', () => {
    const sim = makeSim();
    expect(sim.config).toBe(C172S);
    expect(sim.panelLayout).toBe(C172_STEAM_LAYOUT);
    expect(sim.hasAutopilot).toBe(true);
    expect(model(sim).config).toBe(C172S);
  });

  it('switching to the Super Cub rebuilds the flight model, 3D model, panel, flap detents and assists, and disposes the old ones', () => {
    const sim = makeSim();
    const oldModel = model(sim), oldFdm = sim.fdm, oldSteam = sim.steam;
    const oldTex = oldModel.panelMesh.material.map!;
    const steamDispose = vi.spyOn(oldSteam, 'dispose');
    const texDispose = vi.spyOn(oldTex, 'dispose');
    const audio = { update() {}, setAircraft: vi.fn() };
    sim.plugins.audio = audio;
    const seen: string[] = [];
    sim.onAircraftChange((c) => seen.push(c.id));
    sim.input.controls.flapsIndex = 3;

    expect(sim.selectAircraft('pa18-150')).toBe(true);

    expect(sim.config).toBe(PA18_150);
    expect(sim.fdm).not.toBe(oldFdm);
    expect(sim.fdm.config).toBe(PA18_150);
    expect(oldModel.disposed).toBe(1);
    expect(steamDispose).toHaveBeenCalledTimes(1);
    expect(texDispose).toHaveBeenCalledTimes(1);
    expect(sim.scene.children).not.toContain(oldModel.root);
    expect(sim.scene.children).toContain(model(sim).root);
    expect(model(sim).config).toBe(PA18_150);
    // the new panel texture is bound to the new cockpit and wraps the new panel's canvas
    const tex = model(sim).panelMesh.material.map as THREE.CanvasTexture;
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    expect(tex.image).toBe(sim.steam.canvas);
    expect(sim.panelLayout).toBe(CUB_STEAM_LAYOUT);
    expect(sim.steam.spec.panel).toBe('cub-steam');
    // three flap positions (0/25/50)
    expect(sim.input.controls.flapsIndex).toBe(2);
    expect(sim.flightAssists.config.antiStall.speedFloorMs).toBeGreaterThan(0);
    expect(audio.setAircraft).toHaveBeenCalledWith(PA18_150);
    expect(seen).toEqual(['pa18-150']);
    // the snapshot shows the new aircraft's state (tail wheel + structure points)
    expect(sim.snapshot.aircraft.gear.length).toBe(sim.fdm.state.gear.length);
    expect(sim.panelVariant).toBe('steam');

    // selecting it again changes nothing
    expect(sim.selectAircraft('pa18-150')).toBe(true);
    expect(fakes.models.filter((m) => m.disposed === 0).length).toBeGreaterThan(0);
    expect(seen).toEqual(['pa18-150']);

    // and back to the 172: the Cub's parts are disposed in turn
    const cub = model(sim);
    sim.selectAircraft('c172s');
    expect(cub.disposed).toBe(1);
    expect(sim.config).toBe(C172S);
    expect(sim.panelLayout).toBe(C172_STEAM_LAYOUT);
    expect(sim.flightAssists.config.antiStall.speedFloorMs).toBe(0);
    expect(seen).toEqual(['pa18-150', 'c172s']);
  });

  it('unknown ids change nothing', () => {
    const sim = makeSim();
    const m = sim.model;
    expect(sim.selectAircraft('a380')).toBe(false);
    expect(sim.model).toBe(m);
    expect(sim.config).toBe(C172S);
  });

  it('172S ↔ 172S G1000 keeps the airframe and only swaps the panel (steam when no G1000 is attached)', () => {
    const sim = makeSim();
    const m = sim.model, f = sim.fdm;
    sim.selectAircraft('c172s-g1000');
    expect(sim.model).toBe(m);
    expect(sim.fdm).toBe(f);
    // no glass cockpit plugin: the steam panel stays and the catalog entry follows it
    expect(sim.panelVariant).toBe('steam');
    expect(sim.config).toBe(C172S);
    const canvas = new MockCanvas(2769, 1008) as unknown as HTMLCanvasElement;
    sim.attachG1000({ pfdCanvas: canvas, update: () => false });
    sim.selectAircraft('c172s-g1000');
    expect(sim.panelVariant).toBe('g1000');
    expect(sim.config).toBe(C172S_G1000);
    expect((model(sim).panelMeshG1000.material.map as THREE.CanvasTexture).image).toBe(canvas);
    // the Cub has no glass cockpit: setPanel('g1000') keeps its steam panel
    sim.selectAircraft('pa18-150');
    sim.setPanel('g1000');
    expect(sim.panelVariant).toBe('steam');
    expect(sim.config).toBe(PA18_150);
    // back to the G1000 172: the glass texture is bound to the rebuilt model's G1000 plane
    sim.selectAircraft('c172s-g1000');
    expect(sim.panelVariant).toBe('g1000');
    expect((model(sim).panelMeshG1000.material.map as THREE.CanvasTexture).image).toBe(canvas);
  });

  it('the Super Cub has no autopilot: AP keys and the heading bug do nothing, the autopilot is not run', () => {
    const sim = makeSim();
    sim.handleAction('apToggle');
    expect(sim.autopilot.state.engaged).toBe(true);
    sim.selectAircraft('pa18-150');
    expect(sim.autopilot.state.engaged).toBe(false);
    const bug = sim.autopilot.state.headingBugDeg;
    for (const a of ['apToggle', 'apHdg', 'apAlt', 'apLvl', 'fdToggle', 'headingBugInc', 'apAltInc'] as const) sim.handleAction(a);
    expect(sim.autopilot.state.engaged).toBe(false);
    expect(sim.autopilot.state.flightDirector).toBe(false);
    expect(sim.autopilot.state.headingBugDeg).toBe(bug);
    expect(sim.hasAutopilot).toBe(false);
    // flying a few seconds never engages or updates it
    sim.fdm.reset({ geo: { lat: 37.6, lon: -122.4, alt: 900 }, headingRad: 0, speedMs: 45, onGround: false, engineRunning: true }, sim.world.env);
    sim.advance(2);
    expect(sim.autopilot.state.engaged).toBe(false);
    expect(sim.autopilot.state.altAlert ?? 'none').toBe('none');
    // back in the 172 the keys work again
    sim.selectAircraft('c172s');
    sim.handleAction('apToggle');
    expect(sim.autopilot.state.engaged).toBe(true);
  });

  it('the replay and slew do not carry over to another airframe; the new flight model flies', () => {
    const sim = makeSim();
    const s = sim.fdm.state;
    for (let i = 0; i < 40; i++) sim.replay.record(1 / 30, s, sim.effective);
    expect(sim.replay.length).toBeGreaterThan(0);
    sim.selectAircraft('pa18-150');
    expect(sim.replay.length).toBe(0);
    expect(sim.replayer.active).toBe(false);
    expect(sim.replayer.enter()).toBe(false); // nothing to replay from the old airframe
    // the Cub on the ground: three-point attitude, nothing NaN after a few seconds of physics
    sim.fdm.reset({ geo: { lat: 37.6, lon: -122.4, alt: 4 }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, sim.world.env);
    sim.advance(3);
    const st = sim.fdm.state;
    expect(st.crashed).toBe(false);
    expect(Number.isFinite(st.posNED[2])).toBe(true);
    expect(st.euler[1] * 180 / Math.PI).toBeGreaterThan(8);
    // and it records again for the new airframe
    for (let i = 0; i < 10; i++) sim.replay.record(1 / 30, st, sim.effective);
    expect(sim.replay.length).toBeGreaterThan(0);
  });

  it('activities fly their own aircraft through the ActivityHost; landing challenges keep the 172', () => {
    const sim = makeSim();
    const host = makeActivityHost(sim);
    void host.useAircraft?.('pa18-150');
    expect(sim.config).toBe(PA18_150);
    void host.useAircraft?.('c172');
    expect(sim.config).toBe(C172S);
    sim.attachG1000({ pfdCanvas: new MockCanvas(2769, 1008) as unknown as HTMLCanvasElement, update: () => false });
    sim.selectAircraft('c172s-g1000');
    void host.useAircraft?.('c172');
    expect(sim.config).toBe(C172S_G1000);
    sim.selectAircraft('pa18-150');
    sim.useAircraftFor('c172'); // what startChallenge does first
    expect(sim.config).toBe(C172S);
  });
});
