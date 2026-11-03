/**
 * Bush trips (docs/research/01 §10.2): multi-leg VFR journeys between small and medium
 * airports, each leg with a briefing, named landmarks and a suggested cruise altitude, completed
 * by landing and stopping at the destination. Airports and runways are copied from public/data
 * (bushTrips.test.ts verifies every one, the leg lengths and that each landmark lies near its leg).
 * Landmark positions are the real features (lighthouses, bridges, peaks) to ~100 m.
 */
import type { Waypoint, WeatherPresetId } from '../core/types';
import { FT, NM } from '../core/units';
import { greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import type { ActivityDef, TimePreset } from './activityTypes';
import type { Line, ObjectiveSpec } from './objectives';
import { ftSpeech, ftText, nmText, spellRunway } from './speech';

export interface TripAirport {
  icao: string;
  name: string;
  /** airport reference point, deg (public/data `la`/`lo`) */
  lat: number;
  lon: number;
  /** field elevation, m (public/data `e`) */
  elevM: number;
}

export interface TripWaypoint {
  /** short flight-plan ident */
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface BushLeg {
  from: string;
  to: string;
  /** departure runway (landing-direction designator, must exist at `from`) */
  departureRunway: string;
  /** suggested cruise altitude, ft MSL */
  cruiseFt: number;
  waypoints: TripWaypoint[];
  briefing: Line;
  weather?: WeatherPresetId;
  time?: TimePreset;
}

export interface BushTrip {
  id: string;
  title: string;
  region: string;
  description: string;
  aircraft: string;
  airports: Record<string, TripAirport>;
  legs: BushLeg[];
}

/** Radius for overflying a landmark, m. */
export const WAYPOINT_RADIUS_M = 1.5 * NM;

const ap = (icao: string, name: string, lat: number, lon: number, elevM: number): TripAirport => ({ icao, name, lat, lon, elevM });

export const PACIFIC_COAST: BushTrip = {
  id: 'pacific-coast',
  title: 'Pacific Coast: Half Moon Bay to Santa Barbara',
  region: 'California, USA',
  description: 'Eight short legs down the California coast in the 172: redwoods, Monterey Bay, the cliffs of Big Sur, the Salinas Valley missions, Morro Rock, the Guadalupe dunes and Point Conception.',
  aircraft: 'c172',
  airports: {
    KHAF: ap('KHAF', 'Half Moon Bay', 37.513401, -122.500999, 20.1),
    KRHV: ap('KRHV', 'Reid-Hillview (San Jose)', 37.332901, -121.819, 41.1),
    KWVI: ap('KWVI', 'Watsonville Municipal', 36.935699, -121.790001, 49.7),
    KMRY: ap('KMRY', 'Monterey Regional', 36.586777, -121.844183, 78.3),
    KKIC: ap('KKIC', 'Mesa Del Rey (King City)', 36.228001, -121.122002, 112.8),
    KPRB: ap('KPRB', 'Paso Robles Municipal', 35.672901, -120.626999, 256),
    KSBP: ap('KSBP', 'San Luis Obispo County Regional', 35.236801, -120.641998, 64.6),
    KLPC: ap('KLPC', 'Lompoc', 34.6656, -120.468002, 26.8),
    KSBA: ap('KSBA', 'Santa Barbara Municipal', 34.426201, -119.839996, 4),
  },
  legs: [
    {
      from: 'KHAF', to: 'KRHV', departureRunway: '30', cruiseFt: 3500, weather: 'few', time: 'morning',
      waypoints: [
        { id: 'PIGEON', name: 'Pigeon Point Lighthouse', lat: 37.1817, lon: -122.3944 },
        { id: 'BIGBSN', name: 'Big Basin Redwoods', lat: 37.1724, lon: -122.2224 },
      ],
      briefing: {
        text: 'Leg 1: Half Moon Bay to Reid-Hillview. Follow the coast south to Pigeon Point Lighthouse, turn inland over the redwoods of Big Basin and cross the Santa Cruz Mountains into the Santa Clara Valley.',
        speech: 'Leg one. Half Moon Bay to Reid Hillview, in San Jose. Follow the coast south to Pigeon Point Lighthouse, then turn inland over the redwoods of Big Basin, and cross the Santa Cruz Mountains into the Santa Clara Valley.',
      },
    },
    {
      from: 'KRHV', to: 'KWVI', departureRunway: '31R', cruiseFt: 4500, weather: 'scattered', time: 'morning',
      waypoints: [
        { id: 'LOMAP', name: 'Loma Prieta', lat: 37.1111, lon: -121.8428 },
        { id: 'BRDWLK', name: 'Santa Cruz Beach Boardwalk', lat: 36.9642, lon: -122.0181 },
      ],
      briefing: {
        text: 'Leg 2: Reid-Hillview to Watsonville. Cross the Santa Cruz Mountains over Loma Prieta, the 3,786 ft peak that named the 1989 earthquake, descend to the Santa Cruz Beach Boardwalk and follow the bay shore to Watsonville.',
        speech: 'Leg two. Reid Hillview to Watsonville. Cross the Santa Cruz Mountains over Loma Prieta, the peak that named the nineteen eighty nine earthquake. Then descend to the Santa Cruz Beach Boardwalk, and follow the bay shore to Watsonville.',
      },
    },
    {
      from: 'KWVI', to: 'KMRY', departureRunway: '20', cruiseFt: 2500, weather: 'few', time: 'noon',
      waypoints: [
        { id: 'MOSSLD', name: 'Moss Landing stacks', lat: 36.8053, lon: -121.7822 },
        { id: 'PINOS', name: 'Point Pinos Lighthouse', lat: 36.6336, lon: -121.9336 },
      ],
      briefing: {
        text: 'Leg 3: Watsonville to Monterey. Trace the curve of Monterey Bay past the twin stacks at Moss Landing, round Point Pinos, the oldest working lighthouse on the West Coast, and land at Monterey Regional.',
        speech: 'Leg three. Watsonville to Monterey. Trace the curve of Monterey Bay past the twin stacks at Moss Landing, round Point Pinos, the oldest working lighthouse on the West Coast, and land at Monterey.',
      },
    },
    {
      from: 'KMRY', to: 'KKIC', departureRunway: '28L', cruiseFt: 6500, weather: 'clear', time: 'morning',
      waypoints: [
        { id: 'BIXBY', name: 'Bixby Creek Bridge', lat: 36.3714, lon: -121.9019 },
        { id: 'PTSUR', name: 'Point Sur Lighthouse', lat: 36.3064, lon: -121.9014 },
      ],
      briefing: {
        text: 'Leg 4: Monterey to King City. The Big Sur coast: south to Bixby Creek Bridge and the lighthouse on Point Sur, then east across the Ventana Wilderness and the Santa Lucia Range to the Salinas Valley. High ridges: stay at 6,500 ft until you are clear of them.',
        speech: 'Leg four. Monterey to King City. This is the Big Sur coast. Fly south to Bixby Creek Bridge and the lighthouse on Point Sur, then east across the Ventana Wilderness and the Santa Lucia Range, to the Salinas Valley. The ridges are high, so stay at six thousand five hundred feet until you are clear of them.',
      },
    },
    {
      from: 'KKIC', to: 'KPRB', departureRunway: '29', cruiseFt: 4500, weather: 'few', time: 'afternoon',
      waypoints: [
        { id: 'MSNSA', name: 'Mission San Antonio de Padua', lat: 36.0153, lon: -121.2508 },
        { id: 'NACDAM', name: 'Nacimiento Dam', lat: 35.7586, lon: -120.8855 },
      ],
      briefing: {
        text: 'Leg 5: King City to Paso Robles. Over the hills to Mission San Antonio de Padua, founded in 1771 in a quiet oak valley, then south-east to Nacimiento Dam and on to the vineyards of Paso Robles.',
        speech: 'Leg five. King City to Paso Robles. Over the hills to Mission San Antonio de Padua, founded in seventeen seventy one in a quiet oak valley. Then south east to Nacimiento Dam, and on to the vineyards of Paso Robles.',
      },
    },
    {
      from: 'KPRB', to: 'KSBP', departureRunway: '31', cruiseFt: 3500, weather: 'scattered', time: 'afternoon',
      waypoints: [
        { id: 'MORRO', name: 'Morro Rock', lat: 35.3694, lon: -120.8669 },
        { id: 'BISHOP', name: 'Bishop Peak', lat: 35.3025, lon: -120.6969 },
      ],
      briefing: {
        text: 'Leg 6: Paso Robles to San Luis Obispo. South-west over the Santa Lucia foothills to the coast at Morro Rock, the volcanic plug guarding Morro Bay, then follow the chain of old volcanoes inland past Bishop Peak to San Luis Obispo.',
        speech: 'Leg six. Paso Robles to San Luis Obispo. South west over the foothills to the coast at Morro Rock, the volcanic plug guarding Morro Bay. Then follow the chain of old volcanoes inland, past Bishop Peak, to San Luis Obispo.',
      },
    },
    {
      from: 'KSBP', to: 'KLPC', departureRunway: '29', cruiseFt: 2500, weather: 'few', time: 'noon',
      waypoints: [
        { id: 'PISMO', name: 'Pismo Beach Pier', lat: 35.1383, lon: -120.6431 },
        { id: 'PTSAL', name: 'Point Sal', lat: 34.9036, lon: -120.6703 },
      ],
      briefing: {
        text: 'Leg 7: San Luis Obispo to Lompoc. Out to the pier at Pismo Beach, south along the Guadalupe-Nipomo Dunes to the headland of Point Sal, then inland over the flower fields to Lompoc.',
        speech: 'Leg seven. San Luis Obispo to Lompoc. Out to the pier at Pismo Beach, then south along the Guadalupe Nipomo dunes to the headland of Point Sal, and inland over the flower fields to Lompoc.',
      },
    },
    {
      from: 'KLPC', to: 'KSBA', departureRunway: '25', cruiseFt: 3500, weather: 'clear', time: 'dusk',
      waypoints: [
        { id: 'PTCONC', name: 'Point Conception Lighthouse', lat: 34.4486, lon: -120.4708 },
        { id: 'GAVIOT', name: 'Gaviota State Park', lat: 34.4714, lon: -120.2289 },
      ],
      briefing: {
        text: 'Final leg: Lompoc to Santa Barbara. South to Point Conception, where the coast turns east, then along the Gaviota Coast with the Santa Ynez Mountains on your left, into the evening light at Santa Barbara.',
        speech: 'Final leg. Lompoc to Santa Barbara. South to Point Conception, where the coast turns east. Then along the Gaviota Coast, with the Santa Ynez Mountains on your left, into the evening light at Santa Barbara.',
      },
    },
  ],
};

export const BUSH_TRIPS: readonly BushTrip[] = [PACIFIC_COAST];

export function tripById(id: string): BushTrip | undefined { return BUSH_TRIPS.find((t) => t.id === id); }

export interface NavLogEntry { from: string; to: string; trueCourseDeg: number; distanceNm: number }

const pos = (p: { lat: number; lon: number }, alt = 0) => ({ lat: p.lat, lon: p.lon, alt });

/** Direct distance between the leg's airports, nm. */
export function legDistanceNm(trip: BushTrip, legIndex: number): number {
  const leg = trip.legs[legIndex];
  return greatCircleDistance(pos(trip.airports[leg.from]), pos(trip.airports[leg.to])) / NM;
}

/** Nav log through the landmarks: course and distance of each segment. */
export function navLog(trip: BushTrip, legIndex: number): NavLogEntry[] {
  const leg = trip.legs[legIndex];
  const pts = [{ name: leg.from, ...pos(trip.airports[leg.from]) }, ...leg.waypoints.map((w) => ({ ...pos(w), name: w.name })), { name: leg.to, ...pos(trip.airports[leg.to]) }];
  const out: NavLogEntry[] = [];
  for (let i = 1; i < pts.length; i++) {
    out.push({ from: pts[i - 1].name, to: pts[i].name, trueCourseDeg: Math.round(initialBearingDeg(pts[i - 1], pts[i])), distanceNm: greatCircleDistance(pts[i - 1], pts[i]) / NM });
  }
  return out;
}

/** Total route length through the landmarks, nm. */
export function legRouteNm(trip: BushTrip, legIndex: number): number {
  return navLog(trip, legIndex).reduce((s, e) => s + e.distanceNm, 0);
}

/** Flight-plan waypoints for ActivityHost.loadRoute: departure, landmarks at the cruise altitude, destination. */
export function legRoute(trip: BushTrip, legIndex: number): Waypoint[] {
  const leg = trip.legs[legIndex];
  const dep = trip.airports[leg.from], dest = trip.airports[leg.to];
  return [
    { id: dep.icao, position: pos(dep, dep.elevM), type: 'airport' },
    ...leg.waypoints.map((w): Waypoint => ({ id: w.id, position: pos(w, leg.cruiseFt * FT), type: 'user', altConstraintM: leg.cruiseFt * FT })),
    { id: dest.icao, position: pos(dest, dest.elevM), type: 'airport' },
  ];
}

export const legActivityId = (tripId: string, legIndex: number): string => `${tripId}-leg${legIndex + 1}`;

/** The ActivityDef for one leg: depart, overfly the landmarks (optional), land and stop at the destination. */
export function bushLegActivity(trip: BushTrip, legIndex: number): ActivityDef {
  const leg = trip.legs[legIndex];
  if (!leg) throw new Error(`${trip.id} has no leg ${legIndex}`);
  const dep = trip.airports[leg.from], dest = trip.airports[leg.to];
  const names = leg.waypoints.map((w) => w.name);
  const routeText = [...names, dest.name].join(', then ');
  const waypointObjectives: ObjectiveSpec[] = leg.waypoints.map((w, i) => {
    const next = i + 1 < leg.waypoints.length ? leg.waypoints[i + 1].name : `${dest.name} (${dest.icao})`;
    return {
      type: 'waypoint', label: `Overfly ${w.name}`, name: w.name, lat: w.lat, lon: w.lon, radiusM: WAYPOINT_RADIUS_M, optional: true,
      doneLine: { text: `${w.name}. Next: ${next}.`, speech: `${w.name}. Next, ${next.replace(/ \(.*\)$/, '')}.` },
    };
  });
  return {
    id: legActivityId(trip.id, legIndex),
    kind: 'bushTrip',
    title: `${trip.title}: leg ${legIndex + 1}, ${dep.icao} to ${dest.icao}`,
    description: leg.briefing.text,
    aircraft: trip.aircraft,
    trip: { tripId: trip.id, legIndex },
    setup: {
      spawn: 'runway', icao: dep.icao, runway: leg.departureRunway, weather: leg.weather ?? 'few', time: leg.time ?? 'morning',
      route: legRoute(trip, legIndex), anchor: { lat: dep.lat, lon: dep.lon },
    },
    steps: [
      {
        id: 'depart',
        title: `Depart ${dep.icao} runway ${leg.departureRunway}`,
        instruction: {
          text: `${leg.briefing.text} Depart runway ${leg.departureRunway}; suggested cruise ${ftText(leg.cruiseFt)}, ${nmText(Math.round(legRouteNm(trip, legIndex)))} via the landmarks.`,
          speech: `${leg.briefing.speech ?? leg.briefing.text} Depart ${spellRunway(leg.departureRunway)}, and cruise at ${ftSpeech(leg.cruiseFt)}.`,
        },
        objectives: [{ type: 'reach', label: `Take off from ${dep.icao} runway ${leg.departureRunway}`, all: [{ c: 'agl', minFt: 500 }], progress: { metric: 'aglFt', to: 500 } }],
        quiet: true,
      },
      {
        id: 'enroute',
        title: `Fly to ${dest.name}`,
        instruction: { text: `Navigate by the landmarks: ${routeText}. Cruise at ${ftText(leg.cruiseFt)}.`, speech: `Navigate by the landmarks: ${routeText}. Cruise at ${ftSpeech(leg.cruiseFt)}.` },
        objectives: [
          ...waypointObjectives,
          { type: 'landing', label: `Land at ${dest.icao}`, minScore: 0, airport: dest.icao, optional: true },
          { type: 'stopAt', label: `Land and stop at ${dest.name}`, icao: dest.icao, name: dest.name, lat: dest.lat, lon: dest.lon, radiusM: 2500 },
        ],
        success: { text: `Welcome to ${dest.name}. Leg complete.`, speech: `Welcome to ${dest.name}. Leg complete.` },
      },
    ],
    debrief: {
      pass: { text: legIndex + 1 < trip.legs.length ? 'Leg complete: the next leg is unlocked.' : 'Trip complete. Well flown, bush pilot.', speech: legIndex + 1 < trip.legs.length ? 'The next leg is unlocked.' : 'Trip complete. Well flown, bush pilot.' },
      fail: { text: 'Leg not completed. Try again from the departure airport.', speech: 'Leg not completed. Try again from the departure airport.' },
    },
  };
}
