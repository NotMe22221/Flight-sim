/**
 * Attach optional subsystems (UI, G1000, HUD, audio, ATC) to the simulator by module path.
 * Modules are loaded with import.meta.glob so the build works whether or not each exists;
 * adapters use only each module's documented public API (checked at runtime).
 */
import type { AircraftState, Airport, SimAction, SimSnapshot } from '../core/types';
import * as THREE from 'three';
import type { LocalFrame } from '../geo/wgs84';
import type { G1000PanelLike, SceneryLike, Simulator } from './Simulator';
import { SimUiHost } from './uiHost';

type Ctor<T> = new (...args: never[]) => T;
const ctor = <T>(mod: Record<string, unknown>, name: string): Ctor<T> | null => (typeof mod[name] === 'function' ? (mod[name] as Ctor<T>) : null);

interface UiManagerLike { update(s: SimSnapshot, dt: number): void; show(screen: string): void; onStart?(cb: () => void): void; handleAction?(a: SimAction): boolean; readonly coversView?: boolean }
interface AudioLike { resume(): Promise<void>; update(dt: number, ac: AircraftState, cam: SimSnapshot['camera'], w: SimSnapshot['weather']): void; updateSnapshot?(dt: number, s: SimSnapshot): void; setSurface?(s: string): void; setListener?(posNED: [number, number, number] | null, velNED?: [number, number, number]): void; onTouchdown?(vs: number, drift?: number): void; setMarker?(m: 'outer' | 'middle' | 'inner' | null): void; setVolume?(bus: string, v: number): void; setMasterVolume?(v: number): void; speak?(text: string, voice?: string): void; playUi?(s: string): void }
interface HudLike { readonly canvas: HTMLCanvasElement; resize(w: number, h: number, dpr: number): void; update(s: SimSnapshot, dt: number): void; reset?(): void }
interface G1000Like { readonly pfdCanvas: HTMLCanvasElement | OffscreenCanvas; update(s: SimSnapshot, dt: number): boolean; reset(s: SimSnapshot): void; setNearestAirports(l: readonly Airport[]): void }
type G1000Full = G1000Like & { readonly mfdCanvas: HTMLCanvasElement | OffscreenCanvas; readonly com1: { activeKHz: number; standbyKHz: number } };
/** instruments/g1000/panel.ts `G1000Panel`: both GDUs on one canvas, UV → bezel control */
type G1000PanelFull = G1000PanelLike & { readonly canvas: HTMLCanvasElement; compose(): boolean; invalidate(): void };
interface AtcLike { update(dt: number, ac: AircraftState, w: SimSnapshot['weather'], utcMs?: number): void; select(i: number): void; reset(a: Airport | null): void }

/** What `createScenery` (src/scenery/index.ts) receives from the simulator. */
export interface SceneryHostOptions {
  /** add all scenery objects under this group (part of the scene graph) */
  parent: THREE.Group;
  /** current local frame (also passed again through setFrame on a new flight / rebase) */
  frame: LocalFrame;
  /** ground up-coordinate (−D, includes runway flattening and earth curvature) under a NED point, or null before terrain data exists there */
  groundUp(north: number, east: number): number | null;
  /** terrain height above MSL at a geodetic point from the finest loaded tile, or null */
  heightAt(lat: number, lon: number): number | null;
  /** depth buffer mode of the renderer: custom shaders must support it (log depth needs the logdepthbuf chunks) */
  depthMode: string;
  quality: 'low' | 'medium' | 'high' | 'ultra';
  /** vector tile URL template override from the page's `?osm=` query parameter (e.g. a local fixture server) */
  tileUrl?: string;
}

let host: SimUiHost | null = null;
let audio: AudioLike | null = null;

export async function attachPlugin(sim: Simulator, path: string, mod: Record<string, unknown>, container: HTMLElement): Promise<void> {
  if (path.endsWith('/ui/index.ts')) {
    const UiManager = ctor<UiManagerLike>(mod, 'UiManager');
    if (!UiManager) return;
    host ??= new SimUiHost(sim);
    const ui = new (UiManager as unknown as new (c: HTMLElement, h: SimUiHost) => UiManagerLike)(container, host);
    sim.plugins.ui = { update: (s, dt) => ui.update(s, dt), handleAction: ui.handleAction ? (a) => ui.handleAction!(a) : undefined, coversView: () => ui.coversView === true };
    ui.onStart?.(() => { void audio?.resume(); });
    ui.show('loading');
    return;
  }
  if (path.endsWith('/scenery/index.ts')) {
    const create = mod.createScenery as ((o: SceneryHostOptions) => SceneryLike) | undefined;
    if (typeof create !== 'function') return;
    const parent = new THREE.Group();
    parent.name = 'scenery';
    sim.scene.add(parent);
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    sim.plugins.scenery = create({
      parent,
      frame: sim.world.frame,
      groundUp: (n, e) => sim.world.groundHeight(n, e),
      heightAt: (lat, lon) => sim.terrain?.heightAt(lat, lon) ?? null,
      depthMode: String(sim.gfx.depthMode),
      quality: sim.opts.quality ?? 'high',
      tileUrl: q?.get('osm') ?? undefined,
    });
    return;
  }
  if (path.endsWith('/AudioSystem.ts')) {
    const AudioSystem = ctor<AudioLike>(mod, 'AudioSystem');
    if (!AudioSystem) return;
    // with `events` the audio system handles touchdown, autopilot disconnect and flight reset itself
    audio = new (AudioSystem as unknown as new (o: object) => AudioLike)({ config: sim.config, events: sim.events });
    const camPos: [number, number, number] = [0, 0, 0];
    const camVel: [number, number, number] = [0, 0, 0];
    let lastX = NaN, lastY = 0, lastZ = 0;
    sim.plugins.audio = {
      update: (dt) => {
        const a = audio!;
        const p = sim.cameras.positionThree();
        // render frame (x E, y U, z S) → NED
        camPos[0] = -p.z; camPos[1] = p.x; camPos[2] = -p.y;
        if (dt > 0 && !Number.isNaN(lastX)) { camVel[0] = -(p.z - lastZ) / dt; camVel[1] = (p.x - lastX) / dt; camVel[2] = -(p.y - lastY) / dt; }
        lastX = p.x; lastY = p.y; lastZ = p.z;
        a.setSurface?.(sim.world.env.surface);
        a.setListener?.(sim.cameras.state.mode === 'cockpit' ? null : camPos, camVel);
        if (a.updateSnapshot) a.updateSnapshot(dt, sim.snapshot);
        else a.update(dt, sim.snapshot.aircraft, sim.snapshot.camera, sim.snapshot.weather);
      },
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
    return;
  }
  if (path.endsWith('/Hud.ts')) {
    const Hud = ctor<HudLike>(mod, 'Hud');
    if (!Hud) return;
    const hud = new (Hud as unknown as new () => HudLike)();
    hud.canvas.classList.add('sim-hud');
    container.appendChild(hud.canvas);
    // The instruments HUD replaces the UI's own top flight strip (they would overlap).
    const style = document.createElement('style');
    style.textContent = '.fs-ui .hud-strip { display: none !important; }';
    document.head.appendChild(style);
    sim.plugins.hud = {
      canvas: hud.canvas,
      resize: (w, h, dpr) => hud.resize(w, h, dpr),
      reset: () => hud.reset?.(),
      update: (s, dt) => {
        // the HUD itself draws only warning flags and status in the cockpit view
        // Settings > Flight info strip off hides the HUD's flight data (the UI's own strip is suppressed above)
        const show = sim.hudVisible && sim.inFlight && !sim.replayer.active && host?.infoStrip !== false;
        // the UI's status bar and pause menu already show terrain loading and PAUSED
        (hud as HudLike & { showStatus?: boolean }).showStatus = !sim.plugins.ui;
        hud.canvas.style.display = show ? 'block' : 'none';
        if (show) hud.update(s, dt);
      },
    };
    sim.resize();
    return;
  }
  if (path.endsWith('/G1000.ts')) {
    const G1000 = ctor<G1000Like>(mod, 'G1000');
    const Panel = ctor<G1000PanelFull>(mod, 'G1000Panel');
    const apply = mod.applyG1000Command as ((c: unknown, host: object) => boolean) | undefined;
    const syncCom1 = mod.syncCom1 as ((box: { activeKHz: number; standbyKHz: number }, com1: { activeMHz: number; standbyMHz: number }) => void) | undefined;
    if (!G1000 || !Panel || typeof apply !== 'function') return;
    // G1000 requests act on the simulator's radios, autopilot and altimeter (instruments/g1000/wiring.ts)
    const host = {
      navTuning: sim.radios.tuning,
      tuneNavActive: (i: 0 | 1, kHz: number) => sim.radios.tuneNav(i, kHz),
      com1: sim.radios.state.com1,
      setNavSource: (src: 'gps' | 'nav1' | 'nav2') => sim.autopilot.setNavSource(src),
      // the steam panel's knobs take the same path: reported with the next frame's inputs
      action: (a: SimAction) => sim.input.applyAction(a as never),
      setAltimeterStd: () => sim.fdm.setAltimeter(101325),
    };
    const g = new (G1000 as unknown as new (o: object) => G1000Full)({ nav: sim.nav, planner: sim.planner, onCommand: (c: unknown) => apply(c, host) });
    // one panel texture with the PFD (left) and MFD (right) side by side, as in the 172 G1000
    const panel = new (Panel as unknown as new (g: G1000Full) => G1000PanelFull)(g);
    let nearbyTimer = Infinity;
    sim.attachG1000({
      pfdCanvas: panel.canvas,
      interactive: panel,
      reset: (s) => { g.reset(s); panel.invalidate(); nearbyTimer = Infinity; },
      update: (s, dt) => {
        nearbyTimer += dt;
        if (nearbyTimer > 2) { nearbyTimer = 0; g.setNearestAirports(sim.nearby); }
        // COM1 lives in the radio stack (keyboard swap, ATC): mirror it into the G1000's COM1 box
        syncCom1?.(g.com1, sim.radios.state.com1);
        g.update(s, dt);
        return panel.compose();
      },
    });
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
    // pass the world clock so ATIS reports the simulated Zulu time
    sim.plugins.atc = { update: (dt, ac, w) => atc.update(dt, ac, w, sim.time.utcMs), select: (i) => atc.select(i), reset: (a) => atc.reset(a) };
    return;
  }
}
