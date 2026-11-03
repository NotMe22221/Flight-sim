/**
 * Web Speech API wrapper (docs/research/06 §A5.6): per-role voice presets, a transmission
 * queue, cancel, and Chrome-safe chunking at sentence boundaries (speechText.ts).
 *
 * IMPORTANT: `speechSynthesis` output cannot be routed through Web Audio — there is no
 * MediaStream / AudioNode for it — so speech never passes the `atc` bus, the radio band-pass or
 * the limiter. What we can do: set each utterance's `volume` from the master × atc volume, and
 * call `onTransmission` hooks around every transmission so the mixer can play squelch clicks and
 * a static burst on the atc bus and duck the engine while a voice speaks.
 */
import { chunkText, MAX_CHUNK_CHARS } from './speechText';

/** Who is talking (matches `AudioMixer.speak`). */
export type SpeechRole = 'atc' | 'pilot' | 'copilot';

/** Voice preset per role. `voiceRank` picks a different voice of the language per role when possible. */
export interface RolePreset { rate: number; pitch: number; voiceRank: number }

/** ATC slightly faster and lower (§A5.6); crew voices distinct from the controller. */
export const ROLE_PRESETS: Readonly<Record<SpeechRole, RolePreset>> = {
  atc: { rate: 1.05, pitch: 0.9, voiceRank: 0 },
  pilot: { rate: 1.0, pitch: 1.0, voiceRank: 1 },
  copilot: { rate: 1.0, pitch: 1.12, voiceRank: 2 },
};

/** The subset of `SpeechSynthesis` used (lets tests inject a fake). */
export interface SpeechSynthesisLike {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
  addEventListener?(type: 'voiceschanged', fn: () => void): void;
  removeEventListener?(type: 'voiceschanged', fn: () => void): void;
}

/** Construction options. */
export interface SpeechOptions {
  /** defaults to `globalThis.speechSynthesis`; null disables speech */
  synth?: SpeechSynthesisLike | null;
  /** defaults to `new SpeechSynthesisUtterance(text)` */
  makeUtterance?: (text: string) => SpeechSynthesisUtterance;
  /** BCP-47 language prefix for voice selection (default 'en'; region 'en-US' preferred) */
  lang?: string;
  maxChunkChars?: number;
  /** squelch-open lead before the first word of a transmission, ms (default 180) */
  leadMs?: number;
  /** gap between queued transmissions, ms (default 300) */
  gapMs?: number;
  /** utterance volume 0..1 (read for every chunk) */
  volume?: () => number;
  /** transmission start / end hooks (squelch clicks, static, ducking) */
  onTransmission?: (role: SpeechRole, phase: 'start' | 'end') => void;
}

interface Transmission { role: SpeechRole; chunks: string[]; index: number }

/** Queued, chunked speech for ATC and crew call-outs. Safe (silent) without the Web Speech API. */
export class Speech {
  private readonly synth: SpeechSynthesisLike | null;
  private readonly makeUtterance: ((text: string) => SpeechSynthesisUtterance) | null;
  private readonly queue: Transmission[] = [];
  private current: Transmission | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private lang: string;
  private readonly maxChars: number;
  private readonly leadMs: number;
  private readonly gapMs: number;
  private readonly onVoices = (): void => { this.refreshVoices(); };

  constructor(private readonly opts: SpeechOptions = {}) {
    const g = globalThis as { speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance };
    this.synth = opts.synth === undefined ? (g.speechSynthesis ?? null) : opts.synth;
    const Utt = g.SpeechSynthesisUtterance;
    this.makeUtterance = opts.makeUtterance ?? (Utt ? (t: string) => new Utt(t) : null);
    this.lang = opts.lang ?? 'en';
    this.maxChars = opts.maxChunkChars ?? MAX_CHUNK_CHARS;
    this.leadMs = opts.leadMs ?? 180;
    this.gapMs = opts.gapMs ?? 300;
    if (this.synth) {
      this.refreshVoices();
      try { this.synth.addEventListener?.('voiceschanged', this.onVoices); } catch { /* old Safari */ }
    }
  }

  /** True when the Web Speech API is usable. */
  get available(): boolean { return this.synth !== null && this.makeUtterance !== null; }
  /** True while a transmission is in progress (including its squelch lead). */
  get speaking(): boolean { return this.current !== null; }
  /** Transmissions waiting behind the current one. */
  get queueLength(): number { return this.queue.length; }

  /** Change the voice language (e.g. 'en', 'en-GB', 'fr'). */
  setLanguage(lang: string): void { this.lang = lang; }

  /** Voices of a language, preferred region first, local voices before network ones. */
  voicesFor(lang = this.lang): SpeechSynthesisVoice[] {
    const want = lang.toLowerCase().replace('_', '-');
    const base = want.split('-')[0];
    const region = want.includes('-') ? want : base === 'en' ? 'en-us' : want;
    const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
    const score = (v: SpeechSynthesisVoice) => (norm(v) === region ? 0 : 2) + (v.localService ? 0 : 1);
    return this.voices.filter((v) => norm(v).split('-')[0] === base).sort((a, b) => score(a) - score(b));
  }

  /** Queue `text` spoken by `role`. Blank text is ignored. */
  speak(text: string, role: SpeechRole = 'atc'): void {
    if (!this.available) return;
    const chunks = chunkText(text, this.maxChars);
    if (!chunks.length) return;
    this.queue.push({ role, chunks, index: 0 });
    if (!this.current && this.timer === null) this.startNext();
  }

  /** Stop speaking now and drop the queue. */
  cancel(): void {
    this.queue.length = 0;
    this.clearTimer();
    this.gen++; // invalidates callbacks of utterances already handed to the engine
    const cur = this.current;
    this.current = null;
    if (this.synth) { try { this.synth.cancel(); } catch { /* ignore */ } }
    if (cur) this.opts.onTransmission?.(cur.role, 'end');
  }

  /** Cancel and detach listeners. */
  dispose(): void {
    this.cancel();
    try { this.synth?.removeEventListener?.('voiceschanged', this.onVoices); } catch { /* ignore */ }
  }

  // ───────────────────────────── internals ─────────────────────────────

  private refreshVoices(): void {
    try { this.voices = this.synth?.getVoices() ?? []; } catch { this.voices = []; }
  }

  private startNext(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.opts.onTransmission?.(next.role, 'start');
    const gen = this.gen;
    this.later(this.leadMs, () => { if (gen === this.gen) this.speakChunk(); });
  }

  private speakChunk(): void {
    const cur = this.current;
    if (!cur || !this.synth || !this.makeUtterance) return;
    const u = this.makeUtterance(cur.chunks[cur.index]);
    const preset = ROLE_PRESETS[cur.role];
    if (!this.voices.length) this.refreshVoices();
    const voices = this.voicesFor();
    if (voices.length) {
      u.voice = voices[preset.voiceRank % voices.length];
      u.lang = u.voice.lang;
    } else {
      u.lang = this.lang === 'en' ? 'en-US' : this.lang;
    }
    u.rate = preset.rate;
    u.pitch = preset.pitch;
    u.volume = Math.max(0, Math.min(1, this.opts.volume?.() ?? 1));
    const gen = this.gen;
    const done = (): void => { if (gen === this.gen && this.current === cur) this.advance(cur); };
    u.onend = done;
    u.onerror = done; // 'interrupted', 'synthesis-failed', …: skip the chunk rather than stall the queue
    try { this.synth.speak(u); } catch { done(); }
  }

  private advance(cur: Transmission): void {
    cur.index++;
    if (cur.index < cur.chunks.length) { this.speakChunk(); return; }
    this.current = null;
    this.opts.onTransmission?.(cur.role, 'end');
    if (this.queue.length) {
      const gen = this.gen;
      this.later(this.gapMs, () => { if (gen === this.gen) this.startNext(); });
    }
  }

  private later(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
}
