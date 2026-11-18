/**
 * Discovery flights (as in MSFS): start in the air near a famous landscape, in good weather and
 * flattering light, and just fly. The world's terrain and imagery stream in like anywhere else, so
 * these are natural landmarks, where the elevation data and satellite imagery do the work.
 *
 * Each start sits a few kilometres off the landmark, pointed at it, at an altitude that clears the
 * terrain around it (feet MSL; the highest nearby ground is in `terrainFt` for the tests).
 */
import type { WeatherPresetId } from '../core/types';

export interface DiscoveryFlight {
  id: string;
  title: string;
  region: string;
  blurb: string;
  /** start position and attitude */
  lat: number;
  lon: number;
  altFt: number;
  headingDeg: number;
  iasKt: number;
  /** catalog family: 'c172' or 'pa18-150' */
  aircraft: 'c172' | 'pa18-150';
  time: 'morning' | 'noon' | 'afternoon' | 'dusk';
  weather: WeatherPresetId;
  /** the landmark itself (what the start points at) and the highest terrain within ~10 km of the route, ft */
  target: { lat: number; lon: number };
  terrainFt: number;
  /** the landmark rises above the start altitude: fly beside it, not over it */
  towers?: boolean;
}

export const DISCOVERY_FLIGHTS: readonly DiscoveryFlight[] = [
  {
    id: 'grand-canyon', title: 'Grand Canyon', region: 'Arizona, United States',
    blurb: 'Cross the South Rim near Grand Canyon Village and look a mile down to the Colorado River. The far North Rim is higher still.',
    lat: 35.99, lon: -112.12, altFt: 10_500, headingDeg: 0, iasKt: 100, aircraft: 'c172', time: 'morning', weather: 'few',
    target: { lat: 36.06, lon: -112.11 }, terrainFt: 8_800,
  },
  {
    id: 'matterhorn', title: 'The Matterhorn', region: 'Valais, Switzerland',
    blurb: 'Up the valley from Zermatt toward the most recognisable peak in the Alps (4,478 m). Stay well clear of the ridges: the summit is above you.',
    // over the Mattertal valley floor at Täsch, up past Zermatt toward the Hörnli ridge
    lat: 46.07, lon: 7.777, altFt: 12_500, headingDeg: 221, iasKt: 95, aircraft: 'c172', time: 'morning', weather: 'clear',
    target: { lat: 45.9763, lon: 7.6586 }, terrainFt: 14_692, towers: true,
  },
  {
    id: 'milford-sound', title: 'Milford Sound', region: 'Fiordland, New Zealand',
    blurb: 'In from the Tasman Sea between the fiord walls, with Mitre Peak rising straight out of the water ahead.',
    lat: -44.57, lon: 167.74, altFt: 3_500, headingDeg: 125, iasKt: 75, aircraft: 'pa18-150', time: 'afternoon', weather: 'few',
    target: { lat: -44.637, lon: 167.84 }, terrainFt: 5_500,
  },
  {
    id: 'monument-valley', title: 'Monument Valley', region: 'Arizona–Utah, United States',
    blurb: 'Low and slow over the sandstone buttes of the Navajo Nation, best in the long shadows of late afternoon.',
    lat: 37.05, lon: -110.10, altFt: 7_000, headingDeg: 180, iasKt: 75, aircraft: 'pa18-150', time: 'afternoon', weather: 'clear',
    target: { lat: 36.998, lon: -110.098 }, terrainFt: 6_200,
  },
  {
    id: 'yosemite', title: 'Yosemite Valley', region: 'California, United States',
    blurb: 'Over the western end of the valley, El Capitan on your left, Half Dome at the far end.',
    lat: 37.72, lon: -119.72, altFt: 9_500, headingDeg: 75, iasKt: 95, aircraft: 'c172', time: 'morning', weather: 'clear',
    target: { lat: 37.746, lon: -119.533 }, terrainFt: 8_840,
  },
  {
    id: 'mount-fuji', title: 'Mount Fuji', region: 'Honshu, Japan',
    blurb: 'South from Lake Kawaguchi past the 3,776 m volcano: it rises far above you. Keep it on your right and enjoy the view up.',
    // aimed east of the summit: the cone passes on the right
    lat: 35.52, lon: 138.80, altFt: 9_500, headingDeg: 180, iasKt: 100, aircraft: 'c172', time: 'morning', weather: 'few',
    target: { lat: 35.3606, lon: 138.7274 }, terrainFt: 12_388, towers: true,
  },
  {
    id: 'table-mountain', title: 'Table Mountain', region: 'Cape Town, South Africa',
    blurb: 'Across Table Bay toward the flat-topped mountain over the city, Lion\'s Head on its right.',
    lat: -33.86, lon: 18.43, altFt: 4_500, headingDeg: 190, iasKt: 95, aircraft: 'c172', time: 'afternoon', weather: 'few',
    target: { lat: -33.9628, lon: 18.4098 }, terrainFt: 3_560,
  },
  {
    id: 'na-pali', title: 'Nā Pali Coast', region: 'Kauaʻi, Hawaiʻi',
    blurb: 'Along the green cliffs and hanging valleys of the north-west coast, out over the Pacific.',
    lat: 22.23, lon: -159.55, altFt: 2_500, headingDeg: 240, iasKt: 80, aircraft: 'pa18-150', time: 'afternoon', weather: 'few',
    target: { lat: 22.17, lon: -159.66 }, terrainFt: 4_000,
  },
  {
    id: 'geiranger', title: 'Geirangerfjord', region: 'Møre og Romsdal, Norway',
    blurb: 'East up the fiord from Hellesylt between walls of rock and waterfalls, to the village at its head.',
    lat: 62.085, lon: 6.90, altFt: 3_000, headingDeg: 80, iasKt: 75, aircraft: 'pa18-150', time: 'noon', weather: 'few',
    target: { lat: 62.101, lon: 7.206 }, terrainFt: 5_600,
  },
  {
    id: 'rio', title: 'Rio de Janeiro', region: 'Brazil',
    blurb: 'Over Guanabara Bay past Sugarloaf, toward Corcovado and the statue on its summit.',
    lat: -22.89, lon: -43.12, altFt: 3_000, headingDeg: 225, iasKt: 95, aircraft: 'c172', time: 'afternoon', weather: 'few',
    target: { lat: -22.9519, lon: -43.2105 }, terrainFt: 2_330,
  },
  {
    id: 'uluru', title: 'Uluṟu', region: 'Northern Territory, Australia',
    blurb: 'The great sandstone monolith rising out of the desert, lit red by the setting sun.',
    lat: -25.29, lon: 130.99, altFt: 4_000, headingDeg: 145, iasKt: 95, aircraft: 'c172', time: 'dusk', weather: 'clear',
    target: { lat: -25.3444, lon: 131.0369 }, terrainFt: 2_830,
  },
];

export function discoveryById(id: string): DiscoveryFlight | undefined { return DISCOVERY_FLIGHTS.find((d) => d.id === id); }
