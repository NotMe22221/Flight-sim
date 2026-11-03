/**
 * Radio channel: emits transmissions (subtitle + speech) immediately or after a delay counted
 * in simulation time (`update(dt)`), and runs an effect when a delayed transmission goes out.
 * One controller reply is pending at a time; no timers, no wall clock.
 */
import type { Spoken } from './phraseology';

/** Who is talking. */
export type RadioVoice = 'atc' | 'pilot';

/** A transmission as delivered to the UI (`atc:message` payload). */
export interface RadioMessage {
  from: RadioVoice;
  text: string;
  frequencyMHz?: number;
}

/** Callbacks the radio delivers to. */
export interface RadioSink {
  emit(msg: RadioMessage): void;
  speak?(text: string, voice: RadioVoice): void;
}

interface Pending {
  from: RadioVoice;
  spoken: Spoken;
  mhz: number | null;
  remainingS: number;
  then: (() => void) | null;
}

/** Controller reply latency window, s (upper bound leaves one frame of margin under 3 s). */
export const REPLY_DELAY_MIN_S = 1.5;
export const REPLY_DELAY_MAX_S = 2.75;

/** The shared frequency: immediate transmissions plus a queue of delayed ones. */
export class RadioQueue {
  private readonly queue: Pending[] = [];

  constructor(private readonly sink: RadioSink) {}

  /** True while a delayed transmission is waiting to go out. */
  get busy(): boolean {
    return this.queue.length > 0;
  }

  /** Transmit now. */
  transmit(from: RadioVoice, s: Spoken, mhz: number | null): void {
    const msg: RadioMessage = mhz === null ? { from, text: s.text } : { from, text: s.text, frequencyMHz: mhz };
    this.sink.emit(msg);
    this.sink.speak?.(s.speech, from);
  }

  /** Transmit after `delayS` seconds of simulation time, then run `then`. */
  schedule(from: RadioVoice, s: Spoken, mhz: number | null, delayS: number, then: (() => void) | null = null): void {
    this.queue.push({ from, spoken: s, mhz, remainingS: delayS, then });
  }

  /** Advance time; sends every transmission whose delay has elapsed (in order). */
  update(dt: number): void {
    if (this.queue.length === 0) return;
    let elapsed = dt;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      head.remainingS -= elapsed;
      elapsed = 0; // later entries count from the moment the previous one went out
      if (head.remainingS > 1e-9) break;
      this.queue.shift();
      this.transmit(head.from, head.spoken, head.mhz);
      head.then?.();
    }
  }

  /** Drop everything pending (used on reset). */
  clear(): void {
    this.queue.length = 0;
  }
}
