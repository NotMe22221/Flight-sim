import { describe, expect, it } from 'vitest';
import { InstrumentModel } from '../readings';
import { MockCanvasFactory, mockCanvas } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import {
  AirspeedIndicator, Altimeter, Ammeter, Annunciators, AttitudeIndicator, ClockOat, EgtGauge, FlapsIndicator, FuelFlowGauge, FuelQuantityGauge,
  type Gauge, HeadingIndicator, ManifoldFuelFlowGauge, OilPressureGauge, OilTemperatureGauge, SuctionGauge, Tachometer, TrimIndicator, TurnCoordinator,
  VerticalSpeedIndicator, WhiskeyCompassGauge,
} from './index';

function allGauges(f: MockCanvasFactory): [string, Gauge][] {
  return [
    ['asi', new AirspeedIndicator(undefined, f)], ['ai', new AttitudeIndicator(f)], ['alt', new Altimeter(f)], ['tc', new TurnCoordinator(f)],
    ['hi', new HeadingIndicator(f)], ['vsi', new VerticalSpeedIndicator(f)], ['tach', new Tachometer(f)], ['ff', new FuelFlowGauge(f)],
    ['mapff', new ManifoldFuelFlowGauge(f)], ['fuelL', new FuelQuantityGauge('left', f)], ['fuelR', new FuelQuantityGauge('right', f)],
    ['oilT', new OilTemperatureGauge(f)], ['oilP', new OilPressureGauge(f)], ['egt', new EgtGauge(f)], ['suction', new SuctionGauge(f)],
    ['amps', new Ammeter(f)], ['compass', new WhiskeyCompassGauge(f)], ['flaps', new FlapsIndicator(undefined, f)], ['trim', new TrimIndicator(f)],
    ['annun', new Annunciators(f)], ['clock', new ClockOat(f)],
  ];
}

describe('steam gauges on a mock canvas', () => {
  it('every gauge draws without throwing, with balanced save/restore, for a sample snapshot', () => {
    const factory = new MockCanvasFactory();
    const model = new InstrumentModel();
    const r = model.update(makeSampleSnapshot(), 1 / 60);
    const { ctx, ctx2d } = mockCanvas();
    for (const [name, g] of allGauges(factory)) {
      ctx.clear();
      expect(() => g.draw(ctx2d, 10, 10, 150, r), name).not.toThrow();
      expect(ctx.balanced, `${name} save/restore`).toBe(true);
      expect(ctx.calls.length, `${name} draws something`).toBeGreaterThan(5);
      g.dispose();
    }
  });

  it('caches the static layer: the second draw at the same size only blits', () => {
    const factory = new MockCanvasFactory();
    const g = new AirspeedIndicator(undefined, factory);
    const r = new InstrumentModel().update(makeSampleSnapshot(), 1 / 60);
    const { ctx, ctx2d } = mockCanvas();
    g.draw(ctx2d, 0, 0, 150, r);
    expect(factory.created.length).toBe(1);
    const layerCalls = factory.created[0].ctx.calls.length;
    expect(layerCalls).toBeGreaterThan(20);
    ctx.clear();
    g.draw(ctx2d, 0, 0, 150, r);
    expect(factory.created[0].ctx.calls.length).toBe(layerCalls); // not repainted
    expect(ctx.count('drawImage')).toBe(1);
    const dynamicCalls = ctx.calls.length;
    // a new size repaints the layer
    g.draw(ctx2d, 0, 0, 200, r);
    expect(factory.created[0].ctx.calls.length).toBeGreaterThan(layerCalls);
    expect(dynamicCalls).toBeLessThan(layerCalls);
  });

  it('falls back to direct painting when no offscreen canvas can be created', () => {
    const failing = { create: (): never => { throw new Error('no canvas'); } };
    const g = new Altimeter(failing);
    const r = new InstrumentModel().update(makeSampleSnapshot(), 1 / 60);
    const { ctx, ctx2d } = mockCanvas();
    expect(() => g.draw(ctx2d, 0, 0, 150, r)).not.toThrow();
    expect(ctx.count('drawImage')).toBe(0);
    expect(ctx.count('arc')).toBeGreaterThan(3);
    expect(ctx.balanced).toBe(true);
  });

  it('shows the Kollsman setting and flags on the altimeter / gyros when unpowered', () => {
    const factory = new MockCanvasFactory();
    const model = new InstrumentModel();
    const snap = makeSampleSnapshot({ engineRunning: false, rpm: 0 });
    snap.aircraft.qnhSetPa = 1003 * 100;
    const r = model.update(snap, 1 / 60);
    const { ctx, ctx2d } = mockCanvas();
    new Altimeter(factory).draw(ctx2d, 0, 0, 150, r);
    expect(ctx.texts()).toContain('1003');
    expect(ctx.texts()).toContain('29.62');
    ctx.clear();
    new AttitudeIndicator(factory).draw(ctx2d, 0, 0, 150, r);
    expect(ctx.texts()).toContain('GYRO');
    ctx.clear();
    new HeadingIndicator(factory).draw(ctx2d, 0, 0, 150, r);
    expect(ctx.texts()).toContain('OFF');
  });
});
