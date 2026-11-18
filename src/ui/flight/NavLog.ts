/**
 * Flight plan legs: waypoint, distance, magnetic bearing (what the heading indicator shows; the
 * planner works in true), ETE from snapshot.plan. Recomputed at 1 Hz or on plan change.
 */
import type { FlightPlan, SimSnapshot } from '../../core/types';
import type { UiHost, UnitsSettings } from '../UiHost';
import { button, clear, h } from '../dom';
import { bearingDeg, distanceM, trueToMagnetic, variationFromHeadings } from '../geoMath';
import { formatAltitude, formatDistance, formatDuration, formatEte, formatHeading } from '../format';
import { parsePln, toPln } from '../../nav/pln';

export class NavLog {
  readonly el: HTMLElement;
  private table: HTMLElement;
  private total: HTMLElement;
  private lastRender = 0;
  private lastPlan: FlightPlan | null = null;
  private lastKey = '';
  private clearBtn: HTMLButtonElement | null = null;
  private exportBtn: HTMLButtonElement;
  private status: HTMLElement;

  constructor(container: HTMLElement, private readonly host: UiHost, private units: () => UnitsSettings) {
    this.table = h('div');
    this.total = h('div', { class: 'navlog-total' });
    const actions = h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;flex-wrap:wrap' });
    this.status = h('div', { class: 'muted', style: 'font-size:.8em;min-height:1em' });
    // MSFS / Little Navmap / SimBrief flight plans
    if (host.setPlan) {
      const file = h('input', { type: 'file', style: 'display:none' }) as HTMLInputElement;
      file.accept = '.pln,application/xml,text/xml';
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        void f.text().then((xml) => {
          const plan = parsePln(xml);
          host.setPlan!(plan.waypoints);
          this.lastKey = '';
          this.status.textContent = `Imported "${plan.title}": ${plan.waypoints.length} waypoints`;
        }).catch((e: unknown) => { this.status.textContent = `Could not import: ${e instanceof Error ? e.message : String(e)}`; });
      });
      actions.append(file, button('Import .pln', () => file.click(), { cls: 'btn-sm', title: 'Load an MSFS flight plan (.pln: MSFS, Little Navmap, SimBrief)' }));
    }
    this.exportBtn = button('Export .pln', () => this.exportPln(), { cls: 'btn-sm', title: 'Save this plan as an MSFS .pln' });
    this.exportBtn.style.display = 'none';
    actions.appendChild(this.exportBtn);
    if (host.clearPlan) {
      this.clearBtn = button('Clear plan', () => { host.clearPlan?.(); this.lastKey = ''; }, { cls: 'btn-sm' });
      this.clearBtn.style.display = 'none'; // shown once there is a plan
      actions.appendChild(this.clearBtn);
    }
    this.el = h('div', { class: 'navlog' }, this.table, this.total, actions, this.status);
    container.appendChild(this.el);
  }

  update(s: SimSnapshot, nowMs: number): void {
    const plan = s.plan;
    if (plan === this.lastPlan && nowMs - this.lastRender < 1000) return;
    this.lastRender = nowMs; this.lastPlan = plan;
    if (!plan || plan.waypoints.length === 0) {
      if (this.lastKey !== 'empty') {
        this.lastKey = 'empty'; clear(this.table); clear(this.total);
        this.table.appendChild(h('div', { class: 'empty', text: 'No flight plan. Set an arrival in the World Map or use Direct\u00a0to on the VFR map.' }));
        if (this.clearBtn) this.clearBtn.style.display = 'none';
        this.exportBtn.style.display = 'none';
      }
      return;
    }
    const u = this.units();
    const gs = Math.max(1, s.aircraft.groundSpeedMs);
    const rows: HTMLElement[] = [];
    let totalM = 0, totalS = 0;
    const here = { lat: s.aircraft.geo.lat, lon: s.aircraft.geo.lon };
    const variation = variationFromHeadings(s.aircraft.headingTrueRad, s.aircraft.headingMagRad);
    for (let i = 0; i < plan.waypoints.length; i++) {
      const wp = plan.waypoints[i];
      const prev = i === 0 ? here : plan.waypoints[i - 1].position;
      const isActive = i === plan.activeLeg;
      const passed = i < plan.activeLeg;
      let legM: number, brg: number, ete: number;
      if (isActive) { legM = plan.distanceToActiveM; brg = plan.bearingToActiveDeg; ete = plan.eteS > 0 ? plan.eteS : legM / gs; }
      else { legM = distanceM(prev, wp.position); brg = bearingDeg(prev, wp.position); ete = legM / gs; }
      if (!passed) { totalM += legM; totalS += ete; }
      rows.push(h('tr', { class: isActive ? 'active' : passed ? 'passed' : '' },
        h('td', { text: wp.id }), h('td', { class: 'muted', text: wp.type }),
        h('td', { class: 'num', text: formatDistance(legM, u) }), h('td', { class: 'num', text: formatHeading(trueToMagnetic(brg, variation)) }),
        h('td', { class: 'num', text: passed ? '--' : formatEte(ete) }),
        h('td', { class: 'num', text: wp.altConstraintM !== undefined ? formatAltitude(wp.altConstraintM, u) : '' })));
    }
    const key = rows.map((r) => r.textContent).join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.clearBtn) this.clearBtn.style.display = '';
    this.exportBtn.style.display = '';
    clear(this.table);
    this.table.appendChild(h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Waypoint' }), h('th', { text: 'Type' }), h('th', { class: 'num', text: 'Dist' }), h('th', { class: 'num', text: 'Brg', title: 'Magnetic bearing' }), h('th', { class: 'num', text: 'ETE' }), h('th', { class: 'num', text: 'Alt' }))),
      h('tbody', null, rows)));
    clear(this.total);
    this.total.append(h('span', { text: `Remaining ${formatDistance(totalM, u)}` }), h('span', { text: `ETE ${formatDuration(totalS)} · XTK ${formatDistance(plan.crossTrackM, u)}` }));
  }

  private exportPln(): void {
    const wps = this.lastPlan?.waypoints;
    if (!wps?.length) return;
    const xml = toPln(wps);
    const name = `${wps[0].id}-${wps[wps.length - 1].id}.pln`.replace(/[^\w.-]+/g, '_');
    const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.status.textContent = `Saved ${name}`;
  }
}
