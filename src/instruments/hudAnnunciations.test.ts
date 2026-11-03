import { describe, expect, it } from 'vitest';
import { Hud } from './Hud';
import { MockCanvas, MockCanvasFactory } from './testing/mockCanvas';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

function make() {
  const factory = new MockCanvasFactory();
  const hud = new Hud({ createCanvas: (w, h) => factory.create(w, h) });
  hud.resize(1280, 720, 1);
  const ctx = (hud.canvas as unknown as MockCanvas).ctx;
  return { hud, ctx };
}
const external = () => { const s = makeSampleSnapshot(); s.camera.mode = 'chase'; return s; };
/** Texts drawn by the last redraw (the mock records every call since construction). */
const lastTexts = (ctx: MockCanvas['ctx']): string[] => {
  const calls = ctx.calls;
  let start = 0;
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].name === 'clearRect') { start = i; break; }
  return calls.slice(start).filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
};

describe('HUD autopilot annunciations', () => {
  it('shows LVL in both mode fields while the LVL recovery is active', () => {
    const { hud, ctx } = make();
    const s = external();
    s.autopilot.engaged = true; s.autopilot.lvl = true; s.autopilot.lateral = 'ROL'; s.autopilot.vertical = 'VS';
    hud.update(s, 1 / 60);
    const t = lastTexts(ctx);
    expect(t.filter((x) => x === 'LVL').length).toBe(2);
    expect(t).not.toContain('ROL');
  });

  it('flashes a red AP after the autopilot lets go, never for a disconnect seen at start-up, and stops after 5 s', () => {
    const { hud, ctx } = make();
    const s = external();
    s.autopilot.engaged = false; s.autopilot.flightDirector = false;
    s.autopilot.disconnectT = 3; s.autopilot.disconnectReason = 'stall';
    hud.update(s, 1 / 60); // first look: an old disconnect does not flash
    expect(lastTexts(ctx)).not.toContain('AP');
    s.autopilot.disconnectT = 12;
    // step through a blink period: the flash shows 'AP' in red on the 'on' phase
    let sawRed = false;
    for (let i = 0; i < 40; i++) {
      hud.update(s, 1 / 30);
      const fills = ctx.calls.filter((c) => c.name === 'fillText' && c.args[0] === 'AP');
      if (fills.length) sawRed = true;
    }
    expect(sawRed).toBe(true);
    for (let i = 0; i < 200; i++) hud.update(s, 1 / 30); // > 5 s later
    expect(lastTexts(ctx)).not.toContain('AP');
  });

  it('marks the altitude alerter on the altitude block while approaching the selected altitude', () => {
    const { hud, ctx } = make();
    const s = external();
    s.autopilot.altAlert = 'approach';
    let highlighted = false;
    for (let i = 0; i < 40 && !highlighted; i++) {
      hud.update(s, 1 / 30);
      highlighted = lastTexts(ctx).filter((x) => x === 'ALT').length >= 2; // block label + alert tag
    }
    expect(highlighted).toBe(true);
  });

  it('leaves PAUSED / SLEW to the UI when its status line is off', () => {
    const { hud, ctx } = make();
    const s = external();
    s.paused = true;
    hud.update(s, 1 / 60);
    expect(lastTexts(ctx)).toContain('PAUSED');
    hud.showStatus = false;
    hud.invalidate();
    hud.update(s, 1 / 60);
    expect(lastTexts(ctx)).not.toContain('PAUSED');
  });
});
