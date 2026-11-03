/**
 * ATIS broadcast (and AWOS for untowered fields) generated from the sim weather: code letter,
 * Zulu time, wind (magnetic, as US ATIS and towers report it), visibility, sky condition,
 * temperature / dew point, altimeter, runways in use and "advise on initial contact".
 * Also produces a METAR-style line (true wind) for displays.
 */
import type { Airport, WeatherState } from '../core/types';
import { ceilingLayer, observeSurface, type SkyLayer, type SurfaceObservation } from './surfaceObs';
import {
  altimeter, altitude, atisLetter, runway, spellOut, spoken, temperature, wind, zuluTime, type Spoken,
} from './phraseology';
import { joinSpoken, sentence } from './compose';

/** Everything needed to compose a broadcast. */
export interface AtisInput {
  airport: Airport;
  weather: WeatherState;
  /** 'A'..'Z' (ignored when `automated`) */
  letter: string;
  /** observation time, UTC epoch ms */
  utcMs: number;
  /** runway idents in use for landing and departure, e.g. ['28L', '28R'] */
  runways: readonly string[];
  /**
   * Magnetic declination at the field, deg East positive. When given, winds are reported
   * magnetic (FAA practice for ATIS and tower); omit it to report true wind.
   */
  magVarDeg?: number;
  /** ILS runway advertised when the weather is below VFR, if any */
  ilsRunway?: string;
  /** AWOS/ASOS-style automated observation: no letter, no runway information */
  automated?: boolean;
  /** facility name override (defaults to the airport name without "Airport") */
  name?: string;
}

/** A composed broadcast. */
export interface AtisReport {
  letter: string;
  utcMs: number;
  /** subtitle text */
  text: string;
  /** text for speech synthesis */
  speech: string;
  /** METAR-style line with true wind, e.g. "KSFO 031856Z 28012G18KT 10SM FEW012 BKN200 18/11 A3005" */
  metar: string;
  runways: readonly string[];
  obs: SurfaceObservation;
  /** wind direction as broadcast (magnetic when `magVarDeg` was given), deg */
  windDirDeg: number;
}

/** Broadcast name of an airport: "San Francisco International Airport" → "San Francisco International". */
export function atisName(airport: Airport): string {
  const n = airport.name.replace(/\s+(Airport|Airfield|Aerodrome)$/i, '').trim();
  return n || airport.icao;
}

const FRACTION_SPEECH: Readonly<Record<string, string>> = { '1/4': 'one quarter', '1/2': 'one half', '3/4': 'three quarters' };

/** Visibility in statute miles: 10 → "10" / "one zero", 2.5 → "2 1/2" / "two and one half", 0 → "less than 1/4". */
export function visibility(sm: number): Spoken {
  if (sm <= 0) return spoken('less than 1/4', 'less than one quarter');
  const whole = Math.floor(sm + 1e-9);
  const frac = sm - whole;
  const fr = frac > 0.7 ? '3/4' : frac > 0.4 ? '1/2' : frac > 0.1 ? '1/4' : '';
  const wholeSp = whole > 0 ? spellOut(whole) : '';
  const text = whole > 0 ? (fr ? `${whole} ${fr}` : `${whole}`) : fr;
  const speech = whole > 0 ? (fr ? `${wholeSp} and ${FRACTION_SPEECH[fr]}` : wholeSp) : FRACTION_SPEECH[fr];
  return spoken(text, speech);
}

const COVER_WORD: Readonly<Record<SkyLayer['cover'], string>> = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' };

/** Sky condition phrase: "few clouds at 1,200, ceiling 20,000 broken" (speech in group form). */
export function skyCondition(obs: SurfaceObservation): Spoken {
  if (!obs.layers.length) return spoken('sky clear');
  const ceiling = ceilingLayer(obs);
  const parts: Spoken[] = [];
  for (const l of obs.layers) {
    const alt = altitude(l.baseFtAgl, false);
    if (l === ceiling) parts.push(spoken(`ceiling ${alt.text} ${COVER_WORD[l.cover]}`, `ceiling ${alt.speech} ${COVER_WORD[l.cover]}`));
    else if (l.cover === 'FEW' || l.cover === 'SCT') parts.push(spoken(`${COVER_WORD[l.cover]} clouds at ${alt.text}`, `${COVER_WORD[l.cover]} clouds at ${alt.speech}`));
    else parts.push(spoken(`${alt.text} ${COVER_WORD[l.cover]}`, `${alt.speech} ${COVER_WORD[l.cover]}`));
  }
  return joinSpoken(parts, ', ');
}

const WEATHER_WORDS: Readonly<Record<string, string>> = {
  RA: 'rain', SN: 'snow', TS: 'thunderstorm', BR: 'mist', FG: 'fog', HZ: 'haze',
};

/** Present-weather words: "-TSRA" → "light thunderstorm rain", "BR" → "mist". */
export function weatherWords(code: string): string {
  if (!code) return '';
  const words: string[] = [];
  let c = code;
  if (c.startsWith('-')) { words.push('light'); c = c.slice(1); } else if (c.startsWith('+')) { words.push('heavy'); c = c.slice(1); }
  for (let i = 0; i < c.length; i += 2) {
    const w = WEATHER_WORDS[c.slice(i, i + 2)];
    if (w) words.push(w);
  }
  return words.join(' ');
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const metarTemp = (c: number): string => (c < 0 ? `M${pad(-c, 2)}` : pad(c, 2));

/** METAR-style line (true wind, statute miles, US altimeter). */
export function metarLine(icao: string, utcMs: number, obs: SurfaceObservation): string {
  const d = new Date(utcMs);
  const time = `${pad(d.getUTCDate(), 2)}${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}Z`;
  const w = obs.windSpeedKt === 0
    ? '00000KT'
    : `${pad(obs.windDirTrueDeg, 3)}${pad(obs.windSpeedKt, 2)}${obs.windGustKt ? `G${pad(obs.windGustKt, 2)}` : ''}KT`;
  const vis = obs.visibilitySM <= 0 ? 'M1/4SM' : `${visibility(obs.visibilitySM).text}SM`;
  const sky = obs.layers.length ? obs.layers.map((l) => `${l.cover}${pad(Math.round(l.baseFtAgl / 100), 3)}`).join(' ') : 'CLR';
  const alt = `A${pad(Math.round(obs.altimeterInHg * 100), 4)}`;
  return [icao, time, w, vis, obs.weather, sky, `${metarTemp(obs.temperatureC)}/${metarTemp(obs.dewpointC)}`, alt]
    .filter((s) => s.length > 0).join(' ');
}

/** "runway 28R" or "runways 28L and 28R". */
export function runwayList(idents: readonly string[]): Spoken {
  const rws = idents.map(runway);
  const word = rws.length > 1 ? 'runways' : 'runway';
  return spoken(`${word} ${joinSpoken(rws, ', ', ' and ').text}`, `${word} ${joinSpoken(rws, ', ', ' and ').speech}`);
}

/** Compose the ATIS (or AWOS when `automated`) broadcast. Allocates; call when the letter changes. */
export function buildAtis(input: AtisInput): AtisReport {
  const { airport, weather } = input;
  const obs = observeSurface(weather, airport.elevationM);
  const name = input.name ?? atisName(airport);
  // Magnetic from the observed direction (rounding the METAR's true value first could err by 10°).
  const windDir = input.magVarDeg === undefined ? obs.windDirTrueDeg : obs.windDirTrueRawDeg - input.magVarDeg;
  const parts: Spoken[] = [];
  const letter = atisLetter(input.letter);
  const time = zuluTime(input.utcMs);
  if (input.automated) parts.push(sentence(spoken(`${name} automated weather observation, ${time.text}`, `${name} automated weather observation, ${time.speech}`)));
  else {
    parts.push(sentence(spoken(`${name} information ${letter.text}`, `${name} information ${letter.speech}`)));
    parts.push(sentence(time));
  }
  const w = wind(windDir, obs.windSpeedKt, obs.windGustKt);
  parts.push(sentence(spoken(`Wind ${w.text}`, `wind ${w.speech}`)));
  const vis = visibility(obs.visibilitySM);
  const wx = weatherWords(obs.weather);
  parts.push(sentence(spoken(`Visibility ${vis.text}${wx ? `, ${wx}` : ''}`, `visibility ${vis.speech}${wx ? `, ${wx}` : ''}`)));
  parts.push(sentence(skyCondition(obs)));
  const t = temperature(obs.temperatureC), td = temperature(obs.dewpointC);
  parts.push(sentence(spoken(`Temperature ${t.text}, dew point ${td.text}`, `temperature ${t.speech}, dew point ${td.speech}`)));
  const alt = altimeter(obs.altimeterInHg);
  parts.push(sentence(spoken(`Altimeter ${alt.text}`, `altimeter ${alt.speech}`)));
  if (!input.automated) {
    if (input.ilsRunway) {
      const r = runway(input.ilsRunway);
      parts.push(sentence(spoken(`ILS runway ${r.text} approach in use`, `I L S runway ${r.speech} approach in use`)));
    }
    if (input.runways.length) {
      const rl = runwayList(input.runways);
      parts.push(sentence(spoken(`Landing and departing ${rl.text}`, `landing and departing ${rl.speech}`)));
    }
    parts.push(sentence(spoken(`Advise on initial contact you have information ${letter.text}`, `advise on initial contact you have information ${letter.speech}`)));
  }
  const all = joinSpoken(parts, ' ');
  return {
    letter: input.letter.toUpperCase(),
    utcMs: input.utcMs,
    text: all.text,
    speech: all.speech,
    metar: metarLine(airport.icao, input.utcMs, obs),
    runways: input.runways,
    obs,
    windDirDeg: windDir,
  };
}
