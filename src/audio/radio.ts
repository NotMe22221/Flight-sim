/**
 * Radio squelch effects around ATC transmissions (on the atc bus). The voice itself comes from
 * speechSynthesis and cannot be routed through Web Audio (see Speech.ts), so the "radio" feel
 * comes from a squelch-open click + static burst before the first word and a static tail +
 * click after the last one.
 */
import { playNoiseBurst } from './oneShots';

let seq = 0;

/** Play the squelch open ('start') or close ('end') effect into `dest`. Event-driven only. */
export function playSquelch(ctx: BaseAudioContext, dest: AudioNode, white: AudioBuffer, phase: 'start' | 'end'): void {
  const t = ctx.currentTime;
  const k = seq++;
  const click = (at: number): void => {
    playNoiseBurst(ctx, dest, white, { at, dur: 0.002, gain: 0.3, filter: 'bandpass', freq: 3000, Q: 1, attack: 0.0005, release: 0.002, offsetS: 0.29 * k });
  };
  const hiss = (at: number, dur: number): void => {
    playNoiseBurst(ctx, dest, white, { at, dur, gain: 0.12, filter: 'bandpass', freq: 1800, Q: 0.6, attack: 0.004, release: 0.02, offsetS: 0.71 * k });
  };
  if (phase === 'start') {
    click(t);
    hiss(t + 0.004, 0.13);
  } else {
    hiss(t, 0.09);
    click(t + 0.1);
  }
}
