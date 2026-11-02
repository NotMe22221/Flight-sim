/**
 * Pure METAR parser (docs/research/04 §9.2) producing a `WeatherState`.
 *
 * Handles: station, observation time, wind (incl. VRB, gusts, KT/MPS/KMH, variability range),
 * visibility (metres, statute miles incl. mixed fractions and P/M prefixes, CAVOK), present
 * weather (intensity, descriptors, precipitation, obscuration), cloud groups (FEW/SCT/BKN/OVC,
 * vertical visibility, CB/TCU, NSC/SKC/CLR), temperature/dew point (M prefix), altimeter (A inHg / Q hPa).
 * Trend groups (TEMPO/BECMG/NOSIG) and remarks are ignored. Cloud bases are AGL in the report and
 * stored MSL using the station elevation argument.
 */
import { clamp } from '../core/math';
import type { CloudLayer, TurbulenceIntensity, WeatherState, WindLayer } from '../core/types';
import { FT, INHG } from '../core/units';
import { COVERAGE, defaultWeather } from './presets';

export interface MetarCloudGroup {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV';
  /** base above ground, m (null when the height is not reported, e.g. `///`) */ baseAglM: number | null;
  /** CB or TCU flag */ towering: boolean;
  cb: boolean;
}

export interface MetarReport {
  raw: string;
  station: string;
  /** observation day of month / UTC hour / minute, when present */
  day: number | null;
  hourUtc: number | null;
  minuteUtc: number | null;
  windFromDeg: number | null;
  windVariable: boolean;
  windVariationDeg: [number, number] | null;
  windSpeedKt: number;
  windGustKt: number;
  /** prevailing visibility, m (10 000 = ≥ 10 km / CAVOK) */
  visibilityM: number | null;
  cavok: boolean;
  /** present-weather groups as written, e.g. "-RA", "TSRA", "BR" */
  phenomena: string[];
  clouds: MetarCloudGroup[];
  verticalVisibilityM: number | null;
  temperatureC: number | null;
  dewpointC: number | null;
  qnhPa: number | null;
  /** tokens the parser did not understand (for diagnostics) */
  unparsed: string[];
  /** the derived simulator weather */
  weather: WeatherState;
}

const RE_TIME = /^(\d{2})(\d{2})(\d{2})Z$/;
const RE_WIND = /^(\d{3}|VRB|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}))?(KT|MPS|KMH)$/;
const RE_WIND_VAR = /^(\d{3})V(\d{3})$/;
const RE_VIS_M = /^(\d{4})(NDV|[NSEW]{1,2})?$/;
const RE_VIS_SM_SIMPLE = /^([PM])?(\d{1,2})SM$/;
const RE_VIS_SM_FRAC = /^([PM])?(?:(\d)\s)?(\d)\/(\d{1,2})SM$/;
const RE_RVR = /^R\d{2}[LCR]?\/[PM]?\d{4}(?:V[PM]?\d{4})?(?:FT)?[UDN]?$/;
const RE_WX = /^([-+]|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP){0,3}(BR|FG|FU|VA|DU|SA|HZ|PY)?(PO|SQ|FC|SS|DS)?$/;
const RE_CLOUD = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;
const RE_TEMP = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/;
const RE_ALT_A = /^A(\d{4})$/;
const RE_ALT_Q = /^Q(\d{4})$/;
const RE_STATION = /^[A-Z][A-Z0-9]{3}$/;
const RE_INT = /^\d{1,2}$/;
const RE_FRAC_SM = /^[PM]?\d\/\d{1,2}SM$/;

const STATUTE_MILE_M = 1609.344;
const STOP_TOKENS = new Set(['RMK', 'TEMPO', 'BECMG', 'NOSIG', 'FM', 'PROB30', 'PROB40']);
const SKIP_TOKENS = new Set(['METAR', 'SPECI', 'AUTO', 'COR', 'NSW', 'NSC', 'NCD', 'SKC', 'CLR', 'CAVOK', 'RTD', 'AMD', 'NIL', '$']);

const parseTemp = (s: string): number | null => (s === '//' ? null : s.startsWith('M') ? -Number(s.slice(1)) : Number(s));

/** Parse a raw METAR into a report + derived `WeatherState`. Never throws on malformed input. */
export function parseMetar(raw: string, stationElevationM = 0): MetarReport {
  const text = raw.trim().replace(/=$/, '').replace(/\s+/g, ' ');
  const tokens = text.split(' ').filter((t) => t.length > 0);
  const rep: MetarReport = {
    raw: text, station: '', day: null, hourUtc: null, minuteUtc: null,
    windFromDeg: null, windVariable: false, windVariationDeg: null, windSpeedKt: 0, windGustKt: 0,
    visibilityM: null, cavok: false, phenomena: [], clouds: [], verticalVisibilityM: null,
    temperatureC: null, dewpointC: null, qnhPa: null, unparsed: [],
    weather: defaultWeather(),
  };
  let i = 0;
  if (tokens[i] === 'METAR' || tokens[i] === 'SPECI') i++;
  if (i < tokens.length && RE_STATION.test(tokens[i])) rep.station = tokens[i++];

  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (STOP_TOKENS.has(tok)) break;
    let m: RegExpMatchArray | null;
    if (tok === 'CAVOK') { rep.cavok = true; rep.visibilityM = 10_000; continue; }
    if (SKIP_TOKENS.has(tok)) continue;
    if ((m = tok.match(RE_TIME))) { rep.day = +m[1]; rep.hourUtc = +m[2]; rep.minuteUtc = +m[3]; continue; }
    if ((m = tok.match(RE_WIND))) {
      const unit = m[4] === 'KT' ? 1 : m[4] === 'MPS' ? 1.943844 : 0.539957;
      rep.windVariable = m[1] === 'VRB';
      rep.windFromDeg = m[1] === 'VRB' || m[1] === '///' ? null : +m[1];
      rep.windSpeedKt = m[2] === '//' ? 0 : +m[2] * unit;
      rep.windGustKt = m[3] ? +m[3] * unit : 0;
      continue;
    }
    if ((m = tok.match(RE_WIND_VAR))) { rep.windVariationDeg = [+m[1], +m[2]]; continue; }
    // mixed-fraction statute miles: "1 1/2SM" arrives as two tokens
    if (RE_INT.test(tok) && i + 1 < tokens.length && RE_FRAC_SM.test(tokens[i + 1])) {
      const f = tokens[i + 1].match(RE_VIS_SM_FRAC)!;
      rep.visibilityM = (+tok + +f[3] / +f[4]) * STATUTE_MILE_M;
      i++;
      continue;
    }
    if ((m = tok.match(RE_VIS_SM_SIMPLE))) {
      let sm = +m[2];
      if (m[1] === 'P') sm *= 1.5; // "P6SM" = greater than 6 SM
      rep.visibilityM = sm * STATUTE_MILE_M;
      continue;
    }
    if ((m = tok.match(RE_VIS_SM_FRAC))) {
      const sm = (m[2] ? +m[2] : 0) + +m[3] / +m[4];
      rep.visibilityM = sm * STATUTE_MILE_M * (m[1] === 'M' ? 0.9 : 1); // "M1/4SM" = less than 1/4 SM
      continue;
    }
    if (rep.visibilityM === null && (m = tok.match(RE_VIS_M))) {
      rep.visibilityM = +m[1] === 9999 ? 10_000 : +m[1];
      continue;
    }
    if (RE_RVR.test(tok)) continue;
    if ((m = tok.match(RE_CLOUD))) {
      const cover = m[1] as MetarCloudGroup['cover'];
      const base = m[2] === '///' ? null : +m[2] * 100 * FT;
      const sup = m[3] ?? '';
      const group: MetarCloudGroup = { cover, baseAglM: base, towering: sup === 'CB' || sup === 'TCU', cb: sup === 'CB' };
      if (cover === 'VV') rep.verticalVisibilityM = base;
      rep.clouds.push(group);
      continue;
    }
    if ((m = tok.match(RE_TEMP))) { rep.temperatureC = parseTemp(m[1]); rep.dewpointC = m[2] ? parseTemp(m[2]) : null; continue; }
    if ((m = tok.match(RE_ALT_A))) { rep.qnhPa = (+m[1] / 100) * INHG; continue; }
    if ((m = tok.match(RE_ALT_Q))) { rep.qnhPa = +m[1] * 100; continue; }
    if (tok.length >= 2 && tok !== '//' && (m = tok.match(RE_WX)) && (m[2] || m[3] || m[4] || m[5])) { rep.phenomena.push(tok); continue; }
    rep.unparsed.push(tok);
  }

  rep.weather = weatherFromMetar(rep, stationElevationM);
  return rep;
}

/** Relative humidity 0..1 from temperature / dew point (Magnus). */
export function relativeHumidity(tC: number, tdC: number): number {
  const es = (t: number) => Math.exp((17.625 * t) / (243.04 + t));
  return clamp(es(tdC) / es(tC), 0, 1);
}

const wxIntensity = (p: string): number => (p.startsWith('+') ? 3 : p.startsWith('-') ? 0.5 : p.startsWith('VC') ? 0.25 : 1);

/** Derive the simulator `WeatherState` from a parsed report (also usable on hand-built reports). */
export function weatherFromMetar(rep: MetarReport, stationElevationM: number): WeatherState {
  const w = defaultWeather();
  w.preset = 'custom';

  // ── clouds (AGL → MSL) ───────────────────────────────────────────────────────────────
  const layers: CloudLayer[] = [];
  for (const g of rep.clouds) {
    if (g.cover === 'VV') {
      const top = (g.baseAglM ?? 60) + 300;
      layers.push({ baseM: stationElevationM, topM: stationElevationM + top, coverage: 1, density: 1, type: 'stratus' });
      w.fogTopM = Math.max(w.fogTopM, g.baseAglM ?? 60);
      continue;
    }
    const cov = COVERAGE[g.cover];
    const base = g.baseAglM ?? 1500;
    const high = base > 6000;
    const thickness = g.towering ? (g.cb ? 6000 : 3000) : high ? 600 : cov > 0.5 ? 900 : 600;
    layers.push({
      baseM: stationElevationM + base,
      topM: stationElevationM + base + thickness,
      coverage: cov,
      density: g.towering ? 1.5 : high ? 0.5 : 1,
      type: g.towering ? 'cumulus' : high ? 'cirrus' : cov > 0.7 ? 'stratus' : 'cumulus',
    });
  }
  layers.sort((a, b) => a.baseM - b.baseM);
  w.clouds = layers;

  // ── wind ─────────────────────────────────────────────────────────────────────────────
  let dir = rep.windFromDeg ?? 0;
  if (rep.windFromDeg === null && rep.windVariationDeg) {
    // VRB with a reported range: use the bisector of the range (clockwise from the first value)
    const [a, b] = rep.windVariationDeg;
    dir = (a + ((((b - a) % 360) + 360) % 360) / 2) % 360;
  }
  const sfc: WindLayer = { altM: stationElevationM + 10, directionDeg: dir, speedKt: rep.windSpeedKt, gustKt: rep.windGustKt > rep.windSpeedKt ? rep.windGustKt : 0 };
  // A METAR has no winds aloft: assume a gentle veer/increase so the wind is not constant to FL400.
  w.winds = [
    sfc,
    { altM: stationElevationM + 1500, directionDeg: (dir + 15) % 360, speedKt: Math.max(rep.windSpeedKt * 1.4, 5), gustKt: 0 },
    { altM: stationElevationM + 4000, directionDeg: (dir + 30) % 360, speedKt: Math.max(rep.windSpeedKt * 2, 10), gustKt: 0 },
  ];

  // ── weather phenomena ────────────────────────────────────────────────────────────────
  const ph = rep.phenomena;
  const has = (re: RegExp) => ph.some((p) => re.test(p));
  const maxInt = ph.length ? Math.max(...ph.map(wxIntensity)) : 1;
  const snow = has(/SN|SG|IC|PL/), rain = has(/RA|DZ|GR|GS|UP/);
  if (snow && !rain) { w.precipitationType = 'snow'; w.precipitationRate = 2 * maxInt; }
  else if (rain || snow) { w.precipitationType = 'rain'; w.precipitationRate = 4 * maxInt; }
  else if (has(/^(\+|-)?SH/) || has(/TS/)) { w.precipitationType = 'rain'; w.precipitationRate = has(/TS/) ? 8 : 2; }
  else { w.precipitationType = 'none'; w.precipitationRate = 0; }
  w.thunderstorm = has(/TS/);
  const fog = has(/FG/), mist = has(/BR|HZ|FU|DU|SA/);

  // ── visibility ───────────────────────────────────────────────────────────────────────
  let vis = rep.visibilityM ?? (fog ? 800 : mist ? 4000 : 10_000);
  if (rep.cavok) vis = 10_000;
  w.visibilityM = clamp(vis, 50, 100_000);
  if (fog && w.fogTopM === 0) w.fogTopM = 150;
  if (mist && w.fogTopM === 0 && w.visibilityM < 3000) w.fogTopM = 300;
  w.aerosol = clamp(1 - w.visibilityM / 40_000, 0, 1) * (fog || mist ? 1 : 0.8);

  // ── temperature / humidity / pressure ────────────────────────────────────────────────
  if (rep.temperatureC !== null) w.temperatureC = rep.temperatureC + 0.0065 * stationElevationM; // sea-level reference
  if (rep.temperatureC !== null && rep.dewpointC !== null) w.humidity = relativeHumidity(rep.temperatureC, rep.dewpointC);
  else w.humidity = w.precipitationRate > 0 || fog ? 0.95 : 0.6;
  if (rep.qnhPa !== null) w.qnhPa = rep.qnhPa;

  // ── turbulence (POE index) ───────────────────────────────────────────────────────────
  const gustFactor = Math.max(0, rep.windGustKt - rep.windSpeedKt);
  let turb: TurbulenceIntensity = 0;
  if (w.thunderstorm) turb = 5;
  else if (gustFactor >= 10 || rep.windSpeedKt >= 25) turb = 4;
  else if (gustFactor > 0 || rep.windSpeedKt >= 15) turb = 3;
  else if (rep.windSpeedKt >= 8) turb = 2;
  else if (rep.windSpeedKt >= 4) turb = 1;
  if (layers.some((l) => l.type === 'cumulus' && l.density >= 1.5)) turb = Math.max(turb, 4) as TurbulenceIntensity;
  w.turbulence = turb;
  return w;
}
