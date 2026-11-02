import { describe, expect, it } from 'vitest';
import { ASSIST_ITEMS, activeAssistCount, assistBadges, assistPreset, detectAssistLevel } from './assistPresets';

describe('assist presets', () => {
  it('All assists: every helper on, no damage, no drift', () => {
    const a = assistPreset('all');
    expect(a.autoRudder).toBe(true);
    expect(a.assistedTakeoff).toBe(true);
    expect(a.assistedLanding).toBe(true);
    expect(a.autoMixture).toBe(true);
    expect(a.unlimitedFuel).toBe(true);
    expect(a.landingPathHints).toBe(true);
    expect(a.taxiRibbon).toBe(true);
    expect(a.routeRibbon).toBe(true);
    expect(a.crashDamage).toBe(false);
    expect(a.stressDamage).toBe(false);
    expect(a.gyroDrift).toBe(false);
  });
  it('Middle ground: auto-rudder and nav aids on, takeoff/landing manual, no damage', () => {
    const a = assistPreset('middle');
    expect(a.autoRudder).toBe(true);
    expect(a.assistedTakeoff).toBe(false);
    expect(a.assistedLanding).toBe(false);
    expect(a.unlimitedFuel).toBe(false);
    expect(a.landingPathHints).toBe(true);
    expect(a.taxiRibbon).toBe(true);
    expect(a.routeRibbon).toBe(true);
    expect(a.crashDamage).toBe(false);
    expect(a.gyroDrift).toBe(false);
  });
  it('True to life: everything off, damage and drift on', () => {
    const a = assistPreset('true-to-life');
    for (const it of ASSIST_ITEMS) {
      const realism = it.key === 'crashDamage' || it.key === 'stressDamage' || it.key === 'gyroDrift';
      expect(a[it.key]).toBe(realism);
    }
  });
  it('detects the level from the flags and reports custom otherwise', () => {
    expect(detectAssistLevel(assistPreset('all'))).toBe('all');
    expect(detectAssistLevel(assistPreset('middle'))).toBe('middle');
    expect(detectAssistLevel(assistPreset('true-to-life'))).toBe('true-to-life');
    expect(detectAssistLevel({ ...assistPreset('middle'), autoRudder: false })).toBe('custom');
  });
  it('counts and badges helpers only', () => {
    expect(activeAssistCount(assistPreset('true-to-life'))).toBe(0);
    expect(activeAssistCount(assistPreset('all'))).toBe(8);
    expect(assistBadges(assistPreset('middle'))).toEqual(['AUTO-RUDDER', 'AUTO-MIX', 'LDG PATH', 'TAXI', 'ROUTE']);
  });
  it('every option key has metadata', () => {
    const keys = Object.keys(assistPreset('all')).sort();
    expect(ASSIST_ITEMS.map((i) => i.key).sort()).toEqual(keys);
  });
});
