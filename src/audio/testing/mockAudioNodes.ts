/**
 * Recording fakes for the subset of Web Audio nodes the audio module uses. They implement the
 * DOM interfaces structurally (no audio is produced) and record every AudioParam automation
 * call so tests can assert on targets, time constants and forbidden direct `.value` writes.
 *
 * Test-only code: never imported by production modules.
 */

/** One recorded AudioParam automation call. */
export type ParamCall =
  | { type: 'setValueAtTime'; value: number; time: number }
  | { type: 'setTargetAtTime'; value: number; time: number; tau: number }
  | { type: 'linearRampToValueAtTime'; value: number; time: number }
  | { type: 'exponentialRampToValueAtTime'; value: number; time: number }
  | { type: 'cancelScheduledValues'; time: number }
  | { type: 'cancelAndHoldAtTime'; time: number };

/** A direct `param.value = x` assignment caught by the guard. */
export interface DirectValueWrite {
  node: string;
  param: string;
  value: number;
  time: number;
  /** true when the owning context was already running or the owning source had been started */
  afterStart: boolean;
}

/** Minimal clock + registry the fakes report to (implemented by MockAudioContext). */
export interface MockHost {
  readonly currentTime: number;
  readonly state: string;
  register(node: MockAudioNode): void;
  recordDirectWrite(w: DirectValueWrite): void;
}

const MAX_CALLS = 512;

/** Fake AudioParam: records automation, guards direct writes. */
export class MockAudioParam {
  readonly calls: ParamCall[] = [];
  /** total number of automation calls ever made (calls[] keeps only the latest MAX_CALLS) */
  callCount = 0;
  /** signals connected into this param (fan-out sources) */
  readonly inputs: MockAudioNode[] = [];
  private current: number;
  readonly automationRate: AutomationRate = 'a-rate';

  constructor(
    private readonly host: MockHost,
    readonly owner: MockAudioNode,
    readonly name: string,
    readonly defaultValue: number,
    readonly minValue = -3.4028234663852886e38,
    readonly maxValue = 3.4028234663852886e38,
  ) {
    this.current = defaultValue;
  }

  get value(): number { return this.current; }
  set value(v: number) {
    this.host.recordDirectWrite({
      node: this.owner.kind, param: this.name, value: v, time: this.host.currentTime,
      afterStart: this.host.state === 'running' || this.owner.started,
    });
    this.current = v;
  }

  /** The value the latest value-bearing automation call heads to (or the plain value). */
  get target(): number {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if ('value' in c) return c.value;
    }
    return this.current;
  }

  /** Latest call of a given type, if any. */
  last<T extends ParamCall['type']>(type: T): Extract<ParamCall, { type: T }> | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.type === type) return c as Extract<ParamCall, { type: T }>;
    }
    return undefined;
  }

  private push(c: ParamCall): this {
    this.calls.push(c);
    this.callCount++;
    if (this.calls.length > MAX_CALLS) this.calls.shift();
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    this.current = value;
    return this.push({ type: 'setValueAtTime', value, time });
  }
  setTargetAtTime(value: number, time: number, tau: number): this {
    if (!(tau > 0)) throw new RangeError('setTargetAtTime: timeConstant must be > 0');
    return this.push({ type: 'setTargetAtTime', value, time, tau });
  }
  linearRampToValueAtTime(value: number, time: number): this {
    return this.push({ type: 'linearRampToValueAtTime', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError('exponentialRampToValueAtTime: value must be non-zero');
    return this.push({ type: 'exponentialRampToValueAtTime', value, time });
  }
  cancelScheduledValues(time: number): this { return this.push({ type: 'cancelScheduledValues', time }); }
  cancelAndHoldAtTime(time: number): this { return this.push({ type: 'cancelAndHoldAtTime', time }); }
  setValueCurveAtTime(): this { throw new Error('setValueCurveAtTime not supported by the mock'); }
}

/** Fake AudioNode with connection bookkeeping. */
export class MockAudioNode {
  readonly outputs: (MockAudioNode | MockAudioParam)[] = [];
  readonly inputs: MockAudioNode[] = [];
  started = false;
  stopped = false;
  disconnected = false;
  channelCount = 2;
  numberOfInputs = 1;
  numberOfOutputs = 1;

  constructor(readonly host: MockHost, readonly kind: string) {
    host.register(this);
  }

  get context(): MockHost { return this.host; }

  /** Connect to a node (returns it, so chains work) or to an AudioParam (returns undefined). */
  connect<T extends MockAudioNode | MockAudioParam>(dest: T): T extends MockAudioNode ? T : undefined;
  connect(dest: MockAudioNode | MockAudioParam): MockAudioNode | undefined {
    this.outputs.push(dest);
    dest.inputs.push(this);
    this.disconnected = false;
    return dest instanceof MockAudioNode ? dest : undefined;
  }

  /**
   * `disconnect()` removes every outgoing connection; `disconnect(dest)` only those to `dest` and,
   * like the real API, throws InvalidAccessError when there is none.
   */
  disconnect(dest?: MockAudioNode | MockAudioParam): void {
    if (dest !== undefined && !this.outputs.includes(dest)) throw new Error('InvalidAccessError: not connected to that destination');
    for (let k = this.outputs.length - 1; k >= 0; k--) {
      const d = this.outputs[k];
      if (dest !== undefined && d !== dest) continue;
      const i = d.inputs.indexOf(this);
      if (i >= 0) d.inputs.splice(i, 1);
      this.outputs.splice(k, 1);
    }
    this.disconnected = this.outputs.length === 0;
  }

  protected param(name: string, def: number, min?: number, max?: number): MockAudioParam {
    return new MockAudioParam(this.host, this, name, def, min, max);
  }
}

/** Shared start/stop/onended behaviour of scheduled sources. */
export class MockScheduledSource extends MockAudioNode {
  startTime = -1;
  stopTime = Infinity;
  onended: ((ev: Event) => void) | null = null;
  private endedListeners: (() => void)[] = [];
  ended = false;

  start(when = 0): void {
    if (this.started) throw new Error(`${this.kind}: start() called twice`);
    this.started = true;
    this.startTime = when;
  }
  stop(when = 0): void {
    if (!this.started) throw new Error(`${this.kind}: stop() before start()`);
    this.stopped = true;
    this.stopTime = Math.max(when, this.host.currentTime);
  }
  addEventListener(type: string, fn: () => void): void { if (type === 'ended') this.endedListeners.push(fn); }
  removeEventListener(type: string, fn: () => void): void {
    if (type === 'ended') this.endedListeners = this.endedListeners.filter((f) => f !== fn);
  }
  /** Called by the mock context's clock. */
  tick(now: number): void {
    if (this.ended || !this.stopped || now < this.stopTime) return;
    this.ended = true;
    this.onended?.(new Event('ended'));
    for (const fn of this.endedListeners) fn();
  }
}

export class MockGainNode extends MockAudioNode {
  readonly gain: MockAudioParam;
  constructor(host: MockHost) { super(host, 'gain'); this.gain = this.param('gain', 1); }
}

export class MockOscillatorNode extends MockScheduledSource {
  readonly frequency: MockAudioParam;
  readonly detune: MockAudioParam;
  type: OscillatorType = 'sine';
  periodicWave: MockPeriodicWave | null = null;
  constructor(host: MockHost) {
    super(host, 'oscillator');
    this.frequency = this.param('frequency', 440);
    this.detune = this.param('detune', 0);
  }
  setPeriodicWave(w: MockPeriodicWave): void { this.periodicWave = w; this.type = 'custom'; }
}

export class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency: MockAudioParam;
  readonly Q: MockAudioParam;
  readonly gain: MockAudioParam;
  readonly detune: MockAudioParam;
  constructor(host: MockHost) {
    super(host, 'biquad');
    this.frequency = this.param('frequency', 350, 0, 24000);
    this.Q = this.param('Q', 1);
    this.gain = this.param('gain', 0);
    this.detune = this.param('detune', 0);
  }
}

export class MockAudioBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(ch: number): Float32Array {
    const d = this.data[ch];
    if (!d) throw new RangeError('channel out of range');
    return d;
  }
}

export class MockAudioBufferSourceNode extends MockScheduledSource {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate: MockAudioParam;
  readonly detune: MockAudioParam;
  constructor(host: MockHost) {
    super(host, 'bufferSource');
    this.playbackRate = this.param('playbackRate', 1);
    this.detune = this.param('detune', 0);
  }
}

export class MockConstantSourceNode extends MockScheduledSource {
  readonly offset: MockAudioParam;
  constructor(host: MockHost) { super(host, 'constantSource'); this.offset = this.param('offset', 1); }
}

export class MockStereoPannerNode extends MockAudioNode {
  readonly pan: MockAudioParam;
  constructor(host: MockHost) { super(host, 'stereoPanner'); this.pan = this.param('pan', 0, -1, 1); }
}

export class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(host: MockHost) { super(host, 'waveShaper'); }
}

export class MockDynamicsCompressorNode extends MockAudioNode {
  readonly threshold: MockAudioParam;
  readonly knee: MockAudioParam;
  readonly ratio: MockAudioParam;
  readonly attack: MockAudioParam;
  readonly release: MockAudioParam;
  readonly reduction = 0;
  constructor(host: MockHost) {
    super(host, 'compressor');
    this.threshold = this.param('threshold', -24);
    this.knee = this.param('knee', 30);
    this.ratio = this.param('ratio', 12);
    this.attack = this.param('attack', 0.003);
    this.release = this.param('release', 0.25);
  }
}

export class MockPeriodicWave {
  constructor(readonly real: Float32Array, readonly imag: Float32Array, readonly disableNormalization: boolean) {}
}
