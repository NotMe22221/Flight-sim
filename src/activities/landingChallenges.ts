/**
 * Landing challenges: start established on a 3° final with the aircraft trimmed, score the
 * touchdown and rollout (landingScore.ts). Runway ends come from the bundled OurAirports data
 * at runtime; this table only names them and sets the conditions.
 */
import type { WeatherPresetId } from '../core/types';

export interface LandingChallenge {
  id: string;
  title: string;
  category: 'Famous' | 'Epic' | 'Strong Wind';
  icao: string;
  /** landing runway end designator, must exist in the airport data */
  runway: string;
  /** distance from the threshold to start on final, nautical miles */
  startNm: number;
  /** glide path angle, degrees */
  glideDeg: number;
  /** indicated airspeed at start, knots */
  speedKt: number;
  weather: WeatherPresetId;
  /** surface wind override: from (deg true), speed and gust (kt) */
  wind?: { fromDeg: number; speedKt: number; gustKt: number };
  /** local solar hour (0–24) to set the clock to */
  localHour: number;
  description: string;
}

export const LANDING_CHALLENGES: LandingChallenge[] = [
  { id: 'ksfo-28r', title: 'San Francisco 28R', category: 'Famous', icao: 'KSFO', runway: '28R', startNm: 3, glideDeg: 3, speedKt: 70, weather: 'few', localHour: 17.5, description: 'The classic Bay approach over the water in the golden hour.' },
  { id: 'khaf-30', title: 'Half Moon Bay 30', category: 'Famous', icao: 'KHAF', runway: '30', startNm: 2.5, glideDeg: 3, speedKt: 68, weather: 'scattered', localHour: 10, description: 'Coastal strip with the Pacific on your left.' },
  { id: 'lowi-26', title: 'Innsbruck 26', category: 'Epic', icao: 'LOWI', runway: '26', startNm: 3.5, glideDeg: 3.5, speedKt: 72, weather: 'scattered', localHour: 11, description: 'Down the Inn valley between 2,500 m peaks.' },
  { id: 'lsgs-25', title: 'Sion 25', category: 'Epic', icao: 'LSGS', runway: '25', startNm: 3, glideDeg: 3.5, speedKt: 70, weather: 'few', localHour: 14, description: 'A deep Alpine valley with a long, narrow final.' },
  { id: 'ktrk-29', title: 'Truckee Tahoe 29', category: 'Epic', icao: 'KTRK', runway: '29', startNm: 3, glideDeg: 3, speedKt: 72, weather: 'clear', localHour: 15, description: '5,900 ft field elevation: watch your density altitude.' },
  { id: 'kase-15', title: 'Aspen 15', category: 'Epic', icao: 'KASE', runway: '15', startNm: 3.5, glideDeg: 3.5, speedKt: 72, weather: 'few', localHour: 9, description: 'Steep, high and surrounded by the Rockies.' },
  { id: 'ksfo-28l-wind', title: 'San Francisco 28L gusts', category: 'Strong Wind', icao: 'KSFO', runway: '28L', startNm: 3, glideDeg: 3, speedKt: 75, weather: 'broken', wind: { fromDeg: 250, speedKt: 18, gustKt: 28 }, localHour: 13, description: 'A gusty 30° crosswind off the Pacific.' },
  { id: 'kbfi-14r-wind', title: 'Boeing Field 14R', category: 'Strong Wind', icao: 'KBFI', runway: '14R', startNm: 3, glideDeg: 3, speedKt: 75, weather: 'rain', wind: { fromDeg: 190, speedKt: 16, gustKt: 24 }, localHour: 16, description: 'Seattle rain and a stiff southerly crosswind.' },
  { id: 'lowi-08-wind', title: 'Innsbruck 08 foehn', category: 'Strong Wind', icao: 'LOWI', runway: '08', startNm: 3, glideDeg: 3.5, speedKt: 75, weather: 'scattered', wind: { fromDeg: 170, speedKt: 20, gustKt: 32 }, localHour: 12, description: 'Foehn winds tumbling down from the south.' },
];
