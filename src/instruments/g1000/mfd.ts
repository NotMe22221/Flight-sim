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
import { type MapAirport, type MapOrientation, MovingMap } from './map';
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
}

/** Data-field strip geometry (top bar centre). */
export const DATA_FIELDS = Object.freeze({ x: 300, w: 424, fieldW: 106, y: 21 });

const ktLabels = new LabelCache((v) => `${v}KT`);
const degLabels = new LabelCache((v) => formatHeadingNum(v) + '°');
const eteLabels = new LabelCache(formatEte);

/** Draw the MFD. `ctx` must be scaled so that one unit is one design pixel. */
export function drawMfd(ctx: Ctx2D, s: SimSnapshot, r: InstrumentReadings, st: MfdState, map: MovingMap): void {
  ctx.fillStyle = G.black; ctx.fillRect(0, 0, MFD.width, MFD.height);
  if (!r.avionicsOn) return;
  drawNavBox(ctx, s.nav1, s.nav2, st.cdiSource);
  drawComBox(ctx, st.com1, st.com2);
  drawDataFields(ctx, s, r);
  box(ctx, MFD.mapX, MFD.topBarH, MFD.width - MFD.mapX, MFD.dataFieldH, G.barBg);
  text(ctx, 'MAP - NAVIGATION MAP', MFD.mapX + (MFD.width - MFD.mapX) / 2, MFD.topBarH + MFD.dataFieldH / 2, condBold.get(16), G.white, 'center');
  drawEis(ctx, r);
  map.draw(ctx, s, r, st.rangeNm, st.orientation, st.airports);
  softkeys(ctx, MFD.softkeyY, MFD.softkeyH, MFD.width, MFD_SOFTKEYS);
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
