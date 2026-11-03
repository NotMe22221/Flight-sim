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
import { type CdiSource, G, PFD, cond, condBold } from './palette';
import { drawComBox, drawNavBox } from './radioBoxes';
import { drawVsi } from './vsi';
import { box, num, softkeys, text } from './widgets';
import type { FmsWindow, Rect, WindowDrawData } from './fmsCore';
import type { MapAirport, MapViewport, MovingMap } from './map';
import { LabelCache } from '../labelCache';
import { tapeOffsetPx } from '../scales';

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
  /** wind window shown (PFD > WIND cycles option 1, option 2, off) */
  windOn: boolean;
  /** inset map (INSET softkey) and its range / declutter level */
  insetOn: boolean;
  insetRangeNm: number;
  insetDeclutter: number;
  /** receiver the NAV / COM knobs tune (cyan tuning box) */
  navFocus: 1 | 2;
  comFocus: 1 | 2;
  /** transponder IDENT time left, s */
  identS: number;
  /** TMR/REF settings */
  vspeedBugs: boolean;
  minimumsFt: number;
  minimumsOn: boolean;
  /** softkey labels currently shown and the highlighted keys (bit i = key i) */
  softkeys: string[];
  softkeyMask: number;
}

export function createPfdState(): PfdState {
  return {
    cdiSource: 'GPS', cdi: createCdiState(), brg1: createBearingState('NAV1'), brg2: createBearingState('GPS'),
    afcs: new AfcsAnnunciator(), windOption: 1, dmeSource: 'NAV1',
    com1: { activeKHz: 120500, standbyKHz: 121800 }, com2: { activeKHz: 118700, standbyKHz: 119300 },
    squawk: 1200, xpdrMode: 'ALT',
    windOn: true, insetOn: false, insetRangeNm: 5, insetDeclutter: 0, navFocus: 1, comFocus: 1, identS: 0,
    vspeedBugs: true, minimumsFt: 200, minimumsOn: false,
    softkeys: [...PFD_SOFTKEYS], softkeyMask: 0,
  };
}

/** PFD inset map (INSET softkey) and the window area (D→, FPL, NRST, PROC, TMR/REF, ALERTS). */
export const PFD_INSET: MapViewport = Object.freeze({ x: 4, y: 470, w: 252, h: 234, compact: true });
export const PFD_WINDOW: Rect = Object.freeze({ x: 668, y: 462, w: 352, h: 244 });

/** What the interactive layer adds to the PFD. */
export interface PfdOverlays {
  /** windows in the lower-right window area, bottom first (a menu or confirmation sits on top) */
  windows: readonly FmsWindow[];
  data: WindowDrawData;
  insetMap: MovingMap | null;
  airports: readonly MapAirport[];
}

/**
 * Draw the whole PFD into `ctx`, which must already be scaled so that one unit is one design
 * pixel of the 1024×768 layout. `hsiGeo` optionally receives the HSI geometry.
 */
export function drawPfd(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings, st: PfdState, vspeeds: VSpeeds, hsiGeo?: HsiGeometry, ov?: PfdOverlays): void {
  ctx.fillStyle = G.black; ctx.fillRect(0, 0, PFD.width, PFD.height);
  if (!r.essentialOn) return; // the PFD runs on the essential bus (master on), the MFD on the avionics bus
  const ap = s.autopilot, mv = r.heading.magVarDeg;
  drawAttitude(ctx, r, ap);
  drawAirspeedTape(ctx, r, ap, vspeeds, st.vspeedBugs);
  drawAltitudeTape(ctx, r, ap, st.cdiSource === 'NAV2' ? s.nav2 : s.nav1);
  if (st.minimumsOn) drawMinimums(ctx, r, st.minimumsFt);
  drawVsi(ctx, r, ap);
  drawMarkerBeacon(ctx, s.nav1.marker ?? null);
  drawHsi(ctx, r, st.cdi, st.brg1, st.brg2, hsiGeo);
  if (st.dmeSource !== 'OFF') drawDmeWindow(ctx, st.dmeSource, st.dmeSource === 'NAV2' ? s.nav2 : s.nav1);
  drawBearingInfo(ctx, 1, st.brg1);
  drawBearingInfo(ctx, 2, st.brg2);
  // top bar and AFCS box
  drawNavBox(ctx, s.nav1, s.nav2, st.cdiSource, st.navFocus);
  drawNavStatus(ctx, s.plan, mv);
  drawComBox(ctx, st.com1, st.com2, st.comFocus);
  drawAfcsBox(ctx, ap, st.afcs, st.cdi);
  // bottom data windows (the inset map takes the lower left)
  const inset = st.insetOn && ov?.insetMap;
  if (inset) ov.insetMap!.draw(ctx, s, r, st.insetRangeNm, 'heading-up', ov.airports, { viewport: PFD_INSET, declutter: st.insetDeclutter });
  else {
    drawGroundSpeed(ctx, r);
    if (st.windOn) drawWind(ctx, r, st.windOption);
  }
  drawOat(ctx, r);
  drawTransponderBox(ctx, st.squawk, st.identS > 0 ? 'IDNT' : st.xpdrMode);
  drawClock(ctx, r);
  drawAlerts(ctx, r);
  if (ov) for (const w of ov.windows) w.draw(ctx, PFD_WINDOW, ov.data);
  drawPfdSoftkeys(ctx, r, st.softkeys, st.softkeyMask);
}

/** Baro minimums: a cyan box under the baro setting and a bug on the altitude tape. */
function drawMinimums(ctx: Ctx2D, r: InstrumentReadings, minFt: number): void {
  const x = PFD.altX, w = PFD.altW, top = PFD.tapeTop, bottom = PFD.tapeBottom, mid = (top + bottom) / 2;
  box(ctx, x, bottom + 28, w, 22);
  text(ctx, 'MIN', x + 5, bottom + 39, cond.get(12), G.cyan, 'left');
  num(ctx, minLabels.get(minFt), x + w - 6, bottom + 39, condBold.get(15), G.cyan, 'right');
  const y = mid + tapeOffsetPx(minFt, r.altimeter.indicatedFt, PFD.altPxPerFt);
  if (y > top && y < bottom) {
    ctx.strokeStyle = G.cyan; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 6, y); ctx.moveTo(x - 10, y - 6); ctx.lineTo(x - 10, y + 6); ctx.stroke();
  }
}
const minLabels = new LabelCache((v) => String(v));

/** Softkey bar (labels and highlighted keys from the menu state) with ALERTS recoloured for active warnings / cautions. */
export function drawPfdSoftkeys(ctx: Ctx2D, r: InstrumentReadings, labels: readonly string[] = PFD_SOFTKEYS, mask = 0): void {
  softkeys(ctx, PFD.softkeyY, PFD.softkeyH, PFD.width, labels, -1, mask);
  const k = alertSoftkey(r);
  if (k.label === 'ALERTS' || labels[ALERTS_KEY_INDEX] !== 'ALERTS') return;
  const w = PFD.width / labels.length, x = ALERTS_KEY_INDEX * w + 2, y = PFD.softkeyY;
  ctx.fillStyle = k.bg; ctx.fillRect(x, y + 2, w - 4, PFD.softkeyH - 4);
  text(ctx, k.label, x + (w - 4) / 2, y + PFD.softkeyH / 2, condBold.get(14), k.fg, 'center');
}
