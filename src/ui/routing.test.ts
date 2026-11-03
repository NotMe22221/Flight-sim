import { describe, expect, it } from 'vitest';
import { EscapeDeduper, ScreenRouter, isTextEntry, shouldCaptureInput } from './routing';

describe('ScreenRouter', () => {
  it('pushes menus and pops them with back()', () => {
    const r = new ScreenRouter('main');
    expect(r.navigate('worldmap')).toBe(true);
    expect(r.navigate('aircraft')).toBe(true);
    expect(r.current).toBe('aircraft');
    expect(r.previous).toBe('worldmap');
    expect(r.back(false)).toBe('worldmap');
    expect(r.back(false)).toBe('main');
    expect(r.back(false)).toBeNull();
    expect(r.current).toBe('main');
  });

  it('ignores navigation to the current screen', () => {
    const r = new ScreenRouter('main');
    expect(r.navigate('main')).toBe(false);
    expect(r.depth).toBe(1);
  });

  it('roots reset the history', () => {
    const r = new ScreenRouter('main');
    r.navigate('worldmap'); r.navigate('weather');
    r.navigate('flight');
    expect(r.depth).toBe(1);
    expect(r.back(true)).toBeNull();
    r.navigate('settings');
    expect(r.back(true)).toBe('flight');
  });

  it('unwinds to a screen already in the stack instead of looping', () => {
    const r = new ScreenRouter('main');
    r.navigate('worldmap'); r.navigate('weather'); r.navigate('aircraft');
    r.navigate('worldmap');
    expect(r.save()).toEqual(['main', 'worldmap']);
  });

  it('back from the main menu resumes a loaded flight', () => {
    const r = new ScreenRouter('main');
    expect(r.back(true)).toBe('flight');
    expect(r.current).toBe('flight');
  });

  it('a non-main root menu falls back to main or the flight', () => {
    const r = new ScreenRouter('main');
    r.restore(['settings']);
    expect(r.back(false)).toBe('main');
    r.restore(['settings']);
    expect(r.back(true)).toBe('flight');
  });

  it('never goes back from loading', () => {
    const r = new ScreenRouter();
    expect(r.current).toBe('loading');
    expect(r.back(true)).toBeNull();
  });

  it('save/restore round-trips and an empty restore falls back to main', () => {
    const r = new ScreenRouter('main');
    r.navigate('activities');
    const saved = r.save();
    r.navigate('loading');
    r.restore(saved);
    expect(r.current).toBe('activities');
    r.restore([]);
    expect(r.current).toBe('main');
  });
});

describe('EscapeDeduper', () => {
  it('swallows exactly one toggleMenu echo per handled key inside the window', () => {
    const d = new EscapeDeduper(500);
    d.noteKey(1000);
    expect(d.isEcho(1016)).toBe(true);
    expect(d.isEcho(1032)).toBe(false); // a second action is a real gamepad press
  });

  it('counts several quick presses', () => {
    const d = new EscapeDeduper(500);
    d.noteKey(0); d.noteKey(100);
    expect(d.isEcho(150)).toBe(true);
    expect(d.isEcho(160)).toBe(true);
    expect(d.isEcho(170)).toBe(false);
  });

  it('expires stale keys (the echo never came because the keyboard was captured)', () => {
    const d = new EscapeDeduper(500);
    d.noteKey(0);
    expect(d.isEcho(2000)).toBe(false);
    d.noteKey(3000);
    expect(d.isEcho(3100)).toBe(true);
  });
});

describe('capture rules', () => {
  it('captures in menus, overlays and text fields only', () => {
    expect(shouldCaptureInput({ route: 'main', overlayOpen: false, textFocus: false })).toBe(true);
    expect(shouldCaptureInput({ route: 'flight', overlayOpen: false, textFocus: false })).toBe(false);
    expect(shouldCaptureInput({ route: 'flight', overlayOpen: true, textFocus: false })).toBe(true);
    expect(shouldCaptureInput({ route: 'flight', overlayOpen: false, textFocus: true })).toBe(true);
  });

  it('recognises text entry elements without a DOM', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextEntry({ tagName: 'input', type: 'number' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('releasesFocusAfter (in-flight controls hand the keyboard back to the simulator)', () => {
  it('releases buttons, sliders, switches and checklist rows after a pointer click', async () => {
    const { releasesFocusAfter } = await import('./routing');
    const el = (tagName: string, type?: string, role?: string) => ({ tagName, type, getAttribute: (n: string) => (n === 'role' ? role ?? null : null) });
    expect(releasesFocusAfter(el('BUTTON'), 'click')).toBe(true);
    expect(releasesFocusAfter(el('INPUT', 'range'), 'click')).toBe(true);
    expect(releasesFocusAfter(el('INPUT', 'checkbox'), 'click')).toBe(true);
    expect(releasesFocusAfter(el('DIV', undefined, 'checkbox'), 'click')).toBe(true);
    expect(releasesFocusAfter(el('DIV', undefined, 'switch'), 'click')).toBe(true);
  });
  it('keeps text fields and an opening dropdown focused on click, releases them once a value is committed', async () => {
    const { releasesFocusAfter } = await import('./routing');
    const el = (tagName: string, type?: string) => ({ tagName, type, getAttribute: () => null });
    expect(releasesFocusAfter(el('INPUT', 'number'), 'click')).toBe(false);
    expect(releasesFocusAfter(el('INPUT', 'search'), 'click')).toBe(false);
    expect(releasesFocusAfter(el('SELECT'), 'click')).toBe(false);
    expect(releasesFocusAfter(el('SELECT'), 'change')).toBe(true);
    expect(releasesFocusAfter(el('INPUT', 'range'), 'change')).toBe(true);
    expect(releasesFocusAfter(el('INPUT', 'number'), 'change')).toBe(true);
    expect(releasesFocusAfter(el('DIV'), 'click')).toBe(false);
    expect(releasesFocusAfter(null, 'click')).toBe(false);
  });
});
