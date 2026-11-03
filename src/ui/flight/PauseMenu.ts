/** Esc in flight: Resume, Restart flight (same spawn: runway, parking or challenge final), World map, Settings, Main menu. */
import { arrowNavigation, button, h } from '../dom';

export interface PauseMenuActions { resume: () => void; restart: () => void; worldMap: () => void; settings: () => void; mainMenu: () => void }

export class PauseMenu {
  readonly el: HTMLElement;
  private first: HTMLButtonElement;
  private titleEl: HTMLElement;
  private noteEl: HTMLElement;

  constructor(layer: HTMLElement, a: PauseMenuActions) {
    this.first = button('Resume flight', a.resume, { icon: 'play', cls: 'menu-btn primary' });
    this.titleEl = h('h2', { class: 'pause-title', text: 'Paused' });
    this.noteEl = h('div', { class: 'pause-note muted', style: 'text-align:center;margin:-8px 0 8px;display:none' });
    const card = h('div', { class: 'panel pause-menu', role: 'dialog', aria: { label: 'Pause menu' } },
      this.titleEl, this.noteEl,
      h('div', { class: 'menu-list' },
        this.first,
        button('Restart flight', a.restart, { icon: 'restart', cls: 'menu-btn', title: 'Start again from the same position (runway, parking or challenge final)' }),
        button('World map', a.worldMap, { icon: 'globe', cls: 'menu-btn' }),
        button('Settings', a.settings, { icon: 'settings', cls: 'menu-btn' }),
        button('Main menu', a.mainMenu, { icon: 'home', cls: 'menu-btn' })),
      h('div', { class: 'muted', style: 'text-align:center;font-size:.8em;margin-top:10px', text: 'Esc resumes · Pause/Break toggles active pause' }));
    arrowNavigation(card);
    this.el = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === this.el) a.resume(); } }, card);
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }
  /** 'Paused' by default; 'Crashed' + the reason after a crash. */
  setTitle(title: string, note = ''): void {
    this.titleEl.textContent = title;
    this.noteEl.textContent = note;
    this.noteEl.style.display = note ? '' : 'none';
  }
  show(): void { this.el.classList.add('visible'); this.first.focus(); }
  hide(): void { this.el.classList.remove('visible'); }
}
