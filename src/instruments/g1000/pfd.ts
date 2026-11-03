/**
 * Composes the G1000 PFD in its 1024×768 design space (docs/research/05 §2.2): attitude, tapes,
 * VSI, HSI with its info windows, top bar (NAV / status / COM), AFCS box, bottom data windows,
 * alerts and the softkey bar. A dead avionics bus leaves the screen black.
 */
import type { SimSnapshot } from '../../core/types';
import type { Ctx2D } from '../canvas';
import type { VSpeeds } from '../c172';
import type { ComState } from '../radioStack';
import type { InstrumentReadings } from '../readings';
import { AfcsAnnunciator, drawAfcsBox, drawNavStatus } from './afcsBox';
import { alertSoftkey, drawAlerts } from './alerts';
import { drawAirspeedTape } from './airspeedTape';
import { drawAltitudeTape } from './altitudeTape';
import { drawAttitude } from './attitude';
import { type HsiGeometry, drawHsi } from './hsi';
import { type WindOption, drawBearingInfo, drawClock, drawDmeWindow, drawGroundSpeed, drawMarkerBeacon, drawOat, drawTransponderBox, drawWind } from './infoBoxes';
import { type BearingState, type CdiState, createBearingState, createCdiState } from './navData';
import { type CdiSource, G, PFD, condBold } from './palette';
import { drawComBox, drawNavBox } from './radioBoxes';
import { drawVsi } from './vsi';
import { softkeys, text } from './widgets';

/** PFD softkey labels (12 keys). */
export const PFD_SOFTKEYS: readonly string[] = Object.freeze(['INSET', '', 'PFD', 'OBS', 'CDI', 'DME', 'XPDR', 'IDENT', 'TMR/REF', 'NRST', '', 'ALERTS']);
const ALERTS_KEY_INDEX = 11;

/** Everything the PFD shows besides the snapshot and readings; owned and refreshed by `G1000`. */
export interface PfdState {
  cdiSource: CdiSource;
  cdi: CdiState;
  brg1: BearingState;
  brg2: BearingState;
  afcs: AfcsAnnunciator;
  windOption: WindOption;
  /** receiver whose DME is shown in the DME window, or OFF */
  dmeSource: 'OFF' | 'NAV1' | 'NAV2';
  com1: ComState;
  com2: ComState;
  squawk: number;
  xpdrMode: string;
}

export function createPfdState(): PfdState {
  return {
    cdiSource: 'GPS', cdi: createCdiState(), brg1: createBearingState('NAV1'), brg2: createBearingState('GPS'),
    afcs: new AfcsAnnunciator(), windOption: 1, dmeSource: 'NAV1',
    com1: { activeKHz: 120500, standbyKHz: 121800 }, com2: { activeKHz: 118700, standbyKHz: 119300 },
    squawk: 1200, xpdrMode: 'ALT',
  };
}

/**
 * Draw the whole PFD into `ctx`, which must already be scaled so that one unit is one design
 * pixel of the 1024×768 layout. `hsiGeo` optionally receives the HSI geometry.
 */
export function drawPfd(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings, st: PfdState, vspeeds: VSpeeds, hsiGeo?: HsiGeometry): void {
  ctx.fillStyle = G.black; ctx.fillRect(0, 0, PFD.width, PFD.height);
  if (!r.essentialOn) return; // the PFD runs on the essential bus (master on), the MFD on the avionics bus
  const ap = s.autopilot, mv = r.heading.magVarDeg;
  drawAttitude(ctx, r, ap);
  drawAirspeedTape(ctx, r, ap, vspeeds);
  drawAltitudeTape(ctx, r, ap, st.cdiSource === 'NAV2' ? s.nav2 : s.nav1);
  drawVsi(ctx, r, ap);
  drawMarkerBeacon(ctx, s.nav1.marker ?? null);
  drawHsi(ctx, r, st.cdi, st.brg1, st.brg2, hsiGeo);
  if (st.dmeSource !== 'OFF') drawDmeWindow(ctx, st.dmeSource, st.dmeSource === 'NAV2' ? s.nav2 : s.nav1);
  drawBearingInfo(ctx, 1, st.brg1);
  drawBearingInfo(ctx, 2, st.brg2);
  // top bar and AFCS box
  drawNavBox(ctx, s.nav1, s.nav2, st.cdiSource);
  drawNavStatus(ctx, s.plan, mv);
  drawComBox(ctx, st.com1, st.com2);
  drawAfcsBox(ctx, ap, st.afcs, st.cdi);
  // bottom data windows
  drawGroundSpeed(ctx, r);
  drawWind(ctx, r, st.windOption);
  drawOat(ctx, r);
  drawTransponderBox(ctx, st.squawk, st.xpdrMode);
  drawClock(ctx, r);
  drawAlerts(ctx, r);
  drawPfdSoftkeys(ctx, r);
}

/** Softkey bar with the ALERTS key recoloured for active warnings / cautions. */
export function drawPfdSoftkeys(ctx: Ctx2D, r: InstrumentReadings): void {
  softkeys(ctx, PFD.softkeyY, PFD.softkeyH, PFD.width, PFD_SOFTKEYS);
  const k = alertSoftkey(r);
  if (k.label === 'ALERTS') return;
  const w = PFD.width / PFD_SOFTKEYS.length, x = ALERTS_KEY_INDEX * w + 2, y = PFD.softkeyY;
  ctx.fillStyle = k.bg; ctx.fillRect(x, y + 2, w - 4, PFD.softkeyH - 4);
  text(ctx, k.label, x + (w - 4) / 2, y + PFD.softkeyH / 2, condBold.get(14), k.fg, 'center');
}
