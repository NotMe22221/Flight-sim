import { describe, expect, it } from 'vitest';
import type { TrafficInfo } from '../../core/types';
import { InstrumentModel } from '../readings';
import { Signature } from '../signature';
import { mockCanvas } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { mfdSignature } from './displaySignature';
import { MovingMap } from './map';
import { G } from './palette';

const tgt = (dLatNm: number, relFt: number, s: ReturnType<typeof makeSampleSnapshot>, o: Partial<TrafficInfo> = {}): TrafficInfo => ({
  callsign: 'N1', type: 'Cessna 172', lat: s.aircraft.geo.lat + dLatNm / 60, lon: s.aircraft.geo.lon, altMslM: s.aircraft.altitudeMslM + relFt * 0.3048,
  headingDeg: 0, groundSpeedMs: 45, verticalSpeedMs: 0, onGround: false, leg: 'downwind', ...o,
});

describe('G1000 map traffic', () => {
  it('draws a traffic advisory as an amber circle, proximate traffic filled, distant traffic hollow, with relative altitude', () => {
    const s = makeSampleSnapshot();
    s.aircraft.onGround = false;
    s.traffic = [tgt(1, 300, s), tgt(4, -800, s, { verticalSpeedMs: -4 }), tgt(9, 2000, s)];
    const r = new InstrumentModel().update(s, 1 / 60);
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    new MovingMap().draw(ctx2d, s, r, 10, 'north-up', []);
    const texts = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(expect.arrayContaining(['+03', '-08', '+20']));
    // the TA (1 nm, +300 ft) is an amber filled circle
    expect(ctx.calls.some((c) => c.name === 'arc' && c.args[2] === 7)).toBe(true);
    const fills = ctx.calls.filter((c) => c.name === 'fill').length;
    expect(fills).toBeGreaterThanOrEqual(2); // the TA circle and the proximate diamond
    expect(G.amber).toBeTruthy();
  });

  it('the MFD signature changes when traffic moves (redraw), not when it stays', () => {
    const s = makeSampleSnapshot();
    const r = new InstrumentModel().update(s, 1 / 60);
    const st = { rangeNm: 10, orientation: 'north-up', cdiSource: 'GPS', com1: { activeKHz: 0, standbyKHz: 0 }, com2: { activeKHz: 0, standbyKHz: 0 } } as never;
    const h = new Signature();
    s.traffic = [tgt(3, 0, s)];
    const a = mfdSignature(h, s, r, st, 30, 0);
    expect(mfdSignature(h, s, r, st, 30, 0)).toBe(a);
    s.traffic = [tgt(3.2, 0, s)];
    expect(mfdSignature(h, s, r, st, 30, 0)).not.toBe(a);
  });
});
