/**
 * Pure view model for Settings › Controls: groups host.bindings() rows, flags conflicts
 * (the same key/button label on the same device bound to two actions) and filters by text.
 */
import type { SimAction } from '../core/types';
import type { BindingInfo, UiHost } from './UiHost';
import { humanizeAction } from './dom';

export type BindingProfileId = Parameters<UiHost['resetBindings']>[0];

export const BINDING_PROFILES: { id: BindingProfileId; label: string; help: string }[] = [
  { id: 'msfs', label: 'MSFS keyboard', help: 'Default Microsoft Flight Simulator keys' },
  { id: 'laptop', label: 'Laptop', help: 'Pitch/roll on the arrow keys, rudder on Q/E' },
  { id: 'gamepad-xbox', label: 'Xbox gamepad', help: 'MSFS Xbox controller layout' },
  { id: 'joystick-generic', label: 'Generic joystick', help: 'Stick axes plus common buttons' },
];

export type DeviceFilter = 'all' | 'keyboard' | 'gamepad' | 'mouse';

export interface BindingRowView {
  info: BindingInfo;
  /** 'Engine auto start' */ title: string;
  /** other actions sharing this exact input */ conflictWith: SimAction[];
  unbound: boolean;
}

export interface BindingGroupView { group: string; rows: BindingRowView[] }

const keyOf = (b: BindingInfo): string | null => {
  const label = b.label.trim().toLowerCase();
  return b.device === 'none' || label === '' ? null : `${b.device}:${label}`;
};

/** action → other actions bound to the same input on the same device. */
export function bindingConflicts(list: readonly BindingInfo[]): Map<SimAction, SimAction[]> {
  const byKey = new Map<string, SimAction[]>();
  for (const b of list) {
    const k = keyOf(b);
    if (!k) continue;
    const arr = byKey.get(k);
    if (arr) { if (!arr.includes(b.action)) arr.push(b.action); } else byKey.set(k, [b.action]);
  }
  const out = new Map<SimAction, SimAction[]>();
  for (const actions of byKey.values()) {
    if (actions.length < 2) continue;
    for (const a of actions) out.set(a, actions.filter((x) => x !== a));
  }
  return out;
}

/** True when `b` matches the free-text query (action title, key label or group). */
export function bindingMatches(b: BindingInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return humanizeAction(b.action).toLowerCase().includes(q) || b.label.toLowerCase().includes(q) || b.group.toLowerCase().includes(q) || b.action.toLowerCase().includes(q);
}

/** Groups in first-appearance order; rows keep the host's order. Empty groups are dropped. */
export function bindingGroups(list: readonly BindingInfo[], query = '', device: DeviceFilter = 'all'): BindingGroupView[] {
  const conflicts = bindingConflicts(list);
  const groups = new Map<string, BindingRowView[]>();
  for (const b of list) {
    if (device !== 'all' && b.device !== device && b.device !== 'none') continue;
    if (!bindingMatches(b, query)) continue;
    const g = b.group || 'Other';
    let rows = groups.get(g);
    if (!rows) { rows = []; groups.set(g, rows); }
    rows.push({ info: b, title: humanizeAction(b.action), conflictWith: conflicts.get(b.action) ?? [], unbound: keyOf(b) === null });
  }
  return Array.from(groups, ([group, rows]) => ({ group, rows }));
}

/** Total number of actions involved in a conflict (for the tab badge). */
export function conflictCount(list: readonly BindingInfo[]): number { return bindingConflicts(list).size; }
