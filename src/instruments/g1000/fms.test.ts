import { beforeAll, describe, expect, it } from 'vitest';
import { NM } from '../../core/units';
import type { NavDb } from '../../nav';
import { colouredTexts, loadTestNav, makeRig } from '../testing/g1000Rig';
import { DirectToWindow } from './directTo';
import { formatHeadingNum } from '../format';
import { bearingDegGeo, distanceNmGeo } from './fmsCore';
import { FplWindow } from './fplWindow';
import { G } from './palette';
import { resolveCdi, createCdiState } from './navData';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });

const rig = (ids: string[] = []) => makeRig(nav, ids);

describe('Direct-To', () => {
  it('D→ · type KOAK · ENT · ENT flies direct from the present position; snapshot plan and HSI follow', () => {
    const r = rig();
    r.btn('mfd', 'DIRECT');
    const w = r.f.mfdPopups.at(-1) as DirectToWindow;
    expect(w).toBeInstanceOf(DirectToWindow);
    expect(r.g.wantsKeyboard).toBe(true);
    r.type('mfd', 'KOA');
    expect(w.field.text).toBe('KOA');
    expect(w.field.completion).toBe('KOAK'); // spell'n'find
    expect(w.matches[0].ident).toBe('KOAK');
    r.btn('mfd', 'ENT'); // accept the ident → cursor on ACTIVATE?
    expect(w.focus).toBe(w.activateIndex);
    r.btn('mfd', 'ENT'); // activate
    expect(r.f.mfdPopups.length).toBe(0);
    expect(r.planner.waypoints.map((x) => x.id)).toEqual(['KOAK']);
    r.frame();
    const plan = r.s.plan!;
    expect(plan.waypoints[plan.activeLeg].id).toBe('KOAK');
    const koak = nav.getAirport('KOAK')!;
    expect(plan.distanceToActiveM / NM).toBeCloseTo(nav.searchIdents('KOAK', r.s.aircraft.geo, 1)[0].distanceM / NM, 1);
    expect(Math.abs(plan.crossTrackM)).toBeLessThan(5);
    // the HSI course pointer (GPS) shows the D→ course, magenta
    const cdi = resolveCdi(r.s, 'GPS', 13, createCdiState());
    expect(cdi.ident).toBe('KOAK');
    expect(cdi.color).toBe(G.magenta);
    expect(cdi.courseDeg).toBeCloseTo(((plan.desiredTrackDeg - 13) % 360 + 360) % 360, 6);
    expect(koak.icao).toBe('KOAK');
  });

  it('spells an ident with the FMS knobs: inner changes the character, outer moves the cursor', () => {
    const r = rig();
    r.btn('pfd', 'DIRECT');
    const w = r.f.pfdWindow() as DirectToWindow;
    expect(w.display).toBe('pfd');
    r.knob('pfd', 'FMS', 11); // A + 10 → K
    expect(w.field.text).toBe('K');
    expect(w.field.completion.startsWith('K')).toBe(true);
    r.knob('pfd', 'FMS', 1, 'outer'); // cursor right adopts the completion's 2nd letter
    expect(w.field.pos).toBe(1);
    r.knob('pfd', 'FMS', 'O'.charCodeAt(0) - w.field.text.charCodeAt(1)); // step it to 'O'
    expect(w.field.text).toBe('KO');
    r.knob('pfd', 'FMS', 1, 'outer');
    r.knob('pfd', 'FMS', 'A'.charCodeAt(0) - w.field.text.charCodeAt(2));
    expect(w.field.text).toBe('KOA');
    expect(w.field.shown).toBe('KOAK');
    r.btn('pfd', 'ENT'); r.btn('pfd', 'ENT');
    expect(r.planner.activeWaypoint?.id).toBe('KOAK');
  });

  it('goes direct to a VOR (duplicate ident: picked from the match list) and to an NDB', () => {
    const r = rig();
    r.btn('mfd', 'DIRECT'); r.type('mfd', 'OAK'); r.btn('mfd', 'ENT');
    const w = r.f.mfdPopups.at(-1) as DirectToWindow;
    // OAK is both the VORTAC and KOAK's IATA code: ENT moves the cursor into the match list
    expect(w.focus).toBe(1);
    expect(w.message).toContain('DUPLICATE');
    const vorRow = w.matches.findIndex((m) => m.kind === 'vor' && m.ident === 'OAK');
    expect(vorRow).toBeGreaterThanOrEqual(0);
    r.knob('mfd', 'FMS', vorRow); // inner knob scrolls the list
    r.btn('mfd', 'ENT');
    expect(w.target?.kind).toBe('vor');
    expect(w.focus).toBe(w.activateIndex);
    r.btn('mfd', 'ENT');
    expect(r.planner.activeWaypoint).toMatchObject({ id: 'OAK', type: 'navaid' });
    const ndb = nav.navaids.find((n) => n.type === 'NDB' && Math.abs(n.position.lat - 37.6) < 1.5 && Math.abs(n.position.lon + 122.3) < 1.5)!;
    expect(ndb).toBeDefined();
    r.btn('mfd', 'DIRECT'); r.type('mfd', ndb.id); r.btn('mfd', 'ENT'); r.btn('mfd', 'ENT');
    expect(r.planner.activeWaypoint?.id).toBe(ndb.id);
  });

  it('an off-plan D→ keeps the stored plan (off-route); CLR closes; MENU cancels the D→', () => {
    const r = rig(['KSFO', 'KHWD', 'KLVK']);
    r.btn('mfd', 'DIRECT'); r.type('mfd', 'KOAK'); r.btn('mfd', 'ENT'); r.btn('mfd', 'ENT');
    expect(r.planner.waypoints.map((x) => x.id)).toEqual(['KSFO', 'KHWD', 'KLVK']);
    expect(r.planner.offRouteTarget?.id).toBe('KOAK');
    r.frame();
    expect(r.s.plan!.waypoints[0].id).toBe('KOAK');
    // MENU in the D→ window → CANCEL DIRECT-TO NAV? → ENT
    r.btn('mfd', 'DIRECT');
    r.btn('mfd', 'MENU');
    expect(r.f.mfdPopups.at(-1)!.kind).toBe('confirm');
    r.btn('mfd', 'ENT');
    expect(r.planner.isDirectTo).toBe(false);
    expect(r.planner.activeWaypoint?.id).toBe('KHWD');
    r.btn('mfd', 'CLR'); // closes the D→ window (not editing)
    expect(r.f.mfdPopups.length).toBe(0);
    // an unknown ident cannot be activated
    r.btn('pfd', 'DIRECT'); r.type('pfd', 'QQQQ'); r.btn('pfd', 'ENT');
    expect((r.f.pfdWindow() as DirectToWindow).message).toBe('NO MATCH');
  });
});

describe('FPL page', () => {
  const TEN = ['KSFO', 'KOAK', 'KHWD', 'KLVK', 'KCCR', 'KAPC', 'KSTS', 'KDVO', 'KSQL', 'KPAO', 'KSJC'];

  it('lists 11 waypoints with DTK / DIS / ETE, the active leg in magenta', () => {
    const r = rig(TEN);
    r.planner.activateLeg(3);
    r.btn('mfd', 'FPL');
    expect(r.f.mfdPage()).toBeInstanceOf(FplWindow);
    expect(r.g.fms.mfd.title).toBe('FPL - ACTIVE FLIGHT PLAN');
    const col = colouredTexts(r.mfdCtx);
    r.frame(2);
    for (const id of TEN) expect(col.has(id)).toBe(true);
    expect(col.get('KLVK')).toContain(G.magenta); // active waypoint
    expect(col.get('KOAK')).toContain(G.grey); // past
    expect(col.get('KSJC')).toContain(G.white); // future
    for (const h of ['DTK', 'DIS', 'ETE']) expect(col.has(h)).toBe(true);
  });

  it('DTK (magnetic) and DIS: future legs from the great circle, the active leg matches the nav status bar', () => {
    const r = rig();
    // a long leg (≈ 650 nm) so the along-track DTK differs from the leg's initial course by degrees
    const a = { lat: 37.6, lon: -122.3, alt: 0 }, b = { lat: 30.0, lon: -110.0, alt: 0 }, c = { lat: 30.0, lon: -100.0, alt: 0 };
    r.planner.setWaypoints([{ id: 'AAA', position: a, type: 'user' }, { id: 'BBB', position: b, type: 'user' }, { id: 'CCC', position: c, type: 'user' }]);
    r.s.aircraft.geo.lat = 33.9; r.s.aircraft.geo.lon = -116.4; // about half way along AAA → BBB
    r.btn('mfd', 'FPL');
    const col = colouredTexts(r.mfdCtx);
    r.frame(2);
    const mv = r.g.model.readings.heading.magVarDeg;
    const fmt = (trueDeg: number) => `${formatHeadingNum(trueDeg - mv)}°`;
    const along = r.s.plan!.desiredTrackDeg, initial = bearingDegGeo(a, b);
    expect(Math.abs(along - initial)).toBeGreaterThan(2);
    // the active row (BBB, magenta) shows the along-track DTK, as the status bar's DTK field does
    const magentaTexts = [...col].filter(([, cs]) => cs.includes(G.magenta)).map(([t]) => t);
    expect(magentaTexts).toContain(fmt(along));
    expect(magentaTexts).not.toContain(fmt(initial));
    expect(col.has(fmt(along))).toBe(true);
    // the next leg (BBB → CCC) shows its initial great-circle course and length in white
    expect(col.get(fmt(bearingDegGeo(b, c)))).toContain(G.white);
    expect(col.get(`${Math.round(distanceNmGeo(b, c))}NM`)).toContain(G.white);
  });

  it('inserts a spelled waypoint before the cursor row and appends on the last row (through the FlightPlanner)', () => {
    const r = rig(['KSFO', 'KLVK']);
    r.btn('mfd', 'FPL');
    r.input({ type: 'push', display: 'mfd', id: 'FMS' }); // cursor on
    const page = r.f.fplPage;
    expect(page.cursor).toBe(true);
    r.knob('mfd', 'FMS', 1, 'outer'); // select KLVK
    r.type('mfd', 'KOAK');
    expect(page.entry?.text).toBe('KOAK');
    r.btn('mfd', 'ENT');
    expect(r.planner.waypoints.map((w) => w.id)).toEqual(['KSFO', 'KOAK', 'KLVK']);
    // the cursor stays on KLVK; go to the empty last row and append two more
    r.knob('mfd', 'FMS', 5, 'outer');
    expect(page.sel).toBe(3);
    r.type('mfd', 'KHWD'); r.btn('mfd', 'ENT');
    r.type('mfd', 'KSQL'); r.btn('mfd', 'ENT');
    expect(r.planner.waypoints.map((w) => w.id)).toEqual(['KSFO', 'KOAK', 'KLVK', 'KHWD', 'KSQL']);
    r.frame();
    expect(r.s.plan!.waypoints.length).toBe(5);
  });

  it('CLR + ENT removes the selected waypoint; MENU → ACTIVATE LEG; ACT LEG softkey; DELETE FLIGHT PLAN', () => {
    const r = rig(TEN);
    r.btn('mfd', 'FPL');
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    r.knob('mfd', 'FMS', 2, 'outer'); // KHWD
    r.btn('mfd', 'CLR');
    expect(r.f.mfdPopups.at(-1)!.kind).toBe('confirm');
    r.btn('mfd', 'ENT');
    expect(r.planner.indexOfId('KHWD')).toBe(-1);
    expect(r.planner.waypoints.length).toBe(TEN.length - 1);
    // CLR then CLR cancels
    r.btn('mfd', 'CLR'); r.btn('mfd', 'CLR');
    expect(r.planner.waypoints.length).toBe(TEN.length - 1);
    // MENU → ACTIVATE LEG → confirm
    r.knob('mfd', 'FMS', 3, 'outer'); // row 5 (KAPC after the removal)
    const target = r.planner.waypoints[5].id;
    r.btn('mfd', 'MENU');
    expect(r.f.mfdPopups.at(-1)!.kind).toBe('menu');
    r.btn('mfd', 'ENT'); // ACTIVATE LEG (first item)
    r.btn('mfd', 'ENT'); // confirm
    expect(r.planner.activeWaypoint?.id).toBe(target);
    // the ACT LEG softkey does the same
    r.knob('mfd', 'FMS', 2, 'outer');
    const t2 = r.planner.waypoints[7].id;
    r.input({ type: 'softkey', display: 'mfd', index: 9 });
    r.btn('mfd', 'ENT');
    expect(r.planner.activeWaypoint?.id).toBe(t2);
    // D→ with the cursor on a waypoint goes direct to it (in plan)
    r.knob('mfd', 'FMS', -4, 'outer');
    const t3 = r.planner.waypoints[3].id;
    r.btn('mfd', 'DIRECT');
    expect((r.f.mfdPopups.at(-1) as DirectToWindow).target?.ident).toBe(t3);
    r.btn('mfd', 'ENT');
    expect(r.planner.activeLeg).toBe(3);
    expect(r.planner.isDirectTo).toBe(true);
    // MENU → DELETE FLIGHT PLAN (second item) → confirm
    r.btn('mfd', 'MENU'); r.knob('mfd', 'FMS', 1); r.btn('mfd', 'ENT'); r.btn('mfd', 'ENT');
    expect(r.planner.waypoints.length).toBe(0);
  });

  it('the PFD FPL key toggles the PFD flight-plan window', () => {
    const r = rig(TEN);
    r.btn('pfd', 'FPL');
    expect(r.f.pfdWindow()).toBeInstanceOf(FplWindow);
    const col = colouredTexts(r.pfdCtx);
    r.frame(2);
    expect(col.has('ACTIVE FLIGHT PLAN')).toBe(true);
    r.btn('pfd', 'FPL');
    expect(r.f.pfdWindow()).toBeNull();
  });
});
