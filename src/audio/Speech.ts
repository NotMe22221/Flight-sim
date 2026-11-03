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

interface Transmission { role: SpeechRole; chunks: string[]; index: number; /** normalised text */ key: string }

/** Most transmissions kept waiting behind the current one; the stalest are dropped first. */
export const MAX_QUEUED_TRANSMISSIONS = 8;

/**
 * Watchdog for speech engines that never report the end of an utterance: Chrome drops `onend`
 * when the utterance object is garbage-collected (crbug 509488), and some Linux builds without
 * voices fire neither `end` nor `error`. Without it the queue (and the engine duck) would stall
 * forever. Generous: ≈ 8 chars/s at rate 1 plus a fixed margin, so a real voice is never cut.
 */
export const SPEECH_WATCHDOG = { baseMs: 4000, msPerChar: 120 } as const;

/** Time after which a chunk of `chars` characters spoken at `rate` is assumed lost, ms. */
export const speechWatchdogMs = (chars: number, rate: number): number =>
  SPEECH_WATCHDOG.baseMs + (SPEECH_WATCHDOG.msPerChar * Math.max(0, chars)) / Math.max(0.1, rate);

/** Queued, chunked speech for ATC and crew call-outs. Safe (silent) without the Web Speech API. */
export class Speech {
  private readonly synth: SpeechSynthesisLike | null;
  private readonly makeUtterance: ((text: string) => SpeechSynthesisUtterance) | null;
  private readonly queue: Transmission[] = [];
  private current: Transmission | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** strong reference to the utterance being spoken (Chrome GC drops its `onend` otherwise) */
  private utterance: SpeechSynthesisUtterance | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private lang: string;
  private readonly maxChars: number;
  private readonly leadMs: number;
  private readonly gapMs: number;
  private disposed = false;
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
  get available(): boolean { return !this.disposed && this.synth !== null && this.makeUtterance !== null; }
  /** True while a transmission is in progress (including its squelch lead). */
  get speaking(): boolean { return this.current !== null; }
  /** Transmissions waiting behind the current one. */
  get queueLength(): number { return this.queue.length; }
  /** The utterance handed to the engine and not yet finished (null between chunks). */
  get inFlight(): SpeechSynthesisUtterance | null { return this.utterance; }

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

  /**
   * Queue `text` spoken by `role`. Blank text is ignored, and so is a message identical to the one
   * in progress or already waiting (a caller re-issuing it every frame must not queue it 60×/s).
   * At most {@link MAX_QUEUED_TRANSMISSIONS} wait; the stalest are dropped first.
   */
  speak(text: string, role: SpeechRole = 'atc'): void {
    if (!this.available) return;
    const chunks = chunkText(text, this.maxChars);
    if (!chunks.length) return;
    const key = chunks.join(' ');
    const same = (t: Transmission | null): boolean => t !== null && t.role === role && t.key === key;
    if (same(this.current) || this.queue.some(same)) return;
    this.queue.push({ role, chunks, index: 0, key });
    if (this.queue.length > MAX_QUEUED_TRANSMISSIONS) this.queue.splice(0, this.queue.length - MAX_QUEUED_TRANSMISSIONS);
    if (!this.current && this.timer === null) this.startNext();
  }

  /** Stop speaking now and drop the queue. */
  cancel(): void {
    this.queue.length = 0;
    this.clearTimer();
    this.clearWatchdog();
    this.gen++; // invalidates callbacks of utterances already handed to the engine
    const cur = this.current;
    this.current = null;
    this.utterance = null;
    if (this.synth) { try { this.synth.cancel(); } catch { /* ignore */ } }
    if (cur) this.opts.onTransmission?.(cur.role, 'end');
  }

  /** Cancel and detach listeners; later calls to `speak` are ignored. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
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
    // only the utterance in flight may advance the queue: a late `end` from a chunk the watchdog
    // already skipped must not skip the next one
    const done = (): void => { if (gen === this.gen && this.current === cur && this.utterance === u) this.advance(cur); };
    u.onend = done;
    u.onerror = done; // 'interrupted', 'synthesis-failed', …: skip the chunk rather than stall the queue
    this.utterance = u;
    this.clearWatchdog();
    this.watchdog = setTimeout(() => { this.watchdog = null; done(); }, speechWatchdogMs(cur.chunks[cur.index].length, preset.rate));
    try { this.synth.speak(u); } catch { done(); }
  }

  private advance(cur: Transmission): void {
    this.clearWatchdog();
    this.utterance = null;
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

  private clearWatchdog(): void {
    if (this.watchdog !== null) { clearTimeout(this.watchdog); this.watchdog = null; }
  }
}
