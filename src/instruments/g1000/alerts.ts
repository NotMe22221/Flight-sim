/**
 * PFD annunciation / alerts window (bottom right, above the transponder) and the ALERTS softkey
 * state. Warnings are red, cautions yellow, listed in priority order; the softkey reads WARNING
 * (red) or CAUTION (yellow) while such alerts are active, like the G1000's alert softkey.
 */
import type { Ctx2D } from '../canvas';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import { G, cond, condBold } from './palette';
import { box, text } from './widgets';

export type AlertLevel = 'warning' | 'caution';
type AnnunciatorKey = keyof InstrumentReadings['annunciators'];

export interface AlertDef { readonly key: AnnunciatorKey; readonly text: string; readonly level: AlertLevel }

/** Annunciations shown in the alerts window, highest priority first. */
export const ALERT_DEFS: readonly AlertDef[] = Object.freeze([
  { key: 'oilPress', text: 'OIL PRESSURE', level: 'warning' },
  { key: 'overspeed', text: 'OVERSPEED', level: 'warning' },
  { key: 'overG', text: 'OVER G', level: 'warning' },
  { key: 'lowVolts', text: 'LOW VOLTS', level: 'caution' },
  { key: 'lowFuelL', text: 'LOW FUEL L', level: 'caution' },
  { key: 'lowFuelR', text: 'LOW FUEL R', level: 'caution' },
  { key: 'vacuum', text: 'LOW VACUUM', level: 'caution' },
  { key: 'flapOverspeed', text: 'FLAP OVERSPEED', level: 'caution' },
  { key: 'gearOverspeed', text: 'GEAR OVERSPEED', level: 'caution' },
] as AlertDef[]);

const moreLabels = new LabelCache((v) => `+${v} MORE`);

/** Alerts window position (PFD design units). */
export const ALERTS_RECT = Object.freeze({ x: 770, y: 600, w: 250, h: 76, lineH: 18 });

/** Highest active alert level, or null when nothing is annunciated. */
export function alertLevel(r: InstrumentReadings): AlertLevel | null {
  let level: AlertLevel | null = null;
  for (const d of ALERT_DEFS) {
    if (!r.annunciators[d.key]) continue;
    if (d.level === 'warning') return 'warning';
    level = 'caution';
  }
  return level;
}

/** Number of active alerts. */
export function activeAlertCount(r: InstrumentReadings): number {
  let n = 0;
  for (const d of ALERT_DEFS) if (r.annunciators[d.key]) n++;
  return n;
}

/** Draw the alerts window; nothing is drawn while no alert is active. */
export function drawAlerts(ctx: Ctx2D, r: InstrumentReadings): void {
  const n = activeAlertCount(r);
  if (n === 0) return;
  const { x, y, w, lineH } = ALERTS_RECT;
  const maxLines = Math.floor(ALERTS_RECT.h / lineH);
  const lines = Math.min(n, maxLines);
  box(ctx, x, y, w, lines * lineH + 4, G.boxBg, G.darkGrey);
  let i = 0;
  for (const d of ALERT_DEFS) {
    if (!r.annunciators[d.key]) continue;
    if (i === maxLines - 1 && n > maxLines) {
      text(ctx, moreLabels.get(n - i), x + w - 8, y + 2 + lineH * (i + 0.5), cond.get(14), G.white, 'right');
      break;
    }
    text(ctx, d.text, x + w - 8, y + 2 + lineH * (i + 0.5), condBold.get(16), d.level === 'warning' ? G.red : G.yellow, 'right');
    i++;
  }
}

/** Label and colours for the ALERTS softkey. */
export function alertSoftkey(r: InstrumentReadings): { label: string; fg: string; bg: string } {
  const level = alertLevel(r);
  if (level === 'warning') return WARNING_KEY;
  if (level === 'caution') return CAUTION_KEY;
  return ALERTS_KEY;
}
const WARNING_KEY = Object.freeze({ label: 'WARNING', fg: G.white, bg: G.red });
const CAUTION_KEY = Object.freeze({ label: 'CAUTION', fg: G.black, bg: G.yellow });
const ALERTS_KEY = Object.freeze({ label: 'ALERTS', fg: G.white, bg: G.softkeyBg });
