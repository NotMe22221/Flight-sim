import { describe, expect, it } from 'vitest';
import { qRotate } from '../core/math';
import type { Vec3 } from '../core/types';
import { LocalFrame, destinationPoint } from '../geo/wgs84';
import { makeRebase, needsRebase, quatFromMatrix } from './rebase';

describe('rebase', () => {
  it('needsRebase triggers beyond 20 km horizontally only', () => {
    expect(needsRebase([19000, 0, -5000])).toBe(false);
    expect(needsRebase([15000, 15000, 0])).toBe(true);
    expect(needsRebase([0, 0, -30000])).toBe(false);
  });

  it('quatFromMatrix reproduces a 90° yaw', () => {
    // R maps old axes to new; a rotation of 90° about D
    const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
    const q = quatFromMatrix([c, s, 0, -s, c, 0, 0, 0, 1]);
    const v = qRotate(q, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 10);
    expect(Math.abs(v[1])).toBeCloseTo(1, 10);
  });

  it('rebasing a far aircraft puts it at the new origin with the same geodetic position and altitude', () => {
    const old = new LocalFrame(37.613538, -122.35716, 4);
    const dest = destinationPoint({ lat: 37.613538, lon: -122.35716, alt: 0 }, 60, 25000, 1500);
    const pos = old.geodeticToNED(dest.lat, dest.lon, dest.alt);
    const t = makeRebase(old, pos);
    const rel: Vec3 = [pos[0] - t.translationNED[0], pos[1] - t.translationNED[1], pos[2] - t.translationNED[2]];
    const newPos = qRotate(t.rotation, rel);
    expect(Math.abs(newPos[0])).toBeLessThan(1e-3);
    expect(Math.abs(newPos[1])).toBeLessThan(1e-3);
    expect(newPos[2]).toBeCloseTo(-1500, 3);
    const g = t.newFrame.nedToGeodetic(newPos[0], newPos[1], newPos[2]);
    expect(g.lat).toBeCloseTo(dest.lat, 7);
    expect(g.lon).toBeCloseTo(dest.lon, 7);
    expect(g.alt).toBeCloseTo(1500, 3);
  });

  it('a velocity vector keeps its magnitude and its down component stays "down" in the new frame', () => {
    const old = new LocalFrame(47.26, 11.34, 581);
    const pos: Vec3 = [22000, -8000, -2000];
    const t = makeRebase(old, pos);
    const v: Vec3 = [50, 20, 3];
    const w = qRotate(t.rotation, v);
    expect(Math.hypot(...w)).toBeCloseTo(Math.hypot(...v), 9);
    // tilt is ~0.2°, so components change by < 0.5 m/s
    expect(Math.abs(w[0] - v[0])).toBeLessThan(0.5);
    expect(Math.abs(w[2] - v[2])).toBeLessThan(0.5);
  });
});
