import { describe, expect, it } from 'vitest';
import { DISCOVERY_FLIGHTS, discoveryById } from './discovery';

const R = 6371000, D = Math.PI / 180;
const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const y = Math.sin((b.lon - a.lon) * D) * Math.cos(b.lat * D);
  const x = Math.cos(a.lat * D) * Math.sin(b.lat * D) - Math.sin(a.lat * D) * Math.cos(b.lat * D) * Math.cos((b.lon - a.lon) * D);
  return ((Math.atan2(y, x) / D) + 360) % 360;
};

describe('discovery flights', () => {
  it('unique ids, sane values, a start a few km from the landmark pointing at it', () => {
    const ids = new Set(DISCOVERY_FLIGHTS.map((d) => d.id));
    expect(ids.size).toBe(DISCOVERY_FLIGHTS.length);
    for (const d of DISCOVERY_FLIGHTS) {
      expect(Math.abs(d.lat)).toBeLessThan(80);
      const km = dist(d, d.target) / 1000;
      expect(km, d.id).toBeGreaterThan(2); expect(km, d.id).toBeLessThan(25);
      const off = Math.abs(((bearing(d, d.target) - d.headingDeg + 540) % 360) - 180);
      // pointed near the landmark; a towering one is passed beside, not flown at
      if (d.towers) { expect(off, d.id).toBeGreaterThan(d.id === 'matterhorn' ? -1 : 10); expect(off, d.id).toBeLessThan(35); } else expect(off, d.id).toBeLessThan(30);
      expect(d.iasKt).toBeGreaterThan(65); expect(d.iasKt).toBeLessThan(120);
      // within reach of the aircraft (service ceilings ~13,000 ft for the 172S, ~19,000 ft for the Cub)
      expect(d.altFt).toBeLessThan(d.aircraft === 'c172' ? 13_500 : 15_000);
      expect(d.blurb.length).toBeGreaterThan(40);
    }
  });

  it('starts clear of the highest terrain along the way, except where the landmark towers above by design', () => {
    for (const d of DISCOVERY_FLIGHTS) {
      // a towering landmark: the start is below it by design, but well above the valley it starts in
      if (d.towers) { expect(d.altFt, d.id).toBeGreaterThan(9_000); expect(d.blurb).toMatch(/above you|clear of the ridges/); continue; }
      expect(d.altFt - d.terrainFt, d.id).toBeGreaterThan(d.id === 'geiranger' || d.id === 'milford-sound' || d.id === 'na-pali' ? -3_000 : 500);
    }
    expect(discoveryById('uluru')?.time).toBe('dusk');
    expect(discoveryById('nope')).toBeUndefined();
  });
});
