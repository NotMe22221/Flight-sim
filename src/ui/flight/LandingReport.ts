/** Landing score card from 'landing:scored' (weights from doc 01 §10.1). Flexible about the detail keys. */
import type { SimEvents } from '../../core/types';
import type { UnitsSettings } from '../UiHost';
import { button, clear, h, icon } from '../dom';
import { FPM_PER_MS, formatAltitude, formatVerticalSpeed } from '../format';

type Payload = SimEvents['landing:scored'];

interface Component { key: string; label: string; weight: number; frac: number | null; raw: string }

const WEIGHTS = { center: 0.30, smooth: 0.35, zone: 0.15, stop: 0.20 } as const;

function num(d: Record<string, number | string>, ...keys: string[]): number | null {
  for (const k of keys) { const v = d[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return null;
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Derives the four weighted components from whatever the scoring module provided. Exported for tests/integrators. */
export function landingComponents(details: Record<string, number | string>, units: UnitsSettings): Component[] {
  // Normalised 0..1 components if present…
  const cN = num(details, 'center', 'centerline', 'centreline', 'centerScore');
  const sN = num(details, 'smooth', 'smoothness', 'touchdownScore');
  const zN = num(details, 'zone', 'aimPoint', 'aimpoint', 'zoneScore');
  const tN = num(details, 'stop', 'stopping', 'stopScore');
  // …or raw measurements.
  const offM = num(details, 'centerlineOffsetM', 'lateralOffsetM', 'centreOffsetM');
  const halfWidthM = num(details, 'runwayHalfWidthM', 'halfWidthM') ?? ((num(details, 'runwayWidthM', 'widthM') ?? 45) / 2);
  const vsMs = num(details, 'verticalSpeedMs', 'touchdownVsMs');
  const vsFpm = num(details, 'verticalSpeedFpm', 'touchdownVsFpm', 'touchdownFpm') ?? (vsMs !== null ? vsMs * FPM_PER_MS : null);
  const alongM = num(details, 'alongTrackM', 'touchdownDistanceM', 'distanceFromThresholdM');
  const aimM = num(details, 'aimPointM') ?? 305; // 1000 ft
  const stopDistM = num(details, 'stopDistanceM', 'rolloutM', 'stoppingDistanceM');
  const lengthM = num(details, 'runwayLengthM', 'lengthM');

  const center = cN !== null && cN >= 0 && cN <= 1 ? cN : offM !== null ? 1 - clamp01(Math.abs(offM) / halfWidthM) : null;
  const smooth = sN !== null && sN >= 0 && sN <= 1 ? sN : vsFpm !== null ? 1 - clamp01((Math.abs(vsFpm) - 60) / 540) : null;
  const zone = zN !== null && zN >= 0 && zN <= 1 ? zN : alongM !== null ? 1 - clamp01(Math.abs(alongM - aimM) / 300) : null;
  const stop = tN !== null && tN >= 0 && tN <= 1 ? tN : stopDistM !== null && lengthM !== null && alongM !== null ? 1 - clamp01(stopDistM / Math.max(1, lengthM - alongM)) : null;

  return [
    { key: 'center', label: 'Centreline', weight: WEIGHTS.center, frac: center, raw: offM !== null ? `${offM >= 0 ? 'R' : 'L'} ${formatAltitude(Math.abs(offM), units)}` : '' },
    { key: 'smooth', label: 'Touchdown rate', weight: WEIGHTS.smooth, frac: smooth, raw: vsFpm !== null ? formatVerticalSpeed(-Math.abs(vsFpm) / FPM_PER_MS, units) : '' },
    { key: 'zone', label: 'Aim point', weight: WEIGHTS.zone, frac: zone, raw: alongM !== null ? formatAltitude(alongM, units) : '' },
    { key: 'stop', label: 'Stopping distance', weight: WEIGHTS.stop, frac: stop, raw: stopDistM !== null ? formatAltitude(stopDistM, units) : '' },
  ];
}

export function scoreBand(score: number): string {
  if (score >= 9000) return 'Butter';
  if (score >= 7500) return 'Great landing';
  if (score >= 5000) return 'Good landing';
  if (score >= 2500) return 'Firm';
  if (score > 0) return 'Hard landing';
  return 'Crash';
}

export class LandingReport {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private onClose?: () => void;

  constructor(layer: HTMLElement) {
    this.card = h('div', { class: 'panel landing-report', role: 'dialog', aria: { label: 'Landing report' } });
    this.el = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === this.el) this.hide(); } }, this.card);
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }

  show(p: Payload, units: UnitsSettings, onClose?: () => void): void {
    this.onClose = onClose;
    clear(this.card);
    const comps = landingComponents(p.details, units);
    const runway = typeof p.details.runway === 'string' ? p.details.runway : typeof p.details.airport === 'string' ? p.details.airport : '';
    this.card.append(
      h('div', { class: 'row' }, icon('trophy'), h('span', { class: 'section-label', style: 'margin:0;border:0;flex:1', text: `Landing report${runway ? ' · ' + runway : ''}` })),
      h('div', { class: 'lr-score', text: Math.round(p.score).toLocaleString('en-US') }),
      h('div', { class: 'lr-band', text: scoreBand(p.score) }),
      h('hr'),
      ...comps.map((c) => h('div', { class: 'lr-row' },
        h('span', { text: c.label }),
        h('div', { class: 'lr-bar' }, h('span', { style: `width:${c.frac === null ? 0 : Math.round(c.frac * 100)}%` })),
        h('span', { class: 'lr-raw', text: c.frac === null ? '--' : `${Math.round(c.frac * 100)}%` + (c.raw ? ` · ${c.raw}` : '') }),
        h('span', { class: 'lr-weight', text: `${Math.round(c.weight * 100)}%` }),
      )),
      ...this.extraRows(p.details),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, button('Continue', () => this.hide(), { primary: true })),
    );
    this.el.classList.add('visible');
    (this.card.querySelector('button.btn-primary') as HTMLButtonElement | null)?.focus();
  }

  private extraRows(d: Record<string, number | string>): HTMLElement[] {
    const known = new Set(['center', 'centerline', 'centreline', 'centerScore', 'smooth', 'smoothness', 'touchdownScore', 'zone', 'aimPoint', 'aimpoint', 'zoneScore', 'stop', 'stopping', 'stopScore',
      'centerlineOffsetM', 'lateralOffsetM', 'centreOffsetM', 'runwayHalfWidthM', 'halfWidthM', 'runwayWidthM', 'widthM', 'verticalSpeedMs', 'touchdownVsMs', 'verticalSpeedFpm', 'touchdownVsFpm', 'touchdownFpm',
      'alongTrackM', 'touchdownDistanceM', 'distanceFromThresholdM', 'aimPointM', 'stopDistanceM', 'rolloutM', 'stoppingDistanceM', 'runwayLengthM', 'lengthM', 'runway', 'airport']);
    const rows: HTMLElement[] = [];
    for (const [k, v] of Object.entries(d)) {
      if (known.has(k)) continue;
      rows.push(h('div', { class: 'row', style: 'justify-content:space-between;font-size:.85em' }, h('span', { class: 'muted', text: k }), h('span', { class: 'tnum', text: typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v })));
    }
    return rows;
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove('visible');
    const cb = this.onClose; this.onClose = undefined; cb?.();
  }
}
