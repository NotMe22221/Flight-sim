/**
 * Test rig for the interactive G1000: a G1000 on mock canvases wired like the simulator wires
 * it (nav database, flight planner, a command log) plus a frame loop in the simulator's order.
 */
import type { SimSnapshot } from '../../core/types';
import { FlightPlanner, NavDb, waypointFromAirport } from '../../nav';
import { countingLoader } from '../../nav/__tests__/fsLoader';
import type { G1000Fms } from '../g1000/fms';
import { G1000 } from '../g1000/G1000';
import type { G1000Command, G1000Display, G1000Input } from '../g1000/input';
import { MockCanvasFactory, type MockContext2D } from './mockCanvas';
import { makeSampleSnapshot } from './sampleSnapshot';

/** The real nav database around the Bay Area (≈1 s to load). */
export async function loadTestNav(): Promise<NavDb> {
  const nav = new NavDb(countingLoader());
  await nav.loadRegion({ lat: 37.62, lon: -122.37, alt: 0 }, 40);
  return nav;
}

/** A G1000 wired like the simulator: nav database, flight planner, a command log, and a loop. */
export function makeRig(nav: NavDb, ids: string[] = [], opts: { bezel?: boolean } = {}) {
  const planner = new FlightPlanner(ids.map((i) => waypointFromAirport(nav.getAirport(i)!)));
  const cmds: G1000Command[] = [];
  const factory = new MockCanvasFactory();
  const g = new G1000({ nav, planner, onCommand: (c) => cmds.push(c), createCanvas: (w, h) => factory.create(w, h), bezel: opts.bezel });
  const s: SimSnapshot = makeSampleSnapshot();
  s.aircraft.geo.lat = 37.60; s.aircraft.geo.lon = -122.30;
  // the simulator's per-frame order: planner → snapshot.plan → G1000
  const frame = (n = 1) => { for (let i = 0; i < n; i++) { s.time.simTimeS += 0.1; s.time.utcMs += 100; s.plan = planner.update(s.aircraft.geo, s.aircraft.groundSpeedMs); g.update(s, 0.1); } };
  const input = (e: G1000Input) => g.handleInput(e);
  const btn = (display: G1000Display, id: Extract<G1000Input, { type: 'button' }>['id']) => input({ type: 'button', display, id });
  const knob = (display: G1000Display, id: Extract<G1000Input, { type: 'knob' }>['id'], steps: number, ring: 'inner' | 'outer' = 'inner') => input({ type: 'knob', display, id, ring, steps });
  const type = (display: G1000Display, text: string) => { for (const c of text) input({ type: 'char', display, char: c }); };
  const pfdCtx = (g.pfdCanvas as unknown as { ctx: MockContext2D }).ctx;
  const mfdCtx = (g.mfdCanvas as unknown as { ctx: MockContext2D }).ctx;
  frame();
  return { g, f: g.fms as G1000Fms, planner, cmds, s, frame, input, btn, knob, type, pfdCtx, mfdCtx };
}

/** Text drawn with its fill colour (the mock records calls but not the style at call time). */
export function colouredTexts(ctx: MockContext2D): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const orig = ctx.fillText.bind(ctx);
  ctx.fillText = (t: string, x: number, y: number, mw?: number) => {
    const list = out.get(t) ?? [];
    list.push(String(ctx.fillStyle));
    out.set(t, list);
    orig(t, x, y, mw);
  };
  return out;
}

