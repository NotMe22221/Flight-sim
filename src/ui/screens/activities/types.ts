/** Shared pieces of the Activities tabs (Landing challenges · Flight training · Bush trips). */
import type { ScreenContext } from '../Screen';
import type { UiHost } from '../../UiHost';

export type ActivitiesTab = 'challenges' | 'training' | 'bush';
/** `short`: the phone label (three tabs share a 360 px wide bar). */
export const ACTIVITY_TABS: readonly { id: ActivitiesTab; label: string; short: string; icon: 'trophy' | 'school' | 'route'; subtitle: string }[] = [
  { id: 'challenges', label: 'Landing challenges', short: 'Challenges', icon: 'trophy', subtitle: 'Start on final, land, get scored' },
  { id: 'training', label: 'Flight training', short: 'Training', icon: 'school', subtitle: 'Lessons with an instructor, step by step' },
  { id: 'bush', label: 'Bush trips', short: 'Bush trips', icon: 'route', subtitle: 'Multi-leg VFR journeys, navigating by landmarks' },
];

export function parseActivitiesTab(v: unknown): ActivitiesTab {
  return ACTIVITY_TABS.some((t) => t.id === v) ? (v as ActivitiesTab) : 'challenges';
}

/** One tab: its own `.screen-body` element, shown below the tab bar. */
export interface ActivityTabView {
  readonly el: HTMLElement;
  /** (re)render from the data and the saved progress */
  onShow(): void;
  focus(): void;
  /** per frame while visible (cheap: only the Start-button gate) */
  update(): void;
}

/** True while the runner is setting a flight up (its spawn is pending): Start must not be pressed again. */
export function activityStarting(host: UiHost): boolean {
  try { return host.activityRunner?.phase === 'starting'; } catch { return false; }
}

/**
 * The Start buttons of a tab: each has its own availability (host support, leg locked) and all
 * are disabled while an activity is starting (ActivityRunner: hosts should serialise spawns).
 */
export class StartGate {
  private btns: { b: HTMLButtonElement; enabled: boolean }[] = [];
  private busy = false;
  constructor(private readonly ctx: ScreenContext) {}
  reset(): void { this.btns.length = 0; }
  add(b: HTMLButtonElement, enabled: boolean): HTMLButtonElement {
    this.btns.push({ b, enabled });
    b.disabled = !enabled || this.busy;
    return b;
  }
  /** Polls the runner; writes the DOM only when the phase flips. */
  update(): void {
    const busy = activityStarting(this.ctx.host);
    if (busy === this.busy) return;
    this.busy = busy;
    for (const x of this.btns) x.b.disabled = !x.enabled || busy;
  }
  get starting(): boolean { return this.busy; }
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
