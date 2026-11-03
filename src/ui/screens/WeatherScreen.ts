/** Pre-flight Weather & Time screen (wraps WeatherPanel). */
import type { SimSnapshot } from '../../core/types';
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { button, h } from '../dom';
import { WeatherPanel } from './WeatherPanel';

export class WeatherScreen extends Screen {
  private panel: WeatherPanel;
  constructor(ctx: ScreenContext) {
    super('weather');
    this.panel = new WeatherPanel(ctx, { compact: false });
    this.el.append(screenHeader(ctx, 'Weather & time', 'Presets, custom layers, live weather and time of day'), this.panel.el,
      h('footer', { class: 'screen-footer' }, h('span', { class: 'spacer' }), button('Back', () => ctx.back()), button('Fly', () => ctx.fly(), { primary: true, big: true, icon: 'plane' })));
  }
  protected override onShow(): void { this.panel.refresh(); }
  override update(s: SimSnapshot): void { this.panel.update(s); }
  override dispose(): void { this.panel.dispose(); }
}
