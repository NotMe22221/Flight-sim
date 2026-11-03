import { beforeEach, describe, expect, it } from 'vitest';
import type { BindableAction } from './actions';
import { makeShaping } from './shaping';
import { TouchControls, stickFromDrag } from './touch';
import { type FakeDom, type FakeElement, makeFakeDom } from './testing/dom';

describe('stickFromDrag', () => {
  it('maps thumb offset to a radial, shaped stick (down = nose up)', () => {
    const s = makeShaping({ deadzone: 0.08, curve: 0, saturation: 1 });
    const out: [number, number] = [0, 0];
    expect(stickFromDrag(5, 5, 120, s, out)).toEqual([0, 0]);
    stickFromDrag(0, 240, 120, s, out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    stickFromDrag(-300, 0, 120, s, out);
    expect(out[0]).toBe(-1);
  });
});

describe('TouchControls', () => {
  let dom: FakeDom;
  let touch: TouchControls;
  const edges: BindableAction[] = [];
  const held = new Set<BindableAction>();
  let now = 0;
  const poll = (): boolean => { edges.length = 0; held.clear(); now += 1 / 60; return touch.poll(1 / 60, now, (a) => edges.push(a), (a) => held.add(a)); };
  const find = (role: string): FakeElement[] => dom.document.body.findAll((e) => e.dataset.input === role);

  beforeEach(() => {
    dom = makeFakeDom();
    touch = new TouchControls({ stickShaping: makeShaping({ deadzone: 0, curve: 0, saturation: 1 }) });
    touch.enable(dom.env.document.body);
  });

  it('creates the overlay once and removes it with all listeners on disable', () => {
    touch.enable(dom.env.document.body);
    expect(find('touch-root').length).toBe(1);
    expect(find('touch-button').length).toBe(6);
    const zone = find('stick-zone')[0];
    touch.disable();
    expect(find('touch-root').length).toBe(0);
    expect(zone.listenerCount()).toBe(0);
    expect(touch.enabled).toBe(false);
  });

  it('virtual stick appears under the thumb and drives pitch/roll', () => {
    const zone = find('stick-zone')[0];
    zone.rect = { left: 0, top: 200, width: 360, height: 400 };
    dom.pointer('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 400 }, zone);
    expect(zone.pointerCaptures.has(7)).toBe(true);
    dom.pointer('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 160, clientY: 460 }, zone);
    expect(poll()).toBe(true);
    expect(touch.stickX).toBeCloseTo(0.5, 6);
    expect(touch.stickY).toBeCloseTo(0.5, 6); // thumb pulled down = nose up
    dom.pointer('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 160, clientY: 520 }, zone);
    poll();
    expect(Math.hypot(touch.stickX, touch.stickY)).toBeCloseTo(1, 6); // clamped to the circle
    expect(touch.stickLastChange).toBe(now);
    dom.pointer('pointerup', { pointerId: 7, pointerType: 'touch' }, zone);
    poll();
    expect(touch.stickX).toBe(0);
    expect(touch.stickY).toBe(0);
  });

  it('throttle slider is sticky and maps top = full', () => {
    const track = find('throttle-track')[0];
    track.rect = { left: 700, top: 100, width: 56, height: 200 };
    dom.pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 720, clientY: 150 }, track);
    dom.pointer('pointerup', { pointerId: 3, pointerType: 'touch' }, track);
    poll();
    expect(touch.throttle).toBeCloseTo(0.75, 6);
    expect(touch.throttleLastChange).toBe(now);
    touch.syncThrottle(0.2);
    expect(touch.throttle).toBe(0.2);
  });

  it('buttons fire actions; brakes are held while touched', () => {
    const btns = find('touch-button');
    const gear = btns.find((b) => b.dataset.action === 'gearToggle') as FakeElement;
    const brake = btns.find((b) => b.dataset.action === 'brakesHold') as FakeElement;
    dom.pointer('pointerdown', { pointerId: 1, pointerType: 'touch' }, gear);
    dom.pointer('pointerup', { pointerId: 1, pointerType: 'touch' }, gear);
    poll();
    expect(edges).toEqual(['gearToggle']);
    dom.pointer('pointerdown', { pointerId: 2, pointerType: 'touch' }, brake);
    poll();
    poll();
    expect(held.has('brakesHold')).toBe(true);
    dom.pointer('pointercancel', { pointerId: 2, pointerType: 'touch' }, brake);
    poll();
    poll();
    expect(held.has('brakesHold')).toBe(false);
  });
});
