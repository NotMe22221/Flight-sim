import { describe, expect, it } from 'vitest';
import {
  type Binding, type BindingProfile, bindingLabel, findConflicts, isActionBinding, mergeProfiles, parseProfile, rebind,
  serializeProfile, triggerKey,
} from './bindings';
import { BINDINGS_STORAGE_KEY, clearBindings, loadBindings, saveBindings, type StorageLike } from './bindingStore';
import { chordLabel, keyLabel, parseChord } from './chord';
import { PROFILE_IDS, defaultProfile } from './profiles';

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  fail = false;
  getItem(k: string): string | null { if (this.fail) throw new Error('blocked'); return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { if (this.fail) throw new Error('quota'); this.map.set(k, v); }
  removeItem(k: string): void { if (this.fail) throw new Error('blocked'); this.map.delete(k); }
}

const actionsOn = (p: BindingProfile, chord: string): string[] => {
  const k = triggerKey({ device: 'keyboard', ...parseChord(chord) });
  return p.bindings.filter((b) => triggerKey(b) === k).map((b) => (isActionBinding(b) ? b.action : `${b.axis}:${b.dir ?? ''}`));
};

const kb = (chord: string, action: 'pause' | 'gearToggle' | 'flapsDown'): Binding => ({ device: 'keyboard', ...parseChord(chord), action });

describe('chords and labels', () => {
  it('parses and labels chords', () => {
    expect(parseChord('Ctrl+Shift+KeyE')).toEqual({ code: 'KeyE', ctrl: true, shift: true });
    expect(chordLabel(parseChord('Ctrl+KeyE'))).toBe('Ctrl+E');
    expect(chordLabel(parseChord('Numpad7'))).toBe('Num 7');
    expect(chordLabel(parseChord('Ctrl+NumpadDecimal'))).toBe('Ctrl+Num Del');
    expect(chordLabel(parseChord('Alt+Shift+F1'))).toBe('Shift+Alt+F1');
    expect(keyLabel('Digit0')).toBe('0');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(() => parseChord('Hyper+KeyA')).toThrow();
  });

  it('labels mouse and gamepad inputs', () => {
    expect(bindingLabel({ device: 'mouse', button: 1 })).toBe('Mouse Middle');
    expect(bindingLabel({ device: 'mouse', wheel: true })).toBe('Mouse Wheel');
    expect(bindingLabel({ device: 'gamepad', button: 0 })).toBe('Pad A');
    expect(bindingLabel({ device: 'gamepad', button: 4 })).toBe('Pad LB');
    expect(bindingLabel({ device: 'gamepad', button: 0, modifierButton: 4 })).toBe('Pad LB+A');
    expect(bindingLabel({ device: 'gamepad', button: 2 }, false)).toBe('Joy 3');
    expect(bindingLabel({ device: 'gamepad', axisIndex: 1 })).toBe('Pad LS Y');
    expect(bindingLabel({ device: 'gamepad', axisIndex: 9, hat: 'up' }, false)).toBe('Joy Hat up');
  });
});

describe('default profiles', () => {
  it('have no internal conflicts (including the merged default)', () => {
    for (const id of PROFILE_IDS) expect(findConflicts(defaultProfile(id).bindings), id).toEqual([]);
  });

  it('default keyboard set merges msfs and laptop (numpad and arrows both work)', () => {
    const d = defaultProfile('default');
    expect(actionsOn(d, 'Numpad8')).toEqual(['pitch:-1']);
    expect(actionsOn(d, 'ArrowUp')).toEqual(['pitch:-1']);
    expect(actionsOn(d, 'Numpad7')).toEqual(['trimNoseDown']);
    expect(actionsOn(d, 'BracketLeft')).toEqual(['trimNoseDown']);
    expect(actionsOn(d, 'Ctrl+KeyE')).toEqual(['engineAutoStart']);
    expect(actionsOn(d, 'KeyE')).toEqual(['yaw:1']);
    expect(actionsOn(d, 'KeyP')).toEqual(['pause']);
    expect(actionsOn(d, 'Period')).toEqual(['brakesHold']);
    // F1 bound in both layers collapses to one binding
    expect(actionsOn(d, 'F1')).toEqual(['throttleCut']);
  });
});

describe('conflicts, merge and rebind', () => {
  it('detects the same chord bound to two targets, not duplicates or different modifiers', () => {
    const c = findConflicts([kb('KeyG', 'gearToggle'), kb('KeyG', 'pause'), kb('KeyG', 'gearToggle'), kb('Ctrl+KeyG', 'pause')]);
    expect(c.length).toBe(2); // gear↔pause twice (two gear duplicates), Ctrl+G is a different chord
    expect(c[0].label).toBe('G');
  });

  it('detects a full gamepad axis overlapping a hat / half-axis binding', () => {
    const c = findConflicts([
      { device: 'gamepad', axisIndex: 9, axis: 'roll' },
      { device: 'gamepad', axisIndex: 9, hat: 'up', action: 'pause' },
    ]);
    expect(c.length).toBe(1);
  });

  it('later profiles override earlier ones on the same input', () => {
    const a: BindingProfile = { version: 1, id: 'a', name: 'a', device: 'keyboard', bindings: [kb('KeyG', 'gearToggle')] };
    const b: BindingProfile = { version: 1, id: 'b', name: 'b', device: 'keyboard', bindings: [kb('KeyG', 'pause')] };
    expect(mergeProfiles('m', 'm', a, b).bindings).toEqual([kb('KeyG', 'pause')]);
  });

  it('rebind replaces the action\'s binding and displaces the previous owner of the input', () => {
    const p = defaultProfile('msfs');
    const r = rebind(p, kb('KeyG', 'pause'));
    expect(r.displaced.map((b) => (isActionBinding(b) ? b.action : ''))).toEqual(['gearToggle']);
    expect(r.replaced.map((b) => bindingLabel(b))).toEqual(['Pause']);
    expect(actionsOn(r.profile, 'KeyG')).toEqual(['pause']);
    expect(actionsOn(r.profile, 'Pause')).toEqual([]);
    expect(findConflicts(r.profile.bindings)).toEqual([]);
  });
});

describe('serialisation and persistence', () => {
  it('round-trips every default profile through JSON', () => {
    for (const id of PROFILE_IDS) {
      const p = defaultProfile(id);
      const back = parseProfile(serializeProfile(p));
      expect(back.errors).toEqual([]);
      expect(back.profile).toEqual(p);
    }
  });

  it('drops invalid bindings with an error but keeps the rest', () => {
    const r = parseProfile({
      version: 1, id: 'x', name: 'x', device: 'keyboard',
      bindings: [{ device: 'keyboard', code: 'KeyG', action: 'gearToggle' }, { device: 'keyboard', code: 'KeyX', action: 'nope' }, { device: 'keyboard', code: 'KeyW', axis: 'pitch' }],
    });
    expect(r.profile?.bindings.length).toBe(1);
    expect(r.errors.length).toBe(2);
    expect(parseProfile('{oops').profile).toBeNull();
    expect(parseProfile({ version: 2, id: 'x', bindings: [] }).profile).toBeNull();
  });

  it('saves, loads and clears via storage; survives blocked or corrupt storage', () => {
    const s = new MemStorage();
    const kbd = rebind(defaultProfile('default'), kb('KeyG', 'pause')).profile;
    expect(saveBindings(s, { version: 1, keyboard: kbd, gamepads: { standard: defaultProfile('gamepad-xbox') } })).toBe(true);
    expect(s.map.has(BINDINGS_STORAGE_KEY)).toBe(true);
    const back = loadBindings(s);
    expect(back.keyboard).toEqual(kbd);
    expect(back.gamepads.standard).toEqual(defaultProfile('gamepad-xbox'));
    clearBindings(s);
    expect(loadBindings(s).keyboard).toBeUndefined();
    s.map.set(BINDINGS_STORAGE_KEY, 'not json');
    const errors: string[] = [];
    expect(loadBindings(s, errors).keyboard).toBeUndefined();
    expect(errors.length).toBe(1);
    s.fail = true;
    expect(saveBindings(s, { version: 1, gamepads: {} })).toBe(false);
    expect(loadBindings(s).gamepads).toEqual({});
    expect(() => clearBindings(s)).not.toThrow();
    expect(loadBindings(null).gamepads).toEqual({});
  });
});
