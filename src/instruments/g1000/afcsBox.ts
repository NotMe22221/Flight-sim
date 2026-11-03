/**
 * PFD status boxes along the top centre (docs/research/05 §2.1–2.2):
 *  - navigation status box (y 0–42): active leg "SAU → KOAK" (or "D→ KOAK"), DIS / BRG / ETE;
 *  - AFCS status box (y 42–70): AP/YD status left, lateral modes centre, vertical modes right;
 *    active modes green, armed white; a newly active mode flashes for 10 s and an autopilot
 *    disconnect flashes a red "AP" for 5 s (`AfcsAnnunciator` keeps that timing state).
 */
import { wrap360 } from '../../core/math';
import { M_TO_FT, MS_TO_FPM, MS_TO_KT, NM } from '../../core/units';
import type { AutopilotState, FlightPlan, LateralMode, VerticalMode } from '../../core/types';
import type { Ctx2D } from '../canvas';
import { formatDistanceNm, formatEte, formatHeadingNum } from '../format';
import { LabelCache } from '../labelCache';
import type { CdiState } from './navData';
import { G, PFD, cond, condBold } from './palette';
import { box, num, text } from './widgets';

/** Status-box layout in PFD design units. */
export const STATUS = Object.freeze({
  x: 300, w: 424,
  navY: 0, navH: PFD.topBarH,
  afcsY: PFD.afcsY, afcsH: PFD.afcsH,
});

/** How long a newly active mode flashes, s. */
export const MODE_FLASH_S = 10;
/** How long the red "AP" flashes after a disconnect, s. */
export const AP_DISCONNECT_FLASH_S = 5;
/** Flash period, s (on for half of it). */
export const FLASH_PERIOD_S = 1;

/** Tracks AFCS mode transitions so the box can flash them. Step it every frame. */
export class AfcsAnnunciator {
  lateralFlashS = 0;
  verticalFlashS = 0;
  disconnectFlashS = 0;
  private time = 0;
  private lastLateral: LateralMode = 'OFF';
  private lastVertical: VerticalMode = 'OFF';
  private lastEngaged = false;
  private primed = false;

  /** Advance the flash timers and detect mode changes. */
  step(ap: AutopilotState, dt: number): void {
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += d;
    this.lateralFlashS = Math.max(0, this.lateralFlashS - d);
    this.verticalFlashS = Math.max(0, this.verticalFlashS - d);
    this.disconnectFlashS = Math.max(0, this.disconnectFlashS - d);
    if (this.primed) {
      if (ap.lateral !== this.lastLateral && ap.lateral !== 'OFF') this.lateralFlashS = MODE_FLASH_S;
      if (ap.vertical !== this.lastVertical && ap.vertical !== 'OFF') this.verticalFlashS = MODE_FLASH_S;
      if (this.lastEngaged && !ap.engaged) this.disconnectFlashS = AP_DISCONNECT_FLASH_S;
      if (ap.engaged) this.disconnectFlashS = 0;
    }
    this.lastLateral = ap.lateral; this.lastVertical = ap.vertical; this.lastEngaged = ap.engaged;
    this.primed = true;
  }

  /** Current flash phase: true while a flashing annunciation is visible. */
  get blinkOn(): boolean { return (this.time % FLASH_PERIOD_S) < FLASH_PERIOD_S / 2; }

  /** Forget the history (flight reset). */
  reset(): void {
    this.lateralFlashS = this.verticalFlashS = this.disconnectFlashS = 0;
    this.primed = false;
  }
}

/**
 * Display text of the active/armed lateral mode. NAV and APR take the CDI source's name the way
 * the GFC 700 annunciates them (GPS / VOR / LOC); OFF is blank.
 */
export function lateralModeLabel(mode: LateralMode | null, cdi: CdiState): string {
  switch (mode) {
    case null: case 'OFF': return '';
    case 'NAV': return cdi.source === 'GPS' ? 'GPS' : cdi.isLocalizer ? (cdi.backCourse ? 'BC' : 'LOC') : 'VOR';
    case 'APR': return cdi.source === 'GPS' ? 'GPS' : cdi.isLocalizer ? (cdi.backCourse ? 'BC' : 'LOC') : 'VAPP';
    case 'LOC': return cdi.backCourse ? 'BC' : 'LOC';
    default: return mode;
  }
}

/** Display text of a vertical mode; ALTS (selected-altitude capture) keeps its name. */
export function verticalModeLabel(mode: VerticalMode | null): string {
  return mode === null || mode === 'OFF' ? '' : mode;
}

const altRef = new LabelCache((v) => `${v}FT`, 10);
const vsRef = new LabelCache((v) => `${v > 0 ? '+' : ''}${v}FPM`, 50);
const iasRef = new LabelCache((v) => `${v}KT`, 1);

/** Reference value shown after the active vertical mode ('' when the mode has none). */
export function verticalReference(ap: AutopilotState): string {
  switch (ap.vertical) {
    case 'ALT': case 'ALTS': return altRef.get(ap.altitudeTargetM * M_TO_FT);
    case 'VS': return vsRef.get(ap.verticalSpeedTargetMs * MS_TO_FPM);
    case 'FLC': return iasRef.get(ap.iasTargetMs * MS_TO_KT);
    default: return '';
  }
}

/** Draw the AFCS status box. Nothing but the frame is drawn while both AP and FD are off. */
export function drawAfcsBox(ctx: Ctx2D, ap: AutopilotState, ann: AfcsAnnunciator, cdi: CdiState): void {
  const { x, w, afcsY: y, afcsH: h } = STATUS;
  const cy = y + h / 2;
  box(ctx, x, y, w, h, G.barBg);
  ctx.fillStyle = G.darkGrey;
  ctx.fillRect(x + 100, y + 4, 1, h - 8); ctx.fillRect(x + 262, y + 4, 1, h - 8);
  const f15 = condBold.get(17);
  if (ap.engaged) text(ctx, 'AP', x + 30, cy, f15, G.green, 'center');
  else if (ann.disconnectFlashS > 0 && ann.blinkOn) {
    box(ctx, x + 14, y + 4, 32, h - 8, G.red);
    text(ctx, 'AP', x + 30, cy, f15, G.white, 'center');
  }
  if (ap.yawDamper) text(ctx, 'YD', x + 70, cy, f15, G.green, 'center');
  if (!ap.engaged && !ap.flightDirector) return;
  const showLat = !(ann.lateralFlashS > 0 && !ann.blinkOn);
  if (showLat) text(ctx, lateralModeLabel(ap.lateral, cdi), x + 112, cy, f15, G.green, 'left');
  text(ctx, lateralModeLabel(ap.armedLateral, cdi), x + 252, cy, condBold.get(15), G.white, 'right');
  const showVert = !(ann.verticalFlashS > 0 && !ann.blinkOn);
  if (showVert) {
    text(ctx, verticalModeLabel(ap.vertical), x + 272, cy, f15, G.green, 'left');
    const ref = verticalReference(ap);
    if (ref) num(ctx, ref, x + 318, cy, condBold.get(15), G.green, 'left');
  }
  text(ctx, verticalModeLabel(ap.armedVertical), x + w - 8, cy, condBold.get(15), G.white, 'right');
}

const disLabels = new LabelCache((v) => formatDistanceNm(v) + 'NM', 0.1);
const brgLabels = new LabelCache((v) => formatHeadingNum(v) + '°', 1);
const eteLabels = new LabelCache((v) => formatEte(v), 1);

/**
 * Navigation status box: active leg (magenta "to" waypoint) on the first line, distance, bearing
 * (magnetic) and ETE to the active waypoint on the second. Blank without a flight plan.
 */
export function drawNavStatus(ctx: Ctx2D, plan: FlightPlan | null, magVarDeg: number): void {
  const { x, w, navY: y, navH: h } = STATUS;
  box(ctx, x, y, w, h, G.barBg);
  const to = plan ? plan.waypoints[plan.activeLeg] : undefined;
  if (!plan || !to) return;
  const from = plan.activeLeg > 0 ? plan.waypoints[plan.activeLeg - 1] : undefined;
  const mid = x + w / 2, y1 = y + 12, y2 = y + 31;
  if (from) {
    text(ctx, from.id, mid - 16, y1, condBold.get(17), G.white, 'right');
    text(ctx, '→', mid, y1, condBold.get(17), G.magenta, 'center');
  } else text(ctx, 'D→', mid - 8, y1, condBold.get(17), G.magenta, 'right');
  text(ctx, to.id, mid + 16, y1, condBold.get(17), G.magenta, 'left');
  const f = cond.get(14), fv = condBold.get(16);
  text(ctx, 'DIS', x + 40, y2, f, G.white, 'left');
  num(ctx, disLabels.get(plan.distanceToActiveM / NM), x + 70, y2, fv, G.magenta, 'left');
  text(ctx, 'BRG', x + 170, y2, f, G.white, 'left');
  num(ctx, brgLabels.get(wrap360(plan.bearingToActiveDeg - magVarDeg)), x + 202, y2, fv, G.magenta, 'left');
  text(ctx, 'ETE', x + 290, y2, f, G.white, 'left');
  num(ctx, eteLabels.get(plan.eteS), x + 322, y2, fv, G.magenta, 'left');
}
