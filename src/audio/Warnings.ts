/**
 * Cockpit aural warnings and alerts (docs/research/06 §A5.1, §A5.3, §A5.5):
 * - C172 stall horn: pneumatic reed ≈ 2.1 kHz (sawtooth + square detuned +7 cents, 6 Hz
 *   ±10 cent vibrato, band-passed), gated by the stall warning, louder and slightly sharper as α
 *   approaches the break.
 * - Overspeed clacker (jets; the C172 has none): 4 Hz train of 3 ms noise clicks → BP 2 kHz.
 * - Marker beacons: 400 Hz dashes (outer), 1300 Hz dot-dash (middle), 3000 Hz dots (inner).
 * - Autopilot-disconnect two-tone, altitude-alert chime, UI sounds.
 * Everything here plays on the cockpit bus (attenuated in exterior views) except UI sounds.
 */
import { clamp } from '../core/math';
import type { AircraftState } from '../core/types';
import type { NoiseBank } from './graph';
import { chain, mkFilter, mkGain, mkLoop, mkOsc, NodeBag } from './nodes';
import { playTone } from './oneShots';
import { SmoothParam, TAU_FAST } from './params';
import { type GatePattern, PatternGate } from './PatternGate';
import type { AudioProfile } from './profile';
import { playUiSound, type UiSound } from './uiSounds';

/** Marker beacon passed over (null = none). */
export type MarkerBeacon = 'outer' | 'middle' | 'inner';

/** Marker tones and keying (ICAO Annex 10): OM 2 dashes/s, MM dot-dash 95/min, IM 6 dots/s. */
export const MARKER_TONES: Readonly<Record<MarkerBeacon, { hz: number; pattern: GatePattern }>> = {
  outer: { hz: 400, pattern: [0.375, 0.125] },
  middle: { hz: 1300, pattern: [0.3, 0.1, 0.1, 0.132] },
  inner: { hz: 3000, pattern: [0.0833, 0.0833] },
};

/** Stall horn tuning (UNVERIFIED design values; see §A5.1). */
export const STALL_HORN = { baseHz: 1950, riseHz: 250, gain: 0.35, minIntensity: 0.35, vibratoHz: 6, vibratoCents: 10 } as const;

/** Clacker rhythm: 4 Hz, 3 ms clicks. */
const CLACKER: GatePattern = [0.003, 0.247];

/** Stall-horn intensity 0..1: 0 unless warning/stalled, then rising with α toward the break. */
export function stallHornIntensity(ac: AircraftState, alphaWarnRad: number, alphaStallRad: number): number {
  const gate = ac.aero.stallWarning || ac.aero.stalled || ac.warnings.stall;
  if (!gate) return 0;
  const a = Number.isFinite(ac.aero.alpha) ? ac.aero.alpha : alphaWarnRad;
  const k = clamp((a - alphaWarnRad) / Math.max(1e-3, alphaStallRad - alphaWarnRad), 0, 1);
  return STALL_HORN.minIntensity + (1 - STALL_HORN.minIntensity) * (ac.aero.stalled ? 1 : k);
}

/** Warning horns, clacker, marker tones and alert chimes. */
export class Warnings {
  private readonly bag = new NodeBag();
  private readonly hornGain: SmoothParam;
  private readonly hornHz: SmoothParam;
  private readonly hornHz2: SmoothParam;
  private readonly clacker: PatternGate;
  private readonly marker: PatternGate;
  private readonly markerOsc: OscillatorNode;
  private _marker: MarkerBeacon | null = null;
  private _horn = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: NoiseBank,
    private readonly cockpitOut: AudioNode,
    private readonly uiOut: AudioNode,
    private readonly profile: AudioProfile,
  ) {
    const b = this.bag, t = ctx.currentTime;
    // stall horn: reedy pair + vibrato → BP → HP → gate
    const saw = b.add(mkOsc(ctx, 'sawtooth', STALL_HORN.baseHz));
    const sq = b.add(mkOsc(ctx, 'square', STALL_HORN.baseHz));
    const vib = b.add(mkOsc(ctx, 'sine', STALL_HORN.vibratoHz));
    const vibDepth = b.add(mkGain(ctx, STALL_HORN.vibratoCents));
    vib.connect(vibDepth);
    vibDepth.connect(saw.detune); vibDepth.connect(sq.detune);
    const sqLevel = b.add(mkGain(ctx, 0.5));
    sq.detune.setValueAtTime(7, t); // +7 cents: slow beating between the reed's two partials (vibrato adds on top)
    const bp = b.add(mkFilter(ctx, 'bandpass', 2300, 1.5));
    const hp = b.add(mkFilter(ctx, 'highpass', 300, 0.7));
    const horn = b.add(mkGain(ctx, 0));
    saw.connect(bp);
    chain(sq, sqLevel, bp);
    chain(bp, hp, horn, cockpitOut);
    this.hornGain = new SmoothParam(horn.gain, TAU_FAST);
    this.hornHz = new SmoothParam(saw.frequency, 0.08, 1, 0.002);
    this.hornHz2 = new SmoothParam(sq.frequency, 0.08, 1, 0.002);
    this.hornGain.init(0, t); this.hornHz.init(STALL_HORN.baseHz, t); this.hornHz2.init(STALL_HORN.baseHz, t);
    // overspeed clacker
    const white = b.add(mkLoop(ctx, noise.white, 3.3));
    const clackBp = b.add(mkFilter(ctx, 'bandpass', 2000, 2));
    const clackGate = b.add(mkGain(ctx, 0));
    chain(white, clackBp, clackGate, cockpitOut);
    this.clacker = new PatternGate(clackGate.gain, 0.0008);
    // marker beacon tone
    this.markerOsc = b.add(mkOsc(ctx, 'sine', MARKER_TONES.outer.hz));
    const markerGate = b.add(mkGain(ctx, 0));
    chain(this.markerOsc, markerGate, cockpitOut);
    this.marker = new PatternGate(markerGate.gain, 0.003);
  }

  /** Stall-horn intensity targeted on the last update (0 = silent). */
  get stallHorn(): number { return this._horn; }
  /** True while the overspeed clacker runs. */
  get clacking(): boolean { return this.clacker.active; }
  /** Current marker beacon. */
  get markerBeacon(): MarkerBeacon | null { return this._marker; }
  /** Number of persistent nodes (CPU budget). */
  get nodeCount(): number { return this.bag.size; }

  /** Per-frame update; allocation-free. */
  update(ac: AircraftState): void {
    const now = this.ctx.currentTime, p = this.profile;
    this._horn = stallHornIntensity(ac, p.alphaWarnRad, p.alphaStallRad);
    this.hornGain.set(STALL_HORN.gain * this._horn, now);
    const hz = STALL_HORN.baseHz + STALL_HORN.riseHz * this._horn;
    this.hornHz.set(hz, now); this.hornHz2.set(hz, now);
    const overspeed = p.overspeedClacker && ac.warnings.overspeed && !ac.crashed;
    if (overspeed && !this.clacker.active) this.clacker.start(CLACKER, now, 0.5);
    else if (!overspeed && this.clacker.active) this.clacker.stop(now);
    this.clacker.update(now);
    this.marker.update(now);
  }

  /** Start / stop the marker-beacon tone. */
  setMarker(m: MarkerBeacon | null): void {
    if (m === this._marker) return;
    this._marker = m;
    const now = this.ctx.currentTime;
    if (!m) { this.marker.stop(now); return; }
    const spec = MARKER_TONES[m];
    this.markerOsc.frequency.setValueAtTime(spec.hz, now); // gate is closed at this instant
    this.marker.start(spec.pattern, now, 0.22);
  }

  /** Autopilot disconnect: alternating 1200/900 Hz two-tone for ≈1.4 s. */
  apDisconnect(): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      playTone(this.ctx, this.cockpitOut, { type: 'triangle', freq: i % 2 === 0 ? 1200 : 900, at: t + i * 0.24, dur: 0.2, gain: 0.25, attack: 0.005, release: 0.015 });
    }
  }

  /** Altitude alert: a soft two-note bell chime (C6 + E6 with an octave partial). */
  altitudeAlert(): void {
    const t = this.ctx.currentTime;
    for (const [hz, g] of CHIME) playTone(this.ctx, this.cockpitOut, { freq: hz, at: t, dur: 0.01, gain: g, attack: 0.004, release: 0.35 });
  }

  /** Synthesized UI sound on the UI bus. */
  playUi(kind: UiSound): void { playUiSound(this.ctx, this.uiOut, this.noise.white, kind); }

  /** Stop and disconnect every persistent node. */
  dispose(): void {
    const now = this.ctx.currentTime;
    this.clacker.stop(now); this.marker.stop(now);
    this.bag.dispose();
  }
}

const CHIME: ReadonlyArray<readonly [number, number]> = [[1046.5, 0.18], [1318.5, 0.14], [2093, 0.05]];
