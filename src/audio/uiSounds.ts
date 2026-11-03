/**
 * Synthesized UI sounds (docs/research/06 §A5.5) — no sample assets:
 * - click: 2 ms white burst → BP 2.5 kHz (0.4) + 20 ms 180 Hz sine (0.3)
 * - switch: two clicks 35 ms apart, the second band-passed at 1.8 kHz
 * - warn: 3 × 880 Hz, 60 ms each
 * - confirm: 660 Hz then 990 Hz
 * - error: 220 Hz square, 120 ms
 */
import { playNoiseBurst, playTone } from './oneShots';

/** UI sound names (match `AudioMixer.playUi`). */
export type UiSound = 'click' | 'switch' | 'warn' | 'confirm' | 'error';

let burstSeq = 0;

function click(ctx: BaseAudioContext, dest: AudioNode, white: AudioBuffer, at: number, bpHz: number, gain = 1): void {
  playNoiseBurst(ctx, dest, white, { at, dur: 0.002, gain: 0.4 * gain, filter: 'bandpass', freq: bpHz, Q: 1, attack: 0.0005, release: 0.003, offsetS: 0.13 * burstSeq++ });
  playTone(ctx, dest, { freq: 180, at, dur: 0.02, gain: 0.3 * gain, attack: 0.001, release: 0.01 });
}

/** Play one UI sound into `dest` (allocates a few transient nodes; event-driven). */
export function playUiSound(ctx: BaseAudioContext, dest: AudioNode, white: AudioBuffer, kind: UiSound): void {
  const t = ctx.currentTime;
  switch (kind) {
    case 'click':
      click(ctx, dest, white, t, 2500);
      break;
    case 'switch':
      click(ctx, dest, white, t, 2500);
      click(ctx, dest, white, t + 0.035, 1800, 0.8);
      break;
    case 'warn':
      for (let i = 0; i < 3; i++) playTone(ctx, dest, { type: 'triangle', freq: 880, at: t + i * 0.12, dur: 0.06, gain: 0.3, attack: 0.004, release: 0.01 });
      break;
    case 'confirm':
      playTone(ctx, dest, { freq: 660, at: t, dur: 0.07, gain: 0.3, attack: 0.004, release: 0.015 });
      playTone(ctx, dest, { freq: 990, at: t + 0.08, dur: 0.1, gain: 0.3, attack: 0.004, release: 0.03 });
      break;
    case 'error':
      playTone(ctx, dest, { type: 'square', freq: 220, at: t, dur: 0.12, gain: 0.18, attack: 0.003, release: 0.015 });
      break;
  }
}
