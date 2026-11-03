/**
 * FAA-style radio phraseology building blocks (AIM 4-2-8/4-2-9, FAA JO 7110.65 §2-4).
 *
 * Every builder returns a {@link Spoken} pair:
 *  - `text`   — what a subtitle shows, with digits ("runway 28R", "120.5", "2,500");
 *  - `speech` — what text-to-speech says, spelled the way it is said on the radio
 *               ("runway two eight right", "one two zero point five", "two thousand five hundred").
 *
 * FAA voice conventions: "niner" for 9 but plain "three"/"five" (not ICAO "tree"/"fife"),
 * digits individually except round altitudes ("one zero thousand five hundred"), "point" for the
 * decimal of a frequency, phonetic alphabet for letters.
 */
import { wrap360 } from '../core/math';

/** A transmission fragment: subtitle text and its spoken form. */
export interface Spoken {
  readonly text: string;
  readonly speech: string;
}

/** Build a {@link Spoken}; `speech` defaults to the text (plain words). */
export const spoken = (text: string, speech: string = text): Spoken => ({ text, speech });

/** Digit words (FAA: "niner"). */
export const DIGIT_WORDS: readonly string[] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];

/** Phonetic alphabet. Spelled for speech engines ("Alpha", "Juliet") rather than the ICAO "Alfa", "Juliett". */
export const PHONETIC: Readonly<Record<string, string>> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel',
  I: 'India', J: 'Juliet', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa',
  Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
  X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

const capitalise = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Spell a string character by character: digits as words, letters phonetically, '.' as "point",
 * '-' as "minus"; spaces and anything else are dropped. `titleCase` capitalises digit words
 * (used for callsigns: "One Seven Two").
 */
export function spellOut(s: string | number, titleCase = false): string {
  const str = String(s).toUpperCase();
  const words: string[] = [];
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') {
      const w = DIGIT_WORDS[ch.charCodeAt(0) - 48];
      words.push(titleCase ? capitalise(w) : w);
    } else if (ch >= 'A' && ch <= 'Z') words.push(PHONETIC[ch]);
    else if (ch === '.') words.push('point');
    else if (ch === '-') words.push('minus');
  }
  return words.join(' ');
}

/** Phonetic word of an ATIS letter ('A' → 'Alpha'). */
export const phoneticLetter = (letter: string): string => PHONETIC[letter.toUpperCase()] ?? letter;

/** ATIS code letter as a Spoken pair (text and speech are both the phonetic word, as on subtitles). */
export const atisLetter = (letter: string): Spoken => spoken(phoneticLetter(letter));

/** Digits spoken individually ("12" → "one two"), text unchanged. For distances, speeds, codes, temperatures. */
export function digits(n: number | string): Spoken {
  const text = typeof n === 'number' ? String(Math.round(n)) : n;
  return spoken(text, spellOut(text));
}

/** Format an integer with thousands separators ("12500" → "12,500"). */
export function thousands(n: number): string {
  const s = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

/**
 * Altitude in feet (rounded to 100 ft) in group form: 2 500 → "two thousand five hundred",
 * 10 500 → "one zero thousand five hundred", 900 → "niner hundred"; 18 000 ft and above are
 * flight levels ("flight level one eight zero") unless `flightLevels` is false (heights such as
 * cloud bases).
 */
export function altitude(ft: number, flightLevels = true): Spoken {
  const h = Math.max(0, Math.round(ft / 100));
  if (flightLevels && h >= 180) return spoken(`FL${h}`, `flight level ${spellOut(h)}`);
  const th = Math.floor(h / 10), hu = h % 10;
  const parts: string[] = [];
  if (th > 0) parts.push(`${th >= 10 ? spellOut(th) : DIGIT_WORDS[th]} thousand`);
  if (hu > 0) parts.push(`${DIGIT_WORDS[hu]} hundred`);
  return spoken(thousands(h * 100), parts.length ? parts.join(' ') : 'zero');
}

/** Altimeter setting in inHg: 30.05 → text "30.05", speech "three zero zero five". */
export function altimeter(inHg: number): Spoken {
  const code = String(Math.round(inHg * 100)).padStart(4, '0');
  return spoken(`${code.slice(0, code.length - 2)}.${code.slice(-2)}`, spellOut(code));
}

/** Magnetic heading/course, 3 digits, north is 360: 5 → "005" / "zero zero five". */
export function heading(deg: number): Spoken {
  let h = Math.round(wrap360(deg));
  if (h === 0 || h === 360) h = 360;
  const text = String(h).padStart(3, '0');
  return spoken(text, spellOut(text));
}

const SIDE_WORD: Readonly<Record<string, string>> = { L: 'left', R: 'right', C: 'center' };

/**
 * Runway designator, FAA style without a leading zero: "28R" → "28R" / "two eight right",
 * "01L" → "1L" / "one left", "09" → "9" / "niner". Non-standard idents are spelled out.
 */
export function runway(ident: string): Spoken {
  const m = /^0*(\d{1,2})([LRC]?)$/i.exec(ident.trim());
  if (!m) return spoken(ident, spellOut(ident));
  const side = m[2].toUpperCase();
  return spoken(`${m[1]}${side}`, side ? `${spellOut(m[1])} ${SIDE_WORD[side]}` : spellOut(m[1]));
}

/**
 * Radio frequency in MHz with trailing zeros dropped: 120.5 → "120.5" / "one two zero point five",
 * 128.325 → "one two eight point three two five", 121 → "121.0".
 */
export function frequency(mhz: number): Spoken {
  let text = mhz.toFixed(3).replace(/0+$/, '');
  if (text.endsWith('.')) text += '0';
  return spoken(text, spellOut(text));
}

/** Wind below this speed is reported as calm (FAA JO 7110.65 §2-6-5: less than three knots). */
export const CALM_WIND_KT = 3;

/**
 * Surface wind as ATC says it: direction rounded to 10° (north = 360), speed and gust in digits:
 * (280, 12, 18) → "280 at 12 gusting 18" / "two eight zero at one two gusting one eight".
 * Below {@link CALM_WIND_KT} → "calm". A gust is reported only when it exceeds the mean speed.
 */
export function wind(dirDeg: number, speedKt: number, gustKt = 0): Spoken {
  const spd = Math.round(speedKt);
  if (spd < CALM_WIND_KT) return spoken('calm');
  let d = Math.round(wrap360(dirDeg) / 10) * 10;
  if (d === 0) d = 360;
  const dir = String(d).padStart(3, '0');
  const gust = Math.round(gustKt);
  const g = gust > spd ? ` gusting ${gust}` : '';
  const gs = gust > spd ? ` gusting ${spellOut(gust)}` : '';
  return spoken(`${dir} at ${spd}${g}`, `${spellOut(dir)} at ${spellOut(spd)}${gs}`);
}

/** Temperature in whole °C: −5 → "-5" / "minus five", 18 → "one eight". */
export function temperature(c: number): Spoken {
  const t = Math.round(c);
  const v = t === 0 ? 0 : t; // no "-0"
  return spoken(String(v), spellOut(String(v)));
}

/** Zulu time "1856Z" / "one eight five six zulu" from UTC epoch ms. */
export function zuluTime(utcMs: number): Spoken {
  const d = new Date(utcMs);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return spoken(`${hhmm}Z`, `${spellOut(hhmm)} zulu`);
}

/** Transponder code (4 octal digits): 4521 → "4521" / "four five two one". */
export const squawk = (code: number): Spoken => digits(String(code).padStart(4, '0'));

/** Distance in nautical miles, whole miles, digits spoken individually: 12 → "12 miles" / "one two miles". */
export function miles(nm: number): Spoken {
  const n = Math.max(1, Math.round(nm));
  return spoken(`${n} mile${n === 1 ? '' : 's'}`, `${spellOut(n)} mile${n === 1 ? '' : 's'}`);
}

const COMPASS_8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

/** 8-point compass word for a true bearing in degrees (0 → 'north', 135 → 'southeast'). */
export function compassWord(bearingDeg: number): string {
  return COMPASS_8[Math.round(wrap360(bearingDeg) / 45) % 8];
}
