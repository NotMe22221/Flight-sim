/** Data attribution (host.dataCredits()) plus the UI's own notes. */
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { clear, h } from '../dom';

export class CreditsScreen extends Screen {
  private list: HTMLElement;
  constructor(private readonly ctx: ScreenContext) {
    super('credits');
    this.list = h('ul', { class: 'credits-list' });
    this.el.append(screenHeader(ctx, 'Credits', 'Data sources and licences'),
      h('div', { class: 'screen-body' }, h('div', { class: 'panel credits-card scroll' },
        h('div', { class: 'section-label', text: 'Data & attribution' }), this.list,
        h('div', { class: 'section-label', text: 'Software' }),
        h('p', { class: 'muted', text: 'Three.js (MIT) renderer · TypeScript · Vite · Vitest. Flight dynamics, terrain streaming, sky, avionics, autopilot and this interface are original code for this project. Checklists are condensed from the Cessna 172S POH Section 4 (paraphrased).' }),
        h('p', { class: 'faint', style: 'font-size:.8em', text: 'Not for real-world navigation. Airport, navaid and weather data may be outdated or incomplete.' }))));
  }
  protected override onShow(): void {
    clear(this.list);
    let lines: string[] = [];
    try { lines = this.ctx.host.dataCredits(); } catch { lines = []; }
    if (!lines.length) lines = ['Elevation: AWS Terrain Tiles (Mapzen Terrarium; public domain / CC-BY sources)', 'Imagery: EOX Sentinel-2 cloudless (CC BY 4.0); NASA GIBS Blue Marble', 'Airports: OurAirports (public domain)'];
    for (const l of lines) this.list.appendChild(h('li', { text: l }));
  }
}
