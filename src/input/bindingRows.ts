/**
 * Builds the rows the controls page / help sheet show: one row per SimAction (compatible
 * with the UI's `BindingInfo`), plus rows for axis keys and input-local actions.
 */
import type { SimAction } from '../core/types';
import { LOCAL_ACTIONS, LOCAL_ACTION_META, SIM_ACTIONS, SIM_ACTION_META, axisTitle } from './actions';
import { type Binding, type BindingProfile, bindingLabel, isActionBinding, targetKey } from './bindings';

export type RowDevice = 'keyboard' | 'gamepad' | 'mouse' | 'none';

/** One SimAction with its bindings (assignable to the UI's `BindingInfo`). */
export interface BindingRow {
  action: SimAction;
  title: string;
  group: string;
  /** label of the preferred binding ('' when unbound), e.g. "Ctrl+E" */
  label: string;
  /** every binding's label, preferred device first */
  labels: string[];
  device: RowDevice;
}

/** An axis direction or an input-local action with its bindings. */
export interface ControlRow {
  /** target key: 'axis:pitch:-1', 'axis:throttle', 'action:mouseYokeToggle' */
  id: string;
  title: string;
  group: string;
  label: string;
  labels: string[];
  device: RowDevice;
}

/** A profile plus how to label its gamepad inputs. */
export interface LabelSource {
  profile: BindingProfile;
  /** standard-mapping pad (Xbox names) vs HID joystick ("Joy 3") */
  standard: boolean;
  /** optional per-preset button names (e.g. PlayStation) */
  buttonNames?: readonly string[];
}

/** Label of one binding in the context of its source. */
export function labelOf(b: Binding, src: LabelSource): string {
  if (b.device === 'gamepad' && b.button !== undefined && b.modifierButton === undefined && src.buttonNames?.[b.button]) {
    return `Pad ${src.buttonNames[b.button]}`;
  }
  return bindingLabel(b, src.standard);
}

/** Labels of every binding with this target key, in source order; also returns the first binding. */
export function labelsFor(target: string, sources: readonly LabelSource[]): { labels: string[]; first: Binding | null } {
  const labels: string[] = [];
  let first: Binding | null = null;
  for (const s of sources) {
    for (const b of s.profile.bindings) {
      if (targetKey(b) !== target) continue;
      const l = labelOf(b, s);
      if (!labels.includes(l)) labels.push(l);
      first ??= b;
    }
  }
  return { labels, first };
}

/** One row per SimAction (unbound actions get device 'none'). */
export function buildBindingRows(sources: readonly LabelSource[]): BindingRow[] {
  return SIM_ACTIONS.map((action) => {
    const { labels, first } = labelsFor(`action:${action}`, sources);
    const meta = SIM_ACTION_META[action];
    return { action, title: meta.title, group: meta.group, label: labels[0] ?? '', labels, device: first ? first.device : 'none' };
  });
}

/** Rows for axis bindings (per direction) and input-local actions. */
export function buildControlRows(sources: readonly LabelSource[]): ControlRow[] {
  const rows = new Map<string, ControlRow>();
  for (const s of sources) {
    for (const b of s.profile.bindings) {
      if (isActionBinding(b)) continue;
      const id = targetKey(b);
      let row = rows.get(id);
      if (!row) {
        row = { id, title: axisTitle(b.axis, b.dir), group: b.axis.startsWith('look') || b.axis === 'cameraZoom' ? 'Camera' : 'Flight controls', label: '', labels: [], device: b.device };
        rows.set(id, row);
      }
      const l = labelOf(b, s);
      if (!row.labels.includes(l)) row.labels.push(l);
      row.label = row.labels[0];
    }
  }
  for (const a of LOCAL_ACTIONS) {
    const { labels, first } = labelsFor(`action:${a}`, sources);
    const meta = LOCAL_ACTION_META[a];
    rows.set(`action:${a}`, { id: `action:${a}`, title: meta.title, group: meta.group, label: labels[0] ?? '', labels, device: first ? first.device : 'none' });
  }
  return [...rows.values()];
}
