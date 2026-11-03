/**
 * Text helpers for instructor lines: numbers formatted for subtitles ("3,500 ft") and spelled
 * for text-to-speech ("three thousand five hundred feet"), the way an instructor says them.
 * Pure string functions; used when lessons are compiled, never per frame.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} hundred`);
  if (r > 0 || h === 0) {
    if (r < 20) parts.push(ONES[r]);
    else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? ` ${ONES[r % 10]}` : ''));
  }
  return parts.join(' ');
}

/** 3500 → "three thousand five hundred", 74 → "seventy four", -200 → "minus two hundred". */
export function spellNumber(value: number): string {
  let n = Math.round(value);
  if (n < 0) return `minus ${spellNumber(-n)}`;
  if (n === 0) return 'zero';
  const out: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  if (millions > 0) { out.push(`${under1000(millions)} million`); n %= 1_000_000; }
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) { out.push(`${under1000(thousands)} thousand`); n %= 1000; }
  if (n > 0) out.push(under1000(n));
  return out.join(' ');
}

/** Digit by digit: "28" → "two eight", "090" → "zero nine zero". Letters L/R/C become left/right/center. */
export function spellDigits(s: string): string {
  const words: string[] = [];
  for (const ch of s.toUpperCase()) {
    if (ch >= '0' && ch <= '9') words.push(ONES[ch.charCodeAt(0) - 48]);
    else if (ch === 'L') words.push('left');
    else if (ch === 'R') words.push('right');
    else if (ch === 'C') words.push('center');
  }
  return words.join(' ');
}

/** Heading in whole degrees, 1..360, three digits: 0 → "360", 90 → "090". */
export function headingText(deg: number): string {
  let d = Math.round(((deg % 360) + 360) % 360);
  if (d === 0) d = 360;
  return String(d).padStart(3, '0');
}

/** "heading zero nine zero" */
export function spellHeading(deg: number): string { return `heading ${spellDigits(headingText(deg))}`; }

/** Runway designator for speech: "28R" → "runway two eight right". */
export function spellRunway(ident: string): string { return `runway ${spellDigits(ident)}`; }

/** "3,500" (thousands separator, no locale dependence). */
export function groupThousands(value: number): string {
  const n = Math.round(value);
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${s}` : s;
}

/** Subtitle: "3,500 ft" */
export const ftText = (ft: number): string => `${groupThousands(ft)} ft`;
/** Speech: "three thousand five hundred feet" */
export const ftSpeech = (ft: number): string => `${spellNumber(ft)} feet`;
/** Subtitle: "74 kt" */
export const ktText = (kt: number): string => `${Math.round(kt)} kt`;
/** Speech: "seventy four knots" */
export const ktSpeech = (kt: number): string => `${spellNumber(kt)} knots`;
/** Subtitle: "500 fpm" */
export const fpmText = (fpm: number): string => `${groupThousands(fpm)} fpm`;
/** Speech: "five hundred feet per minute" */
export const fpmSpeech = (fpm: number): string => `${spellNumber(Math.abs(fpm))} feet per minute`;
/** Nautical miles with one decimal when needed: "1.5 nm" */
export const nmText = (nm: number): string => `${Math.round(nm * 10) / 10} nm`;
/** Speech: "one and a half miles", "three miles" */
export function nmSpeech(nm: number): string {
  const whole = Math.floor(nm + 1e-9);
  const frac = nm - whole;
  if (Math.abs(frac - 0.5) < 0.05) return whole === 0 ? 'half a mile' : `${spellNumber(whole)} and a half miles`;
  const r = Math.round(nm);
  return r === 1 ? 'one mile' : `${spellNumber(r)} miles`;
}
