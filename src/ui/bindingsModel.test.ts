import { describe, expect, it } from 'vitest';
import type { BindingInfo } from './UiHost';
import { BINDING_PROFILES, bindingConflicts, bindingGroups, bindingMatches, conflictCount } from './bindingsModel';

const rows: BindingInfo[] = [
  { action: 'engineAutoStart', label: 'Ctrl+E', device: 'keyboard', group: 'Engine' },
  { action: 'flapsDown', label: 'F7', device: 'keyboard', group: 'Flight controls' },
  { action: 'flapsUp', label: 'F6', device: 'keyboard', group: 'Flight controls' },
  { action: 'gearToggle', label: 'f7', device: 'keyboard', group: 'Flight controls' }, // conflicts with flapsDown
  { action: 'pause', label: 'Pad Start', device: 'gamepad', group: 'Interface' },
  { action: 'toggleMenu', label: 'Pad Start', device: 'gamepad', group: 'Interface' }, // conflicts with pause
  { action: 'screenshot', label: '', device: 'none', group: 'Interface' },
  { action: 'slewToggle', label: '', device: 'none', group: 'Interface' }, // two unbound rows never conflict
];

describe('bindingConflicts', () => {
  it('pairs actions sharing a label on the same device (case-insensitive)', () => {
    const c = bindingConflicts(rows);
    expect(c.get('flapsDown')).toEqual(['gearToggle']);
    expect(c.get('gearToggle')).toEqual(['flapsDown']);
    expect(c.get('pause')).toEqual(['toggleMenu']);
    expect(c.has('screenshot')).toBe(false);
    expect(conflictCount(rows)).toBe(4);
  });
  it('does not flag the same label on different devices', () => {
    const r: BindingInfo[] = [
      { action: 'pause', label: 'P', device: 'keyboard', group: 'x' },
      { action: 'toggleMenu', label: 'P', device: 'gamepad', group: 'x' },
    ];
    expect(bindingConflicts(r).size).toBe(0);
  });
});

describe('bindingGroups', () => {
  it('groups pilot-first (flight controls before engine before interface) with titles and flags', () => {
    const g = bindingGroups(rows);
    expect(g.map((x) => x.group)).toEqual(['Flight controls', 'Engine', 'Interface']);
    expect(g[1].rows[0].title).toBe('Engine auto start');
    const unbound = g[2].rows.find((r) => r.info.action === 'screenshot')!;
    expect(unbound.unbound).toBe(true);
    expect(g[0].rows.find((r) => r.info.action === 'gearToggle')!.conflictWith).toEqual(['flapsDown']);
  });
  it('puts unknown groups after the known ones, in first-appearance order', () => {
    const r: BindingInfo[] = [
      { action: 'pause', label: 'P', device: 'keyboard', group: 'Zeta' },
      { action: 'toggleMenu', label: 'Esc', device: 'keyboard', group: 'Interface' },
      { action: 'screenshot', label: 'F12', device: 'keyboard', group: 'Alpha' },
      { action: 'flapsUp', label: 'F6', device: 'keyboard', group: 'Flight controls' },
    ];
    expect(bindingGroups(r).map((x) => x.group)).toEqual(['Flight controls', 'Interface', 'Zeta', 'Alpha']);
  });
  it('filters by text and device', () => {
    expect(bindingGroups(rows, 'flaps').flatMap((x) => x.rows.map((r) => r.info.action))).toEqual(['flapsDown', 'flapsUp']);
    expect(bindingGroups(rows, 'ctrl+e')[0].rows[0].info.action).toBe('engineAutoStart');
    expect(bindingGroups(rows, 'engine').length).toBe(1);
    const pad = bindingGroups(rows, '', 'gamepad').flatMap((x) => x.rows.map((r) => r.info.action));
    expect(pad).toEqual(['pause', 'toggleMenu', 'screenshot', 'slewToggle']); // unbound rows stay visible
  });
  it('matches on the raw action id too', () => {
    expect(bindingMatches(rows[0], 'autostart')).toBe(true);
    expect(bindingMatches(rows[0], '')).toBe(true);
    expect(bindingMatches(rows[0], 'zzz')).toBe(false);
  });
});

describe('profiles', () => {
  it('lists every profile the host can reset to', () => {
    expect(BINDING_PROFILES.map((p) => p.id)).toEqual(['msfs', 'laptop', 'gamepad-xbox', 'joystick-generic']);
  });
});

describe('humanizeAction (titles in the help sheet and Settings › Controls)', () => {
  it('keeps acronyms upper case, including in the first word', async () => {
    const { humanizeAction } = await import('./dom');
    expect(humanizeAction('apToggle')).toBe('AP toggle');
    expect(humanizeAction('fdToggle')).toBe('FD toggle');
    expect(humanizeAction('apHdg')).toBe('AP HDG');
    expect(humanizeAction('apAltInc')).toBe('AP ALT inc');
    expect(humanizeAction('nav1Swap')).toBe('NAV 1 swap');
    expect(humanizeAction('com1Swap')).toBe('COM 1 swap');
    expect(humanizeAction('atcOption1')).toBe('ATC option 1');
    expect(humanizeAction('altimeterStd')).toBe('Altimeter STD');
    expect(humanizeAction('engineAutoStart')).toBe('Engine auto start');
    expect(humanizeAction('toggleHud')).toBe('Toggle HUD');
  });
});
