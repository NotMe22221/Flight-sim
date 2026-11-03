import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import { LocalFrame } from '../geo/wgs84';
import { SLEW_THROTTLE_CENTRE, SlewController, slewHorizontalSpeed } from './slew';

const LAT = 37.613538, LON = -122.35716;
const DEG = Math.PI / 180;

/** Flat ground at 4 m MSL (up-coordinate in a frame with alt0 = 0, ignoring curvature for a few km). */
const ground = () => 4;

function start(onGround: boolean, altM: number, headingDeg = 0) {
  const frame = new LocalFrame(LAT, LON, 0);
  const s = makeAircraftState({ geo: { lat: LAT, lon: LON, alt: altM }, headingTrueRad: headingDeg * DEG, onGround, altitudeAglM: altM - 4, altitudeMslM: altM });
  s.euler[2] = headingDeg * DEG;
  const sl = new SlewController();
  sl.enter(s, 0.3, 1.2);
  return { frame, s, sl };
}

const run = (sl: SlewController, frame: LocalFrame, u: Partial<{ pitch: number; roll: number; yaw: number; throttle: number }>, seconds: number) => {
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: SLEW_THROTTLE_CENTRE, ...u };
  for (let t = 0; t < seconds; t += 1 / 60) sl.update(1 / 60, inp, frame, ground);
};

describe('SlewController', () => {
  it('moves forward along the heading with the stick forward, at taxi speed near the ground', () => {
    const { frame, sl } = start(true, 5.2, 90);
    run(sl, frame, { pitch: -1 }, 1);
    const p = sl.positionNED(frame);
    expect(p[1]).toBeGreaterThan(0.9 * slewHorizontalSpeed(0));
    expect(p[1]).toBeLessThan(1.1 * slewHorizontalSpeed(0));
    expect(Math.abs(p[0])).toBeLessThan(0.5);
    expect(sl.groundSpeedMs).toBeCloseTo(15, 0);
  });

  it('holds altitude with the throttle centred, climbs above it and never sinks into the ground', () => {
    const { frame, sl } = start(true, 5.2);
    run(sl, frame, {}, 2);
    expect(sl.geo.alt).toBeCloseTo(5.2, 3);
    run(sl, frame, { throttle: 0 }, 3);
    expect(sl.geo.alt).toBeGreaterThan(5.19); // floor = ground 4 m + rest height 1.2 m
    expect(sl.aglM).toBeLessThan(0.01);
    run(sl, frame, { throttle: 1 }, 3);
    expect(sl.geo.alt).toBeGreaterThan(15);
    expect(sl.verticalSpeedMs).toBeGreaterThan(3);
  });

  it('turns with the stick and slides sideways with the pedals', () => {
    const { frame, sl } = start(false, 500, 0);
    run(sl, frame, { roll: 1 }, 1);
    expect(sl.heading / DEG).toBeGreaterThan(45);
    expect(sl.heading / DEG).toBeLessThan(55);
    const before = sl.positionNED(frame).slice();
    const hdg = sl.heading;
    run(sl, frame, { yaw: 1 }, 1);
    const p = sl.positionNED(frame);
    // right of the heading: (−sin h, cos h)
    const right = -(p[0] - before[0]) * Math.sin(hdg) + (p[1] - before[1]) * Math.cos(hdg);
    expect(right).toBeGreaterThan(50);
  });

  it('writes the pose into a display state without mutating objects shared with the flight model', () => {
    const { frame, s, sl } = start(false, 800, 270);
    run(sl, frame, { pitch: -1, throttle: 0.9 }, 2);
    const out = { ...s, posNED: [0, 0, 0] as [number, number, number], qNB: [1, 0, 0, 0] as [number, number, number, number], euler: [0, 0, 0] as [number, number, number] };
    const sharedGeo = s.geo, sharedVel = s.velNED;
    const geoBefore = { ...s.geo };
    sl.writeState(out, frame);
    expect(s.geo).toEqual(geoBefore);
    expect(out.geo).not.toBe(sharedGeo);
    expect(out.velNED).not.toBe(sharedVel);
    expect(out.geo.alt).toBeCloseTo(sl.geo.alt, 6);
    expect(out.altitudeMslM).toBeCloseTo(sl.geo.alt, 6);
    expect(out.headingTrueRad / DEG).toBeCloseTo(270, 3);
    expect(out.onGround).toBe(false);
    // position written in the frame's NED
    const p = frame.geodeticToNED(sl.geo.lat, sl.geo.lon, sl.geo.alt);
    expect(out.posNED[1]).toBeCloseTo(p[1], 6);
  });

  it('keeps its geodetic pose across a frame change (floating-origin rebase)', () => {
    const { frame, sl } = start(false, 1000, 45);
    run(sl, frame, { pitch: -1 }, 3);
    const g = { ...sl.geo };
    const moved = new LocalFrame(LAT + 0.2, LON + 0.2, 0);
    run(sl, moved, {}, 0.5);
    expect(sl.geo.lat).toBeCloseTo(g.lat, 9);
    expect(sl.geo.lon).toBeCloseTo(g.lon, 9);
    expect(sl.geo.alt).toBeCloseTo(g.alt, 3);
  });

  it('does not move while paused (dt = 0)', () => {
    const { frame, sl } = start(false, 300, 0);
    const g = { ...sl.geo };
    sl.update(0, { pitch: -1, roll: 1, yaw: 1, throttle: 1 }, frame, ground);
    expect(sl.geo).toEqual(g);
    expect(sl.groundSpeedMs).toBe(0);
  });
});
