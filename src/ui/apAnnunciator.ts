/**
 * Autopilot annunciations for the flight info strip, after the GFC 700 status bar: active lateral
 * and vertical modes (green), armed modes (white), 'LVL' in both fields during LVL recovery, a
 * flashing 'AP' for 5 s after a disconnect (amber when the pilot disconnected it, red when the
 * autopilot dropped out by itself, with the reason) and the altitude alerter ('approach' cyan,
 * 'deviation' amber). Pure: the caller passes the clock; `read` fills a reused object.
 */
import type { AutopilotState } from '../core/types';

export type DisconnectReason = NonNullable<AutopilotState['disconnectReason']>;
export type AltAlert = NonNullable<AutopilotState['altAlert']>;

/** How long the disconnect annunciation flashes (GFC 700: 5 s). */
export const AP_DISCONNECT_FLASH_MS = 5000;

const REASONS: Record<DisconnectReason, { short: string; long: string }> = {
  pilot: { short: '', long: 'disconnected by the pilot' },
  override: { short: 'OVRD', long: 'pilot override on the controls' },
  stall: { short: 'STALL', long: 'stall warning' },
  bank: { short: 'BANK', long: 'bank limit exceeded' },
  overspeed: { short: 'OVSPD', long: 'overspeed' },
  crash: { short: 'CRASH', long: 'crash' },
  power: { short: 'PWR', long: 'autopilot power lost' },
};

/**
 * Texts for a disconnect: `short` for the strip ('' for a normal disconnect), `long` for tooltips
 * and toasts. Only the pilot's own disconnect is normal; anything else is annunciated in red.
 */
export function disconnectText(reason: DisconnectReason | null | undefined): { short: string; long: string; abnormal: boolean } {
  const r = reason && REASONS[reason] ? reason : null;
  if (!r) return { short: '', long: 'disconnected', abnormal: false };
  return { ...REASONS[r], abnormal: r !== 'pilot' };
}

/**
 * The toast for an autopilot state change, or null: 'engaged' when it went on, 'disconnected'
 * (with the reason when the autopilot let go by itself) when it went off; nothing when the
 * engaged state did not change or the previous state is unknown.
 */
export function autopilotToast(prevEngaged: boolean | null, st: AutopilotState): { text: string; kind: 'info' | 'warn' | 'error' } | null {
  if (prevEngaged === null || prevEngaged === st.engaged) return null;
  if (st.engaged) return { text: 'Autopilot engaged', kind: 'info' };
  const d = disconnectText(st.disconnectReason);
  return d.abnormal ? { text: `AP OFF — autopilot disconnected: ${d.long}`, kind: 'error' } : { text: 'AP OFF — autopilot disconnected', kind: 'warn' };
}

export interface ApAnnunciation {
  /** the AP cell is shown (AP or FD on, LVL, or a disconnect still flashing) */ visible: boolean;
  /** 'AP' engaged, 'FD' flight director only, 'AP' again while a disconnect flashes */ status: '' | 'AP' | 'FD';
  /** 'ok' engaged (green), 'fd' (white), 'disc' abnormal disconnect (red flash), 'disc-pilot' normal disconnect (amber flash) */
  statusTone: 'ok' | 'fd' | 'disc' | 'disc-pilot';
  /** active modes ('' when OFF); 'LVL' in both during LVL recovery */ lateral: string; vertical: string;
  /** armed modes ('' when none) */ armedLateral: string; armedVertical: string;
  /** short disconnect reason while flashing ('STALL'), else '' */ reason: string;
  /** long disconnect reason while flashing ('stall warning'), else '' */ reasonLong: string;
  /** LVL recovery active */ lvl: boolean;
  altAlert: AltAlert;
}

export const emptyAnnunciation = (): ApAnnunciation => ({
  visible: false, status: '', statusTone: 'fd', lateral: '', vertical: '', armedLateral: '', armedVertical: '', reason: '', reasonLong: '', lvl: false, altAlert: 'none',
});

/** Tooltip for the AP cell; call only when the annunciation changed (it builds a string). */
export function annunciationTitle(a: ApAnnunciation): string {
  const parts: string[] = [];
  if (a.statusTone === 'disc' || a.statusTone === 'disc-pilot') parts.push(`Autopilot ${a.statusTone === 'disc' ? 'disconnected: ' : ''}${a.reasonLong}`);
  else if (a.lvl) parts.push('LVL: the autopilot is levelling the wings and holding level flight');
  else if (a.status === 'AP') parts.push('Autopilot engaged');
  else if (a.status === 'FD') parts.push('Flight director only (autopilot off)');
  if (a.armedLateral || a.armedVertical) parts.push(`armed: ${[a.armedLateral, a.armedVertical].filter(Boolean).join(', ')}`);
  if (a.altAlert === 'approach') parts.push('approaching the selected altitude');
  else if (a.altAlert === 'deviation') parts.push('deviating from the selected altitude');
  return parts.join(' · ');
}

const mode = (m: string | null | undefined): string => (m && m !== 'OFF' ? m : '');

export class ApAnnunciator {
  private baseline = false;
  private lastT = 0;
  private flashUntil = Number.NEGATIVE_INFINITY;
  private disc = disconnectText(null);

  /**
   * Forget what was seen (a new flight, or frames the strip did not watch): the next frame is a
   * baseline, so a disconnect from before it never flashes late.
   */
  rebase(): void { this.baseline = false; this.flashUntil = Number.NEGATIVE_INFINITY; }

  /** Per frame. True on the frame a new disconnect (a changed `disconnectT`) is seen. */
  observe(ap: AutopilotState, nowMs: number): boolean {
    const t = ap.disconnectT;
    if (typeof t !== 'number' || Number.isNaN(t)) return false; // an autopilot without the GFC extras
    if (!this.baseline) { this.baseline = true; this.lastT = t; return false; }
    if (t === this.lastT) return false;
    this.lastT = t;
    if (!Number.isFinite(t) || ap.engaged) return false; // reset to "never", or already re-engaged
    this.flashUntil = nowMs + AP_DISCONNECT_FLASH_MS;
    this.disc = disconnectText(ap.disconnectReason);
    return true;
  }

  /** The disconnect annunciation is still flashing. Re-engaging cancels it. */
  flashing(ap: AutopilotState, nowMs: number): boolean { return !ap.engaged && nowMs < this.flashUntil; }

  /** The last disconnect seen (reason texts), for a toast. */
  get lastDisconnect(): { short: string; long: string; abnormal: boolean } { return this.disc; }

  /** Fills `out` for this frame (call after `observe`); allocation-free. */
  read(ap: AutopilotState, nowMs: number, out: ApAnnunciation): ApAnnunciation {
    const flash = this.flashing(ap, nowMs);
    const lvl = ap.lvl === true;
    out.lvl = lvl;
    out.visible = ap.engaged || ap.flightDirector || lvl || flash;
    out.lateral = lvl ? 'LVL' : mode(ap.lateral);
    out.vertical = lvl ? 'LVL' : mode(ap.vertical);
    out.armedLateral = lvl ? '' : mode(ap.armedLateral);
    out.armedVertical = lvl ? '' : mode(ap.armedVertical);
    out.altAlert = ap.altAlert ?? 'none';
    if (flash) {
      out.status = 'AP';
      out.statusTone = this.disc.abnormal ? 'disc' : 'disc-pilot';
      out.reason = this.disc.short;
      out.reasonLong = this.disc.long;
    } else {
      out.status = ap.engaged ? 'AP' : ap.flightDirector ? 'FD' : '';
      out.statusTone = ap.engaged ? 'ok' : 'fd';
      out.reason = '';
      out.reasonLong = '';
    }
    return out;
  }
}
