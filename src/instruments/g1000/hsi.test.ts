import { describe, expect, it } from 'vitest';
import { FT, KT, NM } from '../../core/units';
import { InstrumentModel } from '../readings';
import { mockCanvas } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { HSI, cdiBarCentre, cdiOffsetPx, createHsiGeometry, drawHsi } from './hsi';
import { GPS_CDI_SCALE_NM, createBearingState, createCdiState, gpsCdiScale, resolveBearing, resolveCdi } from './navData';
import { G } from './palette';

function setup(o: Parameters<typeof makeSampleSnapshot>[0] = {}) {
  const s = makeSampleSnapshot(o);
  const r = new InstrumentModel().update(s, 1 / 60);
  return { s, r };
}

describe('nav source resolution', () => {
  it('NAV1 gives a green VOR1 source with the OBS course and +cdi = fly right', () => {
    const { s } = setup();
    const c = resolveCdi(s, 'NAV1', 13, createCdiState());
    expect(c.label).toBe('VOR1');
    expect(c.color).toBe(G.green);
    expect(c.courseDeg).toBe(95);
    expect(c.deviation).toBeCloseTo(0.3);
    expect(c.toFrom).toBe('from');
    expect(c.distanceNm).toBeCloseTo(12.4);
  });

  it('an invalid NAV source shows no deviation and no TO/FROM', () => {
    const { s } = setup();
    const c = resolveCdi(s, 'NAV2', 13, createCdiState());
    expect(c.valid).toBe(false);
    expect(c.deviation).toBe(0);
    expect(c.toFrom).toBe('off');
    expect(c.ident).toBe('');
  });

  it('GPS converts the true DTK to magnetic and the cross-track (+ right of course) to fly-left deviation', () => {
    const { s } = setup();
    s.plan!.crossTrackM = 0.5 * NM;
    const c = resolveCdi(s, 'GPS', 13, createCdiState());
    expect(c.color).toBe(G.magenta);
    expect(c.courseDeg).toBeCloseTo(330 - 13);
    // the sample is within 31 nm of KSFO → TERM, 1.0 nm full scale
    expect(c.scaleLabel).toBe('TERM');
    expect(c.deviation).toBeCloseTo(-0.5 / GPS_CDI_SCALE_NM.TERM);
    expect(c.ident).toBe('SAU');
    expect(c.toFrom).toBe('to');
  });

  it('GPS with no flight plan is invalid but keeps a usable label', () => {
    const { s } = setup();
    s.plan = null;
    const c = resolveCdi(s, 'GPS', 13, createCdiState());
    expect(c.valid).toBe(false);
    expect(c.label).toBe('GPS');
    const b = resolveBearing(s, 'GPS', 13, createBearingState());
    expect(b.valid).toBe(false);
  });

  it('GPS scale is ENR far from the departure and destination', () => {
    const { s } = setup();
    const plan = s.plan!;
    expect(gpsCdiScale(plan, 39.5, -120).label).toBe('ENR');
    expect(gpsCdiScale(plan, 37.62, -122.38).label).toBe('TERM');
  });

  it('bearing pointers: NAV1 bearing, localizers have none, OFF is hidden', () => {
    const { s } = setup();
    expect(resolveBearing(s, 'NAV1', 13, createBearingState()).bearingDeg).toBe(105);
    s.nav1.isLocalizer = true;
    expect(resolveBearing(s, 'NAV1', 13, createBearingState()).valid).toBe(false);
    expect(resolveBearing(s, 'OFF', 13, createBearingState()).valid).toBe(false);
  });
});

describe('HSI', () => {
  it('draws the sample without throwing and with balanced save/restore', () => {
    const { s, r } = setup();
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    const cdi = resolveCdi(s, 'NAV1', r.heading.magVarDeg, createCdiState());
    const b1 = resolveBearing(s, 'NAV1', r.heading.magVarDeg, createBearingState());
    const b2 = resolveBearing(s, 'GPS', r.heading.magVarDeg, createBearingState());
    expect(() => drawHsi(ctx2d, r, cdi, b1, b2)).not.toThrow();
    expect(ctx.balanced).toBe(true);
    expect(ctx.texts()).toContain('N');
    expect(ctx.texts()).toContain('VOR1');
  });

  it('+cdi (fly right) puts the deviation bar right of centre when the course is straight up', () => {
    const { s, r } = setup({ headingMagDeg: 95 });
    s.nav1.obsDeg = r.heading.magDeg;
    s.nav1.cdi = 0.6;
    const cdi = resolveCdi(s, 'NAV1', r.heading.magVarDeg, createCdiState());
    const geo = createHsiGeometry();
    const { ctx2d } = mockCanvas(1024, 768);
    drawHsi(ctx2d, r, cdi, createBearingState(), createBearingState(), geo);
    expect(geo.drawn).toBe(true);
    expect(Math.abs(geo.courseRelDeg)).toBeLessThan(1e-6);
    expect(geo.cdiBarX).toBeGreaterThan(HSI.cx + 20);
    expect(geo.cdiBarY).toBeCloseTo(HSI.cy, 6);
    s.nav1.cdi = -0.6;
    drawHsi(ctx2d, r, resolveCdi(s, 'NAV1', r.heading.magVarDeg, cdi), createBearingState(), createBearingState(), geo);
    expect(geo.cdiBarX).toBeLessThan(HSI.cx - 20);
  });

  it('with the course pointer reversed the bar still shows the course side pictorially', () => {
    // course 180° from heading: "fly right" relative to the course is screen-left
    const p = cdiBarCentre(HSI.cx, HSI.cy, 180, 0.5, { x: 0, y: 0 });
    expect(p.x).toBeLessThan(HSI.cx);
    expect(cdiOffsetPx(5)).toBe(2 * HSI.dot); // clamps at full scale
  });

  it('heading wrap 359 → 001: bug and course angles take the short way', () => {
    const { s, r } = setup({ headingMagDeg: 359 });
    s.autopilot.headingBugDeg = 1;
    s.nav1.obsDeg = 3;
    const r2 = new InstrumentModel().update(s, 1 / 60);
    const geo = createHsiGeometry();
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    drawHsi(ctx2d, r2, resolveCdi(s, 'NAV1', r.heading.magVarDeg, createCdiState()), createBearingState(), createBearingState(), geo);
    expect(geo.bugRelDeg).toBeCloseTo(2, 6);
    expect(geo.courseRelDeg).toBeCloseTo(4, 6);
    const joined = ctx.texts().join('');
    expect(joined).toContain('359°');
    expect(joined).toContain('001°');
  });

  it('shows a turn-rate trend arrowhead above 4°/s and a red X when the AHRS fails', () => {
    const { s } = setup();
    s.aircraft.rates[2] = 5 * Math.PI / 180;
    const r = new InstrumentModel().update(s, 1 / 60);
    const geo = createHsiGeometry();
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    const cdi = resolveCdi(s, 'GPS', 13, createCdiState());
    drawHsi(ctx2d, r, cdi, createBearingState(), createBearingState(), geo);
    expect(geo.trendArrow).toBe(true);
    expect(geo.trendDeg).toBe(HSI.trendMaxDeg);
    r.ahrs.valid = false;
    ctx.clear();
    drawHsi(ctx2d, r, cdi, createBearingState(), createBearingState(), geo);
    expect(geo.drawn).toBe(false);
    expect(ctx.count('fillText')).toBe(0);
    void FT; void KT;
  });
});
