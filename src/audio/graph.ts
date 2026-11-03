/**
 * AudioContext lifecycle and the bus graph (docs/research/06 §A1.1, §A1.4, §A1.6).
 *
 * ```
 * engine ──────► [ViewStage: LP (cabin 1.2 kHz | air absorption) → duck] ─┐
 * environment ─► [ViewStage: LP (cabin 5 kHz | air absorption)] ──────────┴► distance → pan ─┐
 * cockpit ─► cabin (attenuated in exterior views) ───────────────────────────────────────────┼─► master ─► limiter ─► destination
 * ui ────────────────────────────────────────────────────────────────────────────────────────┤
 * atc (squelch/static only; speechSynthesis cannot be routed through Web Audio) ─────────────┘
 * ```
 * The graph owns the buses, master and limiter; `ViewStage` owns the engine/environment
 * routing to master (until a ViewStage is attached those two buses are silent).
 *
 * The context is created lazily on the first `resume()` (which must run inside a user gesture —
 * browsers start contexts 'suspended' without one), re-resumed on visibility changes and on
 * later gestures while 'suspended' / 'interrupted' (iOS), and rebuilt if it was 'closed'.
 */
import { createNoiseBuffer } from './noise';
import { setAt } from './params';

export { dbToGain, gainToDb, setAt, smoothTo, SmoothParam, TAU, TAU_FAST, TAU_SLOW, xfadeIn, xfadeOut } from './params';

/** Mixer bus names (match `AudioMixer.setVolume`). */
export type BusName = 'engine' | 'environment' | 'cockpit' | 'ui' | 'atc';
export const BUS_NAMES: readonly BusName[] = ['engine', 'environment', 'cockpit', 'ui', 'atc'];
/** Default per-bus volumes (§A1.4). */
export const DEFAULT_BUS_VOLUMES: Readonly<Record<BusName, number>> = { engine: 0.8, environment: 0.7, cockpit: 1.0, ui: 0.6, atc: 0.9 };
/** Default master volume ≈ −6 dBFS. */
export const DEFAULT_MASTER_VOLUME = 0.5;
/** Length of the shared noise loops, s. */
export const NOISE_LOOP_S = 4;

/** Returns a new AudioContext, or null when Web Audio is unavailable (Node, old browsers). */
export type AudioContextFactory = () => AudioContext | null;

/** State as reported by the context ('interrupted' is Safari/iOS-only), or 'none' before creation. */
export type GraphState = AudioContextState | 'interrupted' | 'none';

/** Browser factory: `AudioContext` (or `webkitAudioContext`) with an interactive latency hint. */
export const defaultContextFactory: AudioContextFactory = () => {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try { return new Ctor({ latencyHint: 'interactive' }); } catch { return null; }
};

/** Every persistent node the graph owns. */
export interface AudioBuses {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** cockpit bus attenuation for exterior views */
  cabin: GainNode;
  bus: Record<BusName, GainNode>;
}

/** Shared looping noise buffers (white + pink 4 s loops, plus a 2 s sparse-click loop). */
export interface NoiseBank { white: AudioBuffer; pink: AudioBuffer; crackle: AudioBuffer }

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

/** Owns the AudioContext, the buses and the shared noise loops. */
export class AudioGraph {
  private _ctx: AudioContext | null = null;
  private _buses: AudioBuses | null = null;
  private _noise: NoiseBank | null = null;
  /** incremented whenever a new context is built; consumers rebuild their nodes on change */
  generation = 0;
  private readonly volumes: Record<BusName, number> = { ...DEFAULT_BUS_VOLUMES };
  private master = DEFAULT_MASTER_VOLUME;
  private muted = false;
  private unavailable = false;
  private listenersInstalled = false;
  private readonly onWake = (): void => { this.wake(); };
  private readonly onVisibility = (): void => {
    const d = (globalThis as { document?: Document }).document;
    if (!d || d.visibilityState === 'visible') this.wake();
  };

  constructor(private readonly factory: AudioContextFactory = defaultContextFactory) {}

  /** The context, once created. */
  get ctx(): AudioContext | null { return this._ctx; }
  /** The bus nodes, once created. */
  get buses(): AudioBuses | null { return this._buses; }
  /** The shared noise loops, once created. */
  get noise(): NoiseBank | null { return this._noise; }
  /** Current context state. */
  get state(): GraphState { return this._ctx ? (this._ctx.state as GraphState) : 'none'; }
  /** True when audio is actually being rendered. */
  get running(): boolean { return this.state === 'running'; }
  /** Audio clock, s (0 without a context). */
  now(): number { return this._ctx ? this._ctx.currentTime : 0; }

  /**
   * Create the context on first call (or after it was closed) and resume it. Call from a user
   * gesture. Never rejects: resolves true when the context is running.
   */
  async resume(): Promise<boolean> {
    try {
      if (!this._ctx || (this._ctx.state as GraphState) === 'closed') {
        if (!this.build()) return false;
      }
      const ctx = this._ctx;
      if (!ctx) return false;
      if ((ctx.state as GraphState) !== 'running') await ctx.resume();
      return (ctx.state as GraphState) === 'running';
    } catch {
      return false;
    }
  }

  /** Set one bus volume (0..2, linear), smoothed. */
  setBusVolume(bus: BusName, v: number): void {
    this.volumes[bus] = clampVol(v);
    const b = this._buses;
    if (b) b.bus[bus].gain.setTargetAtTime(this.volumes[bus], this.now(), 0.03);
  }
  /** Current (requested) bus volume. */
  busVolume(bus: BusName): number { return this.volumes[bus]; }

  /** Set the master volume (0..2, linear), smoothed. */
  setMasterVolume(v: number): void {
    this.master = clampVol(v);
    const b = this._buses;
    if (b && !this.muted) b.master.gain.setTargetAtTime(this.master, this.now(), 0.03);
  }
  /** Current (requested) master volume. */
  masterVolume(): number { return this.master; }

  /** Mute / unmute everything (e.g. while the sim is paused) without losing the master volume. */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    const b = this._buses;
    if (b) b.master.gain.setTargetAtTime(muted ? 0 : this.master, this.now(), 0.05);
  }
  /** True while muted. */
  get isMuted(): boolean { return this.muted; }

  /** Tear everything down and close the context. */
  dispose(): void {
    this.removeListeners();
    const b = this._buses;
    if (b) {
      for (const n of BUS_NAMES) b.bus[n].disconnect();
      b.cabin.disconnect(); b.master.disconnect(); b.limiter.disconnect();
    }
    const ctx = this._ctx;
    this._buses = null; this._noise = null; this._ctx = null;
    if (ctx && (ctx.state as GraphState) !== 'closed') ctx.close().catch(() => undefined);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private build(): boolean {
    if (this.unavailable) return false;
    if (this._ctx) this.dispose();
    const ctx = this.factory();
    if (!ctx) { this.unavailable = true; return false; }
    this._ctx = ctx;
    this._buses = this.buildBuses(ctx);
    this._noise = {
      white: createNoiseBuffer(ctx, 'white', NOISE_LOOP_S, 0x5eed1),
      pink: createNoiseBuffer(ctx, 'pink', NOISE_LOOP_S, 0x5eed2),
      crackle: createNoiseBuffer(ctx, 'crackle', 2, 0x5eed3),
    };
    this.generation++;
    this.unlock(ctx);
    this.installListeners();
    return true;
  }

  private buildBuses(ctx: AudioContext): AudioBuses {
    const t = ctx.currentTime;
    const gain = (v: number): GainNode => { const g = ctx.createGain(); setAt(g.gain, v, t); return g; };
    const limiter = ctx.createDynamicsCompressor();
    setAt(limiter.threshold, -12, t); setAt(limiter.knee, 20, t); setAt(limiter.ratio, 4, t);
    setAt(limiter.attack, 0.003, t); setAt(limiter.release, 0.25, t);
    const master = gain(this.muted ? 0 : this.master);
    master.connect(limiter); limiter.connect(ctx.destination);
    const cabin = gain(1);
    cabin.connect(master);
    const bus = {} as Record<BusName, GainNode>;
    for (const n of BUS_NAMES) bus[n] = gain(this.volumes[n]);
    bus.cockpit.connect(cabin);
    bus.ui.connect(master); bus.atc.connect(master);
    return { master, limiter, cabin, bus };
  }

  /** iOS unlock: play a 1-sample silent buffer inside the gesture; prefer the media channel (iOS 17+). */
  private unlock(ctx: AudioContext): void {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = () => src.disconnect();
      src.start(0);
      src.stop(ctx.currentTime + 0.01);
    } catch { /* best effort */ }
    try {
      const nav = (globalThis as { navigator?: { audioSession?: { type: string } } }).navigator;
      if (nav?.audioSession) nav.audioSession.type = 'playback';
    } catch { /* best effort */ }
  }

  /** Re-resume after background tabs / iOS interruptions (must be cheap: runs on every gesture). */
  private wake(): void {
    const ctx = this._ctx;
    if (!ctx) return;
    const s = ctx.state as GraphState;
    if (s === 'suspended' || s === 'interrupted') ctx.resume().catch(() => undefined);
  }

  private installListeners(): void {
    if (this.listenersInstalled) return;
    const g = globalThis as { addEventListener?: Window['addEventListener']; document?: Document };
    if (typeof g.addEventListener === 'function') {
      for (const e of GESTURES) g.addEventListener(e, this.onWake, { capture: true, passive: true });
    }
    g.document?.addEventListener('visibilitychange', this.onVisibility);
    this.listenersInstalled = true;
  }

  private removeListeners(): void {
    if (!this.listenersInstalled) return;
    const g = globalThis as { removeEventListener?: Window['removeEventListener']; document?: Document };
    if (typeof g.removeEventListener === 'function') {
      for (const e of GESTURES) g.removeEventListener(e, this.onWake, { capture: true });
    }
    g.document?.removeEventListener('visibilitychange', this.onVisibility);
    this.listenersInstalled = false;
  }
}

const clampVol = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 0);
