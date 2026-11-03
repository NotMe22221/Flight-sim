import { beforeEach, describe, expect, it } from 'vitest';
import type { BindableAction } from './actions';
import { KeyboardSource } from './keyboard';
import { defaultProfile } from './profiles';
import { FakeEvent, type FakeDom, makeFakeDom } from './testing/dom';

const DT = 1 / 60;

describe('KeyboardSource', () => {
  let dom: FakeDom;
  let kb: KeyboardSource;
  let now = 0;
  const edges: BindableAction[] = [];
  const held = new Set<BindableAction>();
  const poll = (dt = DT): boolean => {
    edges.length = 0;
    held.clear();
    now += dt;
    return kb.poll(dt, now, (a) => edges.push(a), (a) => held.add(a));
  };

  beforeEach(() => {
    dom = makeFakeDom();
    kb = new KeyboardSource(dom.env.window, dom.env.document, defaultProfile('default').bindings);
    kb.attach();
    now = 0;
  });

  it('fires an edge action exactly once per press (OS repeat ignored)', () => {
    dom.keyDown('F7');
    expect(poll()).toBe(true);
    expect(edges).toEqual(['flapsDown']);
    dom.keyDown('F7', { repeat: true });
    dom.keyDown('F7', { repeat: true });
    for (let i = 0; i < 60; i++) { poll(); expect(edges).toEqual([]); }
    dom.keyUp('F7');
    poll();
    dom.keyDown('F7');
    poll();
    expect(edges).toEqual(['flapsDown']);
  });

  it('reports held actions as levels', () => {
    dom.keyDown('Period');
    poll();
    expect(edges).toEqual(['brakesHold']);
    expect(held.has('brakesHold')).toBe(true);
    poll();
    expect(edges).toEqual([]);
    expect(held.has('brakesHold')).toBe(true);
    dom.keyUp('Period');
    poll(); // released during this interval: still reported once
    poll();
    expect(held.has('brakesHold')).toBe(false);
  });

  it('matches modifiers exactly: Ctrl+E auto-starts, plain E is rudder only', () => {
    dom.keyDown('KeyE', { ctrl: true });
    poll();
    expect(edges).toEqual(['engineAutoStart']);
    expect(kb.direction('yaw')).toBe(0);
    dom.keyUp('KeyE', { ctrl: true });
    poll();
    dom.keyDown('KeyE');
    poll();
    expect(edges).toEqual([]);
    expect(kb.direction('yaw')).toBe(1);
    expect(kb.value('yaw')).toBeGreaterThan(0);
  });

  it('keeps the chord captured at key-down even if modifiers change while held', () => {
    dom.keyDown('KeyE', { ctrl: true });
    poll();
    dom.keyUp('KeyE'); // Ctrl released first
    poll();
    poll();
    expect(kb.isDown('KeyE')).toBe(false);
    expect(kb.direction('yaw')).toBe(0);
  });

  it('falls back to the unmodified axis binding for unbound modifier chords', () => {
    const e = dom.keyDown('ArrowUp', { shift: true });
    poll();
    expect(e.defaultPrevented).toBe(true);
    expect(kb.direction('pitch')).toBe(-1);
  });

  it('prevents default only for bound keys', () => {
    expect(dom.keyDown('KeyG').defaultPrevented).toBe(true);
    expect(dom.keyDown('KeyK').defaultPrevented).toBe(false);
    expect(dom.keyDown('F5').defaultPrevented).toBe(true);
    expect(dom.keyDown('KeyR', { meta: true }).defaultPrevented).toBe(false);
  });

  it('releases every key on window blur and on visibilitychange', () => {
    dom.keyDown('ArrowLeft');
    dom.keyDown('Period');
    dom.keyDown('BracketLeft');
    poll();
    expect(held.size).toBe(2);
    dom.window.dispatchEvent(new FakeEvent('blur'));
    poll();
    expect(held.size).toBe(0);
    expect(kb.direction('roll')).toBe(0);
    for (let i = 0; i < 30; i++) poll();
    expect(kb.value('roll')).toBe(0);
    expect(edges).toEqual([]); // trim repeat stopped

    dom.keyDown('Period');
    poll();
    dom.document.visibilityState = 'hidden';
    dom.document.dispatchEvent(new FakeEvent('visibilitychange'));
    poll();
    expect(held.size).toBe(0);
  });

  it('ignores keys while captured and releases held keys on capture', () => {
    dom.keyDown('Period');
    poll();
    kb.setCaptured(true);
    poll();
    expect(held.size).toBe(0);
    const e = dom.keyDown('KeyG');
    poll();
    expect(edges).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    kb.setCaptured(false);
    dom.keyDown('KeyG');
    poll();
    expect(edges).toEqual(['gearToggle']);
  });

  it('ignores keys typed into text fields', () => {
    const input = dom.document.createElement('input');
    const e = dom.keyDown('KeyG', {}, input);
    poll();
    expect(edges).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('auto-repeats trim at 10 Hz after 300 ms from poll time', () => {
    dom.keyDown('Numpad7');
    let count = 0;
    let t = 0;
    let firstRepeatAt = -1;
    while (t < 0.65 - 1e-9) {
      poll(0.01);
      t += 0.01;
      count += edges.length;
      if (count === 2 && firstRepeatAt < 0) firstRepeatAt = t;
    }
    // edge at 0.01, repeats at 0.31, 0.41, 0.51, 0.61
    expect(count).toBe(5);
    expect(firstRepeatAt).toBeCloseTo(0.31, 6);
  });

  it('a sub-frame tap still moves a ramped axis for one frame', () => {
    dom.tap('ArrowRight');
    poll();
    expect(kb.value('roll')).toBeCloseTo(DT / 0.6, 6);
    poll();
    expect(kb.value('roll')).toBeLessThan(DT / 0.6);
  });

  it('last pressed key wins when both directions are held', () => {
    dom.keyDown('ArrowLeft');
    dom.keyDown('ArrowRight');
    poll();
    expect(kb.direction('roll')).toBe(1);
    dom.keyUp('ArrowRight');
    poll();
    poll();
    expect(kb.direction('roll')).toBe(-1);
  });

  it('pressing Meta (Cmd) releases held keys: macOS drops their keyups while Cmd is down', () => {
    dom.keyDown('ArrowLeft');
    dom.keyDown('Period');
    poll();
    dom.keyDown('MetaLeft', { meta: true });
    poll();
    poll();
    expect(held.size).toBe(0);
    expect(kb.direction('roll')).toBe(0);
    dom.keyDown('ArrowLeft'); // a fresh press works again
    poll();
    expect(kb.direction('roll')).toBe(-1);
  });

  it('focus moving into a text field releases held keys', () => {
    dom.keyDown('ArrowLeft');
    dom.keyDown('Period');
    poll();
    const input = dom.document.createElement('input');
    const f = new FakeEvent('focusin');
    f.target = input;
    dom.document.dispatchEvent(f);
    poll();
    poll();
    expect(held.size).toBe(0);
    expect(kb.direction('roll')).toBe(0);
  });

  it('never prevents browser-essential chords (zoom, reload, close, tabs, devtools)', () => {
    const chords: Array<[string, { ctrl?: boolean; shift?: boolean; alt?: boolean }]> = [
      ['Equal', { ctrl: true }], ['Minus', { ctrl: true }], ['Digit0', { ctrl: true }],
      ['KeyR', { ctrl: true }], ['KeyR', { ctrl: true, shift: true }], ['KeyW', { ctrl: true }],
      ['Tab', { ctrl: true }], ['Digit1', { ctrl: true }], ['KeyI', { ctrl: true, shift: true }],
      ['KeyJ', { ctrl: true, shift: true }], ['KeyP', { ctrl: true }], ['F4', { alt: true }],
    ];
    for (const [code, m] of chords) {
      const e = dom.keyDown(code, m);
      expect(e.defaultPrevented, `${JSON.stringify(m)}+${code}`).toBe(false);
      dom.keyUp(code, m);
    }
  });

  it('an axis key never falls back for a browser chord (WASD flying keeps Ctrl+R / Ctrl+W / Ctrl+S)', () => {
    kb.setBindings([
      { device: 'keyboard', code: 'KeyW', axis: 'pitch', dir: -1 }, { device: 'keyboard', code: 'KeyS', axis: 'pitch', dir: 1 },
      { device: 'keyboard', code: 'KeyR', axis: 'yaw', dir: 1 },
    ]);
    for (const code of ['KeyR', 'KeyW', 'KeyS']) {
      expect(dom.keyDown(code, { ctrl: true }).defaultPrevented, code).toBe(false);
      dom.keyUp(code, { ctrl: true });
    }
    poll();
    expect(kb.direction('pitch')).toBe(0);
    expect(dom.keyDown('KeyW', { shift: true }).defaultPrevented).toBe(true); // Shift+W still pitches
    poll();
    expect(kb.direction('pitch')).toBe(-1);
  });

  it('detach removes every listener', () => {
    kb.detach();
    expect(dom.window.listenerCount()).toBe(0);
    expect(dom.document.listenerCount()).toBe(0);
  });
});
