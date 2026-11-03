/**
 * The simulator's audio mixer (implements `AudioMixer`, docs/research/06 §A9): owns the
 * AudioGraph, the view stage and the engine / environment / warning voices, plus speech.
 *
 * Headless-safe: without Web Audio (Node, tests, the smoke test, old browsers) every method is a
 * silent no-op and nothing throws. Speech works independently of the AudioContext.
 *
 * Per frame call `update(dt, ac, camera, weather)` (or `updateSnapshot(dt, snap)`); optionally
 * feed `setControls(inputs)` (starter, throttle), `setSurface(env.surface)` and the real camera
 * pose with `setListener` for accurate exterior Doppler.
 */
import type { EventBus } from '../core/events';
import type {
  AircraftConfig, AircraftState, AudioMixer, AutopilotState, CameraState, ControlInputs, SimSnapshot, Vec3, WeatherState,
} from '../core/types';
import { EngineSynth, type EngineSynthInput } from './EngineSynth';
import { EnvironmentSynth } from './Environment';
import type { SurfaceKind } from './environmentLaws';
import { AudioGraph, type AudioContextFactory, type BusName, defaultContextFactory } from './graph';
import { type AudioProfile, audioProfileFromConfig, C172_AUDIO_PROFILE } from './profile';
import { playSquelch } from './radio';
import { Speech, type SpeechOptions, type SpeechRole } from './Speech';
import type { UiSound } from './uiSounds';
import { ViewStage } from './ViewStage';
import { type MarkerBeacon, Warnings } from './Warnings';

/** Construction options. */
export interface AudioSystemOptions {
  /** aircraft whose engine / prop / gear the synth models (default: C172 profile) */
  config?: AircraftConfig;
  /** explicit profile (overrides `config`) */
  profile?: AudioProfile;
  /** AudioContext factory; `() => null` forces headless mode (default: browser AudioContext) */
  contextFactory?: AudioContextFactory;
  /** speech options, or null to disable speech */
  speech?: Omit<SpeechOptions, 'onTransmission' | 'volume'> | null;
  /** subscribe to touchdown / autopilot / reset events */
  events?: EventBus;
}

interface Voices {
  generation: number;
  stage: ViewStage;
  engine: EngineSynth;
  env: EnvironmentSynth;
  warnings: Warnings;
}

/** Procedural Web Audio mixer for the simulator. */
export class AudioSystem implements AudioMixer {
  private readonly graph: AudioGraph;
  private readonly speech: Speech | null;
  private profile: AudioProfile;
  private voices: Voices | null = null;
  private surface: SurfaceKind = 'paved';
  private starter: boolean | null = null;
  private throttle: number | null = null;
  private marker: MarkerBeacon | null = null;
  private listenerPos: Vec3 | null = null;
  private readonly listenerVel: Vec3 = [0, 0, 0];
  private lastApEngaged: boolean | null = null;
  private failed = false;
  private disposed = false;
  private badFrames = 0;
  private warned = false;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly engineIn: EngineSynthInput = {
    rpm: 0, running: false, manifoldPressureInHg: 29.92, throttle: null, starter: null, thrustN: 0, tasMs: 0, speedOfSound: 340,
  };

  constructor(opts: AudioSystemOptions = {}) {
    this.profile = opts.profile ?? (opts.config ? audioProfileFromConfig(opts.config) : { ...C172_AUDIO_PROFILE });
    this.graph = new AudioGraph(opts.contextFactory ?? defaultContextFactory);
    this.speech = opts.speech === null ? null : safe(() => new Speech({
      ...opts.speech,
      volume: () => this.graph.masterVolume() * this.graph.busVolume('atc') * (this.graph.isMuted ? 0 : 1),
      onTransmission: (role, phase) => this.onTransmission(role, phase),
    }), null);
    const ev = opts.events;
    if (ev) {
      this.unsubscribe.push(
        ev.on('aircraft:touchdown', (e) => this.onTouchdown(e.verticalSpeedMs, e.lateralDriftMs)),
        ev.on('autopilot:changed', (e) => this.onAutopilot(e.state)),
        ev.on('flight:reset', (e) => this.onFlightReset(e.spawn.engineRunning)),
      );
    }
  }

  /** True when sound is actually being produced (context running, voices built). */
  get ready(): boolean { return this.voices !== null && this.graph.running; }
  /** The underlying graph (advanced use: analysers, recording). */
  get audioGraph(): AudioGraph { return this.graph; }
  /** Engine voice, once built (diagnostics / tests). */
  get engine(): EngineSynth | null { return this.voices?.engine ?? null; }
  /** Environment voice, once built. */
  get environment(): EnvironmentSynth | null { return this.voices?.env ?? null; }
  /** Warning voice, once built. */
  get warnings(): Warnings | null { return this.voices?.warnings ?? null; }
  /** View stage, once built. */
  get view(): ViewStage | null { return this.voices?.stage ?? null; }

  /**
   * Create / resume the AudioContext. Call from a user gesture (e.g. the "Fly" button). Never
   * rejects. A no-op after `dispose()` (a stale gesture handler must not build a new context).
   */
  async resume(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.graph.resume();
      if (this.disposed) return; // disposed while the context was resuming
      if (this.graph.ctx && (!this.voices || this.voices.generation !== this.graph.generation)) this.build();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Per-frame update. Cheap early-out while no context is running. Never throws. */
  update(dt: number, ac: AircraftState, camera: CameraState, weather: WeatherState): void {
    const v = this.voices;
    if (!v || this.failed || !this.graph.running || this.graph.isMuted) return;
    try {
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
      v.stage.update(ac, camera);
      const e = ac.engine, inp = this.engineIn;
      inp.rpm = e.rpm; inp.running = e.running; inp.manifoldPressureInHg = e.manifoldPressureInHg;
      inp.throttle = this.throttle; inp.starter = this.starter; inp.thrustN = e.thrustN;
      inp.tasMs = ac.aero.tas; inp.speedOfSound = ac.atmosphere.speedOfSound;
      v.engine.update(step, inp, v.stage.exterior, v.stage.doppler);
      v.env.update(step, ac, weather, this.surface);
      v.warnings.update(ac);
      this.badFrames = 0;
    } catch (err) {
      // a malformed frame (e.g. a half-built snapshot) is skipped; persistent errors disable audio
      this.warnOnce(err);
      if (++this.badFrames >= MAX_BAD_FRAMES) this.failed = true;
    }
  }

  /** Convenience: update from a full snapshot (controls, pause → mute). */
  updateSnapshot(dt: number, snap: SimSnapshot): void {
    this.setControls(snap.inputs);
    this.graph.setMuted(snap.paused);
    // altitude alerter chime when the autopilot's alerter starts (approaching or deviating)
    const aa = snap.autopilot?.altAlert ?? 'none';
    if (aa !== this.lastAltAlert && aa !== 'none') this.altitudeAlert();
    this.lastAltAlert = aa;
    this.update(dt, snap.aircraft, snap.camera, snap.weather);
  }
  private lastAltAlert: 'none' | 'approach' | 'deviation' = 'none';

  /** Master volume, linear 0..2 (default 0.5 ≈ −6 dBFS). */
  setMasterVolume(v: number): void { this.graph.setMasterVolume(v); }
  /** Per-bus volume, linear 0..2. The atc volume also scales speech utterances. */
  setVolume(bus: BusName, v: number): void { this.graph.setBusVolume(bus, v); }
  /** Mute everything (pause) without losing volumes. */
  setMuted(muted: boolean): void { this.graph.setMuted(muted); }

  /** Pilot inputs the synth cannot read from AircraftState (starter switch, throttle lever). */
  setControls(c: Pick<ControlInputs, 'starter' | 'throttle'> | null): void {
    this.starter = c ? c.starter : null;
    this.throttle = c && Number.isFinite(c.throttle) ? c.throttle : null;
  }
  /** Surface under the wheels (World's `Environment.surface`). */
  setSurface(s: SurfaceKind): void { this.surface = s; }
  /** Real camera pose in local NED (m, m/s) for exterior distance / Doppler; null → estimate from CameraState. */
  setListener(posNED: Readonly<Vec3> | null, velNED?: Readonly<Vec3>): void {
    if (posNED) {
      this.listenerPos = this.listenerPos ?? [0, 0, 0];
      this.listenerPos[0] = posNED[0]; this.listenerPos[1] = posNED[1]; this.listenerPos[2] = posNED[2];
      this.listenerVel[0] = velNED?.[0] ?? 0; this.listenerVel[1] = velNED?.[1] ?? 0; this.listenerVel[2] = velNED?.[2] ?? 0;
    } else {
      this.listenerPos = null;
    }
    this.voices?.stage.setListener(this.listenerPos, this.listenerVel);
  }

  /** Switch to another aircraft (rebuilds the voices with its profile). */
  setAircraft(config: AircraftConfig): void {
    this.profile = audioProfileFromConfig(config);
    if (this.voices) this.build();
  }

  /** UI sound on the ui bus. */
  playUi(sound: UiSound): void { this.guard(() => this.ready && this.voices?.warnings.playUi(sound)); }
  /** Touchdown thump + tyre chirp (also fired by the `aircraft:touchdown` event). */
  onTouchdown(vsMs: number, lateralDriftMs = 0): void { this.guard(() => this.ready && this.voices?.env.onTouchdown(vsMs, lateralDriftMs)); }
  /** Marker-beacon tone (null = none). */
  setMarker(marker: MarkerBeacon | null): void {
    if (marker === this.marker) return; // the app calls this every frame: no work, no allocation
    this.marker = marker;
    this.guard(() => this.voices?.warnings.setMarker(marker));
  }
  /**
   * Flight reset / teleport (also fired by the `flight:reset` event): stops speech and the marker
   * tone and snaps the engine sound to the spawn's state, so the teleport plays no shutdown ticks,
   * start cough or flap-motor blip, and a reset that disengages the autopilot plays no disconnect
   * tone.
   */
  onFlightReset(engineRunning: boolean): void {
    this.stopSpeaking();
    this.setMarker(null);
    this.lastApEngaged = null;
    this.guard(() => { this.voices?.engine.resetPhase(engineRunning); this.voices?.env.resetTracking(); });
  }
  /** Autopilot-disconnect two-tone (also fired when `autopilot:changed` reports a disengage). */
  apDisconnect(): void { this.guard(() => this.ready && this.voices?.warnings.apDisconnect()); }
  /** Altitude-alert chime. */
  altitudeAlert(): void { this.guard(() => this.ready && this.voices?.warnings.altitudeAlert()); }

  /** Queue a spoken message (Web Speech API; works without an AudioContext). */
  speak(text: string, voice: SpeechRole = 'atc'): void { this.guard(() => this.speech?.speak(text, voice)); }
  /** Stop speech immediately and drop the queue. */
  stopSpeaking(): void { this.guard(() => this.speech?.cancel()); }

  /** Release everything (voices, context, listeners). Terminal: the system stays silent afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
    this.guard(() => this.speech?.dispose());
    this.disposeVoices();
    this.guard(() => this.graph.dispose());
  }

  // ───────────────────────────── internals ─────────────────────────────

  private build(): void {
    const ctx = this.graph.ctx, b = this.graph.buses, n = this.graph.noise;
    if (!ctx || !b || !n) return;
    this.disposeVoices();
    try {
      const stage = new ViewStage(ctx, b.bus.engine, b.bus.environment, b.master, b.cabin);
      const engine = new EngineSynth(ctx, n, this.profile);
      engine.output.connect(b.bus.engine);
      const env = new EnvironmentSynth(ctx, n, b.bus.environment, b.bus.cockpit, this.profile);
      const warnings = new Warnings(ctx, n, b.bus.cockpit, b.bus.ui, this.profile);
      this.voices = { generation: this.graph.generation, stage, engine, env, warnings };
      stage.setListener(this.listenerPos, this.listenerVel);
      if (this.marker) warnings.setMarker(this.marker);
      this.failed = false;
      this.badFrames = 0;
    } catch (e) {
      this.fail(e);
    }
  }

  private disposeVoices(): void {
    const v = this.voices;
    this.voices = null;
    if (!v) return;
    this.guard(() => { v.engine.dispose(); v.env.dispose(); v.warnings.dispose(); v.stage.dispose(); });
  }

  private onTransmission(role: SpeechRole, phase: 'start' | 'end'): void {
    const v = this.voices, b = this.graph.buses, n = this.graph.noise, ctx = this.graph.ctx;
    if (!v || !b || !n || !ctx) return;
    this.guard(() => {
      // the duck must follow the speech whatever the context state, or an 'end' that arrives while
      // suspended (iOS interruption) would leave the engine at −6 dB for good
      v.stage.setDuck(phase === 'start');
      // one-shots need a running clock (on a frozen one they would all fire at once on resume)
      if (role === 'atc' && this.graph.running) playSquelch(ctx, b.bus.atc, n.white, phase);
    });
  }

  private onAutopilot(s: AutopilotState): void {
    if (this.lastApEngaged === true && !s.engaged) this.apDisconnect();
    this.lastApEngaged = s.engaged;
  }

  /** Run an event-driven call; an error is logged once and swallowed (audio must never break the sim). */
  private guard(fn: () => unknown): void {
    try { fn(); } catch (e) { this.warnOnce(e); }
  }

  /** A construction error disables the voices until the next successful build. */
  private fail(e: unknown): void {
    this.warnOnce(e);
    this.failed = true;
  }

  private warnOnce(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[audio] error (audio continues where possible)', e);
  }
}

/** Consecutive failing frames after which the voices are disabled. */
const MAX_BAD_FRAMES = 30;

function safe<T, F>(fn: () => T, fallback: F): T | F {
  try { return fn(); } catch { return fallback; }
}
