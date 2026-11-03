/**
 * Noise generators for pre-rendered looping AudioBuffers (docs/research/06 §A1.6). Looping a
 * 4 s buffer is inaudible and far cheaper than a ScriptProcessor/worklet generator.
 * Pure functions on Float32Arrays so they are unit-testable in Node.
 */
import { mulberry32 } from '../core/math';

/** Kinds of pre-rendered noise. */
export type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle';

/** Uniform white noise in [-1, 1). */
export function fillWhite(out: Float32Array, rnd: () => number): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 2 - 1;
  return out;
}

/**
 * Pink (−3 dB/oct) noise, Paul Kellet's "refined" filter (±0.05 dB above 9.2 Hz at 44.1 kHz,
 * musicdsp.org #76). Output peaks around ±1.
 */
export function fillPink(out: Float32Array, rnd: () => number): Float32Array {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

/** Brown (−6 dB/oct) noise: leaky integrator of white noise. */
export function fillBrown(out: Float32Array, rnd: () => number): Float32Array {
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = (y + 0.02 * (rnd() * 2 - 1)) / 1.02;
    out[i] = y * 3.5;
  }
  return out;
}

/**
 * Sparse random clicks (Poisson process, `ratePerS` mean events per second): each click is a
 * short exponentially decaying noise burst with random amplitude. Used for raindrops on the
 * airframe and shutdown "ticks".
 */
export function fillCrackle(out: Float32Array, sampleRate: number, ratePerS: number, rnd: () => number): Float32Array {
  out.fill(0);
  const p = ratePerS / sampleRate;
  const decay = Math.exp(-1 / (0.0015 * sampleRate)); // ~1.5 ms clicks
  let env = 0;
  for (let i = 0; i < out.length; i++) {
    if (rnd() < p) env = 0.3 + 0.7 * rnd();
    out[i] = env * (rnd() * 2 - 1);
    env *= decay;
  }
  return out;
}

/**
 * Make a loop seamless. `src` holds `out.length + fade` samples; the head of `out` is an
 * equal-power crossfade from the overhang `src[n..n+fade)` (which is the natural continuation
 * of the tail) into `src[0..fade)`, so playback wraps from `out[n-1]` to `out[0] = src[n]`
 * without a discontinuity.
 */
export function loopCrossfade(src: Float32Array, out: Float32Array, fade: number): Float32Array {
  const n = out.length;
  if (src.length < n + fade) throw new RangeError('loopCrossfade: src must be out.length + fade long');
  for (let i = 0; i < n; i++) out[i] = src[i];
  for (let i = 0; i < fade; i++) {
    const t = (i / fade) * Math.PI * 0.5;
    out[i] = src[i] * Math.sin(t) + src[n + i] * Math.cos(t);
  }
  return out;
}

/** Render `seconds` of noise of a given kind into a mono Float32Array (seeded, deterministic). */
export function renderNoise(kind: NoiseKind, sampleRate: number, seconds: number, seed = 1): Float32Array {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const fade = Math.min(Math.round(sampleRate * 0.05), n >> 2);
  const src = new Float32Array(n + fade);
  const rnd = mulberry32(seed);
  switch (kind) {
    case 'white': fillWhite(src, rnd); break;
    case 'pink': fillPink(src, rnd); break;
    case 'brown': fillBrown(src, rnd); break;
    case 'crackle': fillCrackle(src, sampleRate, 40, rnd); break;
  }
  return loopCrossfade(src, new Float32Array(n), fade);
}

/** Create a mono looping-ready AudioBuffer of noise in `ctx` (allocates; call once, not per frame). */
export function createNoiseBuffer(ctx: BaseAudioContext, kind: NoiseKind, seconds = 4, seed = 1): AudioBuffer {
  const data = renderNoise(kind, ctx.sampleRate, seconds, seed);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}
