/**
 * Career jobs: a seeded job board from the airports around the pilot, and each job compiled into an
 * ActivityDef (kind 'mission') for the ActivityRunner, the way bushLegActivity builds a leg. Pure data.
 *
 *   student      solo practice: a short hop to a nearby field (≤ 25 nm), low pay
 *   PPL          cargo, passengers (comfort: no steep banks, a decent landing), aerial survey (photo points),
 *                search & rescue (search an area low, then return)
 *   commercial   medevac (urgent: a time limit), better pay
 */
import type { Airport, Geodetic, Waypoint } from '../../core/types';
import { mulberry32 } from '../../core/math';
import { greatCircleDistance, destinationPoint } from '../../geo/wgs84';
import type { ActivityDef, StepDef } from '../activityTypes';
import type { ObjectiveSpec } from '../objectives';
import type { Licence } from './careerStore';

export type JobType = 'practice' | 'cargo' | 'passengers' | 'survey' | 'sar' | 'medevac';

export interface CareerJob {
  id: string;
  type: JobType;
  title: string;
  /** client / dispatcher briefing */
  brief: string;
  from: string;
  to: string;
  /** where the pilot ends up (the destination; search & rescue returns to `from`) */
  endsAt: string;
  distanceNm: number;
  payloadKg: number;
  /** base pay, $ (60 % guaranteed on completion, the rest by score) */
  pay: number;
  licence: Licence;
  /** medevac: minutes allowed from take-off to the stop at the destination */
  timeLimitMin?: number;
  /** survey points / search area */
  points?: { name: string; lat: number; lon: number }[];
  /** for the spawn and route */
  fromPos: Geodetic;
  toPos: Geodetic;
  fromRunway: string;
  toName: string;
}

export const JOB_LABEL: Record<JobType, string> = {
  practice: 'Solo practice', cargo: 'Cargo', passengers: 'Passengers', survey: 'Aerial survey', sar: 'Search & rescue', medevac: 'Medical flight',
};

const NM = 1852, FT = 0.3048;

/** What the aircraft needs from an airport: runway length (m) and whether grass/gravel will do. */
export interface FieldNeeds { minRunwayM: number; unpavedOk: boolean; cruiseKt: number }
export const C172_FIELDS: FieldNeeds = { minRunwayM: 2000 * FT, unpavedOk: false, cruiseKt: 115 };
export const CUB_FIELDS: FieldNeeds = { minRunwayM: 800 * FT, unpavedOk: true, cruiseKt: 95 };

/** The longest runway the aircraft can use at `a`, or null. */
export function usableRunway(a: Airport, needs: FieldNeeds): Airport['runways'][number] | null {
  let best: Airport['runways'][number] | null = null;
  for (const r of a.runways) {
    if (r.lengthM < needs.minRunwayM || r.surface === 'water') continue;
    const paved = r.surface === 'asphalt' || r.surface === 'concrete';
    if (!paved && !needs.unpavedOk) continue;
    if (!best || r.lengthM > best.lengthM) best = r;
  }
  return best;
}

export interface BoardInput {
  origin: Airport;
  /** nearby airports (e.g. NavDb.nearestAirports(origin.position, 40, 90)) */
  nearby: readonly Airport[];
  licences: readonly Licence[];
  needs: FieldNeeds;
  seed: number;
  count?: number;
}

/** Job board: deterministic for a seed (stable until a job is flown). */
export function generateJobs(inp: BoardInput): CareerJob[] {
  const rnd = mulberry32(inp.seed >>> 0);
  const fromRw = usableRunway(inp.origin, inp.needs);
  if (!fromRw) return [];
  const has = (l: Licence) => inp.licences.includes(l);
  const dests = inp.nearby
    .filter((a) => a.icao !== inp.origin.icao && a.type !== 'heliport' && a.type !== 'seaplane' && usableRunway(a, inp.needs))
    .map((a) => ({ a, nm: greatCircleDistance(inp.origin.position, a.position) / NM }))
    .filter((d) => d.nm >= 6 && d.nm <= 80);
  if (!dests.length) return [];
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
  const types: JobType[] = has('ppl') ? ['cargo', 'passengers', 'survey', 'sar', 'cargo', ...(has('commercial') ? ['medevac', 'medevac'] as JobType[] : [])] : ['practice'];
  const out: CareerJob[] = [];
  const count = inp.count ?? 6;
  for (let k = 0; k < count * 3 && out.length < count; k++) {
    const type = pick(types);
    const pool = type === 'practice' ? dests.filter((d) => d.nm <= 25) : type === 'medevac' ? dests.filter((d) => d.nm >= 15) : dests;
    if (!pool.length) continue;
    const d = pick(pool);
    if (out.some((j) => j.to === d.a.icao && j.type === type)) continue;
    out.push(makeJob(type, inp.origin, fromRw.ident, d.a, d.nm, inp.needs, rnd, `${inp.seed}-${k}`));
  }
  return out;
}

function makeJob(type: JobType, o: Airport, fromRunway: string, a: Airport, nm: number, needs: FieldNeeds, rnd: () => number, key: string): CareerJob {
  const base = { from: o.icao, to: a.icao, endsAt: a.icao, distanceNm: Math.round(nm), fromPos: o.position, toPos: a.position, fromRunway, toName: a.name, id: `career:${type}:${o.icao}-${a.icao}:${key}` };
  const r100 = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) / 10) * 10;
  switch (type) {
    case 'practice':
      return { ...base, type, licence: 'student', payloadKg: 0, pay: Math.round(60 + 4 * nm), title: `Solo practice to ${a.icao}`, brief: `Build hours: fly to ${a.name} and land.` };
    case 'cargo': {
      const kg = r100(60, 220);
      return { ...base, type, licence: 'ppl', payloadKg: kg, pay: Math.round(150 + 9 * nm + kg * 0.4), title: `Cargo to ${a.icao}`, brief: `${kg} kg of parcels for ${a.municipality || a.name}. Land and stop at ${a.name}.` };
    }
    case 'passengers': {
      const pax = 1 + Math.floor(rnd() * 3);
      return { ...base, type, licence: 'ppl', payloadKg: pax * 80, pay: Math.round((150 + 9 * nm) * 1.3), title: `${pax} passenger${pax > 1 ? 's' : ''} to ${a.icao}`, brief: `Charter to ${a.name}. Keep it comfortable: no steep banks, and a smooth landing.` };
    }
    case 'survey': {
      // two photo points either side of the direct line
      const brg = bearingDeg(o.position, a.position);
      const pts = [0.35, 0.7].map((f, i) => {
        const mid = destinationPoint(o.position, brg, f * nm * NM, 0);
        const off = destinationPoint(mid, brg + (i ? 90 : -90), (2 + rnd() * 2) * NM, 0);
        return { name: `Photo point ${i + 1}`, lat: off.lat, lon: off.lon };
      });
      return { ...base, type, licence: 'ppl', payloadKg: 30, pay: Math.round((170 + 10 * nm) * 1.2), title: `Aerial survey, ending at ${a.icao}`, brief: `Photograph two points along the way, then land at ${a.name}.`, points: pts };
    }
    case 'sar': {
      // a search area 5-15 nm out from the origin, toward the "destination" direction; return home after
      const brg = bearingDeg(o.position, a.position) + (rnd() - 0.5) * 60;
      const c = destinationPoint(o.position, brg, (5 + rnd() * 10) * NM, 0);
      return {
        ...base, type, licence: 'ppl', payloadKg: 0, endsAt: o.icao, to: o.icao, toPos: o.position, toName: o.name, distanceNm: Math.round(2 * greatCircleDistance(o.position, c) / NM),
        pay: Math.round(220 + 14 * (greatCircleDistance(o.position, c) / NM)), title: 'Search & rescue', brief: 'A hiker is overdue. Search the area below 1,500 ft above the ground for a minute, then return and land.',
        points: [{ name: 'Search area', lat: c.lat, lon: c.lon }],
      };
    }
    case 'medevac':
    default: {
      const mins = Math.ceil(((nm / needs.cruiseKt) * 60) * 1.5 + 10);
      return { ...base, type: 'medevac', licence: 'commercial', payloadKg: 90, pay: Math.round((180 + 11 * nm) * 1.8), title: `Medical flight to ${a.icao}`, brief: `A patient needs transport to ${a.name}. You have ${mins} minutes from the start.`, timeLimitMin: mins };
    }
  }
}

function bearingDeg(a: Geodetic, b: Geodetic): number {
  const D = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * D) * Math.cos(b.lat * D);
  const x = Math.cos(a.lat * D) * Math.sin(b.lat * D) - Math.sin(a.lat * D) * Math.cos(b.lat * D) * Math.cos((b.lon - a.lon) * D);
  return ((Math.atan2(y, x) / D) + 360) % 360;
}

const wp = (id: string, p: { lat: number; lon: number }, alt = 0): Waypoint => ({ id, position: { lat: p.lat, lon: p.lon, alt }, type: 'user' });

/** The job as an activity: depart, (points), land and stop at the destination. */
export function jobActivity(job: CareerJob): ActivityDef {
  const depart: StepDef = {
    id: 'depart', title: `Depart ${job.from}`,
    instruction: { text: `${JOB_LABEL[job.type]}: ${job.brief}` },
    objectives: [{ type: 'reach', label: `Take off from ${job.from}`, all: [{ c: 'onGround', value: false }, { c: 'agl', minFt: 200 }], confirmS: 2 }],
    cues: [{ when: [{ c: 'parkingBrake', set: true }, { c: 'throttle', min: 0.5 }, { c: 'onGround', value: true }], line: { text: 'Parking brake is set: release it to roll.' } }],
    quiet: true,
  };
  const enroute: ObjectiveSpec[] = [];
  if (job.type === 'survey') for (const p of job.points ?? []) enroute.push({ type: 'waypoint', label: `Overfly ${p.name}`, name: p.name, lat: p.lat, lon: p.lon, radiusM: 0.6 * NM });
  if (job.type === 'sar') {
    const c = job.points![0];
    enroute.push({ type: 'hold', label: 'Search the area below 1,500 ft AGL for 60 s', all: [{ c: 'near', lat: c.lat, lon: c.lon, radiusM: 2 * NM }, { c: 'onGround', value: false }, { c: 'agl', maxFt: 1500 }], forS: 60, graceS: 5 });
  }
  const stop: ObjectiveSpec = {
    type: 'stopAt', label: `Land and stop at ${job.toName}`, icao: job.endsAt, name: job.toName, lat: job.toPos.lat, lon: job.toPos.lon, radiusM: 2500,
    ...(job.timeLimitMin ? { timeoutS: job.timeLimitMin * 60, failText: 'The patient did not arrive in time.' } : {}),
    ...(job.type === 'passengers' ? { failIf: [{ c: 'bank', minDeg: 50 }], failText: 'The passengers were frightened by a steep bank.' } : {}),
  };
  const landing: ObjectiveSpec = { type: 'landing', label: `Land smoothly at ${job.endsAt}`, minScore: job.type === 'passengers' ? 3000 : 0, airport: job.endsAt, elsewhere: 'ignore', optional: job.type !== 'passengers' };
  const route: Waypoint[] = [
    { id: job.from, position: job.fromPos, type: 'airport' },
    ...(job.points ?? []).map((p) => wp(p.name.replace(/\s+/g, '').slice(0, 10).toUpperCase(), p)),
    { id: job.endsAt, position: job.toPos, type: 'airport' },
  ];
  return {
    id: job.id, kind: 'mission', title: job.title, description: job.brief, aircraft: undefined,
    setup: { spawn: 'runway', icao: job.from, runway: job.fromRunway, payloadKg: job.payloadKg, route, anchor: { lat: job.fromPos.lat, lon: job.fromPos.lon }, weather: 'few', time: 'morning' },
    steps: [depart, {
      id: 'enroute', title: job.type === 'sar' ? 'Search, then return' : `Fly to ${job.endsAt}`,
      instruction: { text: job.type === 'sar' ? 'Fly to the search area (magenta line), search low, then return and land.' : `Fly to ${job.toName}. The route is on the map and the GPS.` },
      objectives: [...enroute, landing, stop],
      success: { text: 'Job complete. Well flown.' },
    }],
    debrief: { pass: { text: 'Job complete: payment is on its way.' }, fail: { text: 'Job not completed: no payment, and your reputation suffers.' } },
  };
}
