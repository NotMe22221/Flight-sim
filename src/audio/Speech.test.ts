import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_PRESETS, Speech, type SpeechRole, type SpeechSynthesisLike } from './Speech';
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
