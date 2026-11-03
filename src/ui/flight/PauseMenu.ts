/**
 * Esc in flight: Resume, Restart flight (same spawn: runway, parking or challenge final), World map,
 * Settings, Main menu; while an activity (lesson, bush leg) runs also Restart step and Abort activity.
 */
import { arrowNavigation, button, h, isCoarsePointer, trapFocus } from '../dom';

export interface PauseMenuActions {
  resume: () => void; restart: () => void; worldMap: () => void; settings: () => void; mainMenu: () => void;
  /** activity running: reset the current step's objectives */
  restartStep?: () => void;
  /** activity running: end it, keep flying */
  abortActivity?: () => void;
}

/** What the pause menu shows about the running activity. */
export interface PauseActivityInfo { label: string; canRestartStep: boolean; canAbort: boolean }

export class PauseMenu {
  readonly el: HTMLElement;
  private first: HTMLButtonElement;
  private titleEl: HTMLElement;
  private noteEl: HTMLElement;
  private activityEl: HTMLElement;
  private restartStepBtn: HTMLButtonElement;
  private abortBtn: HTMLButtonElement;
  private restartBtn: HTMLButtonElement;

  constructor(layer: HTMLElement, a: PauseMenuActions) {
    this.first = button('Resume flight', a.resume, { icon: 'play', cls: 'menu-btn primary' });
    this.titleEl = h('h2', { class: 'pause-title', text: 'Paused' });
    this.noteEl = h('div', { class: 'pause-note muted', style: 'text-align:center;margin:-8px 0 8px;display:none' });
    this.activityEl = h('div', { class: 'pause-activity', style: 'display:none' });
    this.restartStepBtn = button('Restart step', () => a.restartStep?.(), { icon: 'restart', cls: 'menu-btn pause-act', title: 'Try the current step again from here (the aircraft is not moved)' });
    this.abortBtn = button('Abort activity', () => a.abortActivity?.(), { icon: 'close', cls: 'menu-btn pause-act btn-danger', title: 'End the activity and keep flying freely' });
    this.restartBtn = button('Restart flight', a.restart, { icon: 'restart', cls: 'menu-btn', title: 'Start again from the same position (runway, parking or challenge final)' });
    for (const b of [this.restartStepBtn, this.abortBtn]) b.style.display = 'none';
    const card = h('div', { class: 'panel pause-menu', role: 'dialog', aria: { label: 'Pause menu' } },
      this.titleEl, this.noteEl, this.activityEl,
      h('div', { class: 'menu-list' },
        this.first,
        this.restartStepBtn,
        this.restartBtn,
        this.abortBtn,
        button('World map', a.worldMap, { icon: 'globe', cls: 'menu-btn' }),
        button('Settings', a.settings, { icon: 'settings', cls: 'menu-btn' }),
        button('Main menu', a.mainMenu, { icon: 'home', cls: 'menu-btn' })),
      h('div', { class: 'muted', style: 'text-align:center;font-size:.8em;margin-top:10px', text: isCoarsePointer() ? 'Tap outside the menu to resume' : 'Esc resumes · Pause/Break toggles active pause' }));
    arrowNavigation(card);
    trapFocus(card);
    // a press on the card's background or on a greyed-out item (the second press of a double click
    // on Abort) would blur the focused item: the keyboard (arrows, Enter, the Tab trap) left the menu
    card.addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('button:not([disabled]), input, select, textarea, a[href]')) e.preventDefault();
    });
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
  /** The running activity (null: none): its line and the Restart step / Abort activity items. */
  setActivity(info: PauseActivityInfo | null): void {
    this.activityEl.textContent = info?.label ?? '';
    this.activityEl.style.display = info ? '' : 'none';
    this.restartStepBtn.style.display = info?.canRestartStep ? '' : 'none';
    this.abortBtn.style.display = info?.canAbort ? '' : 'none';
    this.restartStepBtn.disabled = false;
    this.abortBtn.disabled = false;
    // during an activity "Restart flight" restarts it from step 1 (the runner sees the reset at its start)
    this.restartBtn.querySelector('.btn-label')!.textContent = info ? 'Restart activity' : 'Restart flight';
    this.restartBtn.title = info ? 'Start the activity again from its first step' : 'Start again from the same position (runway, parking or challenge final)';
  }
  /**
   * The activity ended while the menu is open (Abort): its line goes, "Restart activity" becomes
   * "Restart flight", and Restart step / Abort stay in place greyed out until the menu closes, so the
   * rows do not move under the pointer (a double click on Abort used to land on "World map").
   */
  endActivity(): void {
    this.activityEl.style.display = 'none';
    this.restartStepBtn.disabled = true;
    this.abortBtn.disabled = true;
    this.restartBtn.querySelector('.btn-label')!.textContent = 'Restart flight';
    this.restartBtn.title = 'Start again from the same position (runway, parking or challenge final)';
  }
  show(): void { this.el.classList.add('visible'); this.first.focus(); }
  /** Keyboard focus back on "Resume flight" (after an item disappeared under it). */
  focusFirst(): void { if (this.visible) this.first.focus(); }
  hide(): void { this.el.classList.remove('visible'); }
}
