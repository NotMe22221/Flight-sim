/**
 * Attach optional subsystems (UI, G1000, HUD, audio, ATC) to the simulator by module path.
 * Modules are loaded with import.meta.glob so the build works whether or not each exists;
 * adapters use only each module's documented public API (checked at runtime).
 */
import type { AircraftState, Airport, SimAction, SimSnapshot } from '../core/types';
import type { Simulator } from './Simulator';
import { SimUiHost } from './uiHost';

type Ctor<T> = new (...args: never[]) => T;
const ctor = <T>(mod: Record<string, unknown>, name: string): Ctor<T> | null => (typeof mod[name] === 'function' ? (mod[name] as Ctor<T>) : null);

interface UiManagerLike { update(s: SimSnapshot, dt: number): void; show(screen: string): void; onStart?(cb: () => void): void; handleAction?(a: SimAction): boolean }
interface AudioLike { resume(): Promise<void>; update(dt: number, ac: AircraftState, cam: SimSnapshot['camera'], w: SimSnapshot['weather']): void; onTouchdown?(vs: number, drift?: number): void; setMarker?(m: 'outer' | 'middle' | 'inner' | null): void; setVolume?(bus: string, v: number): void; setMasterVolume?(v: number): void; speak?(text: string, voice?: string): void; playUi?(s: string): void }
interface HudLike { readonly canvas: HTMLCanvasElement; resize(w: number, h: number, dpr: number): void; update(s: SimSnapshot, dt: number): void }
interface G1000Like { readonly pfdCanvas: HTMLCanvasElement | OffscreenCanvas; update(s: SimSnapshot, dt: number): boolean; setNearestAirports?(l: { icao: string; lat: number; lon: number; type: string }[]): void }
interface AtcLike { update(dt: number, ac: AircraftState, w: SimSnapshot['weather']): void; select(i: number): void; reset(a: Airport | null): void }

let host: SimUiHost | null = null;
let audio: AudioLike | null = null;
let pendingUiStart: (() => void) | null = null;

export async function attachPlugin(sim: Simulator, path: string, mod: Record<string, unknown>, container: HTMLElement): Promise<void> {
  if (path.endsWith('/UiManager.ts')) {
    const UiManager = ctor<UiManagerLike>(mod, 'UiManager');
    if (!UiManager) return;
    host ??= new SimUiHost(sim);
    const ui = new (UiManager as unknown as new (c: HTMLElement, h: SimUiHost) => UiManagerLike)(container, host);
    sim.plugins.ui = { update: (s, dt) => ui.update(s, dt), handleAction: ui.handleAction ? (a) => ui.handleAction!(a) : undefined };
    const start = () => { void audio?.resume(); pendingUiStart = null; };
    pendingUiStart = start;
    ui.onStart?.(start);
    ui.show('loading');
    return;
  }
  if (path.endsWith('/AudioSystem.ts')) {
    const AudioSystem = ctor<AudioLike>(mod, 'AudioSystem');
    if (!AudioSystem) return;
    audio = new (AudioSystem as unknown as new () => AudioLike)();
    sim.plugins.audio = {
      update: (dt, ac, cam, w) => audio!.update(dt, ac, cam, w),
      onTouchdown: (vs, drift) => audio!.onTouchdown?.(vs, drift),
      setMarker: (m) => audio!.setMarker?.(m as 'outer' | 'middle' | 'inner' | null),
    };
    host ??= new SimUiHost(sim);
    host.onAudioSettings = (a) => {
      audio?.setMasterVolume?.(a.master);
      for (const bus of ['engine', 'environment', 'cockpit', 'ui', 'atc'] as const) audio?.setVolume?.(bus, a[bus]);
    };
    // browsers only allow audio after a user gesture
    const unlock = () => { void audio?.resume(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    if (pendingUiStart) pendingUiStart = () => { void audio?.resume(); };
    return;
  }
  if (path.endsWith('/Hud.ts')) {
    const Hud = ctor<HudLike>(mod, 'Hud');
    if (!Hud) return;
    const hud = new (Hud as unknown as new () => HudLike)();
    hud.canvas.classList.add('sim-hud');
    container.appendChild(hud.canvas);
    sim.plugins.hud = {
      canvas: hud.canvas,
      resize: (w, h, dpr) => hud.resize(w, h, dpr),
      update: (s, dt) => {
        const show = sim.hudVisible && sim.inFlight && s.camera.mode !== 'cockpit';
        hud.canvas.style.display = show ? 'block' : 'none';
        if (show) hud.update(s, dt);
      },
    };
    sim.resize();
    return;
  }
  if (path.endsWith('/G1000.ts')) {
    const G1000 = ctor<G1000Like>(mod, 'G1000');
    if (!G1000) return;
    const g = new (G1000 as unknown as new (o?: object) => G1000Like)({});
    sim.attachG1000({ pfdCanvas: g.pfdCanvas, update: (s, dt) => g.update(s, dt) });
    return;
  }
  if (path.endsWith('/AtcController.ts')) {
    const AtcController = ctor<AtcLike>(mod, 'AtcController');
    if (!AtcController) return;
    const atc = new (AtcController as unknown as new (o: object) => AtcLike)({
      callsign: 'N172FS',
      aircraftType: 'Cessna',
      nav: sim.nav,
      speak: (text: string, voice: 'atc' | 'pilot') => audio?.speak?.(text, voice),
      emit: (m: { from: 'atc' | 'pilot'; text: string; frequencyMHz?: number }) => sim.events.emit('atc:message', m),
      emitOptions: (options: string[]) => sim.events.emit('atc:options', { options }),
    });
    sim.plugins.atc = atc;
    return;
  }
}
