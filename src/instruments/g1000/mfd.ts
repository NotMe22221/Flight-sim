/**
 * Composes the G1000 MFD in its 1024×768 design space (docs/research/05 §2.3): NAV/COM boxes and
 * the GS / DTK / TRK / ETE data fields along the top, the page title, the engine strip on the
 * left, the moving map and the softkey bar.
 */
import { wrap360 } from '../../core/math';
import type { SimSnapshot } from '../../core/types';
import type { Ctx2D } from '../canvas';
import { formatEte, formatHeadingNum } from '../format';
import { LabelCache } from '../labelCache';
import type { ComState } from '../radioStack';
import type { InstrumentReadings } from '../readings';
import { drawEis } from './eis';
import { type MapAirport, type MapOrientation, type MapViewport, MovingMap } from './map';
import type { FmsWindow, Rect, WindowDrawData } from './fmsCore';
import { type CdiSource, G, MFD, cond, condBold } from './palette';
import { drawComBox, drawNavBox } from './radioBoxes';
import { box, num, softkeys, text } from './widgets';

/** MFD softkey labels (12 keys). */
export const MFD_SOFTKEYS: readonly string[] = Object.freeze(['ENGINE', '', 'MAP', '', '', '', '', '', 'DCLTR', 'SHW CHRT', 'CHKLIST', '']);

/** Settings the MFD shows besides the snapshot; owned by `G1000`. */
export interface MfdState {
  rangeNm: number;
  orientation: MapOrientation;
  airports: readonly MapAirport[];
  cdiSource: CdiSource;
  com1: ComState;
  com2: ComState;
  /** map declutter level 0–3 (DCLTR softkey) */
  declutter: number;
  /** softkey labels currently shown and the highlighted keys (bit i = key i) */
  softkeys: string[];
  softkeyMask: number;
  /** page title in the top bar, e.g. "MAP - NAVIGATION MAP" */
  title: string;
}

/** Data-field strip geometry (top bar centre). */
export const DATA_FIELDS = Object.freeze({ x: 300, w: 424, fieldW: 106, y: 21 });

const ktLabels = new LabelCache((v) => `${v}KT`);
const degLabels = new LabelCache((v) => formatHeadingNum(v) + '°');
const eteLabels = new LabelCache(formatEte);

/** Map viewports: full width (MAP page) or left of the page window (FPL / NRST pages). */
export const MFD_MAP_FULL: MapViewport = Object.freeze({ x: MFD.mapX, y: MFD.mapY, w: MFD.mapW, h: 634 });
export const MFD_MAP_NARROW: MapViewport = Object.freeze({ x: MFD.mapX, y: MFD.mapY, w: 570, h: 634 });
/** Page window (FPL / NRST) and popups (D→, PROC, menus) on the right. */
export const MFD_PANEL: Rect = Object.freeze({ x: 724, y: MFD.mapY, w: 300, h: 634 });
export const MFD_POPUP: Rect = Object.freeze({ x: 724, y: MFD.mapY, w: 300, h: 430 });
/** Page-group indicator strip above the softkeys. */
export const PAGE_GROUPS_Y = 700;

/** What the interactive layer adds to the MFD. */
export interface MfdOverlays {
  page: FmsWindow | null;
  popups: readonly FmsWindow[];
  data: WindowDrawData;
  groups: readonly { readonly name: string; readonly pages: readonly string[] }[];
  group: number;
  pageIndex: number;
}

/** Draw the MFD. `ctx` must be scaled so that one unit is one design pixel. */
export function drawMfd(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings, st: MfdState, map: MovingMap, ov?: MfdOverlays): void {
  ctx.fillStyle = G.black; ctx.fillRect(0, 0, MFD.width, MFD.height);
  if (!r.avionicsOn) return;
  drawNavBox(ctx, s.nav1, s.nav2, st.cdiSource);
  drawComBox(ctx, st.com1, st.com2);
  drawDataFields(ctx, s, r);
  box(ctx, MFD.mapX, MFD.topBarH, MFD.width - MFD.mapX, MFD.dataFieldH, G.barBg);
  text(ctx, st.title, MFD.mapX + (MFD.width - MFD.mapX) / 2, MFD.topBarH + MFD.dataFieldH / 2, condBold.get(16), G.white, 'center');
  drawEis(ctx, r);
  const vp = ov ? (ov.page ? MFD_MAP_NARROW : MFD_MAP_FULL) : undefined;
  map.draw(ctx, s, r, st.rangeNm, st.orientation, st.airports, { viewport: vp, declutter: st.declutter });
  if (ov) {
    if (ov.page) ov.page.draw(ctx, MFD_PANEL, ov.data);
    for (const w of ov.popups) w.draw(ctx, w.kind === 'menu' || w.kind === 'confirm' ? MFD_POPUP : popupRect(w), ov.data);
    drawPageGroups(ctx, ov);
  }
  softkeys(ctx, MFD.softkeyY, MFD.softkeyH, MFD.width, st.softkeys, -1, st.softkeyMask);
}

const popupRect = (w: FmsWindow): Rect => (w.kind === 'proc' || w.kind === 'direct' ? MFD_POPUP : MFD_PANEL);

/** Page groups (outer FMS knob) along the bottom right, the active one cyan with its page dots. */
function drawPageGroups(ctx: Ctx2D, ov: MfdOverlays): void {
  const y = PAGE_GROUPS_Y, h = MFD.softkeyY - y, gw = 74;
  box(ctx, MFD.mapX, y, MFD.width - MFD.mapX, h, G.black);
  const x0 = MFD.width - gw * ov.groups.length - 6;
  for (let i = 0; i < ov.groups.length; i++) {
    const x = x0 + i * gw, on = i === ov.group;
    if (on) { ctx.fillStyle = G.cyan; ctx.fillRect(x + 2, y + 4, gw - 4, 18); }
    text(ctx, ov.groups[i].name, x + gw / 2, y + 14, condBold.get(14), on ? G.black : G.white, 'center');
    if (on) {
      const n = ov.groups[i].pages.length;
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = k === ov.pageIndex ? G.cyan : G.darkGrey;
        ctx.fillRect(x + gw / 2 - n * 6 + k * 12 + 1, y + 26, 9, 6);
      }
    }
  }
  text(ctx, 'FMS: OUTER GROUP · INNER PAGE · PUSH CURSOR', MFD.mapX + 8, y + h / 2, cond.get(13), G.grey, 'left');
}

/** GS, DTK (magnetic, from the active leg), TRK (magnetic) and ETE fields. */
export function drawDataFields(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings): void {
  const { x, w, fieldW } = DATA_FIELDS;
  box(ctx, x, 0, w, MFD.topBarH, G.barBg);
  const plan = s.plan, hasLeg = !!plan && plan.activeLeg >= 0 && plan.activeLeg < plan.waypoints.length;
  field(ctx, x, 'GS', ktLabels.get(r.gsKt));
  field(ctx, x + fieldW, 'DTK', hasLeg ? degLabels.get(wrap360(plan.desiredTrackDeg - r.heading.magVarDeg)) : '___°');
  field(ctx, x + fieldW * 2, 'TRK', r.gsKt >= 5 ? degLabels.get(r.heading.trackMagDeg) : '___°');
  field(ctx, x + fieldW * 3, 'ETE', hasLeg ? eteLabels.get(plan.eteS) : '__:__');
}

function field(ctx: Ctx2D, x: number, label: string, value: string): void {
  const y = DATA_FIELDS.y;
  text(ctx, label, x + 6, y, cond.get(13), G.white, 'left');
  num(ctx, value, x + DATA_FIELDS.fieldW - 6, y, condBold.get(17), G.magenta, 'right');
}
