/**
 * Rebinding capture: waits for the next key chord or gamepad button / axis push and returns
 * the physical-input part of a binding. Used by InputManager.startListening*; the manager
 * then applies the binding to the right profile.
 */
import type { Binding } from './bindings';
import type { Chord } from './chord';
import type { GamepadCapture, GamepadSource } from './gamepad';
import type { ResolvedPreset } from './gamepadId';
import type { KeyboardSource } from './keyboard';

/** Physical-input part of a binding produced by a capture. */
export type CapturedInput = Pick<Binding, 'device' | 'code' | 'ctrl' | 'shift' | 'alt' | 'button' | 'axisIndex' | 'axisDir'>;

export interface CaptureOptions {
  /** which devices may answer (default 'any') */
  device?: 'keyboard' | 'gamepad' | 'any';
  /** give up after this many ms (default 8000; 0 = never) */
  timeoutMs?: number;
}

/** A capture in progress. */
export interface Capture {
  /** Ends the capture; its callback receives null. No-op once finished. */
  cancel(): void;
}

/** Keyboard chord → binding input with only the modifiers that are held. */
export const chordInput = (ch: Chord): CapturedInput => ({
  device: 'keyboard', code: ch.code, ...(ch.ctrl ? { ctrl: true } : {}), ...(ch.shift ? { shift: true } : {}), ...(ch.alt ? { alt: true } : {}),
});

/**
 * Starts capturing. `onDone(input, pad)` runs exactly once: with the captured input (plus the
 * pad's resolved preset for gamepad input) or with null on Esc / timeout / cancel. Modifier-only
 * key presses are ignored by the keyboard source; the captured key never reaches the bindings.
 */
export function captureNextInput(
  keyboard: KeyboardSource, pads: GamepadSource, opts: CaptureOptions,
  onDone: (input: CapturedInput | null, pad: ResolvedPreset | null) => void,
): Capture {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (input: CapturedInput | null, pad: ResolvedPreset | null): void => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    keyboard.listener = null;
    pads.stopCapture();
    onDone(input, pad);
  };
  const dev = opts.device ?? 'any';
  if (dev !== 'gamepad') {
    keyboard.releaseAll();
    keyboard.listener = (ch: Chord): boolean => {
      if (ch.code === 'Escape' && !ch.ctrl && !ch.shift && !ch.alt) finish(null, null);
      else finish(chordInput(ch), null);
      return true;
    };
  }
  if (dev !== 'keyboard') {
    pads.listener = (cap: GamepadCapture): boolean => {
      const r = pads.resolved(cap.pad.index);
      if (!r) return false;
      finish(cap.button !== undefined
        ? { device: 'gamepad', button: cap.button }
        : { device: 'gamepad', axisIndex: cap.axisIndex, axisDir: cap.axisDir }, r);
      return true;
    };
  }
  const ms = opts.timeoutMs ?? 8000;
  if (ms > 0) timer = setTimeout(() => finish(null, null), ms);
  return { cancel: () => finish(null, null) };
}
