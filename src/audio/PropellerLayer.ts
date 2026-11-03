/**
 * Propeller layer (docs/research/06 §A3): a blade-pass tone (harmonics of blades·rpm/60 from a
 * PeriodicWave, level rising steeply with helical tip Mach and with thrust) plus broadband
 * vortex-shedding hiss (pink noise band-passed at the Strouhal frequency, ∝ (rpm/rated)³).
 * Driven by the engine synth's crank-frequency control signal, so it tracks rpm and Doppler
 * coherently with the exhaust layers.
 */
import { clamp } from '../core/math';
import { bladePassWave, helicalTipMach, propToneLevel, propVortexHz } from './engineMath';
import { mkFilter, mkGain, mkOsc, mkScaled, type NodeBag } from './nodes';
import { SmoothParam, TAU, TAU_SLOW } from './params';
import type { AudioProfile } from './profile';

/** Interior / exterior balance of the prop vs the exhaust (§A3: prop dominates outside). */
export const PROP_VIEW_GAIN = { interior: 0.7, exterior: 1.6 } as const;
/** Peak blade-pass tone gain and vortex hiss gain. */
const TONE_GAIN = 0.22;
const VORTEX_GAIN = 0.05;

/** Blade-pass tone + vortex noise; output feeds the engine mix. */
export class PropellerLayer {
  readonly output: GainNode;
  private readonly tone: SmoothParam;
  private readonly vortex: SmoothParam;
  private readonly vortexHz: SmoothParam;
  private readonly view: SmoothParam;
  private _toneLevel = 0;

  /**
   * @param crank control signal carrying rpm/60 (× Doppler) Hz
   * @param pink a running pink-noise source to tap for the vortex hiss
   */
  constructor(ctx: BaseAudioContext, crank: AudioNode, pink: AudioNode, private readonly profile: AudioProfile, bag: NodeBag) {
    const t = ctx.currentTime;
    this.output = bag.add(mkGain(ctx, PROP_VIEW_GAIN.interior));
    const w = bladePassWave(6, 1.2);
    const osc = bag.add(mkOsc(ctx, ctx.createPeriodicWave(w.real, w.imag), 0));
    bag.add(mkScaled(ctx, crank, profile.propBlades, osc.frequency)); // BPF = blades · rpm/60
    const toneGain = bag.add(mkGain(ctx, 0));
    osc.connect(toneGain).connect(this.output);
    const bp = bag.add(mkFilter(ctx, 'bandpass', 2500, 1));
    const vortexGain = bag.add(mkGain(ctx, 0));
    pink.connect(bp).connect(vortexGain).connect(this.output);
    this.tone = new SmoothParam(toneGain.gain, TAU);
    this.vortex = new SmoothParam(vortexGain.gain, TAU);
    this.vortexHz = new SmoothParam(bp.frequency, TAU, 1, 0.01);
    this.view = new SmoothParam(this.output.gain, TAU_SLOW);
    this.tone.init(0, t); this.vortex.init(0, t); this.vortexHz.init(2500, t); this.view.init(PROP_VIEW_GAIN.interior, t);
  }

  /** Last computed blade-pass tone level 0..1 (before the layer gain). */
  get toneLevel(): number { return this._toneLevel; }

  /**
   * Per-frame update (allocation-free).
   * @param tau smoothing for the level changes (slower during run-down)
   */
  update(now: number, rpm: number, tasMs: number, speedOfSound: number, thrustN: number, exterior: boolean, doppler: number, tau = TAU): void {
    const p = this.profile;
    const mTip = helicalTipMach(rpm, p.propDiameterM, tasMs, speedOfSound);
    this._toneLevel = propToneLevel(mTip, Math.abs(thrustN) / p.refThrustN);
    this.tone.set(TONE_GAIN * this._toneLevel, now, tau);
    const x = clamp(rpm / p.ratedRpm, 0, 1.2);
    this.vortex.set(VORTEX_GAIN * x * x * x, now, tau);
    this.vortexHz.set(clamp(propVortexHz(rpm, p.propDiameterM) * doppler, 200, 12000), now);
    this.view.set(exterior ? PROP_VIEW_GAIN.exterior : PROP_VIEW_GAIN.interior, now);
  }
}
