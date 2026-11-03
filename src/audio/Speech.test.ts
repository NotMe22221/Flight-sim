import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUEUED_TRANSMISSIONS, ROLE_PRESETS, Speech, type SpeechRole, type SpeechSynthesisLike, speechWatchdogMs } from './Speech';
import { chunkText, splitSentences } from './speechText';

/** Minimal utterance stand-in (Node has no SpeechSynthesisUtterance). */
class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

const voice = (name: string, lang: string, localService = true): SpeechSynthesisVoice =>
  ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;

/** Fake speechSynthesis: records utterances; `finish()` ends the one being spoken. */
class FakeSynth implements SpeechSynthesisLike {
  readonly spoken: FakeUtterance[] = [];
  private pending: FakeUtterance[] = [];
  cancels = 0;
  voices = [voice('Daniel', 'en-GB'), voice('Samantha', 'en-US'), voice('Alex', 'en-US', false), voice('Thomas', 'fr-FR')];
  speak(u: SpeechSynthesisUtterance): void {
    const f = u as unknown as FakeUtterance;
    this.spoken.push(f);
    this.pending.push(f);
  }
  cancel(): void {
    this.cancels++;
    const p = this.pending;
    this.pending = [];
    for (const u of p) u.onerror?.(); // Chrome reports 'interrupted' / 'canceled' errors
  }
  getVoices(): SpeechSynthesisVoice[] { return this.voices; }
  finish(): void { this.pending.shift()?.onend?.(); }
}

describe('chunkText', () => {
  it('keeps short text whole and normalises whitespace', () => {
    expect(chunkText('  Cessna 172SP,   cleared   for takeoff. ')).toEqual(['Cessna 172SP, cleared for takeoff.']);
    expect(chunkText('   ')).toEqual([]);
  });
  it('splits at sentence boundaries, never inside decimals', () => {
    expect(splitSentences('Contact tower 120.5. Good day!')).toEqual(['Contact tower 120.5.', 'Good day!']);
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} talks about runway two eight right at 121.5 megahertz.`).join(' ');
    const chunks = chunkText(text, 160);
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(160);
      expect(c.endsWith('.')).toBe(true); // every chunk ends on a sentence boundary
    }
    expect(chunks.join(' ')).toBe(text);
  });
  it('splits a single over-long sentence at commas / words', () => {
    const s = `${'alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, '.repeat(6)}india.`;
    const chunks = chunkText(s, 80);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(s.replace(/\s+/g, ' ').trim());
    expect(chunkText('x'.repeat(50), 20).every((c) => c.length <= 20)).toBe(true);
  });
});

describe('Speech', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (extra: { volume?: () => number } = {}) => {
    const synth = new FakeSynth();
    const events: string[] = [];
    const speech = new Speech({
      synth,
      makeUtterance: (t) => new FakeUtterance(t) as unknown as SpeechSynthesisUtterance,
      leadMs: 100, gapMs: 200, maxChunkChars: 60,
      onTransmission: (role: SpeechRole, phase) => events.push(`${role}:${phase}`),
      ...extra,
    });
    return { synth, speech, events };
  };

  it('is a silent no-op without the Web Speech API', () => {
    const s = new Speech({ synth: null });
    expect(s.available).toBe(false);
    expect(() => { s.speak('hello'); s.cancel(); s.dispose(); }).not.toThrow();
  });

  it('opens the squelch, speaks chunk by chunk with role presets, then closes', () => {
    const { synth, speech, events } = make({ volume: () => 0.4 });
    speech.speak('Cessna one two three, runway two eight right, cleared to land. Wind two niner zero at eight.', 'atc');
    expect(events).toEqual(['atc:start']);
    expect(synth.spoken.length).toBe(0); // squelch lead
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(1);
    const u = synth.spoken[0];
    expect(u.rate).toBe(ROLE_PRESETS.atc.rate);
    expect(u.pitch).toBe(ROLE_PRESETS.atc.pitch);
    expect(u.volume).toBe(0.4);
    expect(u.voice?.lang).toBe('en-US'); // preferred region, local voice first
    expect(u.voice?.name).toBe('Samantha');
    synth.finish();
    expect(synth.spoken.length).toBe(2); // next chunk only after the previous ended
    synth.finish();
    expect(events).toEqual(['atc:start', 'atc:end']);
    expect(speech.speaking).toBe(false);
  });

  it('queues transmissions with a gap and uses distinct voices per role', () => {
    const { synth, speech, events } = make();
    speech.speak('Tower, Cessna one two three ready.', 'pilot');
    speech.speak('Cessna one two three, hold short.', 'atc');
    expect(speech.queueLength).toBe(1);
    vi.advanceTimersByTime(100);
    synth.finish();
    expect(events).toEqual(['pilot:start', 'pilot:end']);
    vi.advanceTimersByTime(200);
    expect(events).toEqual(['pilot:start', 'pilot:end', 'atc:start']);
    vi.advanceTimersByTime(100);
    expect(synth.spoken[1].voice?.name).not.toBe(synth.spoken[0].voice?.name);
  });

  it('cancel drops the queue, stops the engine, closes the squelch and ignores stale callbacks', () => {
    const { synth, speech, events } = make();
    speech.speak('First message. It is fairly long so that it needs more than one chunk to be spoken.', 'atc');
    speech.speak('Second message.', 'atc');
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(1);
    speech.cancel();
    expect(synth.cancels).toBe(1);
    expect(speech.speaking).toBe(false);
    expect(speech.queueLength).toBe(0);
    expect(events).toEqual(['atc:start', 'atc:end']);
    vi.advanceTimersByTime(5000);
    expect(synth.spoken.length).toBe(1); // nothing else was spoken after cancel
    speech.speak('After cancel.', 'copilot');
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(2);
    expect(synth.spoken[1].pitch).toBe(ROLE_PRESETS.copilot.pitch);
  });

  it('an engine error skips the chunk instead of stalling the queue', () => {
    const { synth, speech, events } = make();
    speech.speak('One.', 'atc');
    vi.advanceTimersByTime(100);
    synth.spoken[0].onerror?.();
    expect(events).toEqual(['atc:start', 'atc:end']);
    expect(speech.speaking).toBe(false);
  });
});

describe('Speech watchdog (engines that never report the end of an utterance)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => {
    const synth = new FakeSynth();
    const events: string[] = [];
    const speech = new Speech({
      synth,
      makeUtterance: (t) => new FakeUtterance(t) as unknown as SpeechSynthesisUtterance,
      leadMs: 100, gapMs: 200, maxChunkChars: 60,
      onTransmission: (role: SpeechRole, phase) => events.push(`${role}:${phase}`),
    });
    return { synth, speech, events };
  };

  it('a voice that never fires onend/onerror cannot stall the queue or hold the squelch open', () => {
    // Chrome drops `onend` when the utterance is garbage-collected; Linux builds without voices fire nothing.
    const { synth, speech, events } = make();
    speech.speak('Tower, Cessna one two three ready.', 'pilot');
    speech.speak('Cessna one two three, hold short.', 'atc');
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(speech.speaking).toBe(true); // not cut short while a real voice could still be talking
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual(['pilot:start', 'pilot:end', 'atc:start', 'atc:end']);
    expect(synth.spoken.map((u) => u.text)).toEqual(['Tower, Cessna one two three ready.', 'Cessna one two three, hold short.']);
    expect(speech.speaking).toBe(false);
  });

  it('a late end event from a chunk the watchdog already skipped does not skip the next chunk', () => {
    const { synth, speech, events } = make();
    speech.speak('First sentence is here and it is long enough. Second sentence follows right after it.', 'atc');
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(1);
    vi.advanceTimersByTime(speechWatchdogMs(synth.spoken[0].text.length, ROLE_PRESETS.atc.rate) + 10);
    expect(synth.spoken.length).toBe(2); // watchdog moved on to chunk 2
    synth.spoken[0].onend?.(); // the engine finally reports chunk 1
    expect(speech.speaking).toBe(true); // chunk 2 is still being spoken
    expect(events).toEqual(['atc:start']);
    synth.spoken[1].onend?.();
    expect(events).toEqual(['atc:start', 'atc:end']);
    expect(speech.speaking).toBe(false);
  });

  it('keeps a strong reference to the utterance in flight (Chrome GC drops its onend otherwise)', () => {
    const { synth, speech } = make();
    speech.speak('Cleared for takeoff.', 'atc');
    vi.advanceTimersByTime(100);
    expect(speech.inFlight).toBe(synth.spoken[0]);
    synth.finish();
    expect(speech.inFlight).toBeNull();
  });

  it('cancel clears the watchdog', () => {
    const { synth, speech, events } = make();
    speech.speak('Cleared for takeoff.', 'atc');
    vi.advanceTimersByTime(100);
    speech.cancel();
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual(['atc:start', 'atc:end']);
    expect(synth.spoken.length).toBe(1);
  });

  it('ignores a message identical to the one in progress or already waiting (per-frame spam)', () => {
    const { synth, speech, events } = make();
    const msg = 'Cessna one two three, traffic twelve o clock.';
    for (let i = 0; i < 60; i++) speech.speak(msg, 'atc'); // a caller speaking every frame for a second
    expect(speech.queueLength).toBe(0);
    vi.advanceTimersByTime(100);
    synth.finish();
    vi.advanceTimersByTime(10_000);
    expect(synth.spoken.length).toBe(1);
    expect(events).toEqual(['atc:start', 'atc:end']);
    speech.speak(msg, 'atc'); // repeating it once it has been heard is fine
    speech.speak(msg, 'pilot'); // and so is the pilot reading it back
    vi.advanceTimersByTime(100);
    expect(synth.spoken.length).toBe(2);
    expect(speech.queueLength).toBe(1);
  });

  it('caps the backlog by dropping the stalest waiting transmission', () => {
    const { speech } = make();
    for (let i = 0; i < 40; i++) speech.speak(`Message number ${i}.`, 'atc');
    expect(speech.queueLength).toBe(MAX_QUEUED_TRANSMISSIONS);
  });
});
