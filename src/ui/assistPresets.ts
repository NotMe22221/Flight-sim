/**
 * MSFS assistance presets → per-item flags (doc 01 §1.2). The settings UI always shows
 * the effective per-item state, because re-selecting a preset silently re-enables items.
 */
import type { AssistLevel, AssistanceOptions } from '../core/types';

export type AssistKey = keyof AssistanceOptions;

export interface AssistItemMeta { key: AssistKey; label: string; category: 'Piloting' | 'Aircraft systems' | 'Failure & damage' | 'Navigation aids'; help: string }

export const ASSIST_ITEMS: AssistItemMeta[] = [
  { key: 'autoRudder', label: 'Auto-rudder', category: 'Piloting', help: 'Couples rudder to ailerons and cancels P-factor/crosswind yaw on takeoff and landing.' },
  { key: 'assistedTakeoff', label: 'Assisted takeoff', category: 'Piloting', help: 'Keeps the take-off roll on the runway heading (rudder and nose wheel); you rotate and climb.' },
  { key: 'antiStall', label: 'Anti-stall protection', category: 'Piloting', help: 'Fades out nose-up input as the wing nears the stall.' },
  { key: 'assistedLanding', label: 'Assisted landing', category: 'Piloting', help: 'Holds glideslope and speed on final and flares below 50 ft.' },
  { key: 'autoMixture', label: 'Auto mixture', category: 'Aircraft systems', help: 'Leans the mixture automatically with altitude.' },
  { key: 'unlimitedFuel', label: 'Unlimited fuel', category: 'Aircraft systems', help: 'Fuel never runs out.' },
  { key: 'gyroDrift', label: 'Gyro drift', category: 'Aircraft systems', help: 'The heading indicator precesses and must be realigned with the compass.' },
  { key: 'crashDamage', label: 'Crash damage', category: 'Failure & damage', help: 'A crash ends the flight instead of being ignored.' },
  { key: 'stressDamage', label: 'Aircraft stress damage', category: 'Failure & damage', help: 'Exceeding Vne or the G limits damages the aircraft.' },
  { key: 'landingPathHints', label: 'Landing path', category: 'Navigation aids', help: 'Floating gates on final with the target speed.' },
  { key: 'taxiRibbon', label: 'Taxi ribbon', category: 'Navigation aids', help: 'Blue ribbon to the assigned runway.' },
  { key: 'routeRibbon', label: 'Route & waypoints', category: 'Navigation aids', help: '3D route ribbon and waypoint markers.' },
];

/** Keys where `true` means *more* help (shown as "assist on"); damage/drift are realism flags. */
export const REALISM_KEYS: ReadonlySet<AssistKey> = new Set<AssistKey>(['crashDamage', 'stressDamage', 'gyroDrift']);

export const ASSIST_LEVELS: { id: AssistLevel; label: string; help: string }[] = [
  { id: 'all', label: 'All assists', help: 'Every helper on, no damage, no gyro drift.' },
  { id: 'middle', label: 'Middle ground', help: 'Auto-rudder and navigation aids on; you fly the takeoff and landing; no damage.' },
  { id: 'true-to-life', label: 'True to life', help: 'No helpers, crash and stress damage on, gyro drift on.' },
];

export function assistPreset(level: AssistLevel): AssistanceOptions {
  switch (level) {
    case 'all':
      return {
        autoRudder: true, assistedTakeoff: true, assistedLanding: true, autoMixture: true, unlimitedFuel: true,
        crashDamage: false, stressDamage: false, gyroDrift: false,
        landingPathHints: true, taxiRibbon: true, routeRibbon: true, antiStall: true,
      };
    case 'middle':
      return {
        autoRudder: true, assistedTakeoff: false, assistedLanding: false, autoMixture: true, unlimitedFuel: false,
        crashDamage: false, stressDamage: false, gyroDrift: false,
        landingPathHints: true, taxiRibbon: true, routeRibbon: true, antiStall: false,
      };
    case 'true-to-life':
      return {
        autoRudder: false, assistedTakeoff: false, assistedLanding: false, autoMixture: false, unlimitedFuel: false,
        crashDamage: true, stressDamage: true, gyroDrift: true,
        landingPathHints: false, taxiRibbon: false, routeRibbon: false, antiStall: false,
      };
  }
}

/** The preset that matches exactly, or 'custom'. */
export function detectAssistLevel(a: AssistanceOptions): AssistLevel | 'custom' {
  for (const lvl of ASSIST_LEVELS) {
    const p = assistPreset(lvl.id);
    if (ASSIST_ITEMS.every((it) => p[it.key] === a[it.key])) return lvl.id;
  }
  return 'custom';
}

/** Number of helpers (non-realism flags) currently on — for the status bar. */
export function activeAssistCount(a: AssistanceOptions): number {
  let n = 0;
  for (const it of ASSIST_ITEMS) if (!REALISM_KEYS.has(it.key) && a[it.key]) n++;
  return n;
}

/** Short badge text, e.g. 'AR ·AM ·LP'. Empty when nothing is on. */
export function assistBadges(a: AssistanceOptions): string[] {
  const short: Partial<Record<AssistKey, string>> = {
    autoRudder: 'AUTO-RUDDER', assistedTakeoff: 'ASSIST T/O', assistedLanding: 'ASSIST LDG', autoMixture: 'AUTO-MIX',
    unlimitedFuel: 'INF FUEL', landingPathHints: 'LDG PATH', taxiRibbon: 'TAXI', routeRibbon: 'ROUTE', antiStall: 'ANTI-STALL',
  };
  const out: string[] = [];
  for (const it of ASSIST_ITEMS) if (!REALISM_KEYS.has(it.key) && a[it.key] && short[it.key]) out.push(short[it.key]!);
  return out;
}
