import { describe, expect, it } from 'vitest';
import type { CanvasSurface } from '../canvas';
import { InstrumentModel } from '../readings';
import { MockCanvas, MockCanvasFactory, type MockContext2D } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { G1000 } from './G1000';
import { MAP, computeMapView, formatRange, mapToScreen } from './map';

function make(opts: ConstructorParameters<typeof G1000>[0] = {}) {
  const factory = new MockCanvasFactory();
  const g = new G1000({ createCanvas: (w, h) => factory.create(w, h), ...opts });
  const pfd = (g.pfdCanvas as unknown as MockCanvas).ctx;
  const mfd = (g.mfdCanvas as unknown as MockCanvas).ctx;
  return { g, factory, pfd, mfd };
}

const texts = (c: MockContext2D): string => c.texts().join('|');

describe('G1000', () => {
  it('creates two 1024×768 canvases through the factory', () => {
    const { g, factory } = make();
    expect(factory.created.length).toBe(2);
    expect(g.pfdCanvas.width).toBe(1024);
    expect(g.mfdCanvas.height).toBe(768);
  });

  it('returns true on the first update and false when called again within 33 ms with the same snapshot', () => {
    const { g, pfd, mfd } = make();
    const s = makeSampleSnapshot();
    expect(g.update(s, 1 / 60)).toBe(true);
    expect(g.changed.pfd).toBe(true);
    expect(g.changed.mfd).toBe(true);
    expect(pfd.balanced).toBe(true);
    expect(mfd.balanced).toBe(true);
    expect(pfd.calls.length).toBeGreaterThan(500);
    expect(g.update(s, 0.02)).toBe(false);
    expect(g.changed.pfd).toBe(false);
  });

  it('redraws at most 30 Hz while values change, and skips frames when nothing visible changed', () => {
    const { g } = make();
    const s = makeSampleSnapshot();
    g.update(s, 1 / 60);
    let pfdDraws = 0;
    for (let i = 0; i < 60; i++) {
      s.aircraft.euler[0] = 0.2 * Math.sin(i / 5); // keep the attitude moving
      g.update(s, 1 / 60);
      if (g.changed.pfd) pfdDraws++;
    }
    expect(pfdDraws).toBeGreaterThanOrEqual(28);
    expect(pfdDraws).toBeLessThanOrEqual(31);
    // a frozen picture: let the lags settle, then count redraws over 0.5 s (< maxIdle)
    for (let i = 0; i < 600; i++) g.update(s, 1 / 60);
    s.time.utcMs = Math.floor(s.time.utcMs / 1000) * 1000 + 100;
    g.invalidate();
    g.update(s, 1 / 60);
    let frozen = 0;
    for (let i = 0; i < 30; i++) { if (g.update(s, 1 / 60)) frozen++; }
    expect(frozen).toBe(0);
  });

  it('forces a refresh after maxIdleS even when nothing changed', () => {
    const { g } = make({ maxIdleS: 0.5 });
    const s = makeSampleSnapshot();
    for (let i = 0; i < 600; i++) g.update(s, 1 / 60);
    let draws = 0;
    for (let i = 0; i < 60; i++) if (g.update(s, 1 / 60) && g.changed.pfd) draws++;
    expect(draws).toBeGreaterThanOrEqual(1);
  });

  it('draws the PFD content: AFCS modes, frequencies, HSI and softkeys', () => {
    const { g, pfd } = make();
    g.update(makeSampleSnapshot(), 1 / 60);
    const t = texts(pfd);
    for (const s of ['HDG', 'AP', 'GPS', 'TERM', 'NAV1', 'COM1', 'OAT', 'XPDR', 'INSET', 'TMR/REF', 'SAU', 'KSFO', 'DME', 'CRS']) expect(t).toContain(s);
    expect(pfd.texts().join('')).toContain('115.80');
  });

  it('switches the CDI source (GPS → NAV1 → NAV2) and redraws immediately', () => {
    const { g, pfd } = make();
    const s = makeSampleSnapshot();
    g.update(s, 1 / 60);
    expect(g.cdiSource).toBe('GPS');
    expect(g.cycleCdiSource()).toBe('NAV1');
    pfd.clear();
    g.update(s, 0.04);
    expect(g.changed.pfd).toBe(true);
    expect(texts(pfd)).toContain('VOR1');
    g.setCdiSource('NAV2');
    pfd.clear();
    g.update(s, 0.04);
    expect(texts(pfd)).toContain('VOR2');
  });

  it('MFD shows the engine strip, data fields, plan legs, airports and range', () => {
    const { g, mfd } = make();
    g.setNearestAirports([
      { icao: 'KSFO', lat: 37.6188, lon: -122.375, type: 'large' },
      { icao: 'KHAF', lat: 37.5134, lon: -122.501, type: 'small' },
      { icao: 'KZZZ', lat: Number.NaN, lon: 0, type: 'small' },
    ]);
    g.setRange(12);
    expect(g.rangeNm).toBe(10);
    g.update(makeSampleSnapshot(), 1 / 60);
    const t = texts(mfd);
    for (const s of ['RPM', 'FFLOW GPH', 'OIL PRES', 'OIL TEMP', 'EGT °F', 'FUEL QTY GAL', 'GS', 'DTK', 'TRK', 'ETE', 'KHAF', 'SAU', 'NORTH UP', 'ENGINE']) {
      expect(t).toContain(s);
    }
    expect(mfd.texts().join('')).toContain('10NM');
  });

  it('accepts nav-database airports, zooms through the range steps and supports track-up', () => {
    const { g, mfd } = make();
    g.setNearestAirports([{ icao: 'KOAK', position: { lat: 37.7213, lon: -122.2208, alt: 3 }, type: 'medium' }]);
    g.setRange(10);
    g.zoom(1);
    expect(g.rangeNm).toBe(15);
    g.zoom(-1); g.zoom(-1);
    expect(g.rangeNm).toBe(7.5);
    g.setMapOrientation('track-up');
    g.setRange(30); // KOAK is ~12 nm behind-right: off the pane at 7.5 nm in track-up
    const s = makeSampleSnapshot();
    s.plan = null;
    g.update(s, 1 / 60);
    expect(texts(mfd)).toContain('TRACK UP');
    expect(texts(mfd)).toContain('KOAK');
    expect(mfd.balanced).toBe(true);
  });

  it('handles AP off, NAV invalid, plan null and the engine stopped on the ground', () => {
    const { g, pfd, mfd } = make();
    const s = makeSampleSnapshot({ onGround: true, engineRunning: false, iasKt: 0, vsFpm: -300 });
    s.autopilot.engaged = false; s.autopilot.flightDirector = false;
    s.nav1.valid = false; s.plan = null;
    expect(() => g.update(s, 1 / 60)).not.toThrow();
    expect(pfd.balanced && mfd.balanced).toBe(true);
    expect(texts(pfd)).toContain('NO WIND');
  });

  it('a shared model is not stepped by the G1000', () => {
    const model = new InstrumentModel();
    const { g } = make({ model });
    const s = makeSampleSnapshot();
    model.update(s, 1 / 60);
    const before = model.readings.vsiFpm;
    s.aircraft.verticalSpeedMs = 10;
    g.update(s, 1 / 60);
    expect(model.readings.vsiFpm).toBe(before);
  });

  it('scales the design space to the backing store and releases canvases on dispose', () => {
    const { g, pfd } = make({ width: 512, height: 384 });
    g.update(makeSampleSnapshot(), 1 / 60);
    const st = pfd.calls.find((c) => c.name === 'setTransform');
    expect(st?.args.slice(0, 4)).toEqual([0.5, 0, 0, 0.5]);
    g.dispose();
    expect((g.pfdCanvas as CanvasSurface).width).toBe(0);
    expect(g.update(makeSampleSnapshot(), 1)).toBe(false);
  });
});

describe('moving map projection', () => {
  it('north-up: north is up and east is right; the outer ring is the range', () => {
    const v = computeMapView(10, 'north-up', 123, { cx: 0, cy: 0, pxPerNm: 0, ringPx: 0, upDeg: 0, cos: 1, sin: 0 });
    const n = mapToScreen(v, { x: 0, y: 10 }, { x: 0, y: 0 });
    expect(n.x).toBeCloseTo(v.cx, 9);
    expect(n.y).toBeCloseTo(v.cy - v.ringPx, 9);
    const e = mapToScreen(v, { x: 5, y: 0 }, { x: 0, y: 0 });
    expect(e.x).toBeCloseTo(v.cx + v.ringPx / 2, 9);
    expect(v.cy).toBe(MAP.y + MAP.h / 2);
  });

  it('track-up 090: a point east of the aircraft is straight up', () => {
    const v = computeMapView(10, 'track-up', 90, { cx: 0, cy: 0, pxPerNm: 0, ringPx: 0, upDeg: 0, cos: 1, sin: 0 });
    const e = mapToScreen(v, { x: 10, y: 0 }, { x: 0, y: 0 });
    expect(e.x).toBeCloseTo(v.cx, 6);
    expect(e.y).toBeCloseTo(v.cy - v.ringPx, 6);
    expect(formatRange(0.75)).toBe('0.75');
    expect(formatRange(0.30000000000000004)).toBe('0.3');
  });
});

describe('G1000 robustness', () => {
  it('draws the map without throwing when the aircraft position or track is not finite', () => {
    const { g, mfd } = make();
    const s = makeSampleSnapshot();
    s.aircraft.geo.lat = Number.NaN;
    s.aircraft.trackRad = Number.NaN;
    g.setMapOrientation('track-up');
    expect(() => g.update(s, 1 / 60)).not.toThrow();
    expect(mfd.balanced).toBe(true);
  });
});
