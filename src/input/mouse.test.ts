import { beforeEach, describe, expect, it } from 'vitest';
import type { BindableAction } from './actions';
import { MouseSource, type MouseOptions } from './mouse';
import { defaultProfile } from './profiles';
import { boxDeadzone } from './shaping';
import { type FakeDom, makeFakeDom } from './testing/dom';

describe('mouse-yoke mapping', () => {
  it('box deadzone: zero inside the box, linear outside, full at the radius, sensitivity shrinks the radius', () => {
    expect(boxDeadzone(0, 12, 250, 1)).toBe(0);
    expect(boxDeadzone(12, 12, 250, 1)).toBe(0);
    expect(boxDeadzone(-11, 12, 250, 1)).toBe(0);
    expect(boxDeadzone(131, 12, 250, 1)).toBeCloseTo(0.5, 6);
    expect(boxDeadzone(250, 12, 250, 1)).toBe(1);
    expect(boxDeadzone(-400, 12, 250, 1)).toBe(-1);
    expect(boxDeadzone(131, 12, 250, 2)).toBe(1);
    expect(boxDeadzone(71.5, 12, 250, 2)).toBeCloseTo(0.5, 6);
  });
});

describe('MouseSource', () => {
  let dom: FakeDom;
  let mouse: MouseSource;
  const look: [number, number] = [0, 0];
  const edges: BindableAction[] = [];
  let now = 0;
  const poll = (): number => { edges.length = 0; now += 1 / 60; return mouse.poll(1 / 60, now, look, (a) => edges.push(a), () => undefined); };
  const make = (o: Partial<MouseOptions> = {}): void => {
    mouse?.detach();
    mouse = new MouseSource(dom.env.canvas, dom.env.document, defaultProfile('default').bindings, { yokeCurve: 0, ...o });
    mouse.attach();
  };
  // canvas is 800×600 at (0,0): centre (400, 300)
  const move = (x: number, y: number): void => { dom.pointer('pointermove', { clientX: x, clientY: y }); };

  beforeEach(() => { dom = makeFakeDom(); make(); });

  it('maps cursor offset from the centre to roll/pitch with a deadzone box', () => {
    mouse.setYoke(true);
    move(400, 300); // engage at centre
    expect(mouse.indicator.engaged).toBe(true);
    move(405, 290);
    expect(mouse.indicator.x).toBe(0);
    expect(mouse.indicator.y).toBe(0);
    move(400 + 131, 300 + 250); // right half deflection, cursor below centre = nose up
    expect(mouse.indicator.x).toBeCloseTo(0.5, 6);
    expect(mouse.indicator.y).toBe(1);
    move(0, 300);
    expect(mouse.indicator.x).toBe(-1);
    expect(mouse.indicator.offsetX).toBe(-400);
    expect(mouse.indicator.centerX).toBe(400);
  });

  it('sensitivity and pitch inversion', () => {
    make({ yokeSensitivity: 2, yokeInvertPitch: true });
    mouse.setYoke(true);
    move(400, 300);
    move(400 + 71.5, 300 + 131);
    expect(mouse.indicator.x).toBeCloseTo(0.5, 6);
    expect(mouse.indicator.y).toBe(-1);
  });

  it('does not engage until the cursor visits the centre box', () => {
    mouse.setYoke(true);
    move(700, 100);
    expect(mouse.indicator.engaged).toBe(false);
    expect(mouse.indicator.x).toBe(0);
    move(401, 299);
    move(700, 300);
    expect(mouse.indicator.x).toBe(1);
  });

  it('right-drag produces free-look deltas and suppresses the context menu', () => {
    dom.pointer('pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    expect(dom.canvas.pointerCaptures.size).toBe(1);
    dom.pointer('pointermove', { buttons: 2, clientX: 110, clientY: 95 });
    dom.pointer('pointermove', { buttons: 2, clientX: 130, clientY: 90 });
    poll();
    expect(look).toEqual([30, -10]);
    poll();
    expect(look).toEqual([0, 0]);
    dom.pointer('pointerup', { button: 2, buttons: 0, clientX: 130, clientY: 90 });
    dom.pointer('pointermove', { buttons: 0, clientX: 200, clientY: 200 });
    poll();
    expect(look).toEqual([0, 0]);
    const ctx = dom.pointer('contextmenu');
    expect(ctx.defaultPrevented).toBe(true);
  });

  it('pointer-lock free-look uses movement deltas until the lock is lost', () => {
    mouse.setFreeLook(true);
    expect(dom.document.pointerLockElement).toBe(dom.canvas);
    dom.pointer('pointermove', { movementX: 7, movementY: 3 });
    poll();
    expect(look).toEqual([7, 3]);
    dom.document.exitPointerLock(); // Esc
    expect(mouse.freeLookLocked).toBe(false);
    dom.pointer('pointermove', { movementX: 7, movementY: 3, clientX: 0, clientY: 0 });
    poll();
    expect(look).toEqual([0, 0]);
  });

  it('wheel: notches (zoom-in positive) and zoom actions; middle button resets the view', () => {
    const w = dom.wheel(-100);
    expect(w.defaultPrevented).toBe(true);
    dom.wheel(-100);
    expect(poll()).toBeCloseTo(2, 6);
    expect(edges).toEqual(['zoomIn', 'zoomIn']);
    dom.wheel(3, 1); // one line-mode notch down
    expect(poll()).toBeCloseTo(-1, 6);
    expect(edges).toEqual(['zoomOut']);
    dom.pointer('pointerdown', { button: 1, buttons: 4 });
    poll();
    expect(edges).toEqual(['cameraReset']);
  });

  it('ignores touch pointers and detaches cleanly', () => {
    dom.pointer('pointerdown', { button: 2, buttons: 2, pointerType: 'touch' });
    dom.pointer('pointermove', { buttons: 2, clientX: 50, pointerType: 'touch' });
    poll();
    expect(look).toEqual([0, 0]);
    mouse.detach();
    expect(dom.canvas.listenerCount()).toBe(0);
    expect(dom.document.listenerCount()).toBe(0);
  });
});
