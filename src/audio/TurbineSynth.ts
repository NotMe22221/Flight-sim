/**
 * Procedural turbofan (CFM56 / LEAP class) for the airliner, a drop-in for {@link EngineSynth}:
 *
 * ```
 * sine  (fan tone, 400 + 2,400 Hz × N1) ─► BP ─► fan whine ───────────────┐
 * sine  (core whine, 1,800 + 5,000 Hz × N1, quieter) ─► core ─────────────┤
 * pink  ─► LP (300 + 2,200 Hz × N1) ─► jet roar (∝ thrust; louder outside) ┼─► mix ─► output
 * pink  ─► LP 140 Hz ─► rumble (∝ N1³) ───────────────────────────────────┤
 * white ─► BP 900 Hz ─► starter air hiss (spool-up below light-off) ──────┘
 * ```
 * N1 is read from `rpm` (the flight model reports rpm = N1 × 5175).
 */
import { clamp } from '../core/math';
import type { EngineSynthInput } from './EngineSynth';
import type { NoiseBank } from './graph';
import { chain, mkFilter, mkGain, mkLoop, mkOsc, NodeBag } from './nodes';
import { SmoothParam, TAU, TAU_SLOW } from './params';

/** rpm reported at 100 % N1 */
export const N1_RPM = 5175;

const G = { fan: 0.05, core: 0.012, roar: 0.55, rumble: 0.35, hiss: 0.06 };

export class TurbineSynth {
  readonly output: GainNode;
  private readonly bag = new NodeBag();
  private readonly ctx: BaseAudioContext;
  private readonly fanHz: SmoothParam;
  private readonly fan: SmoothParam;
  private readonly coreHz: SmoothParam;
  private readonly core: SmoothParam;
  private readonly roarHz: SmoothParam;
  private readonly roar: SmoothParam;
  private readonly rumble: SmoothParam;
  private readonly hiss: SmoothParam;
  private _n1 = 0;

  constructor(ctx: BaseAudioContext, noise: NoiseBank) {
    this.ctx = ctx;
    const b = this.bag, t = ctx.currentTime;
    this.output = b.add(mkGain(ctx, 1));
    const mix = b.add(mkGain(ctx, 1));
    chain(mix, b.add(mkFilter(ctx, 'highpass', 20, 0.7)), this.output);
    // fan blade-pass tone
    const fanOsc = b.add(mkOsc(ctx, 'triangle', 400));
    const fanBp = b.add(mkFilter(ctx, 'bandpass', 1200, 2));
    const fanGain = b.add(mkGain(ctx, 0));
    chain(fanOsc, fanBp, fanGain, mix);
    this.fanHz = new SmoothParam(fanOsc.frequency, TAU_SLOW, 0.5);
    this.fan = new SmoothParam(fanGain.gain, TAU);
    // high-pressure core whine
    const coreOsc = b.add(mkOsc(ctx, 'sine', 1800));
    const coreGain = b.add(mkGain(ctx, 0));
    chain(coreOsc, coreGain, mix);
    this.coreHz = new SmoothParam(coreOsc.frequency, TAU_SLOW, 0.5);
    this.core = new SmoothParam(coreGain.gain, TAU);
    // jet roar and rumble from one pink source
    const pink = b.add(mkLoop(ctx, noise.pink, 1.3));
    const roarLp = b.add(mkFilter(ctx, 'lowpass', 600, 0.6));
    const roarGain = b.add(mkGain(ctx, 0));
    chain(pink, roarLp, roarGain, mix);
    this.roarHz = new SmoothParam(roarLp.frequency, TAU_SLOW, 1);
    this.roar = new SmoothParam(roarGain.gain, TAU);
    const rumbleLp = b.add(mkFilter(ctx, 'lowpass', 140, 0.8));
    const rumbleGain = b.add(mkGain(ctx, 0));
    chain(pink, rumbleLp, rumbleGain, mix);
    this.rumble = new SmoothParam(rumbleGain.gain, TAU);
    // starter air (pneumatic start) hiss
    const white = b.add(mkLoop(ctx, noise.white, 0.7));
    const hissBp = b.add(mkFilter(ctx, 'bandpass', 900, 0.9));
    const hissGain = b.add(mkGain(ctx, 0));
    chain(white, hissBp, hissGain, mix);
    this.hiss = new SmoothParam(hissGain.gain, TAU);
    for (const p of [this.fan, this.core, this.roar, this.rumble, this.hiss]) p.init(0, t);
    this.fanHz.init(400, t); this.coreHz.init(1800, t); this.roarHz.init(600, t);
  }

  /** N1 (0..1.1) of the last update. */
  get n1(): number { return this._n1; }
  get nodeCount(): number { return this.bag.size; }

  update(_dt: number, inp: EngineSynthInput, exterior: boolean, doppler: number): void {
    const now = this.ctx.currentTime;
    const n1 = clamp((Number.isFinite(inp.rpm) ? inp.rpm : 0) / N1_RPM, 0, 1.1);
    this._n1 = n1;
    const dop = Number.isFinite(doppler) && doppler > 0 ? doppler : 1;
    const lit = inp.running;
    // thrust fraction ≈ ((N1 − 0.1) / 0.9)², like the flight model
    const thr = clamp((n1 - 0.1) / 0.9, 0, 1) ** 2;
    this.fanHz.set((400 + 2400 * n1) * dop, now);
    this.coreHz.set((1800 + 5000 * n1) * dop, now);
    this.fan.set(G.fan * clamp(n1 * 1.6, 0, 1) * (exterior ? 1.4 : 0.8), now);
    this.core.set(G.core * clamp(n1 * 2, 0, 1) * (lit ? 1 : 0.4), now);
    // the jet blast is mostly heard outside (and from behind); in the cockpit it is a distant roar
    this.roarHz.set((300 + 2200 * n1) * dop, now);
    this.roar.set(G.roar * (lit ? 0.12 + 0.88 * thr : 0.05 * n1) * (exterior ? 1 : 0.35), now);
    this.rumble.set(G.rumble * n1 * n1 * n1 * (exterior ? 1 : 0.6), now);
    this.hiss.set(G.hiss * (!lit && n1 > 0.01 && n1 < 0.3 ? 1 : 0), now);
  }

  /** No start / stop sequencer: nothing to snap. */
  resetPhase(_running: boolean): void { /* steady-state voice */ }

  dispose(): void { this.bag.dispose(); }
}
