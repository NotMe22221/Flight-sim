/**
 * Transient voices (thumps, chirps, clicks, chimes). Each call allocates a handful of nodes —
 * fine for discrete events, never call these per frame — and every node is disconnected when the
 * voice's source ends, so nothing leaks. Envelopes use only automation calls on fresh nodes.
 */

/** Disconnect a transient voice's nodes once its source has ended. */
export function autoDispose(src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  src.onended = () => {
    try { src.disconnect(); } catch { /* already */ }
    for (const n of nodes) { try { n.disconnect(); } catch { /* already */ } }
  };
}

/** Options for {@link playTone}. */
export interface ToneOptions {
  type?: OscillatorType;
  /** start frequency, Hz */
  freq: number;
  /** end frequency (exponential glide over `glideS`), Hz */
  freqEnd?: number;
  glideS?: number;
  /** absolute start time (ctx clock), s */
  at: number;
  /** time from start to the beginning of the release, s */
  dur: number;
  /** peak gain */
  gain: number;
  /** linear attack, s (default 3 ms) */
  attack?: number;
  /** exponential release time constant, s (default 20 ms) */
  release?: number;
  /** vibrato depth in cents and rate in Hz (optional) */
  vibratoCents?: number;
  vibratoHz?: number;
}

/** Play an enveloped oscillator tone into `dest`. */
export function playTone(ctx: BaseAudioContext, dest: AudioNode, o: ToneOptions): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  const t = Math.max(o.at, ctx.currentTime);
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd !== undefined && o.freqEnd > 0 && o.freq > 0) {
    osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + (o.glideS ?? o.dur));
  }
  const g = ctx.createGain();
  const atk = o.attack ?? 0.003, rel = o.release ?? 0.02;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.gain, t + atk);
  g.gain.setValueAtTime(o.gain, t + Math.max(atk, o.dur));
  g.gain.setTargetAtTime(0, t + Math.max(atk, o.dur), rel);
  osc.connect(g).connect(dest);
  const extra: AudioNode[] = [g];
  if (o.vibratoCents && o.vibratoHz) {
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(o.vibratoHz, t);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(o.vibratoCents, t);
    lfo.connect(depth).connect(osc.detune);
    lfo.start(t);
    lfo.stop(t + o.dur + rel * 6);
    extra.push(depth);
    autoDispose(lfo, depth);
  }
  osc.start(t);
  osc.stop(t + Math.max(atk, o.dur) + rel * 6);
  autoDispose(osc, ...extra);
  return osc;
}

/** Options for {@link playNoiseBurst}. */
export interface NoiseBurstOptions {
  /** absolute start time, s */
  at: number;
  /** burst length before the release, s */
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  freq: number;
  Q?: number;
  attack?: number;
  release?: number;
  /** start offset into the noise loop (decorrelates repeated bursts), s */
  offsetS?: number;
}

/** Play a filtered, enveloped noise burst from a (looping) noise buffer into `dest`. */
export function playNoiseBurst(ctx: BaseAudioContext, dest: AudioNode, buffer: AudioBuffer, o: NoiseBurstOptions): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const t = Math.max(o.at, ctx.currentTime);
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.frequency.setValueAtTime(o.freq, t);
  f.Q.setValueAtTime(o.Q ?? 0.7071, t);
  const g = ctx.createGain();
  const atk = o.attack ?? 0.001, rel = o.release ?? 0.01;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.gain, t + atk);
  g.gain.setValueAtTime(o.gain, t + Math.max(atk, o.dur));
  g.gain.setTargetAtTime(0, t + Math.max(atk, o.dur), rel);
  src.connect(f).connect(g).connect(dest);
  src.start(t, (o.offsetS ?? 0) % Math.max(1e-3, buffer.duration));
  src.stop(t + Math.max(atk, o.dur) + rel * 6);
  autoDispose(src, f, g);
  return src;
}
