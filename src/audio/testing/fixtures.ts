/**
 * Shared fixtures for the audio tests: camera / weather states and a resumed mock graph.
 * Test-only code.
 */
import type { CameraMode, CameraState, WeatherState } from '../../core/types';
import { AudioGraph } from '../graph';
import { asAudioContext, MockAudioContext } from './mockAudioContext';

/** A CameraState with neutral defaults. */
export function makeCamera(mode: CameraMode = 'cockpit', o: Partial<CameraState> = {}): CameraState {
  return {
    mode, lookYaw: 0, lookPitch: 0, orbitYaw: 0, orbitPitch: 0, orbitDistanceM: 30, fovDeg: 70,
    dronePosNED: [0, 0, 0], droneYaw: 0, dronePitch: 0, ...o,
  };
}

/** A clear-sky WeatherState. */
export function makeWeather(o: Partial<WeatherState> = {}): WeatherState {
  return {
    preset: 'clear', clouds: [], winds: [], precipitationRate: 0, precipitationType: 'none', thunderstorm: false,
    humidity: 0.5, qnhPa: 101325, temperatureC: 15, aerosol: 0.1, visibilityM: 30000, turbulence: 0, fogTopM: 0, ...o,
  };
}

/** A mock context + graph, already resumed (state 'running'). */
export async function makeRunningGraph(): Promise<{ mock: MockAudioContext; graph: AudioGraph; ctx: AudioContext }> {
  const mock = new MockAudioContext();
  const graph = new AudioGraph(() => asAudioContext(mock));
  const ok = await graph.resume();
  if (!ok || !graph.ctx) throw new Error('mock graph failed to resume');
  return { mock, graph, ctx: graph.ctx };
}
