/**
 * Callsign phraseology. US civil registrations ("N172FS") are said in full on first contact —
 * "November One Seven Two Foxtrot Sierra" — and abbreviated to aircraft type + last three
 * characters once the controller has abbreviated them — "Cessna Two Foxtrot Sierra"
 * (AIM 4-2-4). Other registrations abbreviate to first character + last two (ICAO).
 */
import { spellOut, spoken, type Spoken } from './phraseology';

/** Full and abbreviated forms of one callsign. */
export interface Callsign {
  /** registration as typed, upper case without spaces/dashes, e.g. "N172FS" */
  readonly registration: string;
  /** first-contact form: "N172FS" / "November One Seven Two Foxtrot Sierra" */
  readonly full: Spoken;
  /** after ATC abbreviates: "Cessna 2FS" / "Cessna Two Foxtrot Sierra" */
  readonly short: Spoken;
  /** aircraft type as spoken in calls, e.g. "Cessna", "Skyhawk" */
  readonly type: string;
}

const isUsRegistration = (r: string): boolean => /^N\d/.test(r);

/**
 * Build the callsign forms. `aircraftType` is the type word used when abbreviated
 * ("Cessna", "Skyhawk", "Bonanza"); an empty type falls back to the full callsign tail.
 */
export function makeCallsign(registration: string, aircraftType: string): Callsign {
  const reg = registration.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'N123AB';
  const type = aircraftType.trim();
  const full = spoken(reg, spellOut(reg, true));
  const tail = isUsRegistration(reg)
    ? reg.slice(-3)
    : `${reg.charAt(0)}${reg.slice(-2)}`;
  const shortText = type ? `${type} ${tail}` : tail;
  const shortSpeech = type ? `${type} ${spellOut(tail, true)}` : spellOut(tail, true);
  return { registration: reg, full, short: spoken(shortText, shortSpeech), type };
}
