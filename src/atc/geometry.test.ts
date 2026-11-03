import { describe, expect, it } from 'vitest';
import type { Airport, Geodetic } from '../core/types';
import { destinationPoint } from '../geo/wgs84';
import { allRunwayRefs } from './field';
import {
  choosePatternEntry, classifyPatternLeg, isAtHoldShort, isEstablishedOnFinal, isOnRunway, makeRunwayFrame,
  relativeTo, type PatternLeg, type TrafficSide,
} from './geometry';

const HDG = 300;
const LEN = 2000;
const THR: Geodetic = { lat: 47.0, lon: 8.0, alt: 100 };
const airport: Airport = {
  icao: 'TEST', name: 'Test Field', position: THR, elevationM: 100, type: 'small', country: 'XX',
  runways: [{
    ident: '30', threshold: THR, end: destinationPoint(THR, HDG, LEN, 100), headingDeg: HDG, lengthM: LEN, widthM: 30,
    surface: 'asphalt', lighted: true, displacedThresholdM: 0,
  }],
};
const ref = allRunwayRefs(airport).find((r) => r.ident === '30');
if (!ref) throw new Error('runway 30 missing');
const frame = makeRunwayFrame(airport, ref);

/** Geodetic position `along` m down the runway direction and `cross` m to its right. */
function at(along: number, cross: number): Geodetic {
  const p = destinationPoint(THR, HDG, along, 100);
  return cross === 0 ? p : destinationPoint(p, HDG + 90, cross, 100);
}

function leg(along: number, cross: number, trackDeg: number, side: TrafficSide, heightM = 300): PatternLeg {
  const rel = relativeTo(frame, at(along, cross), 100 + heightM, trackDeg);
  return classifyPatternLeg(rel, LEN, side);
}

describe('runway-relative geometry', () => {
  it('measures along/cross/height/track in the runway frame', () => {
    const rel = relativeTo(frame, at(-1500, 120), 400, 310);
    expect(rel.alongM).toBeCloseTo(-1500, 0);
    expect(rel.crossM).toBeCloseTo(120, 0);
    expect(rel.heightM).toBeCloseTo(300, 6);
    expect(rel.relTrackDeg).toBeCloseTo(10, 6);
    expect(relativeTo(frame, at(10, -200), 100, HDG).crossM).toBeCloseTo(-200, 0);
  });

  it('runway occupancy and hold-short area', () => {
    expect(isOnRunway(relativeTo(frame, at(500, 5), 100, HDG), frame)).toBe(true);
    expect(isOnRunway(relativeTo(frame, at(500, 60), 100, HDG), frame)).toBe(false);
    expect(isAtHoldShort(relativeTo(frame, at(-30, 80), 100, 30))).toBe(true);
    expect(isAtHoldShort(relativeTo(frame, at(1200, 80), 100, 30))).toBe(false);
  });
});

describe('pattern-leg classification', () => {
  it('left traffic', () => {
    expect(leg(1000, 0, 300, 'left', 100)).toBe('upwind');
    expect(leg(2600, 60, 302, 'left')).toBe('upwind');
    expect(leg(2600, -600, 210, 'left')).toBe('crosswind');
    expect(leg(1000, -1200, 120, 'left')).toBe('downwind');
    expect(leg(-300, -1300, 135, 'left')).toBe('downwind'); // extended downwind / 45° entry heading
    expect(leg(-1200, -1100, 30, 'left')).toBe('base');
    expect(leg(-1500, 20, 300, 'left', 150)).toBe('final');
    expect(leg(-6000, 400, 295, 'left', 500)).toBe('final');
  });

  it('right traffic mirrors the lateral legs', () => {
    expect(leg(2600, 600, 30, 'right')).toBe('crosswind');
    expect(leg(1000, 1200, 120, 'right')).toBe('downwind');
    expect(leg(-1200, 1100, 210, 'right')).toBe('base');
    expect(leg(-1500, -20, 300, 'right', 150)).toBe('final');
    // The same positions are not legs of the opposite pattern.
    expect(leg(1000, 1200, 120, 'left')).toBe('outside');
    expect(leg(-1200, 1100, 210, 'left')).not.toBe('base');
  });

  it('outside the pattern', () => {
    expect(leg(0, -9000, 120, 'left')).toBe('outside');
    expect(leg(1000, -1200, 120, 'left', 2000)).toBe('outside');
    expect(leg(-15000, 0, 300, 'left')).toBe('outside');
    expect(leg(1000, -1200, 300, 'left')).toBe('outside'); // parallel to the runway, wrong way for downwind
  });
});

describe('established on final and pattern entry', () => {
  it('detects a stabilised final', () => {
    const rel = (along: number, cross: number, track: number, h: number) => relativeTo(frame, at(along, cross), 100 + h, track);
    expect(isEstablishedOnFinal(rel(-5000, 100, 302, 250), 3 * 1852)).toBe(true);
    expect(isEstablishedOnFinal(rel(-1200, 30, 299, 90), 3 * 1852)).toBe(true);
    expect(isEstablishedOnFinal(rel(-5000, 100, 302, 1200), 3 * 1852)).toBe(false); // far too high
    expect(isEstablishedOnFinal(rel(-5000, 100, 340, 250), 3 * 1852)).toBe(false); // not aligned
    expect(isEstablishedOnFinal(rel(-5000, 900, 300, 250), 3 * 1852)).toBe(false); // off the centreline
    expect(isEstablishedOnFinal(rel(-8000, 0, 300, 350), 3 * 1852)).toBe(false); // beyond 3 nm
    expect(isEstablishedOnFinal(rel(800, 0, 300, 20), 3 * 1852)).toBe(false); // past the threshold
  });

  it('chooses straight-in, base or downwind entry from geometry', () => {
    const rel = (along: number, cross: number, track: number) => relativeTo(frame, at(along, cross), 600, track);
    expect(choosePatternEntry(rel(-9000, 500, 300), 'left')).toBe('straight-in');
    expect(choosePatternEntry(rel(-3000, -2500, 30), 'left')).toBe('base');
    expect(choosePatternEntry(rel(-3000, 2500, 210), 'right')).toBe('base');
    expect(choosePatternEntry(rel(-3000, 2500, 210), 'left')).toBe('downwind');
    expect(choosePatternEntry(rel(1000, -6000, 120), 'left')).toBe('downwind');
  });
});
