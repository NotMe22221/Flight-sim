import { describe, expect, it } from 'vitest';
import type { Airport } from '../core/types';
import { createView } from './mapProjection';
import { distanceM } from './geoMath';
import { FALLBACK_KSFO, findRunwayEnd } from './runways';
import {
  AIRPORT_DOT_PX, MAX_QUERY_NM, airportDotRadius, airportLabelVisible, airportQuery, airportTypeVisible, hitTestAirport, needsRefetch,
  niceFloor, runwayLine, scaleBar,
} from './worldMapModel';

const ap = (icao: string, lat: number, lon: number, type: Airport['type']): Pick<Airport, 'icao' | 'position' | 'type'> => ({ icao, position: { lat, lon, alt: 0 }, type });

describe('zoom-dependent visibility', () => {
  it('shows large airports always, medium from continental zoom, small when zoomed in', () => {
    expect(airportTypeVisible('large', 1)).toBe(true);
    expect(airportTypeVisible('medium', 3)).toBe(false);
    expect(airportTypeVisible('medium', 20)).toBe(true);
    expect(airportTypeVisible('small', 20)).toBe(false);
    expect(airportTypeVisible('heliport', 200)).toBe(true);
  });
  it('sizes dots by type and grows them gently with zoom', () => {
    expect(airportDotRadius('large', 200)).toBeCloseTo(AIRPORT_DOT_PX.large);
    expect(airportDotRadius('large', 200)).toBeGreaterThan(airportDotRadius('small', 200));
    expect(airportDotRadius('small', 5000)).toBeGreaterThan(airportDotRadius('small', 200));
    expect(airportDotRadius('small', 1e9)).toBeCloseTo(AIRPORT_DOT_PX.small * 1.6);
    expect(airportDotRadius('small', 0.001)).toBeCloseTo(AIRPORT_DOT_PX.small * 0.8);
  });
  it('reveals labels progressively', () => {
    expect(airportLabelVisible('large', 30)).toBe(true);
    expect(airportLabelVisible('medium', 30)).toBe(false);
    expect(airportLabelVisible('small', 300)).toBe(true);
  });
});

describe('airport query and refetch throttling', () => {
  it('covers the half-diagonal of the view, clamped', () => {
    const v = createView(-122.4, 37.6, 100, 800, 600); // 500 px half-diagonal = 5° = 300 nm
    const q = airportQuery(v);
    expect(q.radiusNm).toBeCloseTo(300);
    expect(q.lat).toBeCloseTo(37.6);
    expect(airportQuery(createView(0, 0, 1, 4000, 4000)).radiusNm).toBe(MAX_QUERY_NM);
    expect(airportQuery(createView(0, 0, 50000, 100, 100)).radiusNm).toBe(5);
  });
  it('refetches only after a meaningful pan or zoom', () => {
    const v = createView(-122.4, 37.6, 100, 800, 600);
    const q = airportQuery(v);
    expect(needsRefetch(null, q)).toBe(true);
    expect(needsRefetch(q, { ...q, lat: q.lat + 0.5 })).toBe(false);   // 30 nm < 75 nm
    expect(needsRefetch(q, { ...q, lat: q.lat + 2 })).toBe(true);      // 120 nm
    expect(needsRefetch(q, { ...q, pxPerDeg: 110 })).toBe(false);
    expect(needsRefetch(q, { ...q, pxPerDeg: 140 })).toBe(true);
    expect(needsRefetch(q, { ...q, pxPerDeg: 70 })).toBe(true);
  });
  it('handles the antimeridian when measuring a pan', () => {
    const v = createView(179.9, 0, 100, 800, 600);
    const q = airportQuery(v);
    expect(needsRefetch(q, { ...q, lon: -179.9 })).toBe(false); // 0.2° apart, not 359.8°
  });
});

describe('hitTestAirport', () => {
  const v = createView(0, 0, 100, 400, 400); // centre (200, 200), 1 px = 0.01°
  const list = [ap('BIG', 0, 0, 'large'), ap('NEAR', 0.05, 0, 'small'), ap('FAR', 1, 1, 'medium')];
  it('returns the nearest visible airport within the radius', () => {
    expect(hitTestAirport(list, v, 201, 200)?.icao).toBe('BIG');
    expect(hitTestAirport(list, v, 200, 194)?.icao).toBe('NEAR');
    expect(hitTestAirport(list, v, 300, 300)).toBeNull();
  });
  it('skips types hidden at this zoom', () => {
    const out = createView(0, 0, 10, 400, 400);
    expect(hitTestAirport([ap('S', 0, 0, 'small')], out, 200, 200)).toBeNull();
  });
});

describe('scale bar', () => {
  it('picks 1-2-5 values', () => {
    expect(niceFloor(7.3)).toBe(5);
    expect(niceFloor(19)).toBe(10);
    expect(niceFloor(0.034)).toBeCloseTo(0.03 > 0.02 ? 0.02 : 0.01);
    expect(niceFloor(0)).toBe(0);
  });
  it('labels in nm or km and fits the width', () => {
    const v = createView(0, 0, 100, 800, 600);
    const nm = scaleBar(v, 0, 'nm', 120);
    expect(nm.label).toMatch(/ nm$/);
    expect(nm.px).toBeLessThanOrEqual(120);
    expect(nm.px).toBeGreaterThan(40);
    const km = scaleBar(v, 0, 'km', 120);
    expect(km.label).toMatch(/ km$/);
    const close = scaleBar(createView(0, 0, 40000, 800, 600), 0, 'km', 120);
    expect(close.label).toMatch(/ m$/);
  });
});

describe('runwayLine', () => {
  it('runs from the threshold along the heading for the runway length', () => {
    const end = findRunwayEnd(FALLBACK_KSFO, '28R')!;
    const l = runwayLine(end);
    expect(l.from.lat).toBeCloseTo(end.threshold.lat);
    expect(distanceM(l.from, l.to)).toBeCloseTo(end.lengthM, -1);
    expect(l.to.lon).toBeLessThan(l.from.lon); // 298° heads west-north-west
  });
});
