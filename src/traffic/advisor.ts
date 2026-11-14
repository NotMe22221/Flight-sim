/**
 * Traffic advisories in controller phraseology ("traffic, two o'clock, one mile, Cessna on left
 * downwind, one thousand feet") for AI traffic that is a factor to the player: within 2 nm and
 * 1,000 ft, airborne, and either converging or in the circuit with the player. One call per
 * aircraft per 90 s. Pure: the simulator feeds positions and sends the text on the ATC channel.
 */
import type { TrafficInfo } from '../core/types';

const D2R = Math.PI / 180;
const NM = 1852;
const FT = 0.3048;

export interface AdvisorPlayer {
  lat: number; lon: number; altMslM: number;
  /** true heading of the nose (clock positions are relative to it), deg */ headingDeg: number;
  onGround: boolean;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** Distance (m) and true bearing (deg) from a to b (flat earth; fine within a few nm). */
export function rangeBearing(aLat: number, aLon: number, bLat: number, bLon: number): { rangeM: number; bearingDeg: number } {
  const R = 6378137;
  const n = (bLat - aLat) * D2R * R, e = (bLon - aLon) * D2R * R * Math.cos(aLat * D2R);
  return { rangeM: Math.hypot(n, e), bearingDeg: ((Math.atan2(e, n) / D2R) + 360) % 360 };
}

/** Clock position 1..12 of a bearing relative to the nose. */
export function clockPosition(headingDeg: number, bearingDeg: number): number {
  const rel = ((bearingDeg - headingDeg) % 360 + 360) % 360;
  const c = Math.round(rel / 30) % 12;
  return c === 0 ? 12 : c;
}

/** "one thousand two hundred" style altitude for the spoken call (hundreds of feet MSL, rounded). */
export function altitudeWords(ftMsl: number): string {
  const h = Math.max(0, Math.round(ftMsl / 100));
  const th = Math.floor(h / 10), hu = h % 10;
  const parts: string[] = [];
  if (th > 0) parts.push(`${th <= 12 ? ONES[th] : String(th)} thousand`);
  if (hu > 0) parts.push(`${ONES[hu]} hundred`);
  return parts.length ? parts.join(' ') : 'field elevation';
}

function rangeWords(nm: number): string {
  if (nm < 0.75) return 'less than a mile';
  const r = Math.round(nm);
  return r <= 1 ? 'one mile' : `${ONES[Math.min(r, 12)]} miles`;
}

const LEG_WORDS: Record<string, string> = { upwind: 'on upwind', goaround: 'going around', crosswind: 'on crosswind', downwind: 'on downwind', base: 'on base', final: 'on final' };

export class TrafficAdvisor {
  private readonly lastCall = new Map<string, number>();
  private readonly lastRange = new Map<string, number>();

  /**
   * Advisories due now (`t` = simulated seconds). `side` is the circuit's traffic side so
   * downwind/base read "left downwind". `prefix` is the player's callsign.
   */
  check(t: number, player: AdvisorPlayer, traffic: readonly TrafficInfo[], prefix: string, side: 'left' | 'right' = 'left'): string[] {
    const out: string[] = [];
    if (player.onGround) return out;
    for (const tr of traffic) {
      if (tr.onGround) continue;
      const { rangeM, bearingDeg } = rangeBearing(player.lat, player.lon, tr.lat, tr.lon);
      const relFt = (tr.altMslM - player.altMslM) / FT;
      const prev = this.lastRange.get(tr.callsign);
      this.lastRange.set(tr.callsign, rangeM);
      if (rangeM > 2 * NM || Math.abs(relFt) > 1000) continue;
      const converging = prev !== undefined && rangeM < prev - 1;
      if (!converging && rangeM > 0.75 * NM) continue;
      const last = this.lastCall.get(tr.callsign);
      if (last !== undefined && t - last < 90) continue;
      this.lastCall.set(tr.callsign, t);
      const clock = clockPosition(player.headingDeg, bearingDeg);
      const legWords = LEG_WORDS[tr.leg] ?? '';
      const sideWord = tr.leg === 'downwind' || tr.leg === 'base' || tr.leg === 'crosswind' ? `${side} ` : '';
      const what = `${tr.type.startsWith('Cessna') ? 'Cessna' : tr.type.includes('Cub') ? 'Piper Cub' : tr.type}${legWords ? ` ${legWords.replace('on ', `on ${sideWord}`)}` : ''}`;
      out.push(`${prefix}, traffic, ${ONES[clock]} o'clock, ${rangeWords(rangeM / NM)}, ${what}, ${altitudeWords(tr.altMslM / FT)}.`);
    }
    return out;
  }

  reset(): void { this.lastCall.clear(); this.lastRange.clear(); }
}
