/**
 * Terse constructors for the Web Audio nodes used by the synths. Every initial value is set
 * through `setValueAtTime` (see params.ts) so no audible param is ever assigned via `.value`.
 * Uses the factory methods (`createGain`, …) for the widest browser support.
 */
import { setAt } from './params';

/** GainNode with an initial gain. */
export function mkGain(ctx: BaseAudioContext, gain: number): GainNode {
  const g = ctx.createGain();
  setAt(g.gain, gain, ctx.currentTime);
  return g;
}

/** BiquadFilterNode of a type with frequency, Q and (peaking/shelf) gain in dB. */
export function mkFilter(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, Q = 0.7071, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  const t = ctx.currentTime;
  f.type = type;
  setAt(f.frequency, frequency, t);
  setAt(f.Q, Q, t);
  if (gainDb !== 0) setAt(f.gain, gainDb, t);
  return f;
}

/** Started OscillatorNode with a basic type or a PeriodicWave. */
export function mkOsc(ctx: BaseAudioContext, type: OscillatorType | PeriodicWave, frequency: number, when?: number): OscillatorNode {
  const o = ctx.createOscillator();
  // PeriodicWave is an empty interface in lib.dom (structurally matches string), so narrow by hand
  if (typeof type === 'string') o.type = type as OscillatorType;
  else o.setPeriodicWave(type);
  setAt(o.frequency, frequency, ctx.currentTime);
  o.start(when ?? ctx.currentTime);
  return o;
}

/** Started looping AudioBufferSourceNode (offset staggers shared loops so layers decorrelate). */
export function mkLoop(ctx: BaseAudioContext, buffer: AudioBuffer, offsetS = 0): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.start(ctx.currentTime, offsetS % Math.max(1e-3, buffer.duration));
  return s;
}

/** Started ConstantSourceNode (a control signal for AudioParam fan-out, §A1.3). */
export function mkConst(ctx: BaseAudioContext, value: number): ConstantSourceNode {
  const c = ctx.createConstantSource();
  setAt(c.offset, value, ctx.currentTime);
  c.start(ctx.currentTime);
  return c;
}

/** Route `src × k` into an AudioParam (which sums it with its intrinsic value). Returns the scaler. */
export function mkScaled(ctx: BaseAudioContext, src: AudioNode, k: number, ...dests: AudioParam[]): GainNode {
  const g = mkGain(ctx, k);
  src.connect(g);
  for (const d of dests) g.connect(d);
  return g;
}

/** Chain nodes left → right; returns the last. */
export function chain<T extends AudioNode>(...nodes: [...AudioNode[], T]): T {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1] as T;
}

/** Stop (sources) and disconnect a set of nodes; tolerant of already-stopped nodes. */
export function teardown(nodes: Iterable<AudioNode>): void {
  for (const n of nodes) {
    const s = n as AudioNode & { stop?: (when?: number) => void };
    if (typeof s.stop === 'function') { try { s.stop(); } catch { /* not started / already stopped */ } }
    try { n.disconnect(); } catch { /* already disconnected */ }
  }
}

/**
 * Collects nodes as they are created so a synth can dispose everything in one call.
 * `add` returns its argument for inline use.
 */
export class NodeBag {
  private readonly nodes: AudioNode[] = [];
  add<T extends AudioNode>(n: T): T { this.nodes.push(n); return n; }
  /** Number of persistent nodes owned (CPU-budget bookkeeping). */
  get size(): number { return this.nodes.length; }
  dispose(): void { teardown(this.nodes); this.nodes.length = 0; }
}
