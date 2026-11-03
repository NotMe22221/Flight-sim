/**
 * Procedural piston engine (Lycoming IO-360 class; docs/research/06 §A2, §A3, §A6).
 *
 * ```
 * crank (ConstantSource = rpm/60 · Doppler) ─┬─×½──► cycle oscillators (bright, dull PeriodicWaves)
 *                                            ├─×blades─► propeller blade-pass oscillator
 *                                            ├─×cyl/2─► starter cadence LFO
 *                                            └─×8·cyl/2─► valve-train ring modulator
 * cycle osc ─► bright/dull xfade ─► pulse ─┐
 * pink ─► LP 180 Hz ─► rumble ────────────┴► catch env ─► exhaust peaks 120/350/600 Hz ─► LP 5 kHz ─┐
 * pink ─► BP 400–1200 Hz ─► intake ──────────────────────────────────────────────────────────────────┤
 * white ─► HP 2.5 kHz ─► ring(8·f0) ─► mech ─────────────────────────────────────────────────────────┤
 * saw 70–110 Hz ─► BP 1.2 kHz ─► cadence AM ─► starter whine ───────────────────────────────────────┼─► mix ─► HP 15 Hz ─► output
 * crackle ─► BP 3 kHz ─► shutdown ticks ─────────────────────────────────────────────────────────────┤
 * PropellerLayer (blade-pass tone + vortex hiss) ────────────────────────────────────────────────────┘
 * ```
 * One oscillator runs at the full 4-stroke cycle (rpm/120) with a PeriodicWave of `cylinders`
 * slightly unequal pulses, so the firing frequency (cyl/2 · rpm/60) and the lumpy crank/cam
 * orders come out of a single wavetable; a second, duller wave is crossfaded in at low MAP.
 */
import { clamp } from '../core/math';
import { EngineStartFsm, type EnginePhase } from './EngineStartFsm';
import { crankFrequencyHz, engineCycleWave, engineLoudness, firingFrequencyHz, mapLoad } from './engineMath';
import type { NoiseBank } from './graph';
import { chain, mkConst, mkFilter, mkGain, mkLoop, mkOsc, mkScaled, NodeBag } from './nodes';
import { SmoothParam, TAU, TAU_FAST, TAU_SLOW } from './params';
import type { AudioProfile } from './profile';
import { PropellerLayer } from './PropellerLayer';

/** Per-frame inputs (from EngineState, AeroState and, when known, ControlInputs). */
export interface EngineSynthInput {
  rpm: number;
  running: boolean;
  manifoldPressureInHg: number;
  /** ControlInputs.throttle, or null when unknown (MAP load is used instead) */
  throttle: number | null;
  /** ControlInputs.starter, or null when unknown (cranking is inferred from rpm) */
  starter: boolean | null;
  thrustN: number;
  tasMs: number;
  speedOfSound: number;
}

/** Exhaust pipe quarter-wave resonances (§A2.3: L ≈ 1.2 m, c_exh ≈ 567 m/s). */
export const EXHAUST_RESONANCES: ReadonlyArray<{ hz: number; q: number; db: number }> = [
  { hz: 120, q: 3, db: 9 }, { hz: 350, q: 2.5, db: 6 }, { hz: 600, q: 2, db: 4 },
];

/** Layer gains (linear, before the bus). */
const G = { pulse: 0.35, intake: 0.12, mech: 0.05, rumble: 0.1, whine: 0.15, ticks: 0.12, lopeCents: 26, rough: 0.12 } as const;

/** Procedural engine + propeller voice; connect `output` to the engine bus. */
export class EngineSynth {
  readonly output: GainNode;
  readonly fsm = new EngineStartFsm();
  readonly prop: PropellerLayer;
  private readonly bag = new NodeBag();
  private readonly ctx: BaseAudioContext;
  private readonly crank: SmoothParam;
  private readonly bright: SmoothParam;
  private readonly dull: SmoothParam;
  private readonly rumble: SmoothParam;
  private readonly intake: SmoothParam;
  private readonly intakeHz: SmoothParam;
  private readonly mech: SmoothParam;
  private readonly whine: SmoothParam;
  private readonly whineHz: SmoothParam;
  private readonly lope: SmoothParam;
  private readonly rough: SmoothParam;
  private readonly catchEnv: AudioParam;
  private readonly ticks: AudioParam;
  private _firingHz = 0;
  private _load = 0;
  private _level = 0;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, private readonly profile: AudioProfile) {
    this.ctx = ctx;
    const b = this.bag, t = ctx.currentTime;
    const strokesHalf = profile.strokes / 2;
    this.output = b.add(mkGain(ctx, 1));
    // every layer sums into `mix`; a 15 Hz high-pass blocks the DC that oscillators parked at
    // 0 Hz (engine stopped) hold, without touching the 21.7 Hz idle firing fundamental
    const mix = b.add(mkGain(ctx, 1));
    chain(mix, b.add(mkFilter(ctx, 'highpass', 15, 0.7)), this.output);
    // ── control signal fan-out (§A1.3) ──
    const crank = b.add(mkConst(ctx, 0));
    this.crank = new SmoothParam(crank.offset, TAU, 1e-3, 0.001);
    // ── combustion pulse train: one cycle-rate wavetable, bright/dull crossfade ──
    const wBright = engineCycleWave({ cylinders: profile.cylinders, load: 1 });
    const wDull = engineCycleWave({ cylinders: profile.cylinders, load: 0 });
    const oscB = b.add(mkOsc(ctx, ctx.createPeriodicWave(wBright.real, wBright.imag), 0));
    const oscD = b.add(mkOsc(ctx, ctx.createPeriodicWave(wDull.real, wDull.imag), 0));
    b.add(mkScaled(ctx, crank, 1 / strokesHalf, oscB.frequency, oscD.frequency));
    const gB = b.add(mkGain(ctx, 0)), gD = b.add(mkGain(ctx, 0));
    const catchGain = b.add(mkGain(ctx, 1));
    oscB.connect(gB).connect(catchGain);
    oscD.connect(gD).connect(catchGain);
    this.bright = new SmoothParam(gB.gain, TAU);
    this.dull = new SmoothParam(gD.gain, TAU);
    this.catchEnv = catchGain.gain;
    // idle lope: two slow LFOs → detune (cents) and a little AM ("roughness")
    const lfo1 = b.add(mkOsc(ctx, 'sine', 1.3)), lfo2 = b.add(mkOsc(ctx, 'sine', 0.47));
    const lopeGain = b.add(mkGain(ctx, 0)), roughGain = b.add(mkGain(ctx, 0));
    lfo1.connect(lopeGain); lfo2.connect(lopeGain);
    lopeGain.connect(oscB.detune); lopeGain.connect(oscD.detune);
    lfo1.connect(roughGain).connect(catchGain.gain);
    this.lope = new SmoothParam(lopeGain.gain, TAU_SLOW, 0.05);
    this.rough = new SmoothParam(roughGain.gain, TAU_SLOW);
    // ── exhaust resonator chain ──
    const peaks = EXHAUST_RESONANCES.map((r) => b.add(mkFilter(ctx, 'peaking', r.hz, r.q, r.db)));
    const exhLp = b.add(mkFilter(ctx, 'lowpass', 5000, 0.7));
    chain(catchGain, ...peaks, exhLp, mix);
    // ── noise layers (one pink + one white source, fanned out) ──
    const pink = b.add(mkLoop(ctx, noise.pink, 0.37));
    const white = b.add(mkLoop(ctx, noise.white, 1.91));
    const rumbleLp = b.add(mkFilter(ctx, 'lowpass', 180, 0.9));
    const rumbleGain = b.add(mkGain(ctx, 0));
    chain(pink, rumbleLp, rumbleGain, catchGain);
    this.rumble = new SmoothParam(rumbleGain.gain, TAU);
    const intakeBp = b.add(mkFilter(ctx, 'bandpass', 700, 0.8));
    const intakeGain = b.add(mkGain(ctx, 0));
    chain(pink, intakeBp, intakeGain, mix);
    this.intake = new SmoothParam(intakeGain.gain, TAU);
    this.intakeHz = new SmoothParam(intakeBp.frequency, TAU, 1, 0.01);
    const mechHp = b.add(mkFilter(ctx, 'highpass', 2500, 0.7));
    const ring = b.add(mkGain(ctx, 0)); // gain driven at audio rate by the 8·f0 oscillator
    const ringOsc = b.add(mkOsc(ctx, 'sine', 0));
    b.add(mkScaled(ctx, crank, 8 * profile.cylinders / strokesHalf, ringOsc.frequency));
    ringOsc.connect(ring.gain);
    const mechGain = b.add(mkGain(ctx, 0));
    chain(white, mechHp, ring, mechGain, mix);
    this.mech = new SmoothParam(mechGain.gain, TAU);
    // ── starter: whine with a compression-stroke cadence ──
    const whineOsc = b.add(mkOsc(ctx, 'sawtooth', 70));
    const cadence = b.add(mkOsc(ctx, 'sine', 0));
    b.add(mkScaled(ctx, crank, profile.cylinders / strokesHalf, cadence.frequency));
    const whineBp = b.add(mkFilter(ctx, 'bandpass', 1200, 1.2));
    const whineAm = b.add(mkGain(ctx, 0.65));
    b.add(mkScaled(ctx, cadence, 0.35, whineAm.gain));
    b.add(mkScaled(ctx, cadence, 60, whineOsc.detune));
    const whineGain = b.add(mkGain(ctx, 0));
    chain(whineOsc, whineBp, whineAm, whineGain, mix);
    this.whine = new SmoothParam(whineGain.gain, TAU_FAST);
    this.whineHz = new SmoothParam(whineOsc.frequency, TAU, 0.5);
    // ── shutdown ticks (cooling / afterfire) ──
    const crackle = b.add(mkLoop(ctx, noise.crackle, 0.11));
    const tickBp = b.add(mkFilter(ctx, 'bandpass', 3000, 1.5));
    const tickGain = b.add(mkGain(ctx, 0));
    chain(crackle, tickBp, tickGain, mix);
    this.ticks = tickGain.gain;
    // ── propeller ──
    this.prop = new PropellerLayer(ctx, crank, pink, profile, b);
    this.prop.output.connect(mix);
    for (const p of [this.crank, this.bright, this.dull, this.rumble, this.intake, this.mech, this.whine, this.lope, this.rough]) p.init(0, t);
    this.intakeHz.init(700, t); this.whineHz.init(70, t);
  }

  /** Firing frequency for the last update, Hz (before Doppler). */
  get firingHz(): number { return this._firingHz; }
  /** MAP load 0..1 used for the last update. */
  get load(): number { return this._load; }
  /** Combustion pulse level 0..1 for the last update (before layer gain). */
  get level(): number { return this._level; }
  /** Engine sound phase. */
  get phase(): EnginePhase { return this.fsm.phase; }
  /** Number of persistent nodes (CPU budget). */
  get nodeCount(): number { return this.bag.size; }

  /**
   * Per-frame update; allocation-free.
   * @param exterior listener outside the aircraft (prop dominates, §A3)
   * @param doppler pitch ratio from {@link dopplerRatio} (1 for co-moving cameras)
   */
  update(dt: number, inp: EngineSynthInput, exterior: boolean, doppler: number): void {
    const p = this.profile, now = this.ctx.currentTime;
    const rpm = Number.isFinite(inp.rpm) ? Math.max(0, inp.rpm) : 0;
    const phase = this.fsm.update(dt, inp.running, rpm, inp.starter);
    if (this.fsm.justEntered) this.onPhaseEntered(phase, now);
    const combusting = phase === 'running' || phase === 'catching';
    const x = clamp(rpm / p.ratedRpm, 0, 1.2);
    const mapFrac = mapLoad(inp.manifoldPressureInHg, p.minMapInHg, p.maxMapInHg);
    const load = combusting ? mapFrac : phase === 'cranking' ? 0.1 : 0;
    let level: number;
    if (combusting) level = engineLoudness(x, load);
    else if (phase === 'cranking') level = 0.35 * clamp(rpm / 200, 0, 1);
    else level = 0.3 * engineLoudness(x, 0) * clamp(rpm / 400, 0, 1); // motoring / run-down compression
    this._firingHz = firingFrequencyHz(rpm, p.cylinders, p.strokes);
    this._load = load;
    this._level = level;
    const tau = phase === 'rundown' || phase === 'off' ? TAU_SLOW : TAU;
    const dop = Number.isFinite(doppler) && doppler > 0 ? doppler : 1;
    this.crank.set(crankFrequencyHz(rpm) * dop, now, tau);
    this.bright.set(G.pulse * level * load, now, tau);
    this.dull.set(G.pulse * level * (1 - load), now, tau);
    // idle lope / roughness fade out above idle + 600 rpm
    const lopeK = combusting ? clamp(1 - (rpm - p.idleRpm) / 600, 0, 1) : 0;
    this.lope.set(G.lopeCents * lopeK, now);
    this.rough.set(G.rough * lopeK, now);
    // noise layers
    const thr = combusting ? clamp(inp.throttle ?? mapFrac, 0, 1) : 0;
    const catchBoost = phase === 'catching' ? 1 - this.fsm.catchProgress : 0;
    this.rumble.set(combusting ? G.rumble * (load + catchBoost) : 0, now, tau);
    this.intake.set(G.intake * (combusting ? 0.3 + 0.7 * thr : 0.15) * Math.sqrt(x), now, tau);
    this.intakeHz.set((400 + 800 * Math.min(1, x)) * dop, now);
    this.mech.set(G.mech * Math.min(1, x), now, tau);
    // starter whine follows the cranking speed
    const whineOn = phase === 'cranking' || (phase === 'catching' && inp.starter === true);
    this.whine.set(whineOn ? G.whine : 0, now, whineOn ? TAU_FAST : 0.08);
    this.whineHz.set(70 + 40 * clamp(rpm / 250, 0, 1), now);
    this.prop.update(now, rpm, inp.tasMs, inp.speedOfSound, inp.thrustN, exterior, dop, tau);
  }

  /** Stop and disconnect every node. */
  dispose(): void { this.bag.dispose(); }

  /** One-shot automation when the sequencer changes phase (cough-and-catch, shutdown ticks). */
  private onPhaseEntered(phase: EnginePhase, t: number): void {
    if (phase === 'catching') {
      const g = this.catchEnv; // cough, stumble, cough, catch swell, settle
      g.cancelScheduledValues(t);
      g.setValueAtTime(2.6, t);
      g.setTargetAtTime(0.45, t + 0.03, 0.04);
      g.setValueAtTime(2.0, t + 0.18);
      g.setTargetAtTime(0.7, t + 0.21, 0.05);
      g.setTargetAtTime(1.6, t + 0.32, 0.05);
      g.setTargetAtTime(1.0, t + 0.45, 0.15);
    } else if (phase === 'rundown') {
      const k = this.ticks;
      k.cancelScheduledValues(t);
      k.setValueAtTime(0, t);
      k.setTargetAtTime(G.ticks, t, 0.08);
      k.setTargetAtTime(0, t + 1.2, 0.3);
    } else if (phase === 'running' || phase === 'off') {
      this.catchEnv.setTargetAtTime(1, t, 0.1);
    }
  }
}
