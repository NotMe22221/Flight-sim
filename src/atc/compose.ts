/**
 * Composition helpers for {@link Spoken} pairs: a `say` template tag that builds the subtitle
 * text and the speech text of a transmission in one go, joins and sentence casing.
 */
import type { Spoken } from './phraseology';

/** A template value: a Spoken pair (text/speech differ), or a plain string/number used verbatim in both. */
export type SayValue = Spoken | string | number;

const textOf = (v: SayValue): string => (typeof v === 'object' ? v.text : String(v));
const speechOf = (v: SayValue): string => (typeof v === 'object' ? v.speech : String(v));

/**
 * Template tag building a Spoken pair:
 * `say\`${cs}, runway ${runway('28R')}, cleared for takeoff.\`` →
 * text "Cessna 2FS, runway 28R, cleared for takeoff." / speech "Cessna Two Foxtrot Sierra, runway two eight right, …".
 */
export function say(strings: TemplateStringsArray, ...values: SayValue[]): Spoken {
  let text = strings[0], speech = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += textOf(values[i]) + strings[i + 1];
    speech += speechOf(values[i]) + strings[i + 1];
  }
  return { text: tidy(text), speech: tidy(speech) };
}

/** Collapse doubled spaces and stray spaces before punctuation left by empty template values. */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,+/g, ',').replace(/,\./g, '.').trim();
}

/** Join pairs with a separator (and an optional different last separator, e.g. " and "). */
export function joinSpoken(parts: readonly SayValue[], sep: string, lastSep: string = sep): Spoken {
  let text = '', speech = '';
  for (let i = 0; i < parts.length; i++) {
    const s = i === 0 ? '' : i === parts.length - 1 ? lastSep : sep;
    text += s + textOf(parts[i]);
    speech += s + speechOf(parts[i]);
  }
  return { text, speech };
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const terminate = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Capitalise the first letter and end with a period (both text and speech). */
export function sentence(s: Spoken): Spoken {
  return { text: terminate(capitalise(s.text.trim())), speech: terminate(capitalise(s.speech.trim())) };
}
