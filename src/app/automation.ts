/**
 * `window.__sim` automation hooks used by the headless smoke test and for scripted demos.
 * Contract documented in scripts/smoke.mjs.
 */
import type { CameraMode, ControlInputs, WeatherPresetId } from '../core/types';
import * as THREE from 'three';
import { C172_STEAM_LAYOUT } from '../instruments/SteamPanel';
import type { Simulator } from './Simulator';

export interface SimAutomation {
  ready: boolean;
  readonly frameCount: number;
  flyNow(): Promise<void>;
  startChallenge(id: string): Promise<void>;
  setCamera(mode: CameraMode): void;
  setTimeOfDay(localHour: number): void;
  setTimePreset(p: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night'): void;
  setWeather(preset: WeatherPresetId): void;
  setInputs(partial: Partial<ControlInputs>): void;
  clearInputs(): void;
  advance(seconds: number): Promise<void>;
  /** Scripted pilot: full-power takeoff from the current runway position and climb-out. */
  flyScriptedTakeoff(seconds: number): Promise<unknown>;
  state(): unknown;
  /** the pose being displayed (interpolated, or the slew pose), as the instruments see it */
  displayState(): unknown;
  /** enter / leave slew mode, as the Y key does */
  setSlew(on: boolean): void;
  terrainReady(): number;
  /** screen-space (CSS px) centre of a steam-panel instrument, e.g. 'alt', or null if off-screen */
  panelPoint(id: string): { x: number; y: number } | null;
  /** set the cockpit free-look offsets (rad) for screenshots */
  look(yawRad: number, pitchRad: number): void;
  stats(): unknown;
  /** the Simulator itself, for debugging and look-development experiments in a headless browser */
  readonly sim: Simulator;
}

export function installAutomation(sim: Simulator): SimAutomation {
  const api: SimAutomation = {
    ready: false,
    get frameCount() { return sim.frameCount; },
    get sim() { return sim; },
    flyNow: () => sim.flyNow(),
    startChallenge: (id) => sim.startChallenge(id),
    setCamera: (mode) => sim.cameras.setMode(mode),
    setTimeOfDay: (h) => sim.setLocalHour(h),
    setTimePreset: (p) => sim.setTimePreset(p),
    setWeather: (p) => sim.setWeatherPreset(p, 0),
    setInputs: (partial) => { Object.assign(sim.overrides, partial); },
    clearInputs: () => { for (const k of Object.keys(sim.overrides)) delete (sim.overrides as Record<string, unknown>)[k]; },
    advance: async (s) => { sim.advance(s); },
    flyScriptedTakeoff: async (seconds) => {
      const dt = 1 / 120;
      const s = sim.aircraft;
      const hdg = s.headingTrueRad;
      const o = sim.overrides;
      Object.assign(o, { parkingBrake: false, throttle: 1, flapsIndex: 1, mixture: 1, magnetos: 3, pitch: 0, roll: 0, yaw: 0 });
      let liftoffM = NaN;
      const start = [s.posNED[0], s.posNED[1]];
      for (let i = 0; i < seconds / dt && !s.crashed; i++) {
        let e = hdg - s.headingTrueRad;
        while (e > Math.PI) e -= 2 * Math.PI;
        while (e < -Math.PI) e += 2 * Math.PI;
        const kias = s.aero.ias / 0.514444;
        if (s.onGround) {
          o.yaw = Math.max(-1, Math.min(1, 3 * e - 0.8 * s.rates[2]));
          o.pitch = kias >= 55 ? 0.4 : 0;
          o.roll = 0;
        } else {
          if (Number.isNaN(liftoffM)) liftoffM = Math.hypot(s.posNED[0] - start[0], s.posNED[1] - start[1]);
          const bank = Math.max(-0.35, Math.min(0.35, 1.5 * e));
          o.roll = Math.max(-1, Math.min(1, 2 * (bank - s.euler[0]) - 0.4 * s.rates[0]));
          o.yaw = Math.max(-1, Math.min(1, 10 * s.aero.beta));
          o.pitch = Math.max(-1, Math.min(1, 1.8 * (0.14 - s.euler[1]) - 0.5 * s.rates[1]));
          if (s.altitudeAglM > 150) o.flapsIndex = 0;
        }
        sim.advance(dt);
      }
      return { liftoffM, aglM: s.altitudeAglM, kias: s.aero.ias / 0.514444, crashed: s.crashed };
    },
    state: () => JSON.parse(JSON.stringify(sim.aircraft)),
    displayState: () => JSON.parse(JSON.stringify(sim.snapshot.aircraft)),
    setSlew: (on) => sim.setSlew(on),
    terrainReady: () => sim.snapshot.terrainReady,
    look: (y, p) => { sim.cameras.state.lookYaw = y; sim.cameras.state.lookPitch = p; },
    panelPoint: (id) => {
      const it = C172_STEAM_LAYOUT.items.find((i) => i.id === id);
      if (!it) return null;
      const mesh = sim.model.panelMesh;
      const g = mesh.geometry as THREE.PlaneGeometry;
      const w = g.parameters.width, h = g.parameters.height;
      const u = (it.x + it.size / 2) / C172_STEAM_LAYOUT.width, v = 1 - (it.y + it.size / 2) / C172_STEAM_LAYOUT.height;
      const p = new THREE.Vector3((u - 0.5) * w, (v - 0.5) * h, 0).applyMatrix4(mesh.matrixWorld).project(sim.cameras.camera);
      if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return null;
      const r = sim.gfx.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    },
    stats: () => ({ fps: sim.fps, timings: { ...sim.timings }, terrain: sim.terrain?.stats() ?? null, depth: sim.gfx.depthMode, renderer: { ...sim.gfx.renderer.info.render }, memory: { ...sim.gfx.renderer.info.memory } }),
  };
  (window as unknown as { __sim: SimAutomation }).__sim = api;
  return api;
}
