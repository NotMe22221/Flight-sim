/**
 * Attach optional subsystems (UI, G1000, HUD, audio, ATC) to the simulator by module path.
 * Modules are loaded with import.meta.glob so the build works whether or not each exists;
 * adapters use only each module's documented public API (checked at runtime).
 */
import type { AircraftState, Airport, SimAction, SimSnapshot } from '../core/types';
import * as THREE from 'three';
import type { LocalFrame } from '../geo/wgs84';
import type { SceneryLike, Simulator } from './Simulator';
import { SimUiHost } from './uiHost';

type Ctor<T> = new (...args: never[]) => T;
const ctor = <T>(mod: Record<string, unknown>, name: string): Ctor<T> | null => (typeof mod[name] === 'function' ? (mod[name] as Ctor<T>) : null);

interface UiManagerLike { update(s: SimSnapshot, dt: number): void; show(screen: string): void; onStart?(cb: () => void): void; handleAction?(a: SimAction): boolean }
interface AudioLike { resume(): Promise<void>; update(dt: number, ac: AircraftState, cam: SimSnapshot['camera'], w: SimSnapshot['weather']): void; updateSnapshot?(dt: number, s: SimSnapshot): void; setSurface?(s: string): void; setListener?(posNED: [number, number, number] | null, velNED?: [number, number, number]): void; onTouchdown?(vs: number, drift?: number): void; setMarker?(m: 'outer' | 'middle' | 'inner' | null): void; setVolume?(bus: string, v: number): void; setMasterVolume?(v: number): void; speak?(text: string, voice?: string): void; playUi?(s: string): void }
interface HudLike { readonly canvas: HTMLCanvasElement; resize(w: number, h: number, dpr: number): void; update(s: SimSnapshot, dt: number): void }
interface G1000Like { readonly pfdCanvas: HTMLCanvasElement | OffscreenCanvas; update(s: SimSnapshot, dt: number): boolean; setNearestAirports?(l: { icao: string; lat: number; lon: number; type: string }[]): void }
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
    sim.plugins.ui = { update: (s, dt) => ui.update(s, dt), handleAction: ui.handleAction ? (a) => ui.handleAction!(a) : undefined };
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
      update: (s, dt) => {
        // the HUD itself draws only warning flags and status in the cockpit view
        const show = sim.hudVisible && sim.inFlight && !sim.replayer.active;
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
    type G1000Full = G1000Like & { readonly mfdCanvas: HTMLCanvasElement | OffscreenCanvas; readonly changed?: { pfd: boolean; mfd: boolean } };
    const g = new (G1000 as unknown as new (o?: object) => G1000Full)({});
    // One panel texture with the PFD (left) and MFD (right) side by side, as in the 172 G1000.
    const pfd = g.pfdCanvas, mfd = g.mfdCanvas;
    const gap = Math.round(pfd.width * 0.06);
    const panel = document.createElement('canvas');
    panel.width = pfd.width + gap + mfd.width;
    panel.height = Math.max(pfd.height, mfd.height);
    const ctx = panel.getContext('2d')!;
    ctx.fillStyle = '#16191d';
    ctx.fillRect(0, 0, panel.width, panel.height);
    let nearbyTimer = Infinity;
    sim.attachG1000({
      pfdCanvas: panel,
      update: (s, dt) => {
        nearbyTimer += dt;
        if (nearbyTimer > 2 && g.setNearestAirports) {
          nearbyTimer = 0;
          g.setNearestAirports(sim.nearby.map((a) => ({ icao: a.icao, lat: a.position.lat, lon: a.position.lon, type: a.type })));
        }
        if (!g.update(s, dt)) return false;
        // redraw only the display(s) that changed this frame
        const ch = g.changed ?? { pfd: true, mfd: true };
        if (ch.pfd) ctx.drawImage(pfd as CanvasImageSource, 0, 0);
        if (ch.mfd) ctx.drawImage(mfd as CanvasImageSource, pfd.width + gap, 0);
        return true;
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
