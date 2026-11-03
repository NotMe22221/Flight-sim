/**
 * Airframe environment sounds (docs/research/06 §A4, §A5.2, §A5.4): wind / slipstream with a
 * band-pass whistle sweep, stall-buffet rumble and amplitude modulation, rain on the airframe
 * (hiss + drop clicks), ground-roll rumble and tyre noise by wheel speed and surface, wheel
 * rotation bumps, touchdown thump + tyre chirp, and the electric flap-motor whine.
 *
 * ```
 * pink ─┬► LP 300–5200 Hz ─► wind ────┐
 *       ├► BP whistle sweep ─► whistle ┼► buffet AM (8–14 Hz LFOs) ─────────────► environment bus
 *       └► LP 70 Hz ─► buffet rumble ──┘
 * white ─► HP 3 kHz ─► rain hiss ─────────────────────────────────────────────────► environment bus
 * crackle ─► BP 1.8 kHz ─► raindrops ──────────────────────────────────────────────► environment bus
 * pink ─► LP 150–400 Hz ─► wheel/bump AM ─► roll ──────────────────────────────────► environment bus
 * white ─► BP 900 Hz ─► tyre hiss ─────────────────────────────────────────────────► environment bus
 * saw 140 Hz + square 280 Hz ─► BP 1.1 kHz ─► flap motor ──────────────────────────► cockpit bus
 * ```
 */
import { clamp } from '../core/math';
import type { AircraftState, WeatherState } from '../core/types';
import {
  buffetIntensity, chirpLevel, rainIntensity, rainLevel, rollCutoffHz, rollingSpeedMs, rollLevel, SURFACE_FACTORS,
  type SurfaceKind, thumpLevel, wheelHz, whistleHz, windCutoffHz, windLevel,
} from './environmentLaws';
import type { NoiseBank } from './graph';
import { playNoiseBurst, playTone } from './oneShots';
import { chain, mkFilter, mkGain, mkLoop, mkOsc, NodeBag } from './nodes';
import { SmoothParam, TAU, TAU_FAST, TAU_SLOW } from './params';
import type { AudioProfile } from './profile';

/** Flap motor: base pitch Hz, interior gain; moving threshold °/s. */
const FLAP = { hz: 140, gain: 0.12, movingDegS: 0.5 } as const;

/** Wind, buffet, rain, ground roll, touchdown and flap-motor voice. */
export class EnvironmentSynth {
  private readonly bag = new NodeBag();
  private readonly wind: SmoothParam;
  private readonly windHz: SmoothParam;
  private readonly whistle: SmoothParam;
  private readonly whistleHz: SmoothParam;
  private readonly buffetDepth: SmoothParam;
  private readonly buffetRumble: SmoothParam;
  private readonly rain: SmoothParam;
  private readonly drops: SmoothParam;
  private readonly roll: SmoothParam;
  private readonly rollHz: SmoothParam;
  private readonly wheelLfoHz: SmoothParam;
  private readonly wheelDepth: SmoothParam;
  private readonly bumpDepth: SmoothParam;
  private readonly tyre: SmoothParam;
  private readonly flapGain: SmoothParam;
  private readonly flapSaw: OscillatorNode;
  private readonly flapSquare: OscillatorNode;
  private lastFlapDeg = Number.NaN;
  private flapMoving = false;
  private flapStillS = 0;
  private lastGroundSpeed = 0;
  private _wind = 0;
  private _buffet = 0;
  private _rain = 0;
  private _roll = 0;
  private touchdownSeq = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: NoiseBank,
    private readonly envOut: AudioNode,
    cockpitOut: AudioNode,
    private readonly profile: AudioProfile,
  ) {
    const b = this.bag, t = ctx.currentTime;
    const pink = b.add(mkLoop(ctx, noise.pink, 2.71));
    const white = b.add(mkLoop(ctx, noise.white, 0.53));
    const crackle = b.add(mkLoop(ctx, noise.crackle, 0.77));
    // wind + whistle + buffet rumble through the buffet AM stage
    const buffetAm = b.add(mkGain(ctx, 1));
    buffetAm.connect(envOut);
    const windLp = b.add(mkFilter(ctx, 'lowpass', 300, 0.7));
    const windG = b.add(mkGain(ctx, 0));
    chain(pink, windLp, windG, buffetAm);
    const whistleBp = b.add(mkFilter(ctx, 'bandpass', 1200, 0.5));
    const whistleG = b.add(mkGain(ctx, 0));
    chain(pink, whistleBp, whistleG, buffetAm);
    const buffetLp = b.add(mkFilter(ctx, 'lowpass', 70, 0.9));
    const buffetG = b.add(mkGain(ctx, 0));
    chain(pink, buffetLp, buffetG, buffetAm);
    const lfoA = b.add(mkOsc(ctx, 'sine', 9.3)), lfoB = b.add(mkOsc(ctx, 'triangle', 13.1));
    const depth = b.add(mkGain(ctx, 0));
    lfoA.connect(depth); lfoB.connect(depth);
    depth.connect(buffetAm.gain);
    // rain
    const rainHp = b.add(mkFilter(ctx, 'highpass', 3000, 0.7));
    const rainG = b.add(mkGain(ctx, 0));
    chain(white, rainHp, rainG, envOut);
    const dropBp = b.add(mkFilter(ctx, 'bandpass', 1800, 0.8));
    const dropG = b.add(mkGain(ctx, 0));
    chain(crackle, dropBp, dropG, envOut);
    // ground roll with wheel-rotation and surface bumps (AM on rollAm.gain, intrinsic 1)
    const rollLp = b.add(mkFilter(ctx, 'lowpass', 150, 0.8));
    const rollAm = b.add(mkGain(ctx, 1));
    const rollG = b.add(mkGain(ctx, 0));
    chain(pink, rollLp, rollAm, rollG, envOut);
    const wheelLfo = b.add(mkOsc(ctx, 'sine', 1));
    const wheelD = b.add(mkGain(ctx, 0));
    chain(wheelLfo, wheelD).connect(rollAm.gain);
    const bumpLfo = b.add(mkOsc(ctx, 'triangle', 2.7));
    const bumpD = b.add(mkGain(ctx, 0));
    chain(bumpLfo, bumpD).connect(rollAm.gain);
    const tyreBp = b.add(mkFilter(ctx, 'bandpass', 900, 0.7));
    const tyreG = b.add(mkGain(ctx, 0));
    chain(white, tyreBp, tyreG, envOut);
    // flap motor (cockpit bus)
    this.flapSaw = b.add(mkOsc(ctx, 'sawtooth', FLAP.hz));
    this.flapSquare = b.add(mkOsc(ctx, 'square', 2 * FLAP.hz));
    const sqG = b.add(mkGain(ctx, 0.4));
    const flapBp = b.add(mkFilter(ctx, 'bandpass', 1100, 2));
    const flapG = b.add(mkGain(ctx, 0));
    this.flapSaw.connect(flapBp);
    chain(this.flapSquare, sqG, flapBp);
    chain(flapBp, flapG, cockpitOut);

    this.wind = new SmoothParam(windG.gain, TAU);
    this.windHz = new SmoothParam(windLp.frequency, TAU, 2, 0.01);
    this.whistle = new SmoothParam(whistleG.gain, TAU);
    this.whistleHz = new SmoothParam(whistleBp.frequency, TAU, 2, 0.01);
    this.buffetDepth = new SmoothParam(depth.gain, TAU_FAST);
    this.buffetRumble = new SmoothParam(buffetG.gain, TAU_FAST);
    this.rain = new SmoothParam(rainG.gain, TAU_SLOW);
    this.drops = new SmoothParam(dropG.gain, TAU_SLOW);
    this.roll = new SmoothParam(rollG.gain, TAU);
    this.rollHz = new SmoothParam(rollLp.frequency, TAU, 2, 0.01);
    this.wheelLfoHz = new SmoothParam(wheelLfo.frequency, TAU, 0.05, 0.01);
    this.wheelDepth = new SmoothParam(wheelD.gain, TAU);
    this.bumpDepth = new SmoothParam(bumpD.gain, TAU_SLOW);
    this.tyre = new SmoothParam(tyreG.gain, TAU);
    this.flapGain = new SmoothParam(flapG.gain, 0.04);
    for (const p of [this.wind, this.whistle, this.buffetDepth, this.buffetRumble, this.rain, this.drops, this.roll, this.wheelDepth, this.bumpDepth, this.tyre, this.flapGain]) p.init(0, t);
    this.windHz.init(300, t); this.whistleHz.init(1200, t); this.rollHz.init(150, t); this.wheelLfoHz.init(1, t);
  }

  /** Wind gain targeted on the last update. */
  get windGain(): number { return this._wind; }
  /** Buffet intensity 0..1 on the last update. */
  get buffet(): number { return this._buffet; }
  /** Rain gain targeted on the last update. */
  get rainGain(): number { return this._rain; }
  /** Ground-roll gain targeted on the last update. */
  get rollGain(): number { return this._roll; }
  /** True while the flap motor is running. */
  get flapMotorRunning(): boolean { return this.flapMoving; }
  /** Number of persistent nodes (CPU budget). */
  get nodeCount(): number { return this.bag.size; }

  /** Per-frame update; allocation-free. */
  update(dt: number, ac: AircraftState, weather: WeatherState, surface: SurfaceKind): void {
    const now = this.ctx.currentTime;
    const ias = Number.isFinite(ac.aero.ias) ? Math.max(0, ac.aero.ias) : 0;
    const flapDeg = Number.isFinite(ac.surfaces.flapDeg) ? ac.surfaces.flapDeg : 0;
    // wind / slipstream
    this._wind = windLevel(ias, flapDeg);
    this.wind.set(this._wind, now);
    this.windHz.set(windCutoffHz(ias), now);
    this.whistle.set(0.25 * this._wind, now); // −12 dB relative
    this.whistleHz.set(whistleHz(ias), now);
    // stall buffet
    this._buffet = buffetIntensity(ac, this.profile.alphaStallRad);
    this.buffetDepth.set(0.25 * this._buffet, now);
    this.buffetRumble.set(0.45 * this._buffet, now);
    // rain on the airframe
    const ri = rainIntensity(weather);
    this._rain = rainLevel(ri, ias);
    this.rain.set(this._rain, now);
    this.drops.set(ri > 0 ? 0.5 * Math.sqrt(ri) : 0, now);
    // ground roll
    const wheel = rollingSpeedMs(ac);
    this.lastGroundSpeed = Number.isFinite(ac.groundSpeedMs) ? ac.groundSpeedMs : 0;
    const sf = SURFACE_FACTORS[surface];
    const s = clamp(wheel / 40, 0, 1);
    this._roll = rollLevel(wheel, surface);
    this.roll.set(this._roll, now);
    this.rollHz.set(rollCutoffHz(wheel, surface), now);
    this.wheelLfoHz.set(Math.max(0.1, wheelHz(wheel, this.profile.mainTyreRadiusM)), now);
    this.wheelDepth.set(wheel > 0.3 ? 0.3 : 0, now);
    this.bumpDepth.set(wheel > 0.3 ? sf.bumps : 0, now);
    this.tyre.set(0.06 * s * s * sf.hiss, now);
    this.updateFlapMotor(dt, flapDeg, now);
  }

  /**
   * Touchdown: sine thump 55→35 Hz + low noise burst, and a tyre chirp scaled by ground speed
   * and lateral drift (§A5.4). Allocates a few transient nodes (event-driven, not per frame).
   */
  onTouchdown(vsMs: number, lateralDriftMs = 0, groundSpeedMs = this.lastGroundSpeed): void {
    const ctx = this.ctx, t = ctx.currentTime, a = thumpLevel(vsMs);
    const seq = this.touchdownSeq++;
    playTone(ctx, this.envOut, { freq: 55, freqEnd: 35, glideS: 0.12, at: t, dur: 0.02, gain: 0.9 * a, attack: 0.004, release: 0.15 });
    playNoiseBurst(ctx, this.envOut, this.noise.pink, { at: t, dur: 0.06, gain: 0.6 * a, filter: 'lowpass', freq: 300, release: 0.03, offsetS: 0.37 * seq });
    const chirp = chirpLevel(groundSpeedMs, lateralDriftMs);
    if (chirp > 0.05) {
      playNoiseBurst(ctx, this.envOut, this.noise.white, {
        at: t + 0.005, dur: 0.05 + 0.07 * chirp, gain: 0.35 * chirp, filter: 'bandpass', freq: 2200, Q: 3, release: 0.02, offsetS: 0.61 * seq,
      });
    }
  }

  /**
   * Forget frame-to-frame tracking after a flight reset / teleport, so a flap setting that differs
   * between the old and the new spawn does not read as flap travel (and run the motor).
   */
  resetTracking(): void {
    this.lastFlapDeg = Number.NaN;
    this.flapStillS = 0;
    if (this.flapMoving) {
      this.flapMoving = false;
      this.flapGain.set(0, this.ctx.currentTime, 0.06);
    }
  }

  /** Stop and disconnect every persistent node. */
  dispose(): void { this.bag.dispose(); }

  /** Whine while `flapDeg` changes; pitch sags 6 % under load at start and rises 3 % as it stops (§A5.2). */
  private updateFlapMotor(dt: number, flapDeg: number, now: number): void {
    const prev = this.lastFlapDeg;
    this.lastFlapDeg = flapDeg;
    // a manual flap handle (Super Cub) has no motor to hear
    if (this.profile.electricFlaps === false) return;
    if (!(dt > 0) || !Number.isFinite(prev)) return;
    const rate = Math.abs(flapDeg - prev) / dt;
    if (rate > FLAP.movingDegS) {
      this.flapStillS = 0;
      if (!this.flapMoving) {
        this.flapMoving = true;
        this.glide(this.flapSaw, FLAP.hz, FLAP.hz * 0.94, now, 0.1);
        this.glide(this.flapSquare, 2 * FLAP.hz, 2 * FLAP.hz * 0.94, now, 0.1);
      }
    } else if (this.flapMoving) {
      this.flapStillS += dt;
      if (this.flapStillS > 0.12) { // debounce frame-to-frame jitter of the actuator model
        this.flapMoving = false;
        this.flapSaw.frequency.setTargetAtTime(FLAP.hz * 1.03, now, 0.05);
        this.flapSquare.frequency.setTargetAtTime(2 * FLAP.hz * 1.03, now, 0.05);
      }
    }
    this.flapGain.set(this.flapMoving ? FLAP.gain : 0, now, this.flapMoving ? 0.03 : 0.06);
  }

  private glide(o: OscillatorNode, from: number, to: number, now: number, tau: number): void {
    o.frequency.cancelScheduledValues(now);
    o.frequency.setValueAtTime(from, now);
    o.frequency.setTargetAtTime(to, now, tau);
  }
}
