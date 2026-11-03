/**
 * PFD and MFD softkey menus (G1000 NXi layout for the 172). Implemented keys: PFD — INSET
 * (inset map: OFF, DCLTR), PFD (DFLTS, WIND, DME, BRG1, BRG2, STD BARO), OBS (GPS OBS mode), CDI
 * (GPS → NAV1 → NAV2), DME, XPDR (STBY/ON/ALT, VFR, CODE entry, IDENT), IDENT, TMR/REF, NRST,
 * ALERTS; MFD — MAP (map orientation), DCLTR, ACT LEG (FPL page), APT/VOR/NDB (NRST pages).
 * Every other key is shown with its NXi label and does nothing. ALERTS is always key 12.
 */
import { DirectToWindow } from './directTo';
import type { G1000Fms } from './fms';
import { AlertsWindow, TimerRefWindow } from './fmsWindows';
import type { MapOrientation } from './map';
import type { BearingSource } from './navData';

export type PfdMenu = 'root' | 'inset' | 'pfd' | 'xpdr' | 'code';
export type MfdMenu = 'root' | 'map';

const K = (labels: string[]): readonly string[] => Object.freeze(labels);
export const PFD_MENUS: Readonly<Record<PfdMenu, readonly string[]>> = Object.freeze({
  root: K(['INSET', '', 'PFD', 'OBS', 'CDI', 'DME', 'XPDR', 'IDENT', 'TMR/REF', 'NRST', '', 'ALERTS']),
  inset: K(['OFF', 'DCLTR', 'WX LGND', 'TRAFFIC', 'TOPO', 'TERRAIN', 'STRMSCP', 'NEXRAD', 'XM LTNG', '', 'BACK', 'ALERTS']),
  pfd: K(['SYN VIS', 'DFLTS', 'WIND', 'DME', 'BRG1', 'HSI FRMT', 'BRG2', '', 'ALT UNIT', 'STD BARO', 'BACK', 'ALERTS']),
  xpdr: K(['', '', 'STBY', 'ON', 'ALT', '', 'VFR', 'CODE', 'IDENT', '', 'BACK', 'ALERTS']),
  code: K(['0', '1', '2', '3', '4', '5', '6', '7', 'IDENT', 'BKSP', 'BACK', 'ALERTS']),
});
export const MFD_MENUS = Object.freeze({
  map: K(['ENGINE', '', 'MAP', '', '', '', '', '', 'DCLTR', 'SHW CHRT', 'CHKLIST', '']),
  fpl: K(['ENGINE', '', 'MAP', 'NEW WPT', 'VIEW', 'VNV PROF', 'CNCL VNV', 'VNV ⇨', 'ATK OFST', 'ACT LEG', 'SHW CHRT', 'CHKLIST']),
  nrst: K(['ENGINE', '', 'MAP', '', '', 'APT', 'VOR', 'NDB', '', '', 'SHW CHRT', 'CHKLIST']),
  mapOpt: K(['TRAFFIC', 'PROFILE', 'TOPO', 'TERRAIN', 'STRMSCP', 'NEXRAD', 'XM LTNG', 'NORTH UP', '', '', 'BACK', '']),
});
const DCLTR = ['DCLTR', 'DCLTR-1', 'DCLTR-2', 'DCLTR-3'];
const ORIENT: readonly MapOrientation[] = ['north-up', 'track-up', 'heading-up'];
const ORIENT_LABEL: Record<MapOrientation, string> = { 'north-up': 'NORTH UP', 'track-up': 'TRK UP', 'heading-up': 'HDG UP' };
/** Transponder IDENT duration, s. */
export const IDENT_S = 18;

const bit = (i: number, on: boolean): number => (on ? 1 << i : 0);

/** Refresh the labels and highlight masks the displays draw. */
export function syncSoftkeys(f: G1000Fms): void {
  const p = f.pfd, m = f.mfd;
  const pl = p.softkeys, base = PFD_MENUS[f.pfdMenu];
  for (let i = 0; i < 12; i++) pl[i] = base[i];
  const top = f.pfdWindow();
  switch (f.pfdMenu) {
    case 'root':
      p.softkeyMask = bit(0, p.insetOn) | bit(3, !!f.planner && f.planner.obsCourseDeg !== null) | bit(5, p.dmeSource !== 'OFF')
        | bit(7, p.identS > 0) | bit(8, top?.kind === 'tmrref') | bit(9, top?.kind === 'nrst') | bit(11, top?.kind === 'alerts');
      break;
    case 'inset': pl[1] = DCLTR[p.insetDeclutter & 3]; p.softkeyMask = bit(1, p.insetDeclutter > 0); break;
    case 'pfd': p.softkeyMask = bit(2, p.windOn) | bit(3, p.dmeSource !== 'OFF') | bit(4, p.brg1.source !== 'OFF') | bit(6, p.brg2.source !== 'OFF'); break;
    case 'xpdr': p.softkeyMask = bit(2, p.xpdrMode === 'STBY') | bit(3, p.xpdrMode === 'ON') | bit(4, p.xpdrMode === 'ALT') | bit(6, p.squawk === 1200) | bit(8, p.identS > 0); break;
    case 'code': p.softkeyMask = bit(8, p.identS > 0); break;
  }
  const ml = m.softkeys;
  const mbase = f.mfdMenu === 'map' ? MFD_MENUS.mapOpt : f.mfdGroup === 1 ? MFD_MENUS.fpl : f.mfdGroup === 2 ? MFD_MENUS.nrst : MFD_MENUS.map;
  for (let i = 0; i < 12; i++) ml[i] = mbase[i];
  if (f.mfdMenu === 'map') { ml[7] = ORIENT_LABEL[m.orientation]; m.softkeyMask = 0; }
  else if (f.mfdGroup === 2) m.softkeyMask = bit(5 + f.mfdPageIndex, true);
  else if (f.mfdGroup === 0) { ml[8] = DCLTR[m.declutter & 3]; m.softkeyMask = bit(8, m.declutter > 0); }
  else m.softkeyMask = 0;
}

/** Press PFD softkey `i` (0–11). Returns false for keys that do nothing. */
export function pressPfdSoftkey(f: G1000Fms, i: number): boolean {
  const p = f.pfd;
  if (i === 11) { f.togglePfd('alerts', () => new AlertsWindow(f)); return true; }
  switch (f.pfdMenu) {
    case 'root':
      switch (i) {
        case 0: p.insetOn = true; f.pfdMenu = 'inset'; return true;
        case 2: f.pfdMenu = 'pfd'; return true;
        case 3: return toggleObs(f);
        case 4: f.setCdiSource(p.cdiSource === 'GPS' ? 'NAV1' : p.cdiSource === 'NAV1' ? 'NAV2' : 'GPS'); return true;
        case 5: cycleDme(f); return true;
        case 6: f.pfdMenu = 'xpdr'; return true;
        case 7: ident(f); return true;
        case 8: f.togglePfd('tmrref', () => new TimerRefWindow(f, p, f.timer)); return true;
        case 9: f.togglePfd('nrst', () => f.pfdNrstWindow()); return true;
      }
      return false;
    case 'inset':
      if (i === 0) { p.insetOn = false; f.pfdMenu = 'root'; return true; }
      if (i === 1) { p.insetDeclutter = (p.insetDeclutter + 1) & 3; return true; }
      if (i === 10) { f.pfdMenu = 'root'; return true; }
      return false;
    case 'pfd':
      switch (i) {
        case 1: p.windOn = true; p.windOption = 1; p.dmeSource = 'NAV1'; setBrg(f, 1, 'NAV1'); setBrg(f, 2, 'GPS'); return true;
        case 2: if (!p.windOn) { p.windOn = true; p.windOption = 1; } else if (p.windOption === 1) p.windOption = 2; else p.windOn = false; return true;
        case 3: cycleDme(f); return true;
        case 4: setBrg(f, 1, p.brg1.source === 'OFF' ? 'NAV1' : p.brg1.source === 'NAV1' ? 'GPS' : 'OFF'); return true;
        case 6: setBrg(f, 2, p.brg2.source === 'OFF' ? 'NAV2' : p.brg2.source === 'NAV2' ? 'GPS' : 'OFF'); return true;
        case 9: f.emit({ kind: 'baroStd' }); return true;
        case 10: f.pfdMenu = 'root'; return true;
      }
      return false;
    case 'xpdr':
      switch (i) {
        case 2: p.xpdrMode = 'STBY'; f.emitXpdr(); return true;
        case 3: p.xpdrMode = 'ON'; f.emitXpdr(); return true;
        case 4: p.xpdrMode = 'ALT'; f.emitXpdr(); return true;
        case 6: p.squawk = 1200; f.emitXpdr(); return true;
        case 7: f.codeEntry = ''; f.pfdMenu = 'code'; return true;
        case 8: ident(f); return true;
        case 10: f.pfdMenu = 'root'; return true;
      }
      return false;
    case 'code':
      if (i <= 7) {
        f.codeEntry += String(i);
        if (f.codeEntry.length === 4) { p.squawk = Number(f.codeEntry); f.codeEntry = ''; f.pfdMenu = 'xpdr'; f.emitXpdr(); }
        return true;
      }
      if (i === 8) { ident(f); return true; }
      if (i === 9) { f.codeEntry = f.codeEntry.slice(0, -1); return true; }
      if (i === 10) { f.codeEntry = ''; f.pfdMenu = 'xpdr'; return true; }
      return false;
  }
  return false;
}

/** Press MFD softkey `i` (0–11). */
export function pressMfdSoftkey(f: G1000Fms, i: number): boolean {
  const m = f.mfd;
  if (f.mfdMenu === 'map') {
    if (i === 7) { m.orientation = ORIENT[(ORIENT.indexOf(m.orientation) + 1) % ORIENT.length]; return true; }
    if (i === 10) { f.mfdMenu = 'root'; return true; }
    return false;
  }
  if (i === 2) { f.mfdMenu = 'map'; return true; }
  if (f.mfdGroup === 0 && i === 8) { m.declutter = (m.declutter + 1) & 3; return true; }
  if (f.mfdGroup === 1 && i === 9) { f.fplPage.activateSelected(); return true; }
  if (f.mfdGroup === 2 && i >= 5 && i <= 7) { f.setMfdPage(2, i - 5); return true; }
  return false;
}

function toggleObs(f: G1000Fms): boolean {
  const pl = f.planner;
  if (!pl || f.pfd.cdiSource !== 'GPS') return false;
  if (pl.obsCourseDeg !== null) pl.setObs(null);
  else {
    const plan = f.plan;
    if (!plan || !pl.activeWaypoint) return false;
    pl.setObs(Math.round(plan.desiredTrackDeg - f.magVarDeg) + f.magVarDeg);
  }
  return true;
}

function cycleDme(f: G1000Fms): void {
  const p = f.pfd;
  p.dmeSource = p.dmeSource === 'OFF' ? 'NAV1' : p.dmeSource === 'NAV1' ? 'NAV2' : 'OFF';
}

function setBrg(f: G1000Fms, which: 1 | 2, src: BearingSource): void {
  const b = which === 1 ? f.pfd.brg1 : f.pfd.brg2;
  b.source = src; b.label = src;
}

function ident(f: G1000Fms): void {
  f.pfd.identS = IDENT_S;
  f.emitXpdr();
}

/** D→ from code: open the Direct-To window on a display, prefilled (used by tests and hotkeys). */
export function openDirectTo(f: G1000Fms, display: 'pfd' | 'mfd'): DirectToWindow {
  const w = new DirectToWindow(f, null);
  f.open(display, w);
  return w;
}
