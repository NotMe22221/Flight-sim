/** FLY NOW · WORLD MAP · AIRCRAFT · WEATHER & TIME · SETTINGS · CREDITS, with the MSFS-style selection summary. */
import { Screen, type ScreenContext } from './Screen';
import { arrowNavigation, button, h, icon } from '../dom';
import type { IconName } from '../icons';

export class MainMenu extends Screen {
  private summary: Record<string, HTMLElement> = {};
  private resumeBtn: HTMLButtonElement;
  private flyBtn: HTMLButtonElement;

  constructor(private readonly ctx: ScreenContext) {
    super('main-menu');
    const item = (k: string, label: string, ic: IconName, onClick: () => void) => {
      const v = h('div', { class: 'summary-v', text: '--' });
      this.summary[k] = v;
      return h('div', { class: 'summary-item', role: 'button', tabIndex: 0, onClick, onKeyDown: (e) => { if (e.key === 'Enter') onClick(); } }, icon(ic), h('div', null, h('div', { class: 'summary-k', text: label }), v));
    };
    this.resumeBtn = button('Resume flight', () => ctx.navigate('flight'), { icon: 'play', cls: 'menu-btn primary' });
    this.resumeBtn.style.display = 'none';
    this.flyBtn = button('Fly now', () => ctx.fly(), { icon: 'plane', cls: 'menu-btn primary' });
    const left = h('div', { class: 'main-left' },
      h('h1', { class: 'brand' }, 'Flight Sim', h('small', { text: 'Browser edition' })),
      h('nav', { class: 'menu-list', aria: { label: 'Main menu' } },
        this.resumeBtn, this.flyBtn,
        button('World map', () => ctx.navigate('worldmap'), { icon: 'globe', cls: 'menu-btn' }),
        button('Aircraft', () => ctx.navigate('aircraft'), { icon: 'plane', cls: 'menu-btn' }),
        button('Weather & time', () => ctx.navigate('weather'), { icon: 'cloudSun', cls: 'menu-btn' }),
        button('Settings', () => ctx.navigate('settings'), { icon: 'settings', cls: 'menu-btn' }),
        button('Credits', () => ctx.navigate('credits'), { icon: 'info', cls: 'menu-btn' })));
    const right = h('div', { class: 'main-right' },
      h('aside', { class: 'panel summary-card', aria: { label: 'Current selection' } },
        h('div', { class: 'section-label', text: 'Your flight' }),
        item('airport', 'Departure', 'globe', () => ctx.navigate('worldmap')),
        item('runway', 'Position', 'flag', () => ctx.navigate('worldmap')),
        item('aircraft', 'Aircraft', 'plane', () => ctx.navigate('aircraft')),
        item('weather', 'Weather', 'cloudSun', () => ctx.navigate('weather')),
        item('time', 'Time', 'clock', () => ctx.navigate('weather')),
        h('div', { style: 'margin-top:10px;display:flex;justify-content:flex-end' }, button('Fly', () => ctx.fly(), { primary: true, big: true, icon: 'plane' }))));
    this.el.append(h('div', { class: 'screen-body' }, left, right), h('div', { class: 'version-tag', text: 'Data: AWS Terrain Tiles · EOX Sentinel-2 cloudless · OurAirports — see Credits' }));
    arrowNavigation(left);
    ctx.selection.onChange(() => this.refresh());
  }

  protected override onShow(): void {
    this.refresh();
    this.resumeBtn.style.display = this.ctx.inFlight() ? '' : 'none';
    this.flyBtn.querySelector('.btn-label')!.textContent = this.ctx.inFlight() ? 'New flight' : 'Fly now';
    (this.ctx.inFlight() ? this.resumeBtn : this.flyBtn).focus();
  }

  refresh(): void {
    const d = this.ctx.selection.describe();
    this.summary.airport.textContent = d.airport;
    this.summary.runway.textContent = d.runway;
    this.summary.aircraft.textContent = d.aircraft;
    this.summary.weather.textContent = d.weather;
    this.summary.time.textContent = d.time;
  }
}
