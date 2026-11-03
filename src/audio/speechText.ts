/**
 * Text chunking for the Web Speech API. Chrome silently stops utterances that run longer than
 * ~15 s (long-standing Chromium bug with network voices), so long ATC messages are split at
 * sentence boundaries into chunks that each speak well under that limit (~160 characters ≈ 11 s
 * at ATC rate). Never splits inside numbers such as "121.5" (a boundary needs whitespace after
 * the punctuation). No regex lookbehind (unsupported before Safari 16.4).
 */

/** Default maximum characters per utterance chunk. */
export const MAX_CHUNK_CHARS = 160;

const SENTENCE_END = '.!?;';

/** Split normalised text into sentences (punctuation kept, boundaries need trailing whitespace). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.includes(text[i]) && (i + 1 === text.length || text[i + 1] === ' ')) {
      const s = text.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Split an over-long sentence at commas, then words, then (last resort) hard character cuts. */
function splitLong(sentence: string, max: number): string[] {
  const pieces: string[] = [];
  const clauses = sentence.split(', ');
  for (let i = 0; i < clauses.length; i++) {
    const c = i < clauses.length - 1 ? `${clauses[i]},` : clauses[i];
    if (c.length <= max) { pieces.push(c); continue; }
    for (const w of c.split(' ')) {
      if (w.length <= max) pieces.push(w);
      else for (let j = 0; j < w.length; j += max) pieces.push(w.slice(j, j + max));
    }
  }
  return pack(pieces, max);
}

/** Greedily join pieces with spaces into chunks of at most `max` characters. */
function pack(pieces: string[], max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) cur = p;
    else if (cur.length + 1 + p.length <= max) cur = `${cur} ${p}`;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Chunk `text` for speechSynthesis: whitespace normalised, sentences packed greedily into
 * chunks of at most `maxChars` characters; an over-long sentence is split at commas / words.
 * Returns [] for blank text.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const max = Math.max(8, Math.floor(maxChars));
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return [];
  const pieces: string[] = [];
  for (const s of splitSentences(norm)) {
    if (s.length <= max) pieces.push(s);
    else pieces.push(...splitLong(s, max));
  }
  return pack(pieces, max);
}
