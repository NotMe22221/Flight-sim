/**
 * What the UI shows about an aircraft, derived from its `AircraftConfig` (pure, no simulator access):
 * landing gear (tricycle / tail-wheel), panel, autopilot, seats, a one-line blurb for the aircraft
 * picker, and which checklists the in-flight checklist panel shows.
 */
import type { AircraftConfig } from '../core/types';
import { C172_CHECKLISTS, type ChecklistSection } from './data/c172Checklists';
import { CUB_CHECKLISTS } from './data/cubChecklists';

/** Tail-wheel when a steerable or castering wheel sits behind the CG (body x < 0), else tricycle. */
export function gearKind(a: Pick<AircraftConfig, 'gear'>): 'Tail-wheel' | 'Tricycle' {
  return a.gear.some((g) => g.type === 'wheel' && g.pos[0] < 0 && (g.maxSteerDeg > 0 || g.casters)) ? 'Tail-wheel' : 'Tricycle';
}

/** Panel kind as the aircraft picker names it. */
export function panelKind(a: Pick<AircraftConfig, 'panel'>): string {
  return a.panel.includes('g1000') ? 'G1000' : a.panel.includes('pfd') ? 'Glass' : 'Steam gauges';
}

/** True when the aircraft has an autopilot (the Super Cub's 'cub-steam' panel has none). */
export function hasAutopilot(a: Pick<AircraftConfig, 'panel'>): boolean { return a.panel !== 'cub-steam'; }

/** Seats: one per seat station (stations named 'Baggage' do not count). */
export function seatCount(a: Pick<AircraftConfig, 'mass'>): number {
  return a.mass.stations.filter((s) => !/baggage|cargo/i.test(s.name)).length || 1;
}

/** One sentence for the aircraft picker. */
export function aircraftBlurb(a: AircraftConfig): string {
  if (a.panel === 'cub-steam') return 'Fabric-covered tail-dragger for bush flying: short take-offs and landings on grass, tandem seats, a simple VFR panel and no autopilot. Keep your feet busy on the rudder.';
  if (a.panel === 'c172-g1000') return 'The Skyhawk with a G1000 glass cockpit (PFD and MFD) and a GFC 700 autopilot.';
  if (a.panel === 'c172-steam') return 'The classic four-seat trainer: stable and forgiving, with the six-pack steam gauges and a KAP 140-style autopilot.';
  return `${a.manufacturer} ${a.name}`;
}

/** Checklists for the aircraft being flown (the 172's when unknown). */
export function checklistsFor(a: Pick<AircraftConfig, 'airframe'> | null | undefined): ChecklistSection[] {
  return a?.airframe === 'cub' ? CUB_CHECKLISTS : C172_CHECKLISTS;
}
