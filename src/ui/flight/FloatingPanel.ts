/** Draggable (and optionally resizable) floating panel for the in-flight toolbar; position persisted. */
import { h, icon } from '../dom';
import type { IconName } from '../icons';
import { LAYOUT_KEY, loadJson, saveJson } from '../settingsStore';

export interface PanelRect { x: number; y: number; w?: number; h?: number }
type Layout = Record<string, PanelRect>;

/** One shared layout blob for every floating panel; writes are debounced. */
export class LayoutStore {
  private layout: Layout = loadJson<Layout>(LAYOUT_KEY, {});
  private timer: ReturnType<typeof setTimeout> | null = null;
  get(id: string): PanelRect | undefined { return this.layout[id]; }
  set(id: string, r: PanelRect): void {
    this.layout[id] = r;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; saveJson(LAYOUT_KEY, this.layout); }, 300);
  }
  reset(): void { this.layout = {}; saveJson(LAYOUT_KEY, this.layout); }
}

/**
 * Panel position kept on screen: fully inside horizontally with an 8 px margin when it fits (a
 * phone-wide panel is centred rather than flush with an edge), header always reachable vertically.
 */
export function clampPanelPosition(x: number, y: number, width: number, viewW: number, viewH: number): { x: number; y: number } {
  const w = Math.min(width, viewW);
  const m = Math.max(0, Math.min(8, (viewW - w) / 2));
  return { x: Math.max(m, Math.min(viewW - w - m, x)), y: Math.max(0, Math.min(viewH - 40, y)) };
}

export interface FloatingPanelOpts {
  id: string;
  title: string;
  icon?: IconName;
  width?: number;
  height?: number;
  defaultPos?: { x: number; y: number };
  resizable?: boolean;
  /** no inner padding (canvas panels) */ tight?: boolean;
  onVisibility?: (visible: boolean) => void;
}

export class FloatingPanel {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private titleEl: HTMLElement;
  private _visible = false;
  private rect: PanelRect;
  private readonly defaults: PanelRect;
  private onVisibility?: (v: boolean) => void;

  constructor(private readonly layer: HTMLElement, private readonly layout: LayoutStore, opts: FloatingPanelOpts) {
    this.onVisibility = opts.onVisibility;
    const saved = layout.get(opts.id);
    this.defaults = { x: opts.defaultPos?.x ?? 80, y: opts.defaultPos?.y ?? 80, w: opts.width, h: opts.height };
    this.rect = { x: saved?.x ?? opts.defaultPos?.x ?? 80, y: saved?.y ?? opts.defaultPos?.y ?? 80, w: saved?.w ?? opts.width, h: saved?.h ?? opts.height };
    this.titleEl = h('span', { class: 'fp-title', text: opts.title });
    const header = h('div', { class: 'fp-header' },
      opts.icon ? icon(opts.icon) : icon('drag'),
      this.titleEl,
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Close', aria: { label: 'Close panel' }, onClick: () => this.hide() }, icon('close')),
    );
    this.body = h('div', { class: `fp-body${opts.tight ? ' tight' : ''}` });
    this.el = h('section', { class: 'panel floating-panel', role: 'dialog', aria: { label: opts.title }, dataset: { panel: opts.id } }, header, this.body);
    if (opts.resizable !== false) {
      const grip = h('div', { class: 'fp-resize', aria: { hidden: true } });
      this.el.appendChild(grip);
      this.makeResizable(grip, opts.id);
    }
    this.makeDraggable(header, opts.id);
    this.applyRect();
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this._visible; }
  setTitle(t: string): void { this.titleEl.textContent = t; }
  show(): void { if (this._visible) return; this._visible = true; this.el.classList.add('visible'); this.bringToFront(); this.clampToViewport(); this.onVisibility?.(true); }
  hide(): void { if (!this._visible) return; this._visible = false; this.el.classList.remove('visible'); this.onVisibility?.(false); }
  toggle(): void { this._visible ? this.hide() : this.show(); }
  /** Back to the default position and size (Settings › Data › Reset window layout). */
  resetPosition(): void {
    this.rect = { ...this.defaults };
    this.el.style.width = ''; this.el.style.height = '';
    this.applyRect();
    if (this._visible) this.clampToViewport();
  }
  dispose(): void { this.el.remove(); }

  private bringToFront(): void {
    for (const p of Array.from(this.layer.querySelectorAll<HTMLElement>('.floating-panel'))) p.style.zIndex = '';
    this.el.style.zIndex = '1';
  }

  private applyRect(): void {
    this.el.style.left = `${Math.round(this.rect.x)}px`;
    this.el.style.top = `${Math.round(this.rect.y)}px`;
    if (this.rect.w) this.el.style.width = `${Math.round(this.rect.w)}px`;
    if (this.rect.h) this.el.style.height = `${Math.round(this.rect.h)}px`;
  }

  /** Keeps at least the header on screen after a resize of the window. */
  clampToViewport(): void {
    const W = this.layer.clientWidth || window.innerWidth;
    const H = this.layer.clientHeight || window.innerHeight;
    const p = clampPanelPosition(this.rect.x, this.rect.y, this.el.offsetWidth || this.rect.w || 300, W, H);
    this.rect.x = p.x; this.rect.y = p.y;
    this.applyRect();
  }

  private makeDraggable(handle: HTMLElement, id: string): void {
    let startX = 0, startY = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      dragging = true; startX = e.clientX; startY = e.clientY; ox = this.rect.x; oy = this.rect.y;
      handle.setPointerCapture(e.pointerId);
      this.bringToFront();
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      this.rect.x = ox + (e.clientX - startX);
      this.rect.y = oy + (e.clientY - startY);
      this.clampToViewport();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.layout.set(id, { ...this.rect });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  private makeResizable(grip: HTMLElement, id: string): void {
    let startX = 0, startY = 0, ow = 0, oh = 0, resizing = false;
    grip.addEventListener('pointerdown', (e: PointerEvent) => {
      resizing = true; startX = e.clientX; startY = e.clientY; ow = this.el.offsetWidth; oh = this.el.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e: PointerEvent) => {
      if (!resizing) return;
      this.rect.w = Math.max(240, ow + (e.clientX - startX));
      this.rect.h = Math.max(120, oh + (e.clientY - startY));
      this.applyRect();
      this.el.dispatchEvent(new CustomEvent('panelresize'));
    });
    const end = (e: PointerEvent) => {
      if (!resizing) return;
      resizing = false;
      try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.layout.set(id, { ...this.rect });
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
}
