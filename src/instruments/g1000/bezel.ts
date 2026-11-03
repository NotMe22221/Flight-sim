/**
 * GDU bezel drawn into each display canvas around the 1024×768 screen (docs/research/05 §2.4):
 * 12 softkeys under the screen (labels on the screen's bottom row), on the left the NAV volume
 * and dual frequency knob with its transfer key, the HDG knob, the AFCS keys and the dual ALT
 * knob; on the right the COM knobs and transfer key, the dual CRS/BARO knob, RANGE, the
 * D→/MENU/FPL/PROC/CLR/ENT keys and the dual FMS knob. The unit is 4:3 like the screen, so two
 * GDUs side by side keep the panel texture's aspect ratio.
 *
 * `bezelRegions()` returns the clickable rectangles and circles in canvas pixels, for mapping a
 * ray-cast UV onto a control; `hitTest()` resolves a point (inner vs outer ring of dual knobs).
 */
import type { Ctx2D } from '../canvas';
import { type G1000Button, type G1000Display, type G1000Knob, type KnobRing, DUAL_KNOBS } from './input';
import { G, PFD, cond, condBold } from './palette';
import { text } from './widgets';

/** Bezel design space (one GDU), with the screen's placement. */
export const BEZEL = Object.freeze({
  width: 1344, height: 1008,
  screenX: 160, screenY: 64, screenW: PFD.width, screenH: PFD.height,
  /** physical softkey buttons under the screen */
  keyY: 846, keyH: 34,
  leftCx: 80, rightCx: 1264,
});

/** What a hit region operates. */
export type BezelControl =
  | { readonly kind: 'softkey'; readonly index: number }
  | { readonly kind: 'button'; readonly id: G1000Button }
  | { readonly kind: 'knob'; readonly id: G1000Knob };

/** A clickable area in canvas pixels. Circles of dual knobs carry the inner-ring radius. */
export type HitRegion =
  | { readonly control: BezelControl; readonly shape: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly control: BezelControl; readonly shape: 'circle'; readonly cx: number; readonly cy: number; readonly r: number; readonly rInner: number };

/** Result of a hit test: the region and, for a dual knob, the ring under the point. */
export interface BezelHit { readonly region: HitRegion; readonly control: BezelControl; readonly ring: KnobRing }

interface KnobDef { id: G1000Knob; cx: number; cy: number; r: number; rInner: number; label: string; sub: string }
interface KeyDef { id: G1000Button; x: number; y: number; w: number; h: number; label: string; sub?: string }

const L = BEZEL.leftCx, R = BEZEL.rightCx;
const KNOBS: readonly KnobDef[] = [
  { id: 'NAV_VOL', cx: L, cy: 112, r: 22, rInner: 0, label: 'NAV', sub: 'VOL/ID' },
  { id: 'NAV', cx: L, cy: 240, r: 44, rInner: 26, label: '', sub: 'PUSH 1-2' },
  { id: 'HDG', cx: L, cy: 362, r: 34, rInner: 0, label: 'HDG', sub: 'PUSH SYNC' },
  { id: 'ALT', cx: L, cy: 806, r: 46, rInner: 27, label: 'ALT SEL', sub: '' },
  { id: 'COM_VOL', cx: R, cy: 112, r: 22, rInner: 0, label: 'COM', sub: 'VOL/SQ' },
  { id: 'COM', cx: R, cy: 240, r: 44, rInner: 26, label: '', sub: 'PUSH 1-2' },
  { id: 'CRS_BARO', cx: R, cy: 376, r: 44, rInner: 26, label: 'CRS/BARO', sub: 'PUSH CTR' },
  { id: 'RANGE', cx: R, cy: 496, r: 32, rInner: 0, label: 'RANGE', sub: '' },
  { id: 'FMS', cx: R, cy: 806, r: 50, rInner: 29, label: 'FMS', sub: 'PUSH CRSR' },
];

function keys(): KeyDef[] {
  const out: KeyDef[] = [
    { id: 'NAV_SWAP', x: L - 32, y: 158, w: 64, h: 28, label: '⇅' },
    { id: 'COM_SWAP', x: R - 32, y: 158, w: 64, h: 28, label: '⇅' },
  ];
  const afcs: [G1000Button, string, string?][] = [
    ['AP', 'AP'], ['FD', 'FD'], ['HDG', 'HDG'], ['ALT', 'ALT'], ['NAV', 'NAV'], ['VNV', 'VNV'],
    ['APR', 'APR'], ['BC', 'BC'], ['VS', 'VS'], ['FLC', 'FLC'], ['NOSE_UP', 'UP', 'NOSE'], ['NOSE_DN', 'DN', 'NOSE'],
  ];
  afcs.forEach(([id, label, sub], i) => out.push({ id, x: i % 2 === 0 ? 12 : 84, y: 424 + Math.floor(i / 2) * 50, w: 64, h: 40, label, sub }));
  const fms: [G1000Button, string][] = [['DIRECT', 'D→'], ['MENU', 'MENU'], ['FPL', 'FPL'], ['PROC', 'PROC'], ['CLR', 'CLR'], ['ENT', 'ENT']];
  fms.forEach(([id, label], i) => out.push({ id, x: i % 2 === 0 ? 1196 : 1268, y: 556 + Math.floor(i / 2) * 50, w: 64, h: 40, label }));
  return out;
}
const KEYS: readonly KeyDef[] = keys();

/** Softkey i: its on-screen label cell plus the physical button below it (bezel design units). */
function softkeyRect(i: number): { x: number; y: number; w: number; h: number } {
  const w = BEZEL.screenW / PFD.softkeyCount;
  return { x: BEZEL.screenX + i * w, y: BEZEL.screenY + PFD.softkeyY, w, h: BEZEL.keyY + BEZEL.keyH + 6 - (BEZEL.screenY + PFD.softkeyY) };
}

/**
 * Hit regions in canvas pixels for a canvas of `canvasW × canvasH`. With `bezel` false the canvas
 * is the bare screen and only the on-screen softkey labels are clickable.
 */
export function bezelRegions(canvasW: number, canvasH: number, bezel = true): HitRegion[] {
  const out: HitRegion[] = [];
  if (!bezel) {
    const sx = canvasW / PFD.width, sy = canvasH / PFD.height, w = PFD.width / PFD.softkeyCount;
    for (let i = 0; i < PFD.softkeyCount; i++) out.push({ control: { kind: 'softkey', index: i }, shape: 'rect', x: i * w * sx, y: PFD.softkeyY * sy, w: w * sx, h: PFD.softkeyH * sy });
    return out;
  }
  const sx = canvasW / BEZEL.width, sy = canvasH / BEZEL.height, sr = Math.min(sx, sy);
  for (let i = 0; i < PFD.softkeyCount; i++) {
    const r = softkeyRect(i);
    out.push({ control: { kind: 'softkey', index: i }, shape: 'rect', x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  }
  for (const k of KEYS) out.push({ control: { kind: 'button', id: k.id }, shape: 'rect', x: k.x * sx, y: k.y * sy, w: k.w * sx, h: k.h * sy });
  for (const k of KNOBS) out.push({ control: { kind: 'knob', id: k.id }, shape: 'circle', cx: k.cx * sx, cy: k.cy * sy, r: k.r * sr, rInner: k.rInner * sr });
  return out;
}

/** The control under canvas point (x, y), or null. Knob circles get a 6 % grab margin. */
export function hitTest(regions: readonly HitRegion[], x: number, y: number): BezelHit | null {
  for (const g of regions) {
    if (g.shape === 'rect') {
      if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) return { region: g, control: g.control, ring: 'inner' };
    } else {
      const d = Math.hypot(x - g.cx, y - g.cy);
      if (d <= g.r * 1.06) {
        const dual = g.control.kind === 'knob' && DUAL_KNOBS.has(g.control.id);
        return { region: g, control: g.control, ring: dual && d > g.rInner ? 'outer' : 'inner' };
      }
    }
  }
  return null;
}

/** Stable key of a control (`softkey:3`, `button:ENT`, `knob:FMS`). */
export const controlKey = (c: BezelControl): string => (c.kind === 'softkey' ? `softkey:${c.index}` : `${c.kind}:${c.id}`);

const KNOB_INFO: Record<G1000Knob, [string, string]> = {
  NAV_VOL: ['NAV volume', 'Volume / push: ident (not simulated)'],
  NAV: ['NAV frequency', 'Outer: MHz · inner: kHz (standby) · push: NAV1/NAV2'],
  HDG: ['Heading bug', 'Turn: bug · push: sync to heading'],
  ALT: ['Selected altitude', 'Outer: 1 000 ft · inner: 100 ft'],
  COM_VOL: ['COM volume', 'Volume / push: squelch (not simulated)'],
  COM: ['COM frequency', 'Outer: MHz · inner: kHz (standby) · push: COM1/COM2'],
  CRS_BARO: ['Course / baro', 'Inner: course (OBS) · outer: altimeter setting · push: centre CDI'],
  RANGE: ['Map range', 'Turn: map range (PFD: inset map)'],
  FMS: ['FMS', 'Outer: page group / cursor · inner: page / character · push: cursor'],
};
const BUTTON_INFO: Partial<Record<G1000Button, [string, string]>> = {
  DIRECT: ['Direct-to', 'Enter an ident, ENT, ENT to fly direct'], MENU: ['Menu', 'Page menu'],
  FPL: ['Flight plan', 'Show / hide the active flight plan'], PROC: ['Procedures', 'Select an approach at the destination'],
  CLR: ['Clear', 'Cancel / delete / close'], ENT: ['Enter', 'Confirm'], NAV_SWAP: ['NAV transfer', 'Swap active and standby'],
  COM_SWAP: ['COM transfer', 'Swap active and standby'], VNV: ['VNV', 'Vertical navigation (not simulated)'], BC: ['BC', 'Back course (not simulated)'],
  NOSE_UP: ['Nose up', 'Vertical speed +100 fpm (FLC: −1 kt)'], NOSE_DN: ['Nose down', 'Vertical speed −100 fpm (FLC: +1 kt)'],
};

/** Tooltip title and hint for a control (softkeys show their current label). */
export function controlInfo(c: BezelControl, softkeyLabel = ''): { title: string; hint: string } {
  if (c.kind === 'softkey') return { title: softkeyLabel ? `Softkey ${softkeyLabel}` : 'Softkey', hint: softkeyLabel ? 'Click to press' : 'No function on this page' };
  if (c.kind === 'knob') { const [title, hint] = KNOB_INFO[c.id]; return { title, hint }; }
  const info = BUTTON_INFO[c.id];
  return info ? { title: info[0], hint: info[1] } : { title: `${c.id} key`, hint: 'Autopilot mode key' };
}

/**
 * Draw the bezel (everything outside the screen) in bezel design units. `hover` gets a cyan
 * outline. The screen area is left alone: the PFD/MFD drawing fills it.
 */
export function drawBezel(ctx: Ctx2D, display: G1000Display, hover: BezelControl | null): void {
  const B = BEZEL;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, B.width, B.screenY); ctx.fillRect(0, B.screenY + B.screenH, B.width, B.height - B.screenY - B.screenH);
  ctx.fillRect(0, B.screenY, B.screenX, B.screenH); ctx.fillRect(B.screenX + B.screenW, B.screenY, B.width - B.screenX - B.screenW, B.screenH);
  // bevelled edge and the screen frame
  ctx.strokeStyle = '#33373c'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, B.width - 6, B.height - 6);
  ctx.strokeStyle = '#08090a'; ctx.lineWidth = 8; ctx.strokeRect(B.screenX - 4, B.screenY - 4, B.screenW + 8, B.screenH + 8);
  text(ctx, display === 'pfd' ? 'PFD' : 'MFD', B.width / 2, B.height - 40, condBold.get(18), '#5d636b', 'center');
  const hk = hover ? controlKey(hover) : '';
  for (let i = 0; i < PFD.softkeyCount; i++) {
    const w = B.screenW / PFD.softkeyCount, x = B.screenX + i * w + 10;
    keyCap(ctx, x, B.keyY, w - 20, B.keyH, hk === `softkey:${i}`);
  }
  for (const k of KEYS) {
    keyCap(ctx, k.x, k.y, k.w, k.h, hk === `button:${k.id}`);
    const cy = k.y + k.h / 2;
    if (k.sub) {
      text(ctx, k.sub, k.x + k.w / 2, cy - 8, cond.get(11), G.white, 'center');
      text(ctx, k.label, k.x + k.w / 2, cy + 7, condBold.get(15), G.white, 'center');
    } else text(ctx, k.label, k.x + k.w / 2, cy + 1, condBold.get(k.label.length > 3 ? 15 : 17), G.white, 'center');
  }
  for (const k of KNOBS) knob(ctx, k, hk === `knob:${k.id}`);
}

function keyCap(ctx: Ctx2D, x: number, y: number, w: number, h: number, hot: boolean): void {
  ctx.fillStyle = '#0b0c0d'; ctx.fillRect(x - 1, y - 1, w + 2, h + 3);
  ctx.fillStyle = '#2c3035'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#3a3f45'; ctx.fillRect(x, y, w, 3);
  if (hot) { ctx.strokeStyle = G.cyan; ctx.lineWidth = 2; ctx.strokeRect(x - 2, y - 2, w + 4, h + 4); }
}

function knob(ctx: Ctx2D, k: KnobDef, hot: boolean): void {
  const { cx, cy, r, rInner } = k;
  if (k.label) text(ctx, k.label, cx, cy - r - 10, condBold.get(13), G.white, 'center');
  if (k.sub) text(ctx, k.sub, cx, cy + r + 9, cond.get(10), '#c8ccd0', 'center');
  ctx.fillStyle = '#070809';
  ctx.beginPath(); ctx.arc(cx, cy + 2, r + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a2d31';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  // knurling
  ctx.strokeStyle = '#43484e'; ctx.lineWidth = 2;
  ctx.beginPath();
  const n = Math.round(r * 0.8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    ctx.moveTo(cx + c * (r - 6), cy + s * (r - 6)); ctx.lineTo(cx + c * (r - 1), cy + s * (r - 1));
  }
  ctx.stroke();
  if (rInner > 0) {
    ctx.fillStyle = '#121416'; ctx.beginPath(); ctx.arc(cx, cy, rInner + 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#34383d'; ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#4b5056'; ctx.beginPath(); ctx.arc(cx - r * 0.18, cy - r * 0.22, Math.max(3, (rInner || r) * 0.25), 0, Math.PI * 2); ctx.fill();
  if (hot) { ctx.strokeStyle = G.cyan; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.stroke(); }
}
