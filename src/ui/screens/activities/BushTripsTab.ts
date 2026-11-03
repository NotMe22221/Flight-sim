/**
 * Activities › Bush trips: one card per trip (BUSH_TRIPS) with its progress; an opened trip lists
 * its legs (from → to, distance through the landmarks, cruise altitude, landmarks, highest terrain),
 * locked legs greyed until the previous one is flown, "Resume" (the first incomplete leg), a Start
 * per leg (host.startBushLeg) and "Reset trip" with an inline confirmation.
 */
import type { ScreenContext } from '../Screen';
import { button, clear, h, icon, isNarrowScreen } from '../../dom';
import { BUSH_TRIPS, type BushTrip } from '../../../activities/bushTrips';
import { landingScoreText, legRow, legRows, nmText, scoreText, tripCard, type LegRowVm, type TripCardVm } from '../../activityModels';
import type { IconName } from '../../icons';
import { aircraftName } from './TrainingTab';
import { StartGate, errText, type ActivityTabView } from './types';

const LEG_ICON: Record<LegRowVm['status'], IconName> = { completed: 'check', next: 'play', unlocked: 'circle', locked: 'lock' };

export class BushTripsTab implements ActivityTabView {
  readonly el: HTMLElement;
  private left: HTMLElement;
  private detail: HTMLElement;
  private selectedTripId: string | null = null;
  private openTripId: string | null = null;
  private selectedLeg = 0;
  private confirmingReset = false;
  private items = new Map<string, HTMLElement>();
  private primaryBtn: HTMLButtonElement | null = null;
  private gate: StartGate;

  constructor(private readonly ctx: ScreenContext) {
    this.gate = new StartGate(ctx);
    this.left = h('div', { class: 'act-left' });
    this.detail = h('aside', { class: 'panel act-detail split' });
    this.el = h('div', { class: 'screen-body act-body' }, this.left, this.detail);
  }

  private trips(): readonly BushTrip[] { return BUSH_TRIPS; }
  private trip(id: string | null): BushTrip | undefined { return id ? this.trips().find((t) => t.id === id) : undefined; }
  private get progress() { return this.ctx.host.activityProgress; }
  private get units() { return this.ctx.settings().units; }
  private get canStart(): boolean { return typeof this.ctx.host.startBushLeg === 'function'; }

  onShow(): void {
    const all = this.trips();
    if (!this.trip(this.selectedTripId)) this.selectedTripId = all[0]?.id ?? null;
    if (this.openTripId && !this.trip(this.openTripId)) this.openTripId = null;
    // with a single trip there is nothing to choose: open it right away
    if (!this.openTripId && all.length === 1) this.openTripId = all[0].id;
    const open = this.trip(this.openTripId);
    if (open) this.selectedLeg = Math.min(tripCard(open, this.progress).nextLeg, open.legs.length - 1);
    this.confirmingReset = false;
    this.render();
  }

  update(): void { this.gate.update(); }

  focus(): void {
    const sel = this.openTripId ? this.items.get(`leg${this.selectedLeg}`) : this.items.get(this.selectedTripId ?? '');
    (this.primaryBtn && !this.primaryBtn.disabled ? this.primaryBtn : sel ?? null)?.focus({ preventScroll: true });
  }

  private render(): void {
    this.gate.reset();
    this.items.clear();
    this.primaryBtn = null;
    clear(this.left);
    clear(this.detail);
    const open = this.trip(this.openTripId);
    if (open) { this.renderLegs(open); this.renderLegDetail(open); } else { this.renderTrips(); this.renderTripDetail(); }
  }

  // ─── trip list ──────────────────────────────────────────────────────────────

  private renderTrips(): void {
    const list = h('div', { class: 'act-list scroll', role: 'listbox', aria: { label: 'Bush trips' } });
    if (!this.trips().length) list.appendChild(h('div', { class: 'empty', text: 'No bush trips in this build' }));
    for (const t of this.trips()) {
      const vm = tripCard(t, this.progress);
      const card = h('div', {
        class: `panel act-card trip-card${vm.done ? ' completed' : ''}`, role: 'option', tabIndex: 0, aria: { selected: t.id === this.selectedTripId },
        dataset: { trip: t.id },
        onClick: () => { if (this.selectedTripId === t.id) this.openTrip(t.id); else this.selectTrip(t.id); },
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openTrip(t.id); } },
      },
      h('div', { class: 'row' }, h('span', { class: 'act-title', text: vm.title }), h('span', { class: 'spacer' }), h('span', { class: 'badge', text: vm.region })),
      h('div', { class: 'act-meta', text: `${vm.ends} · ${vm.legCount} legs · ${nmText(vm.totalNm, this.units)}` }),
      h('div', { class: 'act-desc', text: vm.description }),
      this.progressBar(vm));
      card.classList.toggle('selected', t.id === this.selectedTripId);
      this.items.set(t.id, card);
      list.appendChild(card);
    }
    this.left.append(h('div', { class: 'act-intro muted', text: 'Fly from airfield to airfield by looking out of the window: each leg has a briefing, landmarks and a suggested cruise altitude. Legs unlock in order.' }), list);
  }

  private progressBar(vm: TripCardVm): HTMLElement {
    return h('div', { class: 'trip-progress' },
      h('div', { class: 'act-bar', role: 'progressbar', aria: { valuemin: '0', valuemax: String(vm.legCount), valuenow: String(vm.completedLegs), label: 'Legs completed' } },
        h('span', { style: `width:${Math.round(vm.fraction * 100)}%` })),
      h('span', { class: 'trip-progress-text', text: vm.status }));
  }

  private selectTrip(id: string): void {
    this.selectedTripId = id;
    for (const [k, el] of this.items) { el.classList.toggle('selected', k === id); el.setAttribute('aria-selected', String(k === id)); }
    this.gate.reset();
    clear(this.detail);
    this.renderTripDetail();
  }

  private openTrip(id: string): void {
    const t = this.trip(id);
    if (!t) return;
    this.selectedTripId = id;
    this.openTripId = id;
    this.confirmingReset = false;
    this.selectedLeg = Math.min(tripCard(t, this.progress).nextLeg, t.legs.length - 1);
    this.render();
    this.focus();
  }

  private renderTripDetail(): void {
    const t = this.trip(this.selectedTripId);
    if (!t) { this.detail.appendChild(h('div', { class: 'empty', text: 'Select a trip' })); return; }
    const vm = tripCard(t, this.progress);
    const plane = aircraftName(this.ctx, t.aircraft);
    this.primaryBtn = this.gate.add(button(vm.resumeLabel, () => this.startLeg(t, vm.done ? 0 : vm.nextLeg), { primary: true, big: true, icon: 'play' }), this.canStart);
    const body = h('div', { class: 'act-detail-body scroll' },
      h('div', { class: 'row' }, h('span', { class: 'badge badge-accent', text: 'Bush trip' }), h('span', { class: 'spacer' }), h('span', { class: 'badge', text: vm.region })),
      h('h2', { class: 'act-detail-title', text: vm.title }),
      h('p', { class: 'muted', style: 'margin:0', text: vm.description }),
      h('div', { class: 'kv' },
        h('span', { class: 'kv-k', text: 'Route' }), h('span', { class: 'kv-v', text: vm.ends }),
        h('span', { class: 'kv-k', text: 'Legs' }), h('span', { class: 'kv-v', text: String(vm.legCount) }),
        h('span', { class: 'kv-k', text: 'Distance' }), h('span', { class: 'kv-v', text: nmText(vm.totalNm, this.units) }),
        plane ? h('span', { class: 'kv-k', text: 'Aircraft' }) : null, plane ? h('span', { class: 'kv-v', text: plane }) : null),
      this.progressBar(vm));
    this.detail.append(body, h('div', { class: 'act-detail-foot' },
      h('div', { class: 'row act-actions' }, button('View legs', () => this.openTrip(t.id), { icon: 'list' }), this.primaryBtn)));
  }

  // ─── opened trip: legs ──────────────────────────────────────────────────────

  private renderLegs(t: BushTrip): void {
    const vm = tripCard(t, this.progress);
    const rows = legRows(t, this.progress, this.units);
    const resume = this.gate.add(button(vm.resumeLabel, () => this.startLeg(t, vm.done ? 0 : vm.nextLeg), { primary: true, icon: 'play', cls: 'btn-sm' }), this.canStart);
    const head = h('div', { class: 'trip-head' },
      h('div', { class: 'row' },
        this.trips().length > 1 ? button('', () => { this.openTripId = null; this.render(); }, { icon: 'back', cls: 'btn-ghost btn-icon', title: 'All trips', aria: { label: 'All trips' } }) : null,
        h('div', { class: 'trip-head-title' }, h('div', { class: 'act-title', text: vm.title }), h('div', { class: 'act-meta', text: `${vm.region} · ${vm.ends} · ${nmText(vm.totalNm, this.units)}` })),
        h('span', { class: 'spacer' }),
        resume),
      h('div', { class: 'row trip-head-progress' }, this.progressBar(vm), this.resetControl(t, vm)));
    const list = h('div', { class: 'leg-list scroll', role: 'listbox', aria: { label: 'Legs' } });
    for (const r of rows) list.appendChild(this.legItem(t, r));
    this.left.append(head, list);
  }

  private resetControl(t: BushTrip, vm: TripCardVm): HTMLElement {
    const has = vm.completedLegs > 0 || vm.nextLeg > 0;
    const canReset = has && !!this.progress;
    if (!this.confirmingReset) {
      return h('div', { class: 'trip-reset' }, button('Reset trip', () => { this.confirmingReset = true; this.rerenderKeepingScroll(t); }, { icon: 'restart', cls: 'btn-sm btn-ghost', disabled: !canReset, title: canReset ? 'Forget the progress on this trip' : 'Nothing to reset yet' }));
    }
    const cancel = button('Cancel', () => { this.confirmingReset = false; this.rerenderKeepingScroll(t); }, { cls: 'btn-sm' });
    const ok = button('Reset', () => this.resetTrip(t), { icon: 'restart', cls: 'btn-sm btn-danger' });
    const box = h('div', { class: 'trip-reset confirming', role: 'alertdialog', aria: { label: 'Reset trip' } },
      h('span', { class: 'trip-reset-q', text: `Forget all ${vm.completedLegs} completed leg${vm.completedLegs === 1 ? '' : 's'}?` }), cancel, ok);
    setTimeout(() => cancel.focus({ preventScroll: true }), 0);
    return box;
  }

  private resetTrip(t: BushTrip): void {
    this.confirmingReset = false;
    try { this.progress?.resetTrip(t.id); } catch (e) { this.ctx.toast(`Could not reset the trip: ${errText(e)}`, 'error'); }
    this.selectedLeg = 0;
    this.render();
    this.ctx.toast(`${t.title}: progress reset`, 'info');
  }

  private rerenderKeepingScroll(t: BushTrip): void {
    const list = this.left.querySelector<HTMLElement>('.leg-list');
    const top = list?.scrollTop ?? 0;
    clear(this.left);
    this.gate.reset();
    this.items.clear();
    this.renderLegs(t);
    const again = this.left.querySelector<HTMLElement>('.leg-list');
    if (again) again.scrollTop = top;
    clear(this.detail);
    this.renderLegDetail(t);
  }

  private legItem(t: BushTrip, r: LegRowVm): HTMLElement {
    const el = h('div', {
      class: `leg-row ${r.status}`, role: 'option', tabIndex: 0, aria: { selected: r.index === this.selectedLeg, disabled: r.status === 'locked' },
      dataset: { leg: String(r.index) },
      onClick: () => this.selectLeg(t, r.index),
      onKeyDown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (this.selectedLeg === r.index && r.unlocked) this.startLeg(t, r.index); else this.selectLeg(t, r.index); }
        else if (e.key === ' ') { e.preventDefault(); this.selectLeg(t, r.index); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const next = Math.min(t.legs.length - 1, Math.max(0, r.index + (e.key === 'ArrowDown' ? 1 : -1)));
          this.selectLeg(t, next);
          this.items.get(`leg${next}`)?.focus();
        }
      },
    },
    h('span', { class: 'leg-mark' }, icon(LEG_ICON[r.status])),
    h('div', { class: 'leg-main' },
      h('div', { class: 'leg-line' }, h('span', { class: 'leg-num', text: r.label }), h('span', { class: 'leg-title', text: r.title }), h('span', { class: 'leg-names ellipsis', text: `${r.fromName} → ${r.toName}` })),
      h('div', { class: 'leg-meta' },
        h('span', { class: 'leg-chip' }, icon('route'), r.distanceShort),
        h('span', { class: 'leg-chip' }, icon('arrowUp'), r.cruise),
        h('span', { class: 'leg-chip' }, icon('mountain'), r.terrain),
        h('span', { class: 'leg-chip leg-landmarks' }, icon('flag'), r.landmarks.join(' · ')))),
    h('span', { class: 'leg-status', text: r.status === 'locked' ? 'Locked' : r.statusText }));
    el.classList.toggle('selected', r.index === this.selectedLeg);
    this.items.set(`leg${r.index}`, el);
    return el;
  }

  private selectLeg(t: BushTrip, i: number): void {
    this.selectedLeg = i;
    for (const [k, el] of this.items) if (k.startsWith('leg')) { const on = k === `leg${i}`; el.classList.toggle('selected', on); el.setAttribute('aria-selected', String(on)); }
    clear(this.detail);
    this.gate.reset();
    // the header's Resume button stays registered: rebuild the left side's gate entries too
    const resume = this.left.querySelector<HTMLButtonElement>('.trip-head .btn-primary');
    if (resume) this.gate.add(resume, this.canStart);
    this.renderLegDetail(t);
    if (isNarrowScreen()) this.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderLegDetail(t: BushTrip): void {
    const i = Math.min(Math.max(0, this.selectedLeg), t.legs.length - 1);
    const leg = t.legs[i];
    if (!leg) { this.detail.appendChild(h('div', { class: 'empty', text: 'This trip has no legs' })); return; }
    const dep = t.airports[leg.from];
    let magVar: number | null = null;
    try { magVar = dep && this.ctx.host.magneticVariationDeg ? this.ctx.host.magneticVariationDeg(dep.lat, dep.lon) : null; } catch { magVar = null; }
    const r = legRow(t, i, this.progress, this.units, magVar);
    const startable = this.canStart && r.unlocked;
    this.primaryBtn = this.gate.add(button(r.completed ? 'Fly again' : 'Start', () => this.startLeg(t, i), { primary: true, big: true, icon: r.unlocked ? 'play' : 'lock', title: !this.canStart ? 'Not available in this build' : r.unlocked ? `Fly leg ${i + 1}` : r.statusText }), startable);
    const statusBadge = r.status === 'completed' ? h('span', { class: 'badge badge-ok' }, icon('check'), ' Completed')
      : r.status === 'locked' ? h('span', { class: 'badge' }, icon('lock'), ' Locked')
        : r.status === 'next' ? h('span', { class: 'badge badge-accent', text: 'Next leg' }) : null;
    const best: string[] = [];
    if (r.bestScore !== null) best.push(`Best ${scoreText(r.bestScore)}`);
    if (r.bestLandingScore !== null) best.push(`landing ${landingScoreText(r.bestLandingScore)}`);
    const body = h('div', { class: 'act-detail-body scroll' },
      h('div', { class: 'row' }, h('span', { class: 'badge', text: `Leg ${i + 1} of ${t.legs.length}` }), h('span', { class: 'spacer' }), statusBadge),
      h('h2', { class: 'act-detail-title', text: r.title }),
      h('div', { class: 'act-meta', text: `${r.fromName} → ${r.toName}` }),
      h('p', { class: 'muted act-briefing', text: r.briefing }),
      h('div', { class: 'section-label', text: 'Flight plan' }),
      h('div', { class: 'kv' },
        h('span', { class: 'kv-k', text: 'Departure' }), h('span', { class: 'kv-v', text: `${r.from} runway ${r.departureRunway}` }),
        h('span', { class: 'kv-k', text: 'Cruise' }), h('span', { class: 'kv-v', text: r.cruise }),
        h('span', { class: 'kv-k', text: 'Distance' }), h('span', { class: 'kv-v', text: r.distance }),
        h('span', { class: 'kv-k', text: 'Terrain' }), h('span', { class: 'kv-v', text: `Highest: ${r.terrain}` }),
        h('span', { class: 'kv-k', text: 'Weather' }), h('span', { class: 'kv-v', text: `${r.weather} · ${r.time}` })),
      h('div', { class: 'section-label', text: 'Nav log' }),
      h('table', { class: 'leg-navlog' },
        h('thead', null, h('tr', null, h('th', { text: 'From' }), h('th', { text: 'To' }), h('th', { class: 'num', text: magVar === null ? 'Course (T)' : 'Course' }), h('th', { class: 'num', text: 'Dist' }))),
        h('tbody', null, ...r.segments.map((s) => h('tr', null, h('td', { text: s.from }), h('td', { text: s.to }), h('td', { class: 'num mono', text: s.course }), h('td', { class: 'num mono', text: s.distance }))))),
      ...(best.length ? [h('div', { class: 'act-best big' }, icon('trophy'), best.join(' · '))] : []));
    this.detail.append(body, h('div', { class: 'act-detail-foot' },
      h('div', { class: `muted act-note${r.unlocked ? '' : ' locked'}`, text: !this.canStart ? 'Bush trips are not available in this build.'
        : r.unlocked ? 'The route is loaded into the flight plan (VFR map, nav log). Land and stop at the destination to complete the leg.' : r.statusText }),
      h('div', { class: 'row act-actions' }, this.primaryBtn)));
  }

  private startLeg(t: BushTrip, i: number): void {
    const host = this.ctx.host;
    if (typeof host.startBushLeg !== 'function' || this.gate.starting) return;
    const leg = t.legs[i];
    if (!leg) return;
    const p = this.progress;
    let open = true;
    try { open = p ? p.isLegUnlocked(t.id, i) : true; } catch { open = true; }
    if (!open) { this.ctx.toast(`Leg ${i + 1} is locked: complete leg ${i} first`, 'warn'); return; }
    if (this.ctx.startBushLeg) this.ctx.startBushLeg(t.id, i);
    else void host.startBushLeg(t.id, i).catch((e: unknown) => this.ctx.toast(`Could not start leg ${i + 1}: ${errText(e)}`, 'error'));
  }
}
