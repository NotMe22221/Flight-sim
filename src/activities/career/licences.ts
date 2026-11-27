/**
 * The career's licence ladder: Student pilot → Private pilot (PPL) → Instrument rating (IFR) →
 * Commercial pilot. Each new licence needs its prerequisites and, except Commercial, a check-ride: an
 * exam ActivityDef built from the existing objectives (take-off, circuit, landing score; ILS glidepath and
 * centreline). Pure data.
 */
import { destinationPoint } from '../../geo/wgs84';
import type { ActivityDef } from '../activityTypes';
import { KSFO_28R } from '../lessons';
import type { Licence } from './careerStore';

export interface LicenceInfo {
  id: Licence;
  title: string;
  /** what it unlocks, for the career screen */
  unlocks: string;
  /** requirements, in words */
  needs: string[];
  /** a check-ride is flown to get it (otherwise granted once the requirements are met) */
  exam: boolean;
}

export const LICENCES: readonly LicenceInfo[] = [
  { id: 'student', title: 'Student pilot', unlocks: 'Solo practice flights', needs: [], exam: false },
  { id: 'ppl', title: 'Private pilot (PPL)', unlocks: 'Cargo, passenger, aerial survey and search & rescue jobs', needs: ['Pass the PPL check-ride: take off, fly a circuit and land at Palo Alto'], exam: true },
  { id: 'ifr', title: 'Instrument rating (IFR)', unlocks: 'Better-paid jobs in any weather', needs: ['Private pilot licence', 'Pass the IFR check-ride: fly the KSFO 28R ILS to a landing'], exam: true },
  { id: 'commercial', title: 'Commercial pilot', unlocks: 'Medical flights with a time limit, the best pay', needs: ['Private pilot licence', '10 hours in the logbook', '15 jobs completed', 'Reputation 50 or more'], exam: false },
];

export interface CareerFacts { licences: readonly Licence[]; logbookHours: number; jobsDone: number; reputation: number }

/** Requirements of `l` not met yet (empty: it can be taken / granted now). Held licences return []. */
export function missingFor(l: Licence, f: CareerFacts): string[] {
  const has = (x: Licence) => f.licences.includes(x);
  if (has(l)) return [];
  const out: string[] = [];
  if (l === 'ifr' && !has('ppl')) out.push('Private pilot licence');
  if (l === 'commercial') {
    if (!has('ppl')) out.push('Private pilot licence');
    if (f.logbookHours < 10) out.push(`${(10 - f.logbookHours).toFixed(1)} more hours in the logbook`);
    if (f.jobsDone < 15) out.push(`${15 - f.jobsDone} more jobs`);
    if (f.reputation < 50) out.push(`Reputation ${Math.round(f.reputation)} of 50`);
  }
  return out;
}

const PAO = { icao: 'KPAO', lat: 37.461111, lon: -122.115056 };

/** The check-ride for `l` (PPL or IFR), or null when it has none. */
export function examActivity(l: Licence): ActivityDef | null {
  if (l === 'ppl') {
    return {
      id: 'career:exam:ppl', kind: 'exam', title: 'PPL check-ride at Palo Alto', aircraft: 'c172',
      description: 'Take off, climb to 1,000 ft above the field, fly a circuit and land back at Palo Alto with a landing score of at least 5,000.',
      setup: { spawn: 'runway', icao: 'KPAO', runway: '31', weather: 'few', time: 'morning', anchor: { lat: PAO.lat, lon: PAO.lon } },
      steps: [
        {
          id: 'climb', title: 'Take off and climb to 1,000 ft AGL',
          instruction: { text: 'Check-ride. Take off from runway 31 and climb to 1,000 feet above the field.' },
          objectives: [{ type: 'reach', label: 'Climb to 1,000 ft above the field', all: [{ c: 'onGround', value: false }, { c: 'agl', minFt: 1000 }], confirmS: 2, progress: { metric: 'aglFt', to: 1000 } }],
        },
        {
          id: 'land', title: 'Circuit and landing',
          instruction: { text: 'Fly the circuit and land back at Palo Alto. Make it a good one: the examiner is watching the landing.' },
          objectives: [
            { type: 'landing', label: 'Land at KPAO with a score of 5,000 or more', minScore: 5000, airport: 'KPAO' },
            { type: 'stopAt', label: 'Stop on the runway or taxiway', icao: 'KPAO', name: 'Palo Alto', lat: PAO.lat, lon: PAO.lon, radiusM: 2500 },
          ],
          success: { text: 'Congratulations: you are now a private pilot.' },
        },
      ],
      debrief: { pass: { text: 'Check-ride passed: Private pilot licence issued.' }, fail: { text: 'Check-ride not passed. Take it again when you are ready.' } },
    };
  }
  if (l === 'ifr') {
    const rw = KSFO_28R;
    const start = destinationPoint({ lat: rw.lat, lon: rw.lon, alt: 0 }, rw.headingDeg + 180, 9 * 1852, 0);
    return {
      id: 'career:exam:ifr', kind: 'exam', title: 'IFR check-ride: KSFO ILS 28R', aircraft: 'c172s-g1000',
      description: 'Fly the ILS 28R at San Francisco from 9 nm out in low cloud: stay on the localizer and glideslope, then land.',
      setup: { spawn: 'air', lat: start.lat, lon: start.lon, altFt: 2900, headingDeg: rw.headingDeg, iasKt: 95, flapsIndex: 1, gammaDeg: 0, weather: 'overcast', time: 'morning' },
      steps: [{
        id: 'ils', title: 'ILS approach',
        instruction: { text: 'IFR check-ride. Intercept the ILS for runway 28 right, then follow the localizer and glideslope down. Hand-flown or with the autopilot in APR.' },
        objectives: [
          { type: 'maintain', label: 'Stay within 60 m of the localizer', all: [{ c: 'centreline', runway: rw, maxM: 60 }], until: [{ c: 'agl', maxFt: 300 }], failAfterS: 20 },
          { type: 'maintain', label: 'Stay on the glideslope (±0.7°)', all: [{ c: 'glidepath', runway: rw, angleDeg: 3, tolDeg: 0.7, minTolFt: 40 }], until: [{ c: 'agl', maxFt: 300 }], failAfterS: 20 },
          { type: 'landing', label: 'Land on runway 28R (score 4,000 or more)', minScore: 4000, runway: 'KSFO 28R' },
        ],
        success: { text: 'Instrument rating issued. Nicely flown.' },
      }],
      debrief: { pass: { text: 'Check-ride passed: Instrument rating issued.' }, fail: { text: 'Check-ride not passed. Practise the ILS and try again.' } },
    };
  }
  return null;
}
