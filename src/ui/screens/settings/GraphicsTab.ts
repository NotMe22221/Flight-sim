/** Settings › Graphics: quality preset, shadows, clouds, render scale, terrain detail, FOV, imagery. */
import type { GraphicsSettings } from '../../UiHost';
import { Txt, h, segmented, slider, toggle, type SegmentedHandle, type SliderHandle, type ToggleHandle } from '../../dom';
import { graphicsQualityLabel } from '../../settingsModel';
import { group, type SettingsTabView, type TabDeps } from './types';

type Quality = GraphicsSettings['quality'];
type Imagery = GraphicsSettings['imagery'];

export class GraphicsTab implements SettingsTabView {
  readonly el: HTMLElement;
  private quality: SegmentedHandle<Quality>;
  private qualityNote: Txt;
  private shadows: ToggleHandle;
  private clouds: ToggleHandle;
  private renderScale: SliderHandle;
  private terrain: SliderHandle;
  private fov: SliderHandle;
  private imagery: SegmentedHandle<Imagery>;

  constructor(private readonly d: TabDeps) {
    const g = d.ctx.settings().graphics;
    this.quality = segmented<Quality>([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }],
      null, (quality) => d.dispatch({ type: 'graphicsQuality', quality }), 'stretch');
    this.qualityNote = new Txt(h('div', { class: 'effective' }), '');
    this.shadows = toggle('Shadows', g.shadows, (v) => d.dispatch({ type: 'graphics', patch: { shadows: v } }), 'Sun shadows from the aircraft and nearby terrain');
    this.clouds = toggle('Volumetric clouds', g.clouds, (v) => d.dispatch({ type: 'graphics', patch: { clouds: v } }), 'Raymarched cloud layers (the most expensive effect)');
    // expensive to apply: commit on release, readout follows the drag
    this.renderScale = slider({ min: 50, max: 200, step: 5, value: Math.round(g.renderScale * 100), label: 'Render scale', format: (v) => `${v}%`,
      onInput: () => { /* readout */ }, onChange: (v) => d.dispatch({ type: 'graphics', patch: { renderScale: v / 100 } }) });
    this.terrain = slider({ min: 0.25, max: 4, step: 0.25, value: g.terrainDetail, label: 'Terrain detail', format: (v) => `×${v.toFixed(2)}`,
      onInput: () => { /* readout */ }, onChange: (v) => d.dispatch({ type: 'graphics', patch: { terrainDetail: v } }) });
    // cheap and nice to preview live
    this.fov = slider({ min: 30, max: 120, step: 1, value: g.fov, label: 'Field of view', format: (v) => `${v}°`,
      onInput: (v) => d.dispatch({ type: 'graphics', patch: { fov: v } }) });
    this.imagery = segmented<Imagery>([{ value: 'satellite', label: 'Satellite' }, { value: 'procedural', label: 'Procedural' }],
      g.imagery, (imagery) => d.dispatch({ type: 'graphics', patch: { imagery } }), 'stretch');

    this.el = h('div', { class: 'settings-grid' },
      group('Quality', this.quality.el, this.qualityNote.el, this.shadows.el, this.clouds.el, this.renderScale.el, this.terrain.el),
      group('Camera', this.fov.el, h('div', { class: 'muted', style: 'font-size:.85em', text: 'Cockpit and external views. Mouse wheel zooms in flight.' })),
      group('Ground imagery', this.imagery.el,
        h('div', { class: 'muted', style: 'font-size:.85em', text: 'Satellite streams EOX Sentinel-2 cloudless tiles (needs a connection). Procedural colours the terrain from height and slope and works offline.' })));
    this.sync();
  }

  sync(): void {
    const g = this.d.ctx.settings().graphics;
    const label = graphicsQualityLabel(g);
    this.quality.set(label.startsWith('Custom') ? null : g.quality);
    this.qualityNote.set(label.startsWith('Custom') ? label : '');
    if (this.shadows.get() !== g.shadows) this.shadows.set(g.shadows);
    if (this.clouds.get() !== g.clouds) this.clouds.set(g.clouds);
    this.renderScale.set(Math.round(g.renderScale * 100));
    this.terrain.set(g.terrainDetail);
    if (document.activeElement !== this.fov.input) this.fov.set(g.fov);
    this.imagery.set(g.imagery);
  }
}
