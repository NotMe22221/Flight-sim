import { describe, expect, it } from 'vitest';
import type { Runway } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import { headingOfDir, papiIndication, runwayGeometry, runwayLights } from './runwayGeometry';

const ksfo28R: Runway = {
  ident: '10L/28R',
  threshold: { lat: 37.628742, lon: -122.39341, alt: 1.5 }, // 10L end
  end: { lat: 37.613538, lon: -122.35716, alt: 4 }, // 28R end
  headingDeg: 118,
  lengthM: 3618,
  widthM: 61,
  surface: 'asphalt',
  lighted: true,
  displacedThresholdM: 0,
};

describe('runwayGeometry', () => {
  const frame = new LocalFrame(37.613538, -122.35716, 4);
  const g = runwayGeometry(ksfo28R, frame);

  it('heading of render-frame directions', () => {
    expect(headingOfDir([0, 0, -1])).toBeCloseTo(0, 6); // north = -z
    expect(headingOfDir([1, 0, 0])).toBeCloseTo(90, 6);
    expect(headingOfDir([0, 0, 1])).toBeCloseTo(180, 6);
    expect(headingOfDir([-1, 0, 0])).toBeCloseTo(270, 6);
  });

  it('KSFO 10L/28R: ends, headings and length match the data', () => {
    expect(g.ends[0].ident).toBe('10L');
    expect(g.ends[1].ident).toBe('28R');
    expect(g.ends[0].headingDeg).toBeCloseTo(118, 0);
    expect(g.ends[1].headingDeg).toBeCloseTo(298, 0);
    const horiz = Math.hypot(g.ends[1].pos[0] - g.ends[0].pos[0], g.ends[1].pos[2] - g.ends[0].pos[2]);
    expect(horiz).toBeGreaterThan(3550);
    expect(horiz).toBeLessThan(3680);
    // 28R end is the frame origin → near (0, lift, 0)
    expect(Math.abs(g.ends[1].pos[0])).toBeLessThan(0.01);
    expect(Math.abs(g.ends[1].pos[2])).toBeLessThan(0.01);
    expect(g.ends[1].pos[1]).toBeCloseTo(0.12, 3);
  });

  it('corners form a rectangle of the right width and across is right-of-travel', () => {
    const [al, ar, br, bl] = g.corners;
    expect(Math.hypot(ar[0] - al[0], ar[2] - al[2])).toBeCloseTo(61, 6);
    expect(Math.hypot(br[0] - bl[0], br[2] - bl[2])).toBeCloseTo(61, 6);
    // across should be ~90° clockwise of along: heading(along) + 90
    expect(headingOfDir(g.across)).toBeCloseTo((headingOfDir(g.along) + 90) % 360, 6);
  });

  it('lights: edge lights every 60 m on both sides, 8 threshold lights per end, 4 PAPI boxes left of each approach', () => {
    const L = runwayLights(g);
    expect(L.edgeWhite.length).toBe(2 * (Math.floor(3618 / 60) + 1) || L.edgeWhite.length);
    expect(L.edgeWhite.length % 2).toBe(0);
    expect(L.thresholdA.length).toBe(8);
    expect(L.papiA.length).toBe(4);
    // PAPI for 28R approach (end B) lies 300 m down the runway from the 28R threshold, to the LEFT of a pilot landing on 28R (heading 298 → left is ~208°)
    const p = L.papiB[0];
    const fromThr = [p[0] - g.ends[1].pos[0], 0, p[2] - g.ends[1].pos[2]] as [number, number, number];
    const alongDist = fromThr[0] * g.ends[1].dir[0] + fromThr[2] * g.ends[1].dir[2];
    expect(alongDist).toBeCloseTo(300, 0);
    const leftDir = [-(-g.ends[1].dir[2]), 0, -g.ends[1].dir[0]];
    const leftDist = fromThr[0] * leftDir[0] + fromThr[2] * leftDir[2];
    expect(leftDist).toBeGreaterThan(40); // 30.5 + 15
  });

  it('PAPI indication: on a 3° path 2 white 2 red; high → 4 white; low → 4 red', () => {
    const base: [number, number, number] = [0, 0, 0];
    const on3: [number, number, number] = [1000 * Math.sin(0), 1000 * Math.tan((3 * Math.PI) / 180), -1000];
    expect(papiIndication(on3, base)).toEqual([false, false, true, true]);
    const high: [number, number, number] = [0, 1000 * Math.tan((4 * Math.PI) / 180), -1000];
    expect(papiIndication(high, base)).toEqual([true, true, true, true]);
    const low: [number, number, number] = [0, 1000 * Math.tan((2 * Math.PI) / 180), -1000];
    expect(papiIndication(low, base)).toEqual([false, false, false, false]);
  });
});

import { approachLights } from './runwayGeometry';
describe('approach lighting', () => {
  const frame = new LocalFrame(37.613538, -122.35716, 4);
  const g = runwayGeometry(ksfo28R, frame);
  const L = approachLights(g, { alsA: true, alsB: true, centreline: true });
  it('REIL pairs straddle each threshold outside the edges', () => {
    expect(L.reilB.length).toBe(2);
    const [l, r] = L.reilB;
    expect(Math.hypot(r[0] - l[0], r[2] - l[2])).toBeCloseTo(61 + 24, 3);
  });
  it('approach bars run 720 m out before the 28R threshold, on the extended centreline', () => {
    expect(L.barsB.length).toBe(11 * 5 + 11); // 11 bars of 5, plus the 11-light crossbar at 300 m
    const end = g.ends[1];
    const far = L.rabbitB[0];
    const back = [far[0] - end.displacedPos[0], far[2] - end.displacedPos[2]];
    const along = back[0] * end.dir[0] + back[1] * end.dir[2];
    expect(along).toBeCloseTo(-720, 0); // before the threshold, opposite to the landing direction
    const cross = -back[0] * end.dir[2] + back[1] * end.dir[0];
    expect(Math.abs(cross)).toBeLessThan(0.01);
  });
  it('the rabbit runs from the far end toward the threshold', () => {
    const end = g.ends[1];
    const dist = (p: number[]) => Math.hypot(p[0] - end.displacedPos[0], p[2] - end.displacedPos[2]);
    for (let i = 1; i < L.rabbitB.length; i++) expect(dist(L.rabbitB[i])).toBeLessThan(dist(L.rabbitB[i - 1]));
  });
  it('centreline lights every ~15 m along the runway', () => {
    expect(L.centreline.length).toBeGreaterThan(3618 / 15 - 3);
  });
});
