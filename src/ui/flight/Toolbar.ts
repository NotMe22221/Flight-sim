/** MSFS20-style top toolbar: slides in when the pointer approaches the top edge, hides 3 s after it leaves. */
import type { CameraMode } from '../../core/types';
import { h, icon } from '../dom';
import type { IconName } from '../icons';

export interface ToolbarItem { id: string; label: string; icon: IconName; onClick: () => void; title?: string }
export interface CameraPicker { modes: { mode: CameraMode; label: string; icon?: IconName }[]; onPick: (mode: CameraMode) => void }

export const CAMERA_MODES: { mode: CameraMode; label: string; icon: IconName }[] = [
  { mode: 'cockpit', label: 'Cockpit', icon: 'eye' },
  { mode: 'chase', label: 'Chase', icon: 'plane' },
  { mode: 'external-orbit', label: 'External orbit', icon: 'camera' },
  { mode: 'drone', label: 'Drone', icon: 'target' },
  { mode: 'tower', label: 'Tower', icon: 'flag' },
  { mode: 'flyby', label: 'Fly-by', icon: 'fast' },
  { mode: 'wing', label: 'Wing', icon: 'north' },
];

export class Toolbar {
  readonly el: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraMenu: HTMLElement | null = null;
  private pinned = false;
  private enabled = false;
  private readonly onMove = (e: PointerEvent) => this.pointerMoved(e);
  private readonly onDocClick = (e: MouseEvent) => { if (this.cameraMenu && !this.el.contains(e.target as Node)) this.closeCamera(); };

  constructor(layer: HTMLElement, items: ToolbarItem[], camera: CameraPicker) {
    this.el = h('div', { class: 'panel toolbar', role: 'toolbar', aria: { label: 'Flight toolbar' } });
    for (const it of items) {
      const wrap = h('div', { class: 'toolbar-item' });
      const b = h('button', { class: 'toolbar-btn', type: 'button', title: it.title ?? it.label, dataset: { item: it.id } }, icon(it.icon), h('span', { text: it.label }));
      if (it.id === 'camera') {
        this.cameraMenu = h('div', { class: 'panel camera-menu', role: 'menu' });
        for (const m of camera.modes) {
          this.cameraMenu.appendChild(h('button', { class: 'btn', type: 'button', role: 'menuitem', dataset: { mode: m.mode }, onClick: () => { camera.onPick(m.mode); this.closeCamera(); } }, m.icon ? icon(m.icon) : null, h('span', { text: m.label })));
        }
        b.addEventListener('click', () => { this.cameraMenu!.classList.toggle('open'); this.pinned = this.cameraMenu!.classList.contains('open'); this.show(); });
        wrap.append(b, this.cameraMenu);
      } else {
        b.addEventListener('click', it.onClick);
        wrap.appendChild(b);
      }
      this.buttons.set(it.id, b);
      this.el.appendChild(wrap);
      if (it.id === 'navlog' || it.id === 'camera') this.el.appendChild(h('div', { class: 'toolbar-sep' }));
    }
    this.el.addEventListener('pointerenter', () => { this.clearTimer(); });
    this.el.addEventListener('pointerleave', () => this.scheduleHide());
    // keyboard users (Tab) reveal it too; it hides again once the focus leaves
    this.el.addEventListener('focusin', () => this.show());
    this.el.addEventListener('focusout', (e) => { if (!this.el.contains(e.relatedTarget as Node | null)) this.scheduleHide(); });
    layer.appendChild(this.el);
  }

  /** Enable the pointer-near-top reveal (only in flight). */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) { window.addEventListener('pointermove', this.onMove); document.addEventListener('click', this.onDocClick, true); }
    else { window.removeEventListener('pointermove', this.onMove); document.removeEventListener('click', this.onDocClick, true); this.hide(); }
  }

  setActive(id: string, on: boolean): void { this.buttons.get(id)?.classList.toggle('active', on); }
  setCameraMode(mode: CameraMode): void {
    if (!this.cameraMenu) return;
    for (const b of Array.from(this.cameraMenu.querySelectorAll<HTMLElement>('button'))) b.classList.toggle('active', b.dataset.mode === mode);
  }

  show(): void { this.el.classList.add('visible'); this.clearTimer(); }
  hide(): void { if (this.pinned || (this.enabled && this.el.contains(document.activeElement))) return; this.el.classList.remove('visible'); this.clearTimer(); }
  toggle(): void { this.el.classList.contains('visible') ? this.hide() : (this.show(), this.scheduleHide()); }

  private closeCamera(): void { this.cameraMenu?.classList.remove('open'); this.pinned = false; this.scheduleHide(); }
  private clearTimer(): void { if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; } }
  private scheduleHide(): void { this.clearTimer(); this.hideTimer = setTimeout(() => this.hide(), 3000); }
  private pointerMoved(e: PointerEvent): void {
    if (e.clientY <= 28) { this.show(); }
    else if (this.el.classList.contains('visible') && !this.hideTimer && !this.el.matches(':hover')) this.scheduleHide();
  }

  dispose(): void { this.setEnabled(false); this.el.remove(); }
}
