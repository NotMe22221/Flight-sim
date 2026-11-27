import { describe, expect, it } from 'vitest';
import { A320 } from '../../fdm/aircraft/a320';
import { KT } from '../../core/units';
import { MockCanvasFactory, type MockContext2D } from '../testing/mockCanvas';
import { makeFlightPlan, makeSampleSnapshot } from '../testing/sampleSnapshot';
import { AIRLINER_H, AIRLINER_W, AirlinerDisplays } from './AirlinerDisplays';

function rig() {
  const f = new MockCanvasFactory();
  const d = new AirlinerDisplays(A320, f);
  const ctx = (d.canvas as unknown as { ctx: MockContext2D }).ctx;
  return { d, ctx };
}

describe('airliner displays (PFD / ND / E-WD / FCU)', () => {
  it('draws all four parts balanced, with the FCU targets, the FMA and the engine readouts', () => {
    const { d, ctx } = rig();
    expect([d.canvas.width, d.canvas.height]).toEqual([AIRLINER_W, AIRLINER_H]);
    const snap = makeSampleSnapshot({ iasKt: 250, altFt: 10_000 });
    snap.autopilot.iasTargetMs = 250 * KT;
    snap.aircraft.engine.n1 = 82;
    snap.plan = makeFlightPlan();
    d.update(snap, 1 / 30, { athrEngaged: true, athrMode: 'SPEED', athrLever: 0.7 });
    d.draw(snap);
    expect(ctx.balanced).toBe(true);
    const t = ctx.texts();
    // FCU windows and buttons
    expect(t).toContain('SPD'); expect(t).toContain('250'); expect(t).toContain('AP1'); expect(t).toContain('A/THR');
    // FMA: A/THR SPEED, ALT, HDG, armed NAV
    expect(t).toContain('SPEED'); expect(t).toContain('ALT'); expect(t).toContain('HDG'); expect(t).toContain('NAV');
    // E/WD: N1 in percent and the gear memo; ND: the TO waypoint
    expect(t).toContain('82.0');
    expect(t.some((s) => s.startsWith('LDG GEAR'))).toBe(true);
    expect(t).toContain('SAU');
  });

  it('redraws at about 15 Hz, not every frame', () => {
    const { d } = rig();
    const snap = makeSampleSnapshot();
    let n = 0;
    for (let i = 0; i < 60; i++) if (d.update(snap, 1 / 60)) n++;
    expect(n).toBeGreaterThanOrEqual(13); expect(n).toBeLessThanOrEqual(16);
  });

  it('survives a cold aircraft on the ground with no plan or nav signal', () => {
    const { d, ctx } = rig();
    const snap = makeSampleSnapshot({ onGround: true, engineRunning: false, iasKt: 0, altFt: 13 });
    snap.plan = null; snap.nav1.valid = false;
    snap.autopilot.engaged = false; snap.autopilot.flightDirector = false;
    d.reset(snap);
    expect(ctx.balanced).toBe(true);
    expect(ctx.texts()).toContain('ENG SHUT DOWN');
  });
});
