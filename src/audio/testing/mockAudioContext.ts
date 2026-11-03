/**
 * A recording fake `AudioContext` for Node tests (no DOM, no audio). Implements the factory
 * methods the audio module uses and a controllable clock (`advance`). Cast with
 * `asAudioContext(mock)` where production code expects a real `AudioContext`.
 */
import {
  type DirectValueWrite, MockAudioBuffer, MockAudioBufferSourceNode, MockAudioNode, MockAudioParam,
  MockBiquadFilterNode, MockConstantSourceNode, MockDynamicsCompressorNode, MockGainNode, type MockHost,
  MockOscillatorNode, MockPeriodicWave, MockScheduledSource, MockStereoPannerNode, MockWaveShaperNode,
} from './mockAudioNodes';

export * from './mockAudioNodes';

type Listener = () => void;

/** Options for {@link MockAudioContext}. */
export interface MockAudioContextOptions {
  sampleRate?: number;
  /** initial state; real browsers without user activation start 'suspended' */
  state?: AudioContextState | 'interrupted';
  /** make resume() reject (autoplay blocked) */
  rejectResume?: boolean;
}

/** Recording fake AudioContext. */
export class MockAudioContext implements MockHost {
  readonly sampleRate: number;
  currentTime = 0;
  state: AudioContextState | 'interrupted';
  readonly destination: MockAudioNode;
  readonly nodes: MockAudioNode[] = [];
  readonly directValueWrites: DirectValueWrite[] = [];
  readonly baseLatency = 0.01;
  resumeCalls = 0;
  rejectResume: boolean;
  onstatechange: Listener | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(opts: MockAudioContextOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
    this.state = opts.state ?? 'suspended';
    this.rejectResume = opts.rejectResume ?? false;
    this.destination = new MockAudioNode(this, 'destination');
  }

  register(node: MockAudioNode): void { this.nodes.push(node); }
  recordDirectWrite(w: DirectValueWrite): void { this.directValueWrites.push(w); }

  // ── lifecycle ──
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: context closed'));
    if (this.rejectResume) return Promise.reject(new Error('NotAllowedError: no user gesture'));
    this.setState('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> { this.setState('suspended'); return Promise.resolve(); }
  close(): Promise<void> { this.setState('closed'); return Promise.resolve(); }
  /** Test hook: simulate an external state change (e.g. iOS 'interrupted' by a phone call). */
  setState(s: AudioContextState | 'interrupted'): void {
    if (this.state === s) return;
    this.state = s;
    this.onstatechange?.();
    for (const l of this.listeners) l();
  }
  addEventListener(type: string, fn: Listener): void { if (type === 'statechange') this.listeners.add(fn); }
  removeEventListener(type: string, fn: Listener): void { if (type === 'statechange') this.listeners.delete(fn); }

  /** Advance the clock and fire `ended` on sources whose stop time has passed. */
  advance(dt: number): void {
    this.currentTime += dt;
    for (const n of this.nodes) if (n instanceof MockScheduledSource) n.tick(this.currentTime);
  }

  // ── factories ──
  createGain(): MockGainNode { return new MockGainNode(this); }
  createOscillator(): MockOscillatorNode { return new MockOscillatorNode(this); }
  createBiquadFilter(): MockBiquadFilterNode { return new MockBiquadFilterNode(this); }
  createBufferSource(): MockAudioBufferSourceNode { return new MockAudioBufferSourceNode(this); }
  createConstantSource(): MockConstantSourceNode { return new MockConstantSourceNode(this); }
  createStereoPanner(): MockStereoPannerNode { return new MockStereoPannerNode(this); }
  createWaveShaper(): MockWaveShaperNode { return new MockWaveShaperNode(this); }
  createDynamicsCompressor(): MockDynamicsCompressorNode { return new MockDynamicsCompressorNode(this); }
  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    if (channels < 1 || length < 1 || sampleRate < 3000) throw new RangeError('createBuffer: bad arguments');
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  createPeriodicWave(real: Float32Array | number[], imag: Float32Array | number[], constraints?: { disableNormalization?: boolean }): MockPeriodicWave {
    if (real.length !== imag.length || real.length < 2) throw new RangeError('createPeriodicWave: bad arrays');
    return new MockPeriodicWave(Float32Array.from(real), Float32Array.from(imag), constraints?.disableNormalization ?? false);
  }

  // ── inspection helpers ──
  /** All created nodes of a kind ('gain', 'oscillator', 'biquad', 'bufferSource', …). */
  nodesOfKind<T extends MockAudioNode>(kind: string): T[] {
    return this.nodes.filter((n) => n.kind === kind) as T[];
  }
  /** Sources that were started and have not ended. */
  liveSources(): MockScheduledSource[] {
    return this.nodes.filter((n): n is MockScheduledSource => n instanceof MockScheduledSource && n.started && !n.ended);
  }
  /** Every AudioParam of every node (for global assertions). */
  allParams(): MockAudioParam[] {
    const out: MockAudioParam[] = [];
    for (const n of this.nodes) {
      for (const v of Object.values(n)) if (v instanceof MockAudioParam) out.push(v);
    }
    return out;
  }
  /** Direct `.value` writes that happened while audible (context running or source started). */
  audibleDirectWrites(): DirectValueWrite[] { return this.directValueWrites.filter((w) => w.afterStart); }
}

/** View a mock as the DOM `AudioContext` type that production code expects. */
export const asAudioContext = (m: MockAudioContext): AudioContext => m as unknown as AudioContext;
